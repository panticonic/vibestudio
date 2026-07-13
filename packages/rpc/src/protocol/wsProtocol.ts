import type { CallerKind, RpcEnvelope, RpcErrorKind } from "../types.js";

export type ClientPlatform = "desktop" | "headless" | "mobile";

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

export type WsClientMessage = WsAuthMessage | WsRpcMessage | WsToolResultMessage | WsRouteMessage;

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
  deviceCredential?: { deviceId: string; refreshToken: string };
  error?: string;
}

export interface WsAuthSuccessResultMessage extends WsAuthResultBase {
  success: true;
  /** Server's end-to-end contract; clients reject missing or mismatched values. */
  contractVersion: number;
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

export interface WsEventMessage {
  type: "ws:event";
  event: string;
  payload: unknown;
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
}

export type WsServerMessage =
  | WsAuthResultMessage
  | WsRpcResponseMessage
  | WsEventMessage
  | WsRoutedMessage
  | WsRoutedEventErrorMessage
  | WsRoutedResponseErrorMessage;
