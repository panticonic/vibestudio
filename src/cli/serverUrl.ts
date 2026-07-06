/**
 * CLI-facing server URL normalization.
 *
 * The canonical stored/env form is the HTTP(S) server base URL accepted by
 * RpcClient. Older context markers and Claude launch profiles used the concrete
 * RPC websocket endpoint (`ws(s)://.../rpc`); accept that shape at the boundary
 * so existing profiles keep working.
 */

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function transportNormalizedUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  url.hash = "";
  url.search = "";
  return url;
}

function stripRpcEndpointPath(pathname: string): string {
  if (pathname === "/rpc") return "/";
  if (!pathname.endsWith("/rpc")) return pathname;
  const withoutSuffix = pathname.slice(0, -"/rpc".length) || "/";
  // `/_workspace/rpc` is a valid selected-workspace base URL for a workspace
  // named "rpc"; its RPC endpoint is `/_workspace/rpc/rpc`.
  if (withoutSuffix === "/_workspace") return pathname;
  return withoutSuffix;
}

/** Normalize a known server/RPC endpoint value into RpcClient's HTTP base URL. */
export function normalizeServerBaseUrl(raw: string): string {
  const url = transportNormalizedUrl(raw);
  url.pathname = stripRpcEndpointPath(url.pathname);
  return stripTrailingSlash(url.toString());
}

/** Transport-normalized exact URL, preserving the path for canonical comparisons. */
function normalizeServerUrlForExactMatch(raw: string): string {
  return stripTrailingSlash(transportNormalizedUrl(raw).toString());
}

/**
 * Compare a marker/session URL with a credential URL. Exact path matches win,
 * while legacy marker/profile RPC endpoints are also accepted against the
 * credential base URL.
 */
export function serverUrlsReferToSameBase(left: string, right: string): boolean {
  try {
    const exactLeft = normalizeServerUrlForExactMatch(left);
    const exactRight = normalizeServerUrlForExactMatch(right);
    if (exactLeft === exactRight) return true;
    const baseLeft = normalizeServerBaseUrl(left);
    const baseRight = normalizeServerBaseUrl(right);
    return baseLeft === exactRight || exactLeft === baseRight || baseLeft === baseRight;
  } catch {
    return left === right;
  }
}
