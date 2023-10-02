import { setMaxListeners } from 'events'
import { CodeError, codes } from '@libp2p/interface/errors'
import { logger } from '@libp2p/logger'
import * as mss from '@libp2p/multistream-select'
import { peerIdFromString } from '@libp2p/peer-id'
import { createConnection } from './connection/index.js'
import { INBOUND_UPGRADE_TIMEOUT } from './connection-manager/constants.js'
import { DEFAULT_MAX_INBOUND_STREAMS, DEFAULT_MAX_OUTBOUND_STREAMS } from './registrar.js'
import type { Libp2pEvents, AbortOptions } from '@libp2p/interface'
import type { MultiaddrConnection, Connection, Stream, ConnectionProtector, NewStreamOptions } from '@libp2p/interface/connection'
import type { ConnectionEncrypter, SecuredConnection } from '@libp2p/interface/connection-encrypter'
import type { ConnectionGater } from '@libp2p/interface/connection-gater'
import type { EventEmitter } from '@libp2p/interface/events'
import type { Metrics } from '@libp2p/interface/metrics'
import type { PeerId } from '@libp2p/interface/peer-id'
import type { PeerStore } from '@libp2p/interface/peer-store'
import type { StreamMuxer, StreamMuxerFactory } from '@libp2p/interface/stream-muxer'
import type { Upgrader, UpgraderOptions } from '@libp2p/interface/transport'
import type { ConnectionManager } from '@libp2p/interface-internal/connection-manager'
import type { Registrar } from '@libp2p/interface-internal/registrar'
import type { Duplex, Source } from 'it-stream-types'

const log = logger('libp2p:upgrader')

interface CreateConnectionOptions {
  cryptoProtocol: string
  direction: 'inbound' | 'outbound'
  maConn: MultiaddrConnection
  upgradedConn: Duplex<AsyncGenerator<Uint8Array>, Source<Uint8Array>, Promise<void>>
  remotePeer: PeerId
  muxerFactory?: StreamMuxerFactory
  transient?: boolean
}

interface OnStreamOptions {
  connection: Connection
  stream: Stream
  protocol: string
}

export interface CryptoResult extends SecuredConnection {
  protocol: string
}

export interface UpgraderInit {
  connectionEncryption: ConnectionEncrypter[]
  muxers: StreamMuxerFactory[]

  /**
   * An amount of ms by which an inbound connection upgrade
   * must complete
   */
  inboundUpgradeTimeout?: number
}

function findIncomingStreamLimit (protocol: string, registrar: Registrar): number | undefined {
  try {
    const { options } = registrar.getHandler(protocol)

    return options.maxInboundStreams
  } catch (err: any) {
    if (err.code !== codes.ERR_NO_HANDLER_FOR_PROTOCOL) {
      throw err
    }
  }

  return DEFAULT_MAX_INBOUND_STREAMS
}

function findOutgoingStreamLimit (protocol: string, registrar: Registrar, options: NewStreamOptions = {}): number {
  try {
    const { options } = registrar.getHandler(protocol)

    if (options.maxOutboundStreams != null) {
      return options.maxOutboundStreams
    }
  } catch (err: any) {
    if (err.code !== codes.ERR_NO_HANDLER_FOR_PROTOCOL) {
      throw err
    }
  }

  return options.maxOutboundStreams ?? DEFAULT_MAX_OUTBOUND_STREAMS
}

function countStreams (protocol: string, direction: 'inbound' | 'outbound', connection: Connection): number {
  let streamCount = 0

  connection.streams.forEach(stream => {
    if (stream.direction === direction && stream.protocol === protocol) {
      streamCount++
    }
  })

  return streamCount
}

export interface DefaultUpgraderComponents {
  peerId: PeerId
  metrics?: Metrics
  connectionManager: ConnectionManager
  connectionGater: ConnectionGater
  connectionProtector?: ConnectionProtector
  registrar: Registrar
  peerStore: PeerStore
  events: EventEmitter<Libp2pEvents>
}

type EncryptedConn = Duplex<AsyncGenerator<Uint8Array, any, unknown>, Source<Uint8Array>, Promise<void>>

type ConnectionDeniedType = keyof Pick<ConnectionGater, 'denyOutboundConnection' | 'denyInboundEncryptedConnection' | 'denyOutboundEncryptedConnection' | 'denyInboundUpgradedConnection' | 'denyOutboundUpgradedConnection'>

