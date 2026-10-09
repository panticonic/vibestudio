/**
 * Wire envelopes for the host ↔ extension RPC bridge.
 *
 * Bytes cross the bridge natively as `Uint8Array` (the RPC wire codec carries
 * them). Fetch bodies too large to inline are exposed as pull streams named by
 * a {@link StreamEnvelope}. Keep this module free of node/browser-specific
 * imports — both sides import the same types.
 */

export interface StreamEnvelope {
  __stream: true;
  id: string;
}

export type BodyEnvelope = Uint8Array | StreamEnvelope;

export interface StreamChunkEnvelope {
  done: boolean;
  chunk?: Uint8Array;
}

export function isStreamEnvelope(value: unknown): value is StreamEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { __stream?: unknown }).__stream === true &&
    typeof (value as { id?: unknown }).id === "string"
  );
}
