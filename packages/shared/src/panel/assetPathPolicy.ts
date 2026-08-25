import { sha256HexSyncText } from "@vibestudio/content-addressing";

/**
 * Panel-origin gateway path policy — the allowlist of gateway paths reachable
 * from the panel/loopback origin.
 *
 * The panel-asset façades in each client host and the panel runtime's
 * `gatewayFetch` all tunnel webview-originated requests to the
 * server's `gateway.fetch` RPC (`src/server/services/gatewayFetchService.ts`),
 * which re-issues them against the server's OWN loopback gateway. That gateway
 * namespace also contains MANAGEMENT surfaces that a panel must never reach:
 *
 *  - `/_r/s/<service>/…`  — service HTTP routes (device refresh, workspace
 *    routing, webhook ingress, credential OAuth callbacks, …)
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
 *    `/__transport.js`) and content-addressed shared styles
 *    (`/__vibestudio/shared-style/<sha256>.css`) and panel build artifacts
 *    (`/__vibestudio/panel-build/<sha256>/…`)
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
  "/__vibestudio/unit-icon", // immutable, build-owned unit icon assets
]);

/** Reserved-namespace prefixes panels DO legitimately need. */
export const PANEL_GATEWAY_PATH_PREFIXES: readonly string[] = [
  "/_r/w/", // worker HTTP routes declared by workspace code (routeRegistry)
  "/_a/", // approved workspace app artifacts (Electron-hosted app webviews)
];

const PANEL_SHARED_STYLE_PATH = /^\/__vibestudio\/shared-style\/[0-9a-f]{64}\.css$/u;
const PANEL_BUILD_ASSET_PATH = /^\/__vibestudio\/panel-build\/[0-9a-f]{64}\/[^/].*$/u;

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
  if (PANEL_SHARED_STYLE_PATH.test(pathname)) return true;
  if (PANEL_BUILD_ASSET_PATH.test(pathname)) return true;
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

const VERSIONED_UNIT_ICON_PATH = /^\/__vibestudio\/unit-icon\?(?:.*&)?v=[0-9a-f]{8,64}(?:&|$)/u;
const VERSIONED_RUNTIME_HELPER_PATH = /\/(?:__loader|__transport)\.js$/u;
const PANEL_BUILD_KEY = /^[0-9a-f]{64}$/u;
const PINNED_ENTRY_REPRESENTATION = /^\/.*\/\?buildKey=[0-9a-f]{64}$/u;

/**
 * Return the representation key used by every panel-asset facade.
 *
 * A build-pinned entry document is a pure function of its panel source and
 * build key. Per-panel launch query parameters (`contextId` and `ref`) select
 * runtime state but do not alter the HTML body, so retaining them would split
 * one immutable representation into a cache entry per launch. Unpinned entry
 * documents and all subresources retain their complete normalized target.
 */
export function panelAssetRepresentationPath(rawPath: string): string {
  let url: URL;
  try {
    url = new URL(rawPath, PARSE_BASE);
  } catch {
    return rawPath;
  }
  if (url.origin !== PARSE_BASE) return rawPath;

  const buildKey = url.searchParams.get("buildKey");
  if (!buildKey || !PANEL_BUILD_KEY.test(buildKey)) {
    return `${url.pathname}${url.search}`;
  }

  let source: string | null = null;
  if (url.pathname.endsWith("/")) {
    source = url.pathname;
  } else if (url.pathname.endsWith("/index.html")) {
    source = url.pathname.slice(0, -"index.html".length);
  }
  return source ? `${source}?buildKey=${buildKey}` : `${url.pathname}${url.search}`;
}

/**
 * Shared cache-key contract for the desktop and mobile panel origins.
 * Forwarded headers remain part of the representation identity; spelling and
 * insertion order do not.
 */
export function panelAssetCacheKey(
  rawPath: string,
  forwardHeaders: Readonly<Record<string, string>>
): string {
  const representationPath = panelAssetRepresentationPath(rawPath);
  // A pinned entry document is defined above as a pure function of source and
  // build key. Request metadata cannot select different bytes for that
  // content-addressed identity, so credential rotation, WebView revalidation,
  // or UA changes must not fragment it across app/server restarts.
  if (PINNED_ENTRY_REPRESENTATION.test(representationPath)) return representationPath;
  // A build subresource is content-addressed by construction: its path contains
  // the build key and its bytes never change. No FORWARDED header can select a
  // different representation for one — the only header that does is
  // `accept-encoding` (panelHttpServer.writeArtifact, which sets
  // `Vary: Accept-Encoding`), and that is deliberately not in
  // FORWARD_REQUEST_HEADERS; the facade always asks for gzip. Range and
  // conditional requests answer non-200 and are never cacheable.
  //
  // Keying them by header digest therefore bought nothing and cost twice: the
  // same immutable chunk was stored once per `accept` value the webview happened
  // to send (script, style, image all differ), and no key could be computed
  // ahead of a request — which makes prefetching them impossible, because the
  // key is only knowable once the fetch it was meant to avoid has occurred.
  if (PANEL_BUILD_ASSET_PATH.test(representationPath)) return representationPath;
  if (
    VERSIONED_RUNTIME_HELPER_PATH.test(representationPath.split("?", 1)[0] ?? "") &&
    /(?:^|[?&])v=[0-9a-f]{64}(?:&|$)/u.test(representationPath)
  ) {
    return representationPath;
  }
  // A unit icon carrying a `v` that names its content is immutable for the same
  // reason, and its whole point is to be storable — keying it by header digest
  // would split one glyph across every `accept` a client happens to send.
  if (VERSIONED_UNIT_ICON_PATH.test(representationPath)) return representationPath;
  const vary = Object.entries(forwardHeaders)
    // Authorization admits the request but does not select the immutable
    // representation. Workspace credentials are rotated when the server
    // restarts; including their opaque value turns every valid warm restart
    // into a cold cache. The loopback facade is already scoped to one server
    // and authoritative workspace and is not an authorization boundary.
    .filter(([name]) => name.toLowerCase() !== "authorization")
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (vary.length === 0) return representationPath;
  // Forwarded headers can contain bearer credentials. Preserve representation
  // separation without writing those values into the durable desktop index.
  const digest = sha256HexSyncText(JSON.stringify(vary)).slice(0, 24);
  return `${representationPath}#h=${digest}`;
}

/**
 * The `__vibestudio/unit-icon` target for a unit's declared icon, WITHOUT a
 * leading slash so each origin can prefix its own base (`../../` from a panel,
 * the loopback origin on mobile).
 *
 * One function because three clients built this URL by hand and the `version`
 * is the whole point: with it the route answers `immutable` and the icon is
 * fetched once ever; without it the route must answer `private, no-cache` and
 * every launcher render re-fetches every unit's icon. `icon` is the manifest's
 * declared value, so a `./`-relative one is the only kind this applies to.
 */
export function unitIconTarget(
  source: string,
  icon: string,
  version?: string,
  state?: string
): string | null {
  if (!icon.startsWith("./")) return null;
  const query = new URLSearchParams({ source, path: icon.slice(2) });
  if (version) query.set("v", version);
  if (state) query.set("s", state);
  return `__vibestudio/unit-icon?${query.toString()}`;
}

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
        `address panel assets and builds, content-addressed shared styles, ` +
        `/_r/w/ worker routes, and /_a/ app artifacts ` +
        `(management routes like /_r/s/ and /rpc are never proxied)`,
    };
  }
  return { allowed: true, target: `${url.pathname}${url.search}` };
}
