import type { EnvelopeRpcTransport, RpcEnvelope } from "../types.js";
import {
  bridgeStreamSurfaceOf,
  openBridgeStream,
  openBridgeUploadStream,
  type BridgeStreamShellSurface,
} from "../bridgeStream.js";

/** A host-supplied envelope channel, independent of panel globals or native APIs. */
export type EnvelopeBridge = Partial<BridgeStreamShellSurface> & {
  postEnvelope(envelope: RpcEnvelope): void | Promise<void>;
  onEnvelope(handler: (envelope: RpcEnvelope) => void): () => void;
  stream?: EnvelopeRpcTransport["stream"];
};

/**
 * The same bridge adapter serves installed panels and connected documents.
 * Authentication, admission, routing, and document lifetime belong to the host.
 * Constructing this adapter neither requests a connection nor performs RPC.
 */
export function bridgeTransport(bridge: EnvelopeBridge): EnvelopeRpcTransport {
  if (typeof bridge.postEnvelope !== "function" || typeof bridge.onEnvelope !== "function") {
    throw new Error("RPC envelope bridge is unavailable");
  }
  const transport: EnvelopeRpcTransport = {
    send: async (envelope) => {
      await bridge.postEnvelope(envelope);
    },
    onMessage: (handler) => bridge.onEnvelope(handler),
  };
  if (typeof bridge.stream === "function") transport.stream = bridge.stream.bind(bridge);
  const surface = bridgeStreamSurfaceOf(bridge);
  if (surface) {
    transport.stream = (envelope, signal, body) =>
      openBridgeStream(surface, envelope, signal ?? null, body ?? null);
    transport.streamBody = (envelope, signal, body) => {
      if (!body) return Promise.reject(new Error("Bridge upload requires a request body"));
      return openBridgeUploadStream(surface, envelope, signal ?? null, body);
    };
  }
  return transport;
}
