export const IROH_REACH_VERSION = 4 as const;
export const MAX_RELAY_URLS = 8;
export const MAX_RELAY_URL_BYTES = 512;
const CANONICAL_ENDPOINT_ID = /^[0-9a-f]{64}$/;

export interface IrohReach {
  endpointId: string;
  relays: readonly string[];
  v: typeof IROH_REACH_VERSION;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export function assertIrohReach(reach: IrohReach): void {
  if (reach.v !== IROH_REACH_VERSION) {
    throw new Error(`Unsupported Iroh reach version ${String(reach.v)}`);
  }
  if (!CANONICAL_ENDPOINT_ID.test(reach.endpointId)) {
    throw new Error("Iroh reach endpointId must be a canonical 32-byte lowercase hex key");
  }
  if (reach.relays.length === 0 || reach.relays.length > MAX_RELAY_URLS) {
    throw new Error(`Iroh reach must contain 1-${MAX_RELAY_URLS} relay URLs`);
  }

  const seen = new Set<string>();
  for (const relay of reach.relays) {
    if (utf8Length(relay) > MAX_RELAY_URL_BYTES) {
      throw new Error(`Iroh relay URL exceeds ${MAX_RELAY_URL_BYTES} bytes`);
    }
    let parsed: URL;
    try {
      parsed = new URL(relay);
    } catch {
      throw new Error(`Invalid Iroh relay URL: ${relay}`);
    }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error(`Iroh relay URL must be credential-free HTTPS: ${relay}`);
    }
    if (parsed.toString() !== relay) {
      throw new Error(`Iroh relay URL is not canonical: ${relay}`);
    }
    if (seen.has(relay)) throw new Error(`Duplicate Iroh relay URL: ${relay}`);
    seen.add(relay);
  }
}
