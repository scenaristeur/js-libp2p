import { setMaxListeners } from 'events'
import { AbortError, CodeError, codes } from '@libp2p/interface/errors'
import { logger } from '@libp2p/logger'
import { defaultAddressSort } from '@libp2p/utils/address-sort'
import { type Multiaddr, type Resolver, resolvers } from '@multiformats/multiaddr'
import { dnsaddrResolver } from '@multiformats/multiaddr/resolvers'
import { type ClearableSignal, anySignal } from 'any-signal'
import pDefer from 'p-defer'
import PQueue from 'p-queue'
import { fromString as uint8ArrayFromString } from 'uint8arrays/from-string'
import { getPeerAddress } from '../get-peer.js'
import {
  DIAL_TIMEOUT,
  MAX_PARALLEL_DIALS_PER_PEER,
  MAX_PARALLEL_DIALS,
  MAX_PEER_ADDRS_TO_DIAL,
  LAST_DIAL_FAILURE_KEY
} from './constants.js'
import { combineSignals, resolveMultiaddrs } from './utils.js'
import type { AddressSorter, AbortOptions, PendingDial } from '@libp2p/interface'
import type { Connection } from '@libp2p/interface/connection'
import type { ConnectionGater } from '@libp2p/interface/connection-gater'
import type { Metric, Metrics } from '@libp2p/interface/metrics'
import type { PeerId } from '@libp2p/interface/peer-id'
import type { Address, PeerStore } from '@libp2p/interface/peer-store'
import type { TransportManager } from '@libp2p/interface-internal/transport-manager'

const log = logger('libp2p:connection-manager:dial-queue')

export interface PendingDialTarget {
  resolve: (value: any) => void
  reject: (err: Error) => void
}

export interface DialOptions extends AbortOptions {
  priority?: number
}

interface PendingDialInternal extends PendingDial {
  promise: Promise<Connection>
}

interface DialerInit {
  addressSorter?: AddressSorter
  maxParallelDials?: number
  maxPeerAddrsToDial?: number
  maxParallelDialsPerPeer?: number
  dialTimeout?: number
  resolvers?: Record<string, Resolver>
}

const defaultOptions = {
  addressSorter: defaultAddressSort,
  maxParallelDials: MAX_PARALLEL_DIALS,
  maxPeerAddrsToDial: MAX_PEER_ADDRS_TO_DIAL,
  maxParallelDialsPerPeer: MAX_PARALLEL_DIALS_PER_PEER,
  dialTimeout: DIAL_TIMEOUT,
  resolvers: {
    dnsaddr: dnsaddrResolver
  }
}

interface DialQueueComponents {
  peerId: PeerId
  metrics?: Metrics
  peerStore: PeerStore
  transportManager: TransportManager
  connectionGater: ConnectionGater
}

export class DialQueue {
  public pendingDials: PendingDialInternal[]
  public queue: PQueue
  private readonly peerId: PeerId
  private readonly peerStore: PeerStore
  private readonly connectionGater: ConnectionGater
  private readonly transportManager: TransportManager
  private readonly addressSorter: AddressSorter
  private readonly maxPeerAddrsToDial: number
  private readonly maxParallelDialsPerPeer: number
  private readonly dialTimeout: number
  private readonly inProgressDialCount?: Metric
  private readonly pendingDialCount?: Metric
  private readonly shutDownController: AbortController

