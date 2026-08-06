import type { CallerKind, RpcEnvelope, RpcErrorKind } from "../types.js";

export type ClientPlatform = "desktop" | "headless" | "mobile";

/** Durable credential issued exactly once when a device pairing code is redeemed. */
export interface DeviceCredential {
  deviceId: string;
  refreshToken: string;
}

/** Target selected by the pairing invite that admitted the newly paired device. */
export interface PairingContext {
  workspaceId: string;
}

export interface ToolExecutionResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  data?: unknown;
}

export interface WsAuthMessage {
  type: "ws:auth";
  /** End-to-end RPC contract required by the server. */
  contractVersion: number;
  token: string;
  connectionId?: string;
  clientSessionId?: string;
  clientLabel?: string;
  clientPlatform?: ClientPlatform;
}

export interface WsRpcMessage {
  type: "ws:rpc";
  envelope: RpcEnvelope;
  /** The enclosed stream-request has a request body on the ordered WS wire. */
  streamBody?: true;
}

export interface WsToolResultMessage {
  type: "ws:tool-result";
  callId: string;
  result: ToolExecutionResult;
}

export interface WsRouteMessage {
  type: "ws:route";
  envelope: RpcEnvelope;
  targetConnectionId?: string;
}

export interface WsStreamBodyChunkMessage {
  type: "ws:stream-body-chunk";
  requestId: string;
  seq: number;
  payload?: string;
  done?: boolean;
  error?: string;
}

export type WsClientMessage =
  | WsAuthMessage
  | WsRpcMessage
  | WsToolResultMessage
  | WsRouteMessage
  | WsStreamBodyChunkMessage;

export const WS_STREAM_REQUEST_BODY_CAPABILITY = "stream-request-body-v1" as const;
export type WsTransportCapability = typeof WS_STREAM_REQUEST_BODY_CAPABILITY;

interface WsAuthResultBase {
  type: "ws:auth-result";
  callerId?: string;
  callerKind?: CallerKind | string;
  connectionId?: string;
  serverBootId?: string;
  sessionDirty?: boolean;
  /**
   * Present only when this session authenticated by redeeming a one-time pairing
   * code: the freshly issued device credential the client must persist to
   * reconnect (the server keeps only its hash, so this is the one delivery).
   */
  deviceCredential?: DeviceCredential;
  /** Present with a freshly issued credential; never repeated on refresh auth. */
  pairingContext?: PairingContext;
  error?: string;
}

export interface WsAuthSuccessResultMessage extends WsAuthResultBase {
  success: true;
  /** Server's end-to-end contract; clients reject missing or mismatched values. */
  contractVersion: number;
  /** Additive transport features this server can safely receive. */
  transportCapabilities?: WsTransportCapability[];
}

export interface WsAuthFailureResultMessage extends WsAuthResultBase {
  success: false;
  /** Included by compatibility failures when the server can identify its contract. */
  contractVersion?: number;
}

export type WsAuthResultMessage = WsAuthSuccessResultMessage | WsAuthFailureResultMessage;

export interface WsRpcResponseMessage {
  type: "ws:rpc";
  envelope: RpcEnvelope;
}

export interface WsRoutedMessage {
  type: "ws:routed";
  envelope: RpcEnvelope;
}

export interface WsRoutedEventErrorMessage {
  type: "ws:routed-event-error";
  targetId: string;
  event: string;
  error: string;
  errorKind: RpcErrorKind;
  errorCode?: string;
}

export interface WsRoutedResponseErrorMessage {
  type: "ws:routed-response-error";
  targetId: string;
  requestId: string;
  error: string;
  errorKind: RpcErrorKind;
  errorCode?: string;
  errorData?: unknown;
}

export interface WsStreamBodyAckMessage {
  type: "ws:stream-body-ack";
  requestId: string;
  seq: number;
  error?: string;
}

export type WsServerMessage =
  | WsAuthResultMessage
  | WsRpcResponseMessage
  | WsRoutedMessage
  | WsRoutedEventErrorMessage
  | WsRoutedResponseErrorMessage
  | WsStreamBodyAckMessage;