export class DefaultUpgrader implements Upgrader {
  private readonly components: DefaultUpgraderComponents
  private readonly connectionEncryption: Map<string, ConnectionEncrypter>
  private readonly muxers: Map<string, StreamMuxerFactory>
  private readonly inboundUpgradeTimeout: number
  private readonly events: EventEmitter<Libp2pEvents>

  constructor (components: DefaultUpgraderComponents, init: UpgraderInit) {
    this.components = components
    this.connectionEncryption = new Map()

    init.connectionEncryption.forEach(encrypter => {
      this.connectionEncryption.set(encrypter.protocol, encrypter)
    })

    this.muxers = new Map()

    init.muxers.forEach(muxer => {
      this.muxers.set(muxer.protocol, muxer)
    })

    this.inboundUpgradeTimeout = init.inboundUpgradeTimeout ?? INBOUND_UPGRADE_TIMEOUT
    this.events = components.events
  }

  async shouldBlockConnection (remotePeer: PeerId, maConn: MultiaddrConnection, connectionType: ConnectionDeniedType): Promise<void> {
    const connectionGater = this.components.connectionGater[connectionType]

    if (connectionGater !== undefined) {
      if (await connectionGater(remotePeer, maConn)) {
        throw new CodeError(`The multiaddr connection is blocked by gater.${connectionType}`, codes.ERR_CONNECTION_INTERCEPTED)
      }
    }
  }

  /**
   * Upgrades an inbound connection
   */
  async upgradeInbound (maConn: MultiaddrConnection, opts?: UpgraderOptions): Promise<Connection> {
    const accept = await this.components.connectionManager.acceptIncomingConnection(maConn)

    if (!accept) {
      throw new CodeError('connection denied', codes.ERR_CONNECTION_DENIED)
    }

    let encryptedConn: EncryptedConn
    let remotePeer
    let upgradedConn: Duplex<AsyncGenerator<Uint8Array>, Source<Uint8Array>, Promise<void>>
    let muxerFactory: StreamMuxerFactory | undefined
    let cryptoProtocol

    const signal = AbortSignal.timeout(this.inboundUpgradeTimeout)

    const onAbort = (): void => {
      maConn.abort(new CodeError('inbound upgrade timeout', codes.ERR_TIMEOUT))
    }

    signal.addEventListener('abort', onAbort, { once: true })

    try {
      // fails on node < 15.4
      setMaxListeners?.(Infinity, signal)
    } catch { }

    try {
      if ((await this.components.connectionGater.denyInboundConnection?.(maConn)) === true) {
        throw new CodeError('The multiaddr connection is blocked by gater.acceptConnection', codes.ERR_CONNECTION_INTERCEPTED)
      }

      this.components.metrics?.trackMultiaddrConnection(maConn)

      log('starting the inbound connection upgrade')

      // Protect
      let protectedConn = maConn

      if (opts?.skipProtection !== true) {
        const protector = this.components.connectionProtector

        if (protector != null) {
          log('protecting the inbound connection')
          protectedConn = await protector.protect(maConn)
        }
      }

      try {
        // Encrypt the connection
        encryptedConn = protectedConn
        if (opts?.skipEncryption !== true) {
          ({
            conn: encryptedConn,
            remotePeer,
            protocol: cryptoProtocol
          } = await this._encryptInbound(protectedConn))

          const maConn: MultiaddrConnection = {
            ...protectedConn,
            ...encryptedConn
          }

          await this.shouldBlockConnection(remotePeer, maConn, 'denyInboundEncryptedConnection')
        } else {
          const idStr = maConn.remoteAddr.getPeerId()

          if (idStr == null) {
            throw new CodeError('inbound connection that skipped encryption must have a peer id', codes.ERR_INVALID_MULTIADDR)
          }

          const remotePeerId = peerIdFromString(idStr)

          cryptoProtocol = 'native'
          remotePeer = remotePeerId
        }

        upgradedConn = encryptedConn
        if (opts?.muxerFactory != null) {
          muxerFactory = opts.muxerFactory
        } else if (this.muxers.size > 0) {
          // Multiplex the connection
          const multiplexed = await this._multiplexInbound({
            ...protectedConn,
            ...encryptedConn
          }, this.muxers)
          muxerFactory = multiplexed.muxerFactory
          upgradedConn = multiplexed.stream
        }
      } catch (err: any) {
        log.error('Failed to upgrade inbound connection', err)
        throw err
      }

      await this.shouldBlockConnection(remotePeer, maConn, 'denyInboundUpgradedConnection')

      log('Successfully upgraded inbound connection')

      return this._createConnection({
        cryptoProtocol,
        direction: 'inbound',
        maConn,
        upgradedConn,
        muxerFactory,
        remotePeer,
        transient: opts?.transient
      })
    } finally {
      signal.removeEventListener('abort', onAbort)

      this.components.connectionManager.afterUpgradeInbound()
    }
  }