  constructor (components: DialQueueComponents, init: DialerInit = {}) {
    this.addressSorter = init.addressSorter ?? defaultOptions.addressSorter
    this.maxPeerAddrsToDial = init.maxPeerAddrsToDial ?? defaultOptions.maxPeerAddrsToDial
    this.maxParallelDialsPerPeer = init.maxParallelDialsPerPeer ?? defaultOptions.maxParallelDialsPerPeer
    this.dialTimeout = init.dialTimeout ?? defaultOptions.dialTimeout

    this.peerId = components.peerId
    this.peerStore = components.peerStore
    this.connectionGater = components.connectionGater
    this.transportManager = components.transportManager
    this.shutDownController = new AbortController()

    try {
      // This emitter gets listened to a lot
      setMaxListeners?.(Infinity, this.shutDownController.signal)
    } catch {}

    this.pendingDialCount = components.metrics?.registerMetric('libp2p_dialler_pending_dials')
    this.inProgressDialCount = components.metrics?.registerMetric('libp2p_dialler_in_progress_dials')
    this.pendingDials = []

    for (const [key, value] of Object.entries(init.resolvers ?? {})) {
      resolvers.set(key, value)
    }

    // controls dial concurrency
    this.queue = new PQueue({
      concurrency: init.maxParallelDials ?? defaultOptions.maxParallelDials
    })

    // a job was added to the queue
    this.queue.on('add', () => {
      this.pendingDialCount?.update(this.queue.size)
      this.inProgressDialCount?.update(this.queue.pending)
    })
    // a queued job started
    this.queue.on('active', () => {
      this.pendingDialCount?.update(this.queue.size)
      this.inProgressDialCount?.update(this.queue.pending)
    })
    // a started job completed without error
    this.queue.on('completed', () => {
      this.pendingDialCount?.update(this.queue.size)
      this.inProgressDialCount?.update(this.queue.pending)
    })
    // a started job errored
    this.queue.on('error', (err) => {
      log.error('error in dial queue', err)
      this.pendingDialCount?.update(this.queue.size)
      this.inProgressDialCount?.update(this.queue.pending)
    })
    // all queued jobs have been started
    this.queue.on('empty', () => {
      this.pendingDialCount?.update(this.queue.size)
      this.inProgressDialCount?.update(this.queue.pending)
    })
    // add started jobs have run and the queue is empty
    this.queue.on('idle', () => {
      this.pendingDialCount?.update(this.queue.size)
      this.inProgressDialCount?.update(this.queue.pending)
    })
  }

  /**
   * Clears any pending dials
   */
  stop (): void {
    this.shutDownController.abort()
  }

  /**
   * Connects to a given peer, multiaddr or list of multiaddrs.
   *
   * If a peer is passed, all known multiaddrs will be tried. If a multiaddr or
   * multiaddrs are passed only those will be dialled.
   *
   * Where a list of multiaddrs is passed, if any contain a peer id then all
   * multiaddrs in the list must contain the same peer id.
   *
   * The dial to the first address that is successfully able to upgrade a connection
   * will be used, all other dials will be aborted when that happens.
   */
  async dial (peerIdOrMultiaddr: PeerId | Multiaddr | Multiaddr[], options: DialOptions = {}): Promise<Connection> {
    const { peerId, multiaddrs } = getPeerAddress(peerIdOrMultiaddr)

    const addrs: Address[] = multiaddrs.map(multiaddr => ({
      multiaddr,
      isCertified: false
    }))

    // create abort conditions - need to do this before `calculateMultiaddrs` as we may be about to
    // resolve a dns addr which can time out
    const signal = this.createDialAbortControllers(options.signal)
    let addrsToDial: Address[]

    try {
      // load addresses from address book, resolve and dnsaddrs, filter undiallables, add peer IDs, etc
      addrsToDial = await this.calculateMultiaddrs(peerId, addrs, {
        ...options,
        signal
      })
    } catch (err) {
      signal.clear()
      throw err
    }

    // ready to dial, all async work finished - make sure we don't have any
    // pending dials in progress for this peer or set of multiaddrs
    const existingDial = this.pendingDials.find(dial => {
      // is the dial for the same peer id?
      if (dial.peerId != null && peerId != null && dial.peerId.equals(peerId)) {
        return true
      }

      // is the dial for the same set of multiaddrs?
      if (addrsToDial.map(({ multiaddr }) => multiaddr.toString()).join() === dial.multiaddrs.map(multiaddr => multiaddr.toString()).join()) {
        return true
      }

      return false
    })

    if (existingDial != null) {
      log('joining existing dial target for %p', peerId)
      signal.clear()
      return existingDial.promise
    }

    log('creating dial target for', addrsToDial.map(({ multiaddr }) => multiaddr.toString()))
    // @ts-expect-error .promise property is set below
    const pendingDial: PendingDialInternal = {
      id: randomId(),
      status: 'queued',
      peerId,
      multiaddrs: addrsToDial.map(({ multiaddr }) => multiaddr)
    }

    pendingDial.promise = this.performDial(pendingDial, {
      ...options,
      signal
    })
      .finally(() => {
        // remove our pending dial entry
        this.pendingDials = this.pendingDials.filter(p => p.id !== pendingDial.id)

        // clean up abort signals/controllers
        signal.clear()
      })
      .catch(async err => {
        log.error('dial failed to %s', pendingDial.multiaddrs.map(ma => ma.toString()).join(', '), err)

        if (peerId != null) {
          // record the last failed dial
          try {
            await this.peerStore.patch(peerId, {
              metadata: {
                [LAST_DIAL_FAILURE_KEY]: uint8ArrayFromString(Date.now().toString())
              }
            })
          } catch (err: any) {
            log.error('could not update last dial failure key for %p', peerId, err)
          }
        }

        // Error is a timeout
        if (signal.aborted) {
          const error = new CodeError(err.message, codes.ERR_TIMEOUT)
          throw error
        }

        throw err
      })

    // let other dials join this one
    this.pendingDials.push(pendingDial)

    return pendingDial.promise
  }

