import { wsClientTransport, type WsClientTransportConfig } from "@vibestudio/rpc/transports/wsClient";
import { serverRpcWsUrl } from "@vibestudio/shared/connect";

export interface ServerWsTransportConfig extends Omit<WsClientTransportConfig, "getWsUrl"> {
  /**
   * HTTP(S) server base URL. May already point at a selected workspace, e.g.
   * https://host/_workspace/dev; the shared helper appends /rpc in-place.
   */
  serverUrl: string | URL | (() => string | URL);
}

export function createServerWsTransport(config: ServerWsTransportConfig) {
  const { serverUrl, ...rest } = config;
  return wsClientTransport({
    ...rest,
    getWsUrl: () => serverRpcWsUrl(typeof serverUrl === "function" ? serverUrl() : serverUrl),
  });
}