  /**
   * Upgrades an outbound connection
   */
  async upgradeOutbound (maConn: MultiaddrConnection, opts?: UpgraderOptions): Promise<Connection> {
    const idStr = maConn.remoteAddr.getPeerId()
    let remotePeerId: PeerId | undefined

    if (idStr != null) {
      remotePeerId = peerIdFromString(idStr)

      await this.shouldBlockConnection(remotePeerId, maConn, 'denyOutboundConnection')
    }

    let encryptedConn
    let remotePeer: PeerId
    let upgradedConn: Duplex<AsyncGenerator<Uint8Array>, Source<Uint8Array>, Promise<void>>
    let cryptoProtocol
    let muxerFactory

    this.components.metrics?.trackMultiaddrConnection(maConn)

    log('Starting the outbound connection upgrade')

    // If the transport natively supports encryption, skip connection
    // protector and encryption

    // Protect
    let protectedConn = maConn
    if (opts?.skipProtection !== true) {
      const protector = this.components.connectionProtector

      if (protector != null) {
        protectedConn = await protector.protect(maConn)
      }
    }

    try {
      // Encrypt the connection
      encryptedConn = protectedConn
      if (opts?.skipEncryption !== true) {
        ({
          conn: encryptedConn,
          remotePeer,
          protocol: cryptoProtocol
        } = await this._encryptOutbound(protectedConn, remotePeerId))

        const maConn: MultiaddrConnection = {
          ...protectedConn,
          ...encryptedConn
        }

        await this.shouldBlockConnection(remotePeer, maConn, 'denyOutboundEncryptedConnection')
      } else {
        if (remotePeerId == null) {
          throw new CodeError('Encryption was skipped but no peer id was passed', codes.ERR_INVALID_PEER)
        }

        cryptoProtocol = 'native'
        remotePeer = remotePeerId
      }

      upgradedConn = encryptedConn
      if (opts?.muxerFactory != null) {
        muxerFactory = opts.muxerFactory
      } else if (this.muxers.size > 0) {
        // Multiplex the connection
        const multiplexed = await this._multiplexOutbound({
          ...protectedConn,
          ...encryptedConn
        }, this.muxers)
        muxerFactory = multiplexed.muxerFactory
        upgradedConn = multiplexed.stream
      }
    } catch (err: any) {
      log.error('Failed to upgrade outbound connection', err)
      await maConn.close(err)
      throw err
    }

    await this.shouldBlockConnection(remotePeer, maConn, 'denyOutboundUpgradedConnection')

    log('Successfully upgraded outbound connection')

    return this._createConnection({
      cryptoProtocol,
      direction: 'outbound',
      maConn,
      upgradedConn,
      muxerFactory,
      remotePeer,
      transient: opts?.transient
    })
  }