  private createDialAbortControllers (userSignal?: AbortSignal): ClearableSignal {
    // let any signal abort the dial
    const signal = anySignal(
      [AbortSignal.timeout(this.dialTimeout),
        this.shutDownController.signal,
        userSignal
      ]
    )

    try {
      // This emitter gets listened to a lot
      setMaxListeners?.(Infinity, signal)
    } catch {}

    return signal
  }

  // eslint-disable-next-line complexity
  private async calculateMultiaddrs (peerId?: PeerId, addrs: Address[] = [], options: DialOptions = {}): Promise<Address[]> {
    // if a peer id or multiaddr(s) with a peer id, make sure it isn't our peer id and that we are allowed to dial it
    if (peerId != null) {
      if (this.peerId.equals(peerId)) {
        throw new CodeError('Tried to dial self', codes.ERR_DIALED_SELF)
      }

      if ((await this.connectionGater.denyDialPeer?.(peerId)) === true) {
        throw new CodeError('The dial request is blocked by gater.allowDialPeer', codes.ERR_PEER_DIAL_INTERCEPTED)
      }

      // if just a peer id was passed, load available multiaddrs for this peer from the address book
      if (addrs.length === 0) {
        log('loading multiaddrs for %p', peerId)
        try {
          const peer = await this.peerStore.get(peerId)
          addrs.push(...peer.addresses)
          log('loaded multiaddrs for %p', peerId, addrs.map(({ multiaddr }) => multiaddr.toString()))
        } catch (err: any) {
          if (err.code !== codes.ERR_NOT_FOUND) {
            throw err
          }
        }
      }
    }

    // resolve addresses - this can result in a one-to-many translation when dnsaddrs are resolved
    const resolvedAddresses = (await Promise.all(
      addrs.map(async addr => {
        const result = await resolveMultiaddrs(addr.multiaddr, options)

        if (result.length === 1 && result[0].equals(addr.multiaddr)) {
          return addr
        }

        return result.map(multiaddr => ({
          multiaddr,
          isCertified: false
        }))
      })
    ))
      .flat()

    const filteredAddrs = resolvedAddresses.filter(addr => {
      // filter out any multiaddrs that we do not have transports for
      if (this.transportManager.transportForMultiaddr(addr.multiaddr) == null) {
        return false
      }

      // if the resolved multiaddr has a PeerID but it's the wrong one, ignore it
      // - this can happen with addresses like bootstrap.libp2p.io that resolve
      // to multiple different peers
      const addrPeerId = addr.multiaddr.getPeerId()
      if (peerId != null && addrPeerId != null) {
        return peerId.equals(addrPeerId)
      }

      return true
    })

    // deduplicate addresses
    const dedupedAddrs = new Map<string, Address>()

    for (const addr of filteredAddrs) {
      const maStr = addr.multiaddr.toString()
      const existing = dedupedAddrs.get(maStr)

      if (existing != null) {
        existing.isCertified = existing.isCertified || addr.isCertified || false
        continue
      }

      dedupedAddrs.set(maStr, addr)
    }

    let dedupedMultiaddrs = [...dedupedAddrs.values()]

    if (dedupedMultiaddrs.length === 0 || dedupedMultiaddrs.length > this.maxPeerAddrsToDial) {
      log('addresses for %p before filtering', peerId ?? 'unknown peer', resolvedAddresses.map(({ multiaddr }) => multiaddr.toString()))
      log('addresses for %p after filtering', peerId ?? 'unknown peer', dedupedMultiaddrs.map(({ multiaddr }) => multiaddr.toString()))
    }

    // make sure we actually have some addresses to dial
    if (dedupedMultiaddrs.length === 0) {
      throw new CodeError('The dial request has no valid addresses', codes.ERR_NO_VALID_ADDRESSES)
    }

    // make sure we don't have too many addresses to dial
    if (dedupedMultiaddrs.length > this.maxPeerAddrsToDial) {
      throw new CodeError('dial with more addresses than allowed', codes.ERR_TOO_MANY_ADDRESSES)
    }

    // ensure the peer id is appended to the multiaddr
    if (peerId != null) {
      const peerIdMultiaddr = `/p2p/${peerId.toString()}`
      dedupedMultiaddrs = dedupedMultiaddrs.map(addr => {
        const addressPeerId = addr.multiaddr.getPeerId()
        const lastProto = addr.multiaddr.protos().pop()

        // do not append peer id to path multiaddrs
        if (lastProto?.path === true) {
          return addr
        }

        // append peer id to multiaddr if it is not already present
        if (addressPeerId !== peerId.toString()) {
          return {
            multiaddr: addr.multiaddr.encapsulate(peerIdMultiaddr),
            isCertified: addr.isCertified
          }
        }

        return addr
      })
    }

    const gatedAdrs: Address[] = []

    for (const addr of dedupedMultiaddrs) {
      if (this.connectionGater.denyDialMultiaddr != null && await this.connectionGater.denyDialMultiaddr(addr.multiaddr)) {
        continue
      }

      gatedAdrs.push(addr)
    }

    const sortedGatedAddrs = gatedAdrs.sort(this.addressSorter)

    // make sure we actually have some addresses to dial
    if (sortedGatedAddrs.length === 0) {
      throw new CodeError('The connection gater denied all addresses in the dial request', codes.ERR_NO_VALID_ADDRESSES)
    }

    return sortedGatedAddrs
  }

