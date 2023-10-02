/**
 * When this error is thrown it means an operation was aborted,
 * usually in response to the `abort` event being emitted by an
 * AbortSignal.
 */
export class AbortError extends Error {
  public readonly code: string
  public readonly type: string

  constructor (message: string = 'The operation was aborted') {
    super(message)
    this.code = AbortError.code
    this.type = AbortError.type
  }

  static readonly code = 'ABORT_ERR'

  static readonly type = 'aborted'
}

export class CodeError<T extends Record<string, any> = Record<string, never>> extends Error {
  public readonly props: T

  constructor (
    message: string,
    public readonly code: string,
    props?: T
  ) {
    super(message)

    this.name = props?.name ?? 'CodeError'
    this.props = props ?? {} as T // eslint-disable-line @typescript-eslint/consistent-type-assertions
  }
}

export class UnexpectedPeerError extends Error {
  public code: string

  constructor (message = 'Unexpected Peer') {
    super(message)
    this.code = UnexpectedPeerError.code
  }

  static readonly code = 'ERR_UNEXPECTED_PEER'
}

export class InvalidCryptoExchangeError extends Error {
  public code: string

  constructor (message = 'Invalid crypto exchange') {
    super(message)
    this.code = InvalidCryptoExchangeError.code
  }

  static readonly code = 'ERR_INVALID_CRYPTO_EXCHANGE'
}

export class InvalidCryptoTransmissionError extends Error {
  public code: string

  constructor (message = 'Invalid crypto transmission') {
    super(message)
    this.code = InvalidCryptoTransmissionError.code
  }

  static readonly code = 'ERR_INVALID_CRYPTO_TRANSMISSION'
}

export enum messages {
  NOT_STARTED_YET = 'The libp2p node is not started yet',
  DHT_DISABLED = 'DHT is not available',
  PUBSUB_DISABLED = 'PubSub is not available',
  CONN_ENCRYPTION_REQUIRED = 'At least one connection encryption module is required',
  ERR_TRANSPORTS_REQUIRED = 'At least one transport module is required',
  ERR_PROTECTOR_REQUIRED = 'Private network is enforced, but no protector was provided',
  NOT_FOUND = 'Not found'
}