  /**
   * A convenience method for generating a new `Connection`
   */
  _createConnection (opts: CreateConnectionOptions): Connection {
    const {
      cryptoProtocol,
      direction,
      maConn,
      upgradedConn,
      remotePeer,
      muxerFactory,
      transient
    } = opts

    let muxer: StreamMuxer | undefined
    let newStream: ((multicodecs: string[], options?: AbortOptions) => Promise<Stream>) | undefined
    let connection: Connection // eslint-disable-line prefer-const

    if (muxerFactory != null) {
      // Create the muxer
      muxer = muxerFactory.createStreamMuxer({
        direction,
        // Run anytime a remote stream is created
        onIncomingStream: muxedStream => {
          if (connection == null) {
            return
          }

          void Promise.resolve()
            .then(async () => {
              const protocols = this.components.registrar.getProtocols()
              const { stream, protocol } = await mss.handle(muxedStream, protocols)
              log('%s: incoming stream opened on %s', direction, protocol)

              if (connection == null) {
                return
              }

              const incomingLimit = findIncomingStreamLimit(protocol, this.components.registrar)
              const streamCount = countStreams(protocol, 'inbound', connection)

              if (streamCount === incomingLimit) {
                const err = new CodeError(`Too many inbound protocol streams for protocol "${protocol}" - limit ${incomingLimit}`, codes.ERR_TOO_MANY_INBOUND_PROTOCOL_STREAMS)
                muxedStream.abort(err)

                throw err
              }

              // after the handshake the returned stream can have early data so override
              // the souce/sink
              muxedStream.source = stream.source
              muxedStream.sink = stream.sink
              muxedStream.protocol = protocol

              // If a protocol stream has been successfully negotiated and is to be passed to the application,
              // the peerstore should ensure that the peer is registered with that protocol
              await this.components.peerStore.merge(remotePeer, {
                protocols: [protocol]
              })

              this.components.metrics?.trackProtocolStream(muxedStream, connection)

              this._onStream({ connection, stream: muxedStream, protocol })
            })
            .catch(async err => {
              log.error(err)

              if (muxedStream.timeline.close == null) {
                await muxedStream.close()
              }
            })
        }
      })

      newStream = async (protocols: string[], options: NewStreamOptions = {}): Promise<Stream> => {
        if (muxer == null) {
          throw new CodeError('Stream is not multiplexed', codes.ERR_MUXER_UNAVAILABLE)
        }

        log('%s: starting new stream on %s', direction, protocols)
        const muxedStream = await muxer.newStream()

        try {
          if (options.signal == null) {
            log('No abort signal was passed while trying to negotiate protocols %s falling back to default timeout', protocols)

            options.signal = AbortSignal.timeout(30000)

            try {
              // fails on node < 15.4
              setMaxListeners?.(Infinity, options.signal)
            } catch { }
          }

          const { stream, protocol } = await mss.select(muxedStream, protocols, options)

          const outgoingLimit = findOutgoingStreamLimit(protocol, this.components.registrar, options)
          const streamCount = countStreams(protocol, 'outbound', connection)

          if (streamCount >= outgoingLimit) {
            const err = new CodeError(`Too many outbound protocol streams for protocol "${protocol}" - limit ${outgoingLimit}`, codes.ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS)
            muxedStream.abort(err)

            throw err
          }

          // If a protocol stream has been successfully negotiated and is to be passed to the application,
          // the peerstore should ensure that the peer is registered with that protocol
          await this.components.peerStore.merge(remotePeer, {
            protocols: [protocol]
          })

          // after the handshake the returned stream can have early data so override
          // the souce/sink
          muxedStream.source = stream.source
          muxedStream.sink = stream.sink
          muxedStream.protocol = protocol

          this.components.metrics?.trackProtocolStream(muxedStream, connection)

          return muxedStream
        } catch (err: any) {
          log.error('could not create new stream for protocols %s on connection with address %a', protocols, connection.remoteAddr, err)

          if (muxedStream.timeline.close == null) {
            muxedStream.abort(err)
          }

          if (err.code != null) {
            throw err
          }

          throw new CodeError(String(err), codes.ERR_UNSUPPORTED_PROTOCOL)
        }
      }

      // Pipe all data through the muxer
      void Promise.all([
        muxer.sink(upgradedConn.source),
        upgradedConn.sink(muxer.source)
      ]).catch(err => {
        log.error(err)
      })
    }

    const _timeline = maConn.timeline
    maConn.timeline = new Proxy(_timeline, {
      set: (...args) => {
        if (connection != null && args[1] === 'close' && args[2] != null && _timeline.close == null) {
          // Wait for close to finish before notifying of the closure
          (async () => {
            try {
              if (connection.status === 'open') {
                await connection.close()
              }
            } catch (err: any) {
              log.error(err)
            } finally {
              this.events.safeDispatchEvent('connection:close', {
                detail: connection
              })
            }
          })().catch(err => {
            log.error(err)
          })
        }

        return Reflect.set(...args)
      }
    })
    maConn.timeline.upgraded = Date.now()

    const errConnectionNotMultiplexed = (): any => {
      throw new CodeError('connection is not multiplexed', codes.ERR_CONNECTION_NOT_MULTIPLEXED)
    }

    // Create the connection
    connection = createConnection({
      remoteAddr: maConn.remoteAddr,
      remotePeer,
      status: 'open',
      direction,
      timeline: maConn.timeline,
      multiplexer: muxer?.protocol,
      encryption: cryptoProtocol,
      transient,
      newStream: newStream ?? errConnectionNotMultiplexed,
      getStreams: () => { if (muxer != null) { return muxer.streams } else { return [] } },
      close: async (options?: AbortOptions) => {
        await maConn.close(options)
        // Ensure remaining streams are closed gracefully
        if (muxer != null) {
          await muxer.close(options)
        }
      },
      abort: (err) => {
        maConn.abort(err)
        // Ensure remaining streams are aborted
        if (muxer != null) {
          muxer.abort(err)
        }
      }
    })

    this.events.safeDispatchEvent('connection:open', {
      detail: connection
    })

    return connection
  }

