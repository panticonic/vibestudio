import type { Duplex } from "node:stream";

export type SocketBridgeSide = "client" | "upstream";

export interface SocketBridgeEvent {
  side: SocketBridgeSide;
  error?: unknown;
}

export interface SocketBridgeOptions {
  onError?(event: Required<SocketBridgeEvent>): void;
  onClose?(event: SocketBridgeEvent): void;
}

/**
 * Bidirectionally pipe two already-negotiated sockets and consume all socket
 * errors so a late TLS/TCP failure tears down only this bridge, not the process.
 */
export function bridgeDuplexSockets(
  clientSocket: Duplex,
  upstreamSocket: Duplex,
  options: SocketBridgeOptions = {}
): () => void {
  let disposed = false;
  let clientClosed = clientSocket.destroyed;
  let upstreamClosed = upstreamSocket.destroyed;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clientSocket.off("error", onClientError);
    clientSocket.off("close", onClientClose);
    upstreamSocket.off("error", onUpstreamError);
    upstreamSocket.off("close", onUpstreamClose);
  };

  const disposeIfClosed = () => {
    if (clientClosed && upstreamClosed) dispose();
  };

  const destroyClient = () => {
    if (!clientSocket.destroyed) clientSocket.destroy();
  };
  const destroyUpstream = () => {
    if (!upstreamSocket.destroyed) upstreamSocket.destroy();
  };

  function onClientError(error: unknown): void {
    options.onError?.({ side: "client", error });
    destroyUpstream();
  }

  function onUpstreamError(error: unknown): void {
    options.onError?.({ side: "upstream", error });
    destroyClient();
  }

  function onClientClose(): void {
    clientClosed = true;
    options.onClose?.({ side: "client" });
    destroyUpstream();
    disposeIfClosed();
  }

  function onUpstreamClose(): void {
    upstreamClosed = true;
    options.onClose?.({ side: "upstream" });
    destroyClient();
    disposeIfClosed();
  }

  clientSocket.on("error", onClientError);
  clientSocket.on("close", onClientClose);
  upstreamSocket.on("error", onUpstreamError);
  upstreamSocket.on("close", onUpstreamClose);

  clientSocket.pipe(upstreamSocket);
  upstreamSocket.pipe(clientSocket);

  return dispose;
}
