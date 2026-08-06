import type { CallerKind, EnvelopeRpcTransport, RpcMessage } from "./types.js";

type AnyHandler = (sourceId: string, message: RpcMessage, callerKind?: CallerKind) => void;
type SourceHandler = (message: RpcMessage) => void;

export function createHandlerRegistry(options?: { context?: string }) {
  const anyHandlers = new Set<AnyHandler>();
  const sourceHandlers = new Map<string, Set<SourceHandler>>();

  const contextPrefix = options?.context ? `${options.context} ` : "";

  const deliver = (sourceId: string, message: RpcMessage, callerKind?: CallerKind) => {
    for (const handler of anyHandlers) {
      try {
        handler(sourceId, message, callerKind);
      } catch (error) {
        console.error(`Error in ${contextPrefix}RPC onAnyMessage handler:`, error);
      }
    }

    const handlers = sourceHandlers.get(sourceId);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(message);
      } catch (error) {
        console.error(`Error in ${contextPrefix}RPC onMessage handler:`, error);
      }
    }
  };

  const onMessage = (sourceId: string, handler: (message: RpcMessage) => void): (() => void) => {
    let handlers = sourceHandlers.get(sourceId);
    if (!handlers) {
      handlers = new Set();
      sourceHandlers.set(sourceId, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) {
        sourceHandlers.delete(sourceId);
      }
    };
  };

  const onAnyMessage = (handler: AnyHandler): (() => void) => {
    anyHandlers.add(handler);
    return () => {
      anyHandlers.delete(handler);
    };
  };

  return { deliver, onMessage, onAnyMessage };
}

/**
 * Restrict an RPC transport to initiating calls and streams. Responses, events,
 * and stream frames still reach the client using the wrapper, but requests are
 * left exclusively to the real endpoint that shares the underlying transport.
 */
export function createRpcInitiatorTransport(transport: EnvelopeRpcTransport): EnvelopeRpcTransport {
  return {
    send: (envelope, signal) => transport.send(envelope, signal),
    onMessage: (handler) =>
      transport.onMessage((envelope) => {
        const type = envelope.message.type;
        if (type === "request" || type === "stream-request") return;
        handler(envelope);
      }),
    ...(transport.status ? { status: () => transport.status!() } : {}),
    ...(transport.ready ? { ready: () => transport.ready!() } : {}),
    ...(transport.onStatusChange
      ? { onStatusChange: (handler) => transport.onStatusChange!(handler) }
      : {}),
    ...(transport.stream
      ? {
          stream: (envelope, signal, body, headTimeoutMs) =>
            transport.stream!(envelope, signal, body, headTimeoutMs),
        }
      : {}),
    ...(transport.streamReadable
      ? {
          streamReadable: (envelope, signal, body, headTimeoutMs) =>
            transport.streamReadable!(envelope, signal, body, headTimeoutMs),
        }
      : {}),
    ...(transport.streamBody
      ? {
          streamBody: (envelope, signal, body) => transport.streamBody!(envelope, signal, body),
        }
      : {}),
  };
}