  /**
   * Routes incoming streams to the correct handler
   */
  _onStream (opts: OnStreamOptions): void {
    const { connection, stream, protocol } = opts
    const { handler, options } = this.components.registrar.getHandler(protocol)

    if (connection.transient && options.runOnTransientConnection !== true) {
      throw new CodeError('Cannot open protocol stream on transient connection', 'ERR_TRANSIENT_CONNECTION')
    }

    handler({ connection, stream })
  }

  /**
   * Attempts to encrypt the incoming `connection` with the provided `cryptos`
   */
  async _encryptInbound (connection: Duplex<AsyncGenerator<Uint8Array>, Source<Uint8Array>>): Promise<CryptoResult> {
    const protocols = Array.from(this.connectionEncryption.keys())
    log('handling inbound crypto protocol selection', protocols)

    try {
      const { stream, protocol } = await mss.handle(connection, protocols, {
        writeBytes: true
      })
      const encrypter = this.connectionEncryption.get(protocol)

      if (encrypter == null) {
        throw new Error(`no crypto module found for ${protocol}`)
      }

      log('encrypting inbound connection...')

      return {
        ...await encrypter.secureInbound(this.components.peerId, stream),
        protocol
      }
    } catch (err: any) {
      throw new CodeError(String(err), codes.ERR_ENCRYPTION_FAILED)
    }
  }

  /**
   * Attempts to encrypt the given `connection` with the provided connection encrypters.
   * The first `ConnectionEncrypter` module to succeed will be used
   */
  async _encryptOutbound (connection: MultiaddrConnection, remotePeerId?: PeerId): Promise<CryptoResult> {
    const protocols = Array.from(this.connectionEncryption.keys())
    log('selecting outbound crypto protocol', protocols)

    try {
      const { stream, protocol } = await mss.select(connection, protocols, {
        writeBytes: true
      })
      const encrypter = this.connectionEncryption.get(protocol)

      if (encrypter == null) {
        throw new Error(`no crypto module found for ${protocol}`)
      }

      log('encrypting outbound connection to %p', remotePeerId)

      return {
        ...await encrypter.secureOutbound(this.components.peerId, stream, remotePeerId),
        protocol
      }
    } catch (err: any) {
      throw new CodeError(String(err), codes.ERR_ENCRYPTION_FAILED)
    }
  }

  /**
   * Selects one of the given muxers via multistream-select. That
   * muxer will be used for all future streams on the connection.
   */
  async _multiplexOutbound (connection: MultiaddrConnection, muxers: Map<string, StreamMuxerFactory>): Promise<{ stream: Duplex<AsyncGenerator<Uint8Array>, Source<Uint8Array>, Promise<void>>, muxerFactory?: StreamMuxerFactory }> {
    const protocols = Array.from(muxers.keys())
    log('outbound selecting muxer %s', protocols)
    try {
      const { stream, protocol } = await mss.select(connection, protocols, {
        writeBytes: true
      })
      log('%s selected as muxer protocol', protocol)
      const muxerFactory = muxers.get(protocol)

      return { stream, muxerFactory }
    } catch (err: any) {
      log.error('error multiplexing outbound stream', err)
      throw new CodeError(String(err), codes.ERR_MUXER_UNAVAILABLE)
    }
  }

  /**
   * Registers support for one of the given muxers via multistream-select. The
   * selected muxer will be used for all future streams on the connection.
   */
  async _multiplexInbound (connection: MultiaddrConnection, muxers: Map<string, StreamMuxerFactory>): Promise<{ stream: Duplex<AsyncGenerator<Uint8Array>, Source<Uint8Array>, Promise<void>>, muxerFactory?: StreamMuxerFactory }> {
    const protocols = Array.from(muxers.keys())
    log('inbound handling muxers %s', protocols)
    try {
      const { stream, protocol } = await mss.handle(connection, protocols, {
        writeBytes: true
      })
      const muxerFactory = muxers.get(protocol)

      return { stream, muxerFactory }
    } catch (err: any) {
      log.error('error multiplexing inbound stream', err)
      throw new CodeError(String(err), codes.ERR_MUXER_UNAVAILABLE)
    }
  }
}
