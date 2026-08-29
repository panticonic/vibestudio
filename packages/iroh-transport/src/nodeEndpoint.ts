import type { Connection, Endpoint, EndpointAddr, SecretKey } from "@number0/iroh";
import { loadIrohNodeBinding } from "./nodeBinding.js";
import { VIBESTUDIO_IROH_ALPN } from "./alpn.js";

export { VIBESTUDIO_IROH_ALPN, VIBESTUDIO_IROH_ALPN_TEXT } from "./alpn.js";
/**
 * Do not impose a product concurrency policy beneath RPC. QUIC already owns
 * stream lifetime and backpressure, and RFC 9000 permits at most 2^60 streams
 * of each type. Advertising the protocol maximum prevents normal application
 * fan-out from hitting an unrelated transport window. Resource protection for
 * unauthenticated/incomplete admissions remains at the ingress boundary.
 */
export const IROH_MAX_CONCURRENT_BI_STREAMS = 1n << 60n;

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