export enum codes {
  DHT_DISABLED = 'ERR_DHT_DISABLED',
  ERR_PUBSUB_DISABLED = 'ERR_PUBSUB_DISABLED',
  PUBSUB_NOT_STARTED = 'ERR_PUBSUB_NOT_STARTED',
  DHT_NOT_STARTED = 'ERR_DHT_NOT_STARTED',
  CONN_ENCRYPTION_REQUIRED = 'ERR_CONN_ENCRYPTION_REQUIRED',
  ERR_TRANSPORTS_REQUIRED = 'ERR_TRANSPORTS_REQUIRED',
  ERR_PROTECTOR_REQUIRED = 'ERR_PROTECTOR_REQUIRED',
  ERR_PEER_DIAL_INTERCEPTED = 'ERR_PEER_DIAL_INTERCEPTED',
  ERR_CONNECTION_INTERCEPTED = 'ERR_CONNECTION_INTERCEPTED',
  ERR_INVALID_PROTOCOLS_FOR_STREAM = 'ERR_INVALID_PROTOCOLS_FOR_STREAM',
  ERR_CONNECTION_ENDED = 'ERR_CONNECTION_ENDED',
  ERR_CONNECTION_FAILED = 'ERR_CONNECTION_FAILED',
  ERR_NODE_NOT_STARTED = 'ERR_NODE_NOT_STARTED',
  ERR_ALREADY_ABORTED = 'ERR_ALREADY_ABORTED',
  ERR_TOO_MANY_ADDRESSES = 'ERR_TOO_MANY_ADDRESSES',
  ERR_NO_VALID_ADDRESSES = 'ERR_NO_VALID_ADDRESSES',
  ERR_RELAYED_DIAL = 'ERR_RELAYED_DIAL',
  ERR_DIALED_SELF = 'ERR_DIALED_SELF',
  ERR_DISCOVERED_SELF = 'ERR_DISCOVERED_SELF',
  ERR_DUPLICATE_TRANSPORT = 'ERR_DUPLICATE_TRANSPORT',
  ERR_ENCRYPTION_FAILED = 'ERR_ENCRYPTION_FAILED',
  ERR_HOP_REQUEST_FAILED = 'ERR_HOP_REQUEST_FAILED',
  ERR_INVALID_KEY = 'ERR_INVALID_KEY',
  ERR_INVALID_MESSAGE = 'ERR_INVALID_MESSAGE',
  ERR_INVALID_PARAMETERS = 'ERR_INVALID_PARAMETERS',
  ERR_INVALID_PEER = 'ERR_INVALID_PEER',
  ERR_MUXER_UNAVAILABLE = 'ERR_MUXER_UNAVAILABLE',
  ERR_NOT_FOUND = 'ERR_NOT_FOUND',
  ERR_TIMEOUT = 'ERR_TIMEOUT',
  ERR_TRANSPORT_UNAVAILABLE = 'ERR_TRANSPORT_UNAVAILABLE',
  ERR_TRANSPORT_DIAL_FAILED = 'ERR_TRANSPORT_DIAL_FAILED',
  ERR_UNSUPPORTED_PROTOCOL = 'ERR_UNSUPPORTED_PROTOCOL',
  ERR_PROTOCOL_HANDLER_ALREADY_REGISTERED = 'ERR_PROTOCOL_HANDLER_ALREADY_REGISTERED',
  ERR_INVALID_MULTIADDR = 'ERR_INVALID_MULTIADDR',
  ERR_SIGNATURE_NOT_VALID = 'ERR_SIGNATURE_NOT_VALID',
  ERR_FIND_SELF = 'ERR_FIND_SELF',
  ERR_NO_ROUTERS_AVAILABLE = 'ERR_NO_ROUTERS_AVAILABLE',
  ERR_CONNECTION_NOT_MULTIPLEXED = 'ERR_CONNECTION_NOT_MULTIPLEXED',
  ERR_NO_DIAL_TOKENS = 'ERR_NO_DIAL_TOKENS',
  ERR_KEYCHAIN_REQUIRED = 'ERR_KEYCHAIN_REQUIRED',
  ERR_INVALID_CMS = 'ERR_INVALID_CMS',
  ERR_MISSING_KEYS = 'ERR_MISSING_KEYS',
  ERR_NO_KEY = 'ERR_NO_KEY',
  ERR_INVALID_KEY_NAME = 'ERR_INVALID_KEY_NAME',
  ERR_INVALID_KEY_TYPE = 'ERR_INVALID_KEY_TYPE',
  ERR_KEY_ALREADY_EXISTS = 'ERR_KEY_ALREADY_EXISTS',
  ERR_INVALID_KEY_SIZE = 'ERR_INVALID_KEY_SIZE',
  ERR_KEY_NOT_FOUND = 'ERR_KEY_NOT_FOUND',
  ERR_OLD_KEY_NAME_INVALID = 'ERR_OLD_KEY_NAME_INVALID',
  ERR_NEW_KEY_NAME_INVALID = 'ERR_NEW_KEY_NAME_INVALID',
  ERR_PASSWORD_REQUIRED = 'ERR_PASSWORD_REQUIRED',
  ERR_PEM_REQUIRED = 'ERR_PEM_REQUIRED',
  ERR_CANNOT_READ_KEY = 'ERR_CANNOT_READ_KEY',
  ERR_MISSING_PRIVATE_KEY = 'ERR_MISSING_PRIVATE_KEY',
  ERR_MISSING_PUBLIC_KEY = 'ERR_MISSING_PUBLIC_KEY',
  ERR_INVALID_OLD_PASS_TYPE = 'ERR_INVALID_OLD_PASS_TYPE',
  ERR_INVALID_NEW_PASS_TYPE = 'ERR_INVALID_NEW_PASS_TYPE',
  ERR_INVALID_PASS_LENGTH = 'ERR_INVALID_PASS_LENGTH',
  ERR_NOT_IMPLEMENTED = 'ERR_NOT_IMPLEMENTED',
  ERR_WRONG_PING_ACK = 'ERR_WRONG_PING_ACK',
  ERR_INVALID_RECORD = 'ERR_INVALID_RECORD',
  ERR_ALREADY_SUCCEEDED = 'ERR_ALREADY_SUCCEEDED',
  ERR_NO_HANDLER_FOR_PROTOCOL = 'ERR_NO_HANDLER_FOR_PROTOCOL',
  ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS = 'ERR_TOO_MANY_OUTBOUND_PROTOCOL_STREAMS',
  ERR_TOO_MANY_INBOUND_PROTOCOL_STREAMS = 'ERR_TOO_MANY_INBOUND_PROTOCOL_STREAMS',
  ERR_CONNECTION_DENIED = 'ERR_CONNECTION_DENIED',
  ERR_TRANSFER_LIMIT_EXCEEDED = 'ERR_TRANSFER_LIMIT_EXCEEDED',
}
