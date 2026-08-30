import type { Connection, Endpoint, EndpointAddr, SecretKey } from "@number0/iroh";
import { loadIrohNodeBinding } from "./nodeBinding.js";
import { VIBESTUDIO_IROH_ALPN } from "./alpn.js";

export { VIBESTUDIO_IROH_ALPN, VIBESTUDIO_IROH_ALPN_TEXT } from "./alpn.js";
/**
 * QUIC's MAX_STREAMS value is a replenishing flow-control window, not a cap on
 * the number of streams a connection may carry over its lifetime. Do not use
 * RFC 9000's 2^60 encoding maximum here: native QUIC implementations are free
 * to size stream bookkeeping from the advertised window, and Electron's
 * allocator terminates the process when that theoretical value reaches it.
 *
 * 32K simultaneously open request streams preserves the transport headroom
 * already proven by Vibestudio's native fan-out coverage while keeping the
 * advertised resource contract finite. Closed streams continuously replenish
 * the window. Logical sessions and RPC requests have no product scheduler;
 * their separate, much higher process-memory ceilings are catastrophic guards.
 */
export const IROH_CONCURRENT_BI_STREAM_WINDOW = 32_768n;

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
  connection.setMaxConcurrentBiStreams(IROH_CONCURRENT_BI_STREAM_WINDOW);
  connection.setMaxConcurrentUniStreams(0n);
}
