import type { Connection, Endpoint, EndpointAddr, SecretKey } from "@number0/iroh";
import { loadIrohNodeBinding } from "./nodeBinding.js";
import { VIBESTUDIO_IROH_ALPN } from "./alpn.js";
import { MAX_ACTIVE_REQUESTS_PER_SESSION, MAX_LOGICAL_SESSIONS_PER_CONNECTION } from "./wire.js";

export { VIBESTUDIO_IROH_ALPN, VIBESTUDIO_IROH_ALPN_TEXT } from "./alpn.js";
/**
 * QUIC stream IDs are transport headroom, not the application admission
 * mechanism. A connection carries at most 64 logical sessions, each of which
 * admits at most MAX_ACTIVE_REQUESTS_PER_SESSION active requests. Twice that
 * aggregate leaves room for control, one-shot envelopes, cancellation races,
 * and response retirement without making normal work wait on a transport ID.
 * Slow headers and retained requests have their own tighter application bounds.
 */
export const IROH_MAX_CONCURRENT_BI_STREAMS =
  2n * BigInt(MAX_LOGICAL_SESSIONS_PER_CONNECTION) * BigInt(MAX_ACTIVE_REQUESTS_PER_SESSION);

export interface BindNodeEndpointOptions {
  secretKey: SecretKey;
  relayUrls?: readonly string[];
  bindAddr?: string;
}

export async function bindNodeEndpoint(options: BindNodeEndpointOptions): Promise<Endpoint> {
  const { Endpoint, RelayMode } = loadIrohNodeBinding();
  const builder = Endpoint.builder();
  builder.applyMinimal();
  builder.secretKey(options.secretKey.toBytes());
  builder.alpns([[...VIBESTUDIO_IROH_ALPN]]);
  builder.relayMode(
    options.relayUrls?.length
      ? RelayMode.customFromUrls([...options.relayUrls])
      : RelayMode.disabled()
  );
  if (options.bindAddr) builder.bindAddr(options.bindAddr);
  return builder.bind();
}

export function endpointAddrForRelay(endpointId: string, relayUrl: string): EndpointAddr {
  const { EndpointAddr, EndpointId } = loadIrohNodeBinding();
  return new EndpointAddr(EndpointId.fromString(endpointId), relayUrl, []);
}

export async function connectNodeEndpoint(
  endpoint: Endpoint,
  address: EndpointAddr
): Promise<Connection> {
  const connection = await endpoint.connect(address, [...VIBESTUDIO_IROH_ALPN]);
  configureNodeConnection(connection);
  return connection;
}

export function configureNodeConnection(connection: Connection): void {
  connection.setMaxConcurrentBiStreams(IROH_MAX_CONCURRENT_BI_STREAMS);
  connection.setMaxConcurrentUniStreams(0n);
}