  private async performDial (pendingDial: PendingDialInternal, options: DialOptions = {}): Promise<Connection> {
    const dialAbortControllers: Array<(AbortController | undefined)> = pendingDial.multiaddrs.map(() => new AbortController())

    try {
      // internal peer dial queue to ensure we only dial the configured number of addresses
      // per peer at the same time to prevent one peer with a lot of addresses swamping
      // the dial queue
      const peerDialQueue = new PQueue({
        concurrency: this.maxParallelDialsPerPeer
      })
      peerDialQueue.on('error', (err) => {
        log.error('error dialling', err)
      })

      const conn = await Promise.any(pendingDial.multiaddrs.map(async (addr, i) => {
        const controller = dialAbortControllers[i]

        if (controller == null) {
          throw new CodeError('dialAction did not come with an AbortController', codes.ERR_INVALID_PARAMETERS)
        }

        // let any signal abort the dial
        const signal = combineSignals(controller.signal, options.signal)
        signal.addEventListener('abort', () => {
          log('dial to %a aborted', addr)
        })
        const deferred = pDefer<Connection>()

        await peerDialQueue.add(async () => {
          if (signal.aborted) {
            log('dial to %a was aborted before reaching the head of the peer dial queue', addr)
            deferred.reject(new AbortError())
            return
          }

          // add the individual dial to the dial queue so we don't breach maxConcurrentDials
          await this.queue.add(async () => {
            try {
              if (signal.aborted) {
                log('dial to %a was aborted before reaching the head of the dial queue', addr)
                deferred.reject(new AbortError())
                return
              }

              // update dial status
              pendingDial.status = 'active'

              const conn = await this.transportManager.dial(addr, {
                ...options,
                signal
              })

              if (controller.signal.aborted) {
                // another dial succeeded faster than this one
                log('multiple dials succeeded, closing superfluous connection')

                conn.close().catch(err => {
                  log.error('error closing superfluous connection', err)
                })

                deferred.reject(new AbortError())
                return
              }

              // remove the successful AbortController so it is not aborted
              dialAbortControllers[i] = undefined

              // immediately abort any other dials
              dialAbortControllers.forEach(c => {
                if (c !== undefined) {
                  c.abort()
                }
              })

              log('dial to %a succeeded', addr)

              // resolve the connection promise
              deferred.resolve(conn)
            } catch (err: any) {
              // something only went wrong if our signal was not aborted
              log.error('error during dial of %a', addr, err)
              deferred.reject(err)
            }
          }, {
            ...options,
            signal
          }).catch(err => {
            deferred.reject(err)
          })
        }, {
          signal
        }).catch(err => {
          deferred.reject(err)
        }).finally(() => {
          signal.clear()
        })

        return deferred.promise
      }))

      // dial succeeded or failed
      if (conn == null) {
        throw new CodeError('successful dial led to empty object returned from peer dial queue', codes.ERR_TRANSPORT_DIAL_FAILED)
      }

      pendingDial.status = 'success'

      return conn
    } catch (err: any) {
      pendingDial.status = 'error'

      // if we only dialled one address, unwrap the AggregateError to provide more
      // useful feedback to the user
      if (pendingDial.multiaddrs.length === 1 && err.name === 'AggregateError') {
        throw err.errors[0]
      }

      throw err
    }
  }
}

/**
 * Returns a random string
 */
function randomId (): string {
  return `${(parseInt(String(Math.random() * 1e9), 10)).toString()}${Date.now()}`
}
