import {
  IROH_REACH_VERSION,
  PAIRING_CODE_PATTERN,
  createConnectDeepLink,
  createConnectLink,
  createConnectPairUrl,
  parseConnectLink,
  type ConnectLink,
  type ConnectPairing,
  type IrohReach,
} from "@vibestudio/iroh-transport";

export {
  PAIRING_CODE_PATTERN,
  createConnectDeepLink,
  createConnectLink,
  createConnectPairUrl,
  parseConnectLink,
};
export type { ConnectLink, ConnectPairing };
export type ReconnectReach = IrohReach;
export const PAIRING_PROTOCOL_VERSION = IROH_REACH_VERSION;
export const CONNECT_DEEP_LINK_SCHEME = "vibestudio:";
export const CONNECT_DEEP_LINK_HOST = "connect";
export const PAIR_LINK_ORIGIN = "https://vibestudio.app";
export const PAIR_LINK_PATH = "/p";
export const WORKSPACE_ROUTE_PREFIX = "/_workspace/";

export function connectPairingFromLink(link: { kind: "ok" } & ConnectPairing): ConnectPairing {
  const { kind: _kind, ...pairing } = link;
  return pairing;
}

export function appendServerPath(baseUrl: string | URL, suffix: string): URL {
  const url = new URL(baseUrl.toString());
  const basePath = url.pathname.replace(/\/+$/, "");
  const nextPath = suffix.replace(/^\/+/, "");
  url.pathname = nextPath ? `${basePath}/${nextPath}` : basePath || "/";
  url.search = "";
  url.hash = "";
  return url;
}

// These take a BASE server URL (an origin, or a /_workspace/<name> selected-workspace URL) and
// append the canonical RPC path — the same contract as serverAuthRouteUrl.
// Never pass an already-suffixed URL; there is deliberately no idempotency, so a workspace literally
// named "rpc" (URL .../_workspace/rpc) is handled correctly instead of colliding with the suffix.
export function serverRpcHttpUrl(baseUrl: string | URL): URL {
  return appendServerPath(baseUrl, "/rpc");
}

export function serverRpcStreamHttpUrl(baseUrl: string | URL): URL {
  return appendServerPath(baseUrl, "/rpc/stream");
}

export function serverRpcWsUrl(baseUrl: string | URL): string {
  const url = serverRpcHttpUrl(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export function serverCdpHostWsUrl(baseUrl: string | URL, hostConnectionId: string): string {
  const url = appendServerPath(baseUrl, "/api/cdp-host");
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("hostConnectionId", hostConnectionId);
  return url.toString();
}

export function serverAuthRouteUrl(baseUrl: string | URL, route: string): URL {
  return appendServerPath(baseUrl, `/_r/s/auth/${route.replace(/^\/+/, "")}`);
}

export function selectedWorkspacePath(workspaceName: string): string {
  return `${WORKSPACE_ROUTE_PREFIX}${encodeURIComponent(workspaceName)}`;
}

export function selectedWorkspaceUrl(baseUrl: string | URL, workspaceName: string): URL {
  return appendServerPath(baseUrl, selectedWorkspacePath(workspaceName));
}

export function selectedWorkspaceNameFromUrl(rawUrl: string | URL): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl.toString());
  } catch {
    return null;
  }
  const pathname = url.pathname.replace(/\/+$/, "");
  const match = pathname.match(/^\/_workspace\/([^/]+)$/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function isSelectedWorkspaceUrl(rawUrl: string | URL): boolean {
  return selectedWorkspaceNameFromUrl(rawUrl) !== null;
}

export function isLoopbackHost(host: string): boolean {
  const lower = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (lower === "localhost" || lower === "10.0.2.2") return true;
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") return true;
  // 127.0.0.0/8
  if (/^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(lower)) return true;
  return false;
}
