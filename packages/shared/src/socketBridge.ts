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
 * Own the EventEmitter error channel for the full lifetime of a raw socket.
 * Protocol-specific listeners may come and go while an upgraded connection is
 * negotiated or bridged; this guard prevents a reset in those handoff windows
 * from becoming an uncaught process-level error.
 */
export function consumeSocketErrorsUntilClose(socket: Duplex): () => void {
  const consumeError = () => undefined;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    socket.off("error", consumeError);
    socket.off("close", release);
  };
  socket.on("error", consumeError);
  socket.once("close", release);
  return release;
}

/**
 * Bidirectionally pipe two already-negotiated sockets and consume all socket
 * errors so a late TLS/TCP failure tears down only this bridge, not the process.
 * Clean EOF ends the peer's writable side through pipe(), preserving its
 * queued writes until finish. Abrupt destruction and errors destroy the peer;
 * listeners remain owned until both sockets actually close.
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

  const closePeer = (source: Duplex, peer: Duplex) => {
    if (peer.destroyed) return;
    if (source.readableEnded && source.writableFinished && !source.errored) {
      // Source close can precede destination finish. end() drains queued writes
      // before finish; the retained close listener still owns the socket.
      // destroy() here would discard a buffered final frame or TCP close reply.
      if (!peer.writableEnded) peer.end();
      // The closed destination removes the reverse pipe's data listener. Keep
      // consuming that remaining readable half so its real EOF can close it.
      peer.resume();
    } else {
      peer.destroy();
    }
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
    closePeer(clientSocket, upstreamSocket);
    disposeIfClosed();
  }

  function onUpstreamClose(): void {
    upstreamClosed = true;
    options.onClose?.({ side: "upstream" });
    closePeer(upstreamSocket, clientSocket);
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
