import type {
  BridgeBodyChunk,
  BridgeStreamMessage,
  BridgeStreamOpen,
  RpcEnvelope,
  RpcFailure,
} from "@vibestudio/rpc";

/**
 * The wire between one renderer document and the connection process.
 *
 * Main creates a `MessageChannelMain` per document, hands one end to the
 * connection process and the other to the document's preload, and never sees
 * the traffic. Everything a renderer used to send over `vibestudio:rpc:*` IPC
 * travels here instead, one `MessagePort` per document.
 */

/** Renderer to connection process. */
export type RendererToHost =
  /** One RPC envelope. */
  | { t: "send"; envelope: RpcEnvelope }
  /** Open a bridge stream. Answered by a `reply` with the same `id`. */
  | { t: "stream-open"; id: number; message: BridgeStreamOpen }
  /** One request-body message of a bridge stream. Answered by a `reply`. */
  | { t: "stream-body"; id: number; message: BridgeBodyChunk }
  | { t: "stream-abort"; opId: string }
  | { t: "stream-ack"; opId: string; seq: number };

/** Connection process to renderer. */
export type HostToRenderer =
  | { t: "message"; envelope: RpcEnvelope }
  | { t: "stream-message"; message: BridgeStreamMessage }
  | { t: "reply"; id: number; error?: RpcFailure }
  /** The host ended this document's session; nothing further arrives on the port. */
  | { t: "closed"; reason: string };

/** What main posts to a renderer frame that asked for its port. */
export interface RpcPortGrant {
  /** Present instead of a port when main refused the request. */
  error?: string;
}

/** The IPC channels of the port handshake (the only RPC-related traffic main sees). */
export const RPC_PORT_REQUEST_CHANNEL = "vibestudio:rpc:open-port";
export const RPC_PORT_GRANT_CHANNEL = "vibestudio:rpc:port";
/** Main to renderer: the connection process ended; the reason is its exit. */
export const RPC_PORT_LOST_CHANNEL = "vibestudio:rpc:port-lost";
