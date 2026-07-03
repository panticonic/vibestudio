/**
 * Panel-origin gateway path policy — the allowlist of gateway paths reachable
 * from the panel/loopback origin.
 *
 * The panel-asset façades (desktop `src/main/panelAssetFacade.ts`, mobile
 * `workspace/apps/mobile/src/services/panelAssetFacade.ts`) and the panel
 * runtime's `gatewayFetch` all tunnel webview-originated requests to the
 * server's `gateway.fetch` RPC (`src/server/services/gatewayFetchService.ts`),
 * which re-issues them against the server's OWN loopback gateway. That gateway
 * namespace also contains MANAGEMENT surfaces that a panel must never reach:
 *
 *  - `/_r/s/<service>/…`  — service HTTP routes (auth issue-device, workspaces,
 *    webhook ingress, credential OAuth callbacks, …)
 *  - `/rpc`, `/rpc/stream` — the in-process RPC plane
 *  - `/_w/`, `/_u/`, `/_workercode/`, `/_workerversion/`, `/_docode/`,
 *    `/_doversion/` — workerd/DO loader + dispatch internals (secret-gated)
 *  - `/_r/ext/…` — extension fetch surface (bearer-gated, server-side callers)
 *
 * Panels hold no privileged bearer (grant tokens ride the shell bridge, not
 * HTTP), so today downstream route auth would reject them anyway — but this
 * allowlist is DEFENSE IN DEPTH at the authoritative choke point: the panel
 * origin must never be able to address a management route at all, even if a
 * downstream route's auth regresses or a new loopback-trusting route is added.
 *
 * What panels legitimately need (and all this policy admits):
 *  - panel HTML/bundle assets: `/{source0}/{source1}/…` served by
 *    PanelHttpServer (`buildPanelUrl` → `/apps/shell/?contextId=…`), plus its
 *    index page, favicons, and runtime helpers (`/__loader.js`,
 *    `/__transport.js`)
 *  - `/_r/w/<source>/…` — workspace-declared worker HTTP routes (the panel
 *    runtime's `gatewayFetch` exists for these)
 *  - `/_a/<build-key>/…` — approved workspace app artifacts (Electron-hosted
 *    app webviews load these through the façade in remote mode)
 */

/** Exact pathnames allowed that would otherwise be denied by the namespace
 * rule below (reserved-looking, but served by PanelHttpServer). */
export const PANEL_GATEWAY_EXACT_PATHS: ReadonlySet<string> = new Set([
  "/", // PanelHttpServer index page
  "/index.html", // same index page
  "/__loader.js", // panel config loader (PanelHttpServer.serveRuntimeHelper)
  "/__transport.js", // browser RPC transport helper
]);

/** Reserved-namespace prefixes panels DO legitimately need. */
export const PANEL_GATEWAY_PATH_PREFIXES: readonly string[] = [
  "/_r/w/", // worker HTTP routes declared by workspace code (routeRegistry)
  "/_a/", // approved workspace app artifacts (Electron-hosted app webviews)
];

/**
 * First path segments that live OUTSIDE the underscore-reserved namespace but
 * are still gateway surfaces, not panel assets.
 */
const DENIED_FIRST_SEGMENTS: ReadonlySet<string> = new Set([
  "rpc", // /rpc + /rpc/stream — in-process RPC plane
  "healthz", // liveness / (admin-bearer-gated) detailed status
]);

/**
 * Is this NORMALIZED pathname (no query/hash, dot-segments resolved — i.e. a
 * WHATWG `URL.pathname`) reachable from the panel origin?
 *
 * Everything not starting with `_` (and not an explicitly denied segment) is
 * the gateway's catch-all → PanelHttpServer panel-asset namespace, which is
 * exactly what the façades exist to serve.
 */
export function isPanelReachableGatewayPathname(pathname: string): boolean {
  if (PANEL_GATEWAY_EXACT_PATHS.has(pathname)) return true;
  for (const prefix of PANEL_GATEWAY_PATH_PREFIXES) {
    if (pathname.startsWith(prefix)) return true;
  }
  const firstSegment = pathname.split("/", 2)[1] ?? "";
  if (firstSegment.length === 0) return false;
  // Every reserved gateway namespace starts with "_" (/_r, /_a, /_w, /_u,
  // /_workercode, /_docode, …); only the two prefixes above are panel-facing.
  if (firstSegment.startsWith("_")) return false;
  if (DENIED_FIRST_SEGMENTS.has(firstSegment)) return false;
  return true;
}

// Dummy base for origin-independent path resolution. WHATWG URL resolution of
// an origin-form path does not depend on the base host, but the base must be a
// SPECIAL scheme (http) so backslash/dot-segment handling matches what
// `fetch()` will actually send to the gateway.
const PARSE_BASE = "http://panel-gateway.invalid";

export type PanelGatewayPathDecision =
  | {
      allowed: true;
      /** Normalized `pathname?query` to re-issue against the gateway. Using
       * this (not the raw input) guarantees the checked path and the fetched
       * path are the same string. */
      target: string;
    }
  | {
      allowed: false;
      /** `malformed` — not a well-formed origin-relative gateway path;
       * `policy` — well-formed but outside the panel-reachable allowlist. */
      denied: "malformed" | "policy";
      reason: string;
    };

/**
 * Validate a raw panel-origin request path against the panel gateway policy.
 * Handles origin escapes (`http://…`, `//host`, `/\host`) and dot-segment
 * normalization identically to `fetch()`'s own URL parsing.
 */
export function checkPanelGatewayPath(rawPath: string): PanelGatewayPathDecision {
  if (!rawPath.startsWith("/")) {
    return {
      allowed: false,
      denied: "malformed",
      reason: `path must be absolute (start with "/"): ${rawPath}`,
    };
  }
  let url: URL;
  try {
    url = new URL(rawPath, PARSE_BASE);
  } catch {
    return { allowed: false, denied: "malformed", reason: `path is not parseable: ${rawPath}` };
  }
  if (url.origin !== PARSE_BASE) {
    // e.g. "/\evil.example/x" or "//evil.example/x" — resolves off-origin.
    return {
      allowed: false,
      denied: "malformed",
      reason: `path escapes the gateway origin: ${rawPath}`,
    };
  }
  if (!isPanelReachableGatewayPathname(url.pathname)) {
    return {
      allowed: false,
      denied: "policy",
      reason:
        `path is not panel-reachable: ${url.pathname} — the panel origin may only ` +
        `address panel assets, /_r/w/ worker routes, and /_a/ app artifacts ` +
        `(management routes like /_r/s/ and /rpc are never proxied)`,
    };
  }
  return { allowed: true, target: `${url.pathname}${url.search}` };
}
