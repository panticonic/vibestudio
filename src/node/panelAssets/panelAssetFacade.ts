/**
 * panelAssetFacade — loopback panel-asset server for REMOTE sessions.
 *
 * Panels always load from a fixed loopback origin
 * (`buildPanelUrl` → `http://127.0.0.1:{gatewayPort}/{source}/?contextId=…`).
 * In LOCAL mode that port is the child server's gateway. In REMOTE mode there
 * is no local gateway — the RPC plane rides the WebRTC pipe — so this façade
 * stands in for it: a tiny loopback HTTP server that proxies each request to
 * the remote server's own gateway via the `gateway.fetch` STREAMING RPC and
 * pipes the response body straight back to the webview. Streaming (not a
 * buffered base64 return) is mandatory: real panel bundles are multiple MB and
 * would exceed the WebRTC control-channel message-size limit; the bulk channel
 * chunks them.
 *
 * On top of that raw proxy the façade adds three cache layers (plan §6):
 *  - It requests `gzip: true` (parity with mobile) so multi-MB assets ride the
 *    pipe compressed; the gateway marks the body `x-vibestudio-content-gzip` and the
 *    façade re-derives `Content-Encoding: gzip` so the webview inflates natively
 *    (the façade never touches the bytes).
 *  - A content-addressed on-disk cache ({@link AssetDiskCache}) serves immutable
 *    artifacts from disk on a repeat request — zero pipe bytes. Build-pinned
 *    entry documents are immutable; unpinned developer entries remain
 *    `no-store`. The cache stores the body EXACTLY as
 *    received over the pipe (gzip-encoded for compressible immutable assets) and
 *    replays it verbatim with the re-derived `Content-Encoding` — the façade never
 *    inflates; the digest is over those received (encoded) bytes.
 *  - A stable loopback port persisted across launches, so the webview's own HTTP
 *    cache (keyed by origin = host:port) survives restarts instead of being
 *    busted by a fresh ephemeral port every launch.
 *
 * It is dependency-free (node `http`/`stream`/`fs` only), serves non-secret
 * panel assets, and binds 127.0.0.1 only. Panel RPC still rides the pipe (the
 * grant token reaches the panel out-of-band via the shell bridge), so this
 * socket carries no management surface and needs no per-request token.
 */

import * as http from "node:http";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { createDevLogger } from "@vibestudio/dev-log";
import type { RpcStreamOptions } from "@vibestudio/rpc";
import {
  FORWARD_REQUEST_HEADERS,
  STRIP_RESPONSE_HEADERS,
  GZIP_MARKER_HEADER,
} from "@vibestudio/shared/panel/assetHeaders";
import {
  checkPanelGatewayPath,
  panelAssetCacheKey,
} from "@vibestudio/shared/panel/assetPathPolicy";
import { createBlobBundleReader } from "@vibestudio/shared/panel/blobBundle";
import { AssetDiskCache, type FetchedResponse, type VerifiedCacheEntry } from "./assetDiskCache.js";

/** Minimal streaming seam shared by Electron and headless Node hosts. */
export interface PanelAssetStreamClient {
  stream(
    service: string,
    method: string,
    args?: unknown[],
    options?: Pick<RpcStreamOptions, "signal" | "headTimeoutMs" | "trafficClass">
  ): Promise<Response>;
}

const log = createDevLogger("PanelAssetFacade");

/**
 * GENEROUS fail-loud backstops (never tight enough to abort a slow-but-healthy
 * load). Without them an offline/unreachable server parks every panel asset
 * request forever (the RPC has no implicit deadline and reconnects are
 * unbounded) → a blank webview with no error. Two independent backstops:
 *
 *  - CONNECT: cap the time-to-first-response (the `gateway.fetch` stream call
 *    resolving at all). A dead pipe never returns a `Response`, so this is what
 *    unsticks the request and surfaces "can't reach your server — reconnecting".
 *  - STALL: once bytes are flowing, cap the gap between chunks — NOT the total
 *    duration. A multi-MB bundle over slow TURN keeps arming the timer on every
 *    chunk, so only a genuine no-progress stall trips it.
 */
const ASSET_CONNECT_BACKSTOP_MS = 60_000;
const ASSET_STALL_BACKSTOP_MS = 30_000;
const MAX_PREFETCH_MANIFEST_BYTES = 4 * 1024 * 1024;
const MAX_PREFETCH_TOTAL_BYTES = 128 * 1024 * 1024;
const SHA256_INTEGRITY = /^sha256-([0-9a-f]{64})$/u;

interface PrefetchManifestResource {
  path: string;
  contentType: string;
  integrity: string;
  initial?: boolean;
  version?: string;
}

interface PrefetchManifest {
  artifacts: PrefetchManifestResource[];
  runtimeHelpers?: PrefetchManifestResource[];
}

interface PinnedEntry {
  buildKey: string;
  sourceRoot: string;
}

/** Distinguishes a backstop/cancel abort from a generic pipe error (nicer copy). */
class AssetBackstopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetBackstopError";
  }
}

/**
 * Await the first response, but abort (and reject loud) if it never arrives
 * within the connect backstop — an offline server otherwise parks here forever.
 */
async function withConnectBackstop<T>(
  run: () => Promise<T>,
  controller: AbortController,
  reqPath: string,
  connectMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new AssetBackstopError(
          `no response from your server within ${connectMs / 1000}s for ${reqPath}`
        )
      );
    }, connectMs);
  });
  try {
    return await Promise.race([run(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Optional server-supplied content digest. The gateway serving panel artifacts
 * does not emit this today (see gatewayFetchService — artifacts are hashed at
 * build time but the hash isn't surfaced as a response header), so the façade
 * falls back to hashing immutable bodies on write. If a future change surfaces a
 * digest here, the cache prefers it (it is not forwarded to the webview).
 */
const CONTENT_DIGEST_HEADER = "x-vibestudio-content-digest";

export interface PanelAssetFacadeOptions {
  /**
   * Directory for persistent façade state (content-addressed asset cache under
   * `asset-cache/`, persisted loopback port in `port`). Omitted in unit tests →
   * cache disabled and an ephemeral port is used.
   */
  stateDir?: string;
  /**
   * Backstop windows (ms). Defaults are GENEROUS ({@link ASSET_CONNECT_BACKSTOP_MS}
   * / {@link ASSET_STALL_BACKSTOP_MS}); tests override them to small values to
   * exercise the offline-server path without a 30s wait.
   */
  connectBackstopMs?: number;
  stallBackstopMs?: number;
}

interface ResolvedBackstops {
  connectMs: number;
  stallMs: number;
}

function collectForwardHeaders(req: http.IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST_HEADERS) {
    // Every forwarded name is a single-value request header (IncomingHttpHeaders
    // types them `string | undefined`), so a plain string check is exhaustive.
    const value = req.headers[name];
    if (typeof value === "string") {
      headers[name] = value;
    }
  }
  return headers;
}

/** Turn the pipe `Response` into the façade's normalized, cache-agnostic shape. */
function normalizeResponse(response: Response): FetchedResponse {
  const gzip = response.headers.get(GZIP_MARKER_HEADER) === "1";
  const cacheControl = response.headers.get("cache-control") ?? "";
  const replayHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    // Drop hop headers (body is re-framed + re-sent), the internal gzip marker,
    // the internal digest header, and content-type (carried separately).
    if (STRIP_RESPONSE_HEADERS.has(lower)) return;
    if (lower === GZIP_MARKER_HEADER || lower === CONTENT_DIGEST_HEADER) return;
    if (lower === "content-type") return;
    replayHeaders[key] = value;
  });
  return {
    status: response.status,
    statusText: response.statusText,
    gzip,
    contentType: response.headers.get("content-type") ?? "application/octet-stream",
    replayHeaders,
    // Immutable artifacts (including build-pinned HTML entries) carry the
    // immutable marker. Unpinned developer entries remain `no-store`.
    cacheable: response.status === 200 && cacheControl.includes("immutable"),
    digest: response.headers.get(CONTENT_DIGEST_HEADER) ?? undefined,
    body: (response.body as ReadableStream<Uint8Array> | null) ?? null,
  };
}

function buildResponseHeaders(
  contentType: string,
  gzip: boolean,
  replayHeaders: Record<string, string>
): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": contentType, ...replayHeaders };
  // Marker → real Content-Encoding so the webview inflates natively (mirrors mobile).
  if (gzip) headers["Content-Encoding"] = "gzip";
  return headers;
}

/**
 * Start the loopback panel-asset façade. Resolves once the port is bound;
 * `buildPanelUrl` should then be pointed at the returned `port`.
 */
export async function startPanelAssetFacade(
  serverClient: PanelAssetStreamClient,
  options: PanelAssetFacadeOptions = {}
): Promise<{ port: number; close(): Promise<void> }> {
  let cache: AssetDiskCache | null = null;
  let portFile: string | undefined;
  if (options.stateDir) {
    fs.mkdirSync(options.stateDir, { recursive: true });
    portFile = path.join(options.stateDir, "port");
    cache = new AssetDiskCache({ dir: path.join(options.stateDir, "asset-cache") });
    await cache.init();
  }

  const backstops: ResolvedBackstops = {
    connectMs: options.connectBackstopMs ?? ASSET_CONNECT_BACKSTOP_MS,
    stallMs: options.stallBackstopMs ?? ASSET_STALL_BACKSTOP_MS,
  };
  const prefetchFlights = new Map<string, Promise<void>>();
  const prefetchedBuilds = new Set<string>();
  const prefetchLifetime = new AbortController();
  const server = http.createServer((req, res) => {
    void handleRequest(
      serverClient,
      cache,
      prefetchFlights,
      prefetchedBuilds,
      prefetchLifetime.signal,
      backstops,
      req,
      res
    );
  });

  const port = await listenWithStablePort(server, portFile);
  log.info(`Panel asset façade listening on http://127.0.0.1:${port}`);
  return {
    port,
    close: async () => {
      prefetchLifetime.abort();
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      });
      await Promise.allSettled(prefetchFlights.values());
      await cache?.close();
    },
  };
}

/**
 * Bind 127.0.0.1 on the persisted port if we have one and it's free; otherwise
 * bind an ephemeral port and persist it. A stable per-install port keeps the
 * webview HTTP cache (keyed by origin) warm across restarts. Loopback only.
 */
function listenWithStablePort(server: http.Server, portFile: string | undefined): Promise<number> {
  const preferred = readPersistedPort(portFile);

  const bind = (requested: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => reject(err);
      server.once("error", onError);
      server.listen(requested, "127.0.0.1", () => {
        server.removeListener("error", onError);
        const address = server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("Panel asset façade failed to bind a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });

  const persistIfNeeded = (bound: number, wasPreferred: boolean): number => {
    if (portFile && !wasPreferred) writePersistedPort(portFile, bound);
    return bound;
  };

  if (preferred !== null) {
    return bind(preferred)
      .then((bound) => persistIfNeeded(bound, true))
      .catch(() => bind(0).then((bound) => persistIfNeeded(bound, false)));
  }
  return bind(0).then((bound) => persistIfNeeded(bound, false));
}

function readPersistedPort(portFile: string | undefined): number | null {
  if (!portFile) return null;
  try {
    const raw = fs.readFileSync(portFile, "utf-8").trim();
    const port = Number.parseInt(raw, 10);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

function writePersistedPort(portFile: string, port: number): void {
  try {
    fs.writeFileSync(portFile, String(port));
  } catch (err) {
    log.warn(`Failed to persist façade port: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleRequest(
  serverClient: PanelAssetStreamClient,
  cache: AssetDiskCache | null,
  prefetchFlights: Map<string, Promise<void>>,
  prefetchedBuilds: Set<string>,
  prefetchLifetime: AbortSignal,
  backstops: ResolvedBackstops,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const reqPath = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();

  // This is an unauthenticated loopback asset origin, not an alternate gateway
  // or upload channel. Dynamic calls belong on the authenticated panel bridge.
  if (method !== "GET") {
    res.writeHead(405, {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "GET",
    });
    res.end("Method Not Allowed: the panel asset origin serves immutable GET content only");
    return;
  }

  // Mirror of the AUTHORITATIVE server-side allowlist in gatewayFetchService
  // (see @vibestudio/shared/panel/assetPathPolicy): reject non-panel-reachable
  // paths (management /_r/s/*, /rpc, workerd internals) here for a cheap,
  // clear 403 instead of a pipe round-trip + 502. The server enforces the
  // same policy regardless of this check.
  const decision = checkPanelGatewayPath(reqPath);
  if (!decision.allowed) {
    log.warn(`Panel asset request blocked: ${decision.reason}`);
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Blocked: not a panel-reachable gateway path");
    return;
  }
  const gatewayPath = decision.target;

  const pinnedEntry = parsePinnedEntry(gatewayPath);
  if (
    cache &&
    pinnedEntry &&
    !prefetchedBuilds.has(pinnedEntry.buildKey) &&
    !prefetchFlights.has(pinnedEntry.buildKey)
  ) {
    const flight = prefetchInitialPanelAssets(
      serverClient,
      cache,
      backstops,
      pinnedEntry,
      prefetchLifetime
    )
      .then(() => {
        prefetchedBuilds.add(pinnedEntry.buildKey);
      })
      .catch((error: unknown) => {
        if (prefetchLifetime.aborted) return;
        log.warn(
          `Initial asset prefetch failed for build ${pinnedEntry.buildKey}; ` +
            `individual immutable requests remain available: ${
              error instanceof Error ? error.message : String(error)
            }`
        );
      })
      .finally(() => prefetchFlights.delete(pinnedEntry.buildKey));
    prefetchFlights.set(pinnedEntry.buildKey, flight);
  }

  // Subresources requested while the entry document is parsing join the one
  // build flight. This is the synchronization point that replaces dozens of
  // independent RPC round trips; a failed flight simply falls through to the
  // normal per-resource fetch below.
  const requestBuildKey = buildKeyForRequest(gatewayPath, req.headers.referer);
  const prefetchFlight = requestBuildKey ? prefetchFlights.get(requestBuildKey) : undefined;
  if (prefetchFlight && !pinnedEntry) await prefetchFlight;

  // Worker routes may be panel-reachable through bridge-tunneled gatewayFetch,
  // but they are dynamic surfaces and never belong on this unauthenticated
  // origin. This mirrors the mobile facade exactly.
  if (gatewayPath.startsWith("/_r/w/")) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Blocked: worker routes require the authenticated panel bridge");
    return;
  }

  const forwardHeaders = collectForwardHeaders(req);

  // One controller for the whole request: the connect/stall backstops and the
  // webview-cancel path all abort it, which cancels the underlying pipe stream so
  // we stop pulling multi-MB bytes over the (paid) pipe nobody will read.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded && !controller.signal.aborted) {
      controller.abort();
    }
  });

  const fetcher = async (): Promise<FetchedResponse> => {
    const response = await withConnectBackstop(
      () =>
        serverClient.stream(
          "gateway",
          "fetch",
          [{ path: gatewayPath, method, headers: forwardHeaders, gzip: true }],
          {
            signal: controller.signal,
            headTimeoutMs: backstops.connectMs,
            trafficClass: pinnedEntry ? "interactive" : "bulk",
          }
        ),
      controller,
      reqPath,
      backstops.connectMs
    );
    return normalizeResponse(response);
  };

  try {
    if (cache) {
      const outcome = await cache.serve(panelAssetCacheKey(gatewayPath, forwardHeaders), fetcher);
      if (outcome.kind === "asset") {
        const { asset } = outcome;
        res.writeHead(
          asset.status,
          buildResponseHeaders(asset.contentType, asset.gzip, asset.replayHeaders)
        );
        res.end(asset.body);
        return;
      }
      writePassthrough(reqPath, res, outcome.response, controller, backstops.stallMs);
      return;
    }

    writePassthrough(reqPath, res, await fetcher(), controller, backstops.stallMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A webview cancel aborts the controller too; that's not an error worth a body.
    if (res.writableEnded || res.destroyed) return;
    const unreachable = err instanceof AssetBackstopError;
    log.warn(
      `Panel asset fetch ${unreachable ? "backstopped" : "failed"} for ${reqPath}: ${message}`
    );
    const wantsDocument = String(req.headers.accept ?? "").includes("text/html");
    if (!res.headersSent) {
      res.writeHead(unreachable ? 504 : 502, {
        "Content-Type": wantsDocument ? "text/html; charset=utf-8" : "text/plain; charset=utf-8",
      });
    }
    if (wantsDocument) {
      const title = unreachable ? "Workspace server unavailable" : "Panel asset bridge error";
      const detail = unreachable
        ? "Reconnect to the workspace server, then reload this panel."
        : message;
      res.end(
        `<!doctype html><meta name="color-scheme" content="light dark"><title>${title}</title><main style="font:14px system-ui;max-width:640px;margin:15vh auto;padding:24px"><h1>${title}</h1><p>${escapeHtml(detail)}</p><button onclick="location.reload()">Reload panel</button></main>`
      );
    } else {
      res.end(
        unreachable
          ? "Can't reach your server. Reconnect, then reload this panel."
          : "Panel asset bridge error"
      );
    }
  }
}

function parsePinnedEntry(rawPath: string): PinnedEntry | null {
  const url = new URL(rawPath, "http://panel-facade.invalid");
  const buildKey = url.searchParams.get("buildKey");
  if (!buildKey || !/^[0-9a-f]{64}$/u.test(buildKey)) return null;
  const sourceRoot = url.pathname.endsWith("/")
    ? url.pathname
    : url.pathname.endsWith("/index.html")
      ? url.pathname.slice(0, -"index.html".length)
      : null;
  return sourceRoot ? { buildKey, sourceRoot } : null;
}

function buildKeyForRequest(rawPath: string, referer: string | undefined): string | null {
  const direct = rawPath.match(/^\/__vibestudio\/panel-build\/([0-9a-f]{64})\//u)?.[1];
  if (direct) return direct;
  if (!referer) return null;
  try {
    const value = new URL(referer).searchParams.get("buildKey");
    return value && /^[0-9a-f]{64}$/u.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function prefetchInitialPanelAssets(
  serverClient: PanelAssetStreamClient,
  cache: AssetDiskCache,
  backstops: ResolvedBackstops,
  entry: PinnedEntry,
  signal: AbortSignal
): Promise<void> {
  const manifestPath = `/__vibestudio/panel-build/${entry.buildKey}/__manifest.json`;
  const manifestKey = panelAssetCacheKey(manifestPath, {});
  let manifestBytes = (await cache.get(manifestKey))?.body;
  let manifest: PrefetchManifest;
  if (!manifestBytes) {
    const response = await fetchPrefetchResponse(
      serverClient,
      backstops,
      manifestPath,
      "interactive",
      signal
    );
    manifestBytes = await readResponseBytes(response, MAX_PREFETCH_MANIFEST_BYTES);
    // Validate before publication: an older server can answer the panel SPA
    // catch-all at an unknown path with HTML and a truncated JSON response must
    // never become the durable inventory for this build.
    manifest = parsePrefetchManifest(manifestBytes);
    const digest = createHash("sha256").update(manifestBytes).digest("hex");
    await cache.putVerifiedBatch([
      {
        cacheKey: manifestKey,
        bytes: manifestBytes,
        payloadDigest: digest,
        gzip: false,
        contentType: "application/json; charset=utf-8",
        replayHeaders: { "cache-control": "public, max-age=31536000, immutable" },
      },
    ]);
  } else {
    manifest = parsePrefetchManifest(manifestBytes);
  }
  const missingArtifacts: Array<{ index: number; resource: PrefetchManifestResource }> = [];
  for (const [index, resource] of manifest.artifacts.entries()) {
    if (!resource.initial || !integrityDigest(resource.integrity)) continue;
    const cacheKey = panelAssetCacheKey(
      `/__vibestudio/panel-build/${entry.buildKey}/${resource.path}`,
      {}
    );
    if (!(await cache.has(cacheKey))) missingArtifacts.push({ index, resource });
  }
  const missingHelpers: Array<{ index: number; resource: PrefetchManifestResource }> = [];
  for (const [index, resource] of (manifest.runtimeHelpers ?? []).entries()) {
    if (!resource.initial || !resource.version || !integrityDigest(resource.integrity)) continue;
    const cacheKey = panelAssetCacheKey(
      `${entry.sourceRoot}${resource.path}?v=${resource.version}`,
      {}
    );
    if (!(await cache.has(cacheKey))) missingHelpers.push({ index, resource });
  }
  if (missingArtifacts.length === 0 && missingHelpers.length === 0) return;

  const query = new URLSearchParams({ enc: "gzip" });
  if (missingArtifacts.length > 0) {
    query.set("want", missingArtifacts.map(({ index }) => index).join(","));
  }
  if (missingHelpers.length > 0) {
    query.set("helpers", missingHelpers.map(({ index }) => index).join(","));
  }
  const bundlePath = `/__vibestudio/panel-build/${entry.buildKey}/__bundle?${query}`;
  const response = await fetchPrefetchResponse(serverClient, backstops, bundlePath, "bulk", signal);
  if (!response.body) throw new Error("panel prefetch bundle has no response body");

  const expected = new Map<
    string,
    Array<{ cacheKey: string; resource: PrefetchManifestResource }>
  >();
  const addExpected = (cacheKey: string, resource: PrefetchManifestResource): void => {
    const digest = integrityDigest(resource.integrity)!;
    const paths = expected.get(digest) ?? [];
    paths.push({ cacheKey, resource });
    expected.set(digest, paths);
  };
  for (const { resource } of missingArtifacts) {
    addExpected(
      panelAssetCacheKey(`/__vibestudio/panel-build/${entry.buildKey}/${resource.path}`, {}),
      resource
    );
  }
  for (const { resource } of missingHelpers) {
    addExpected(
      panelAssetCacheKey(`${entry.sourceRoot}${resource.path}?v=${resource.version}`, {}),
      resource
    );
  }

  const reader = createBlobBundleReader();
  const received = new Map<string, { payloadDigest: string; bytes: Uint8Array }>();
  const bodyReader = response.body.getReader();
  let totalBytes = 0;
  for (;;) {
    const { done, value } = await bodyReader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_PREFETCH_TOTAL_BYTES) {
      await bodyReader.cancel("panel prefetch exceeded aggregate byte cap");
      throw new Error(`panel prefetch exceeded ${MAX_PREFETCH_TOTAL_BYTES} bytes`);
    }
    for (const record of reader.push(value)) {
      if (expected.has(record.digest)) {
        received.set(record.digest, {
          payloadDigest: record.payloadDigest,
          bytes: record.bytes,
        });
      }
    }
  }
  reader.end();
  for (const digest of expected.keys()) {
    if (!received.has(digest)) throw new Error(`panel prefetch bundle omitted ${digest}`);
  }

  const entries: VerifiedCacheEntry[] = [];
  for (const [digest, targets] of expected) {
    const record = received.get(digest)!;
    for (const { cacheKey, resource } of targets) {
      entries.push({
        cacheKey,
        bytes: record.bytes,
        payloadDigest: record.payloadDigest,
        gzip: record.payloadDigest !== digest,
        contentType: resource.contentType,
        replayHeaders: { "cache-control": "public, max-age=31536000, immutable" },
      });
    }
  }
  await cache.putVerifiedBatch(entries);
}

async function fetchPrefetchResponse(
  serverClient: PanelAssetStreamClient,
  backstops: ResolvedBackstops,
  path: string,
  trafficClass: "interactive" | "bulk",
  signal: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  let response: Response;
  try {
    response = await withConnectBackstop(
      () =>
        serverClient.stream(
          "gateway",
          "fetch",
          [{ path, method: "GET", headers: {}, gzip: false }],
          {
            signal: controller.signal,
            headTimeoutMs: backstops.connectMs,
            trafficClass,
          }
        ),
      controller,
      path,
      backstops.connectMs
    );
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`panel prefetch ${path} returned HTTP ${response.status}`);
  }
  return response;
}

async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel("response exceeded byte cap");
      throw new Error(`response exceeded ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total
  );
}

function parsePrefetchManifest(bytes: Uint8Array): PrefetchManifest {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object")
    throw new Error("panel prefetch manifest is not an object");
  const candidate = parsed as { artifacts?: unknown; runtimeHelpers?: unknown };
  if (!Array.isArray(candidate.artifacts))
    throw new Error("panel prefetch manifest has no artifact list");
  const parseResources = (value: unknown, label: string): PrefetchManifestResource[] => {
    if (!Array.isArray(value)) throw new Error(`panel prefetch manifest ${label} is not an array`);
    return value.map((item) => {
      if (!item || typeof item !== "object")
        throw new Error(`panel prefetch ${label} entry is invalid`);
      const resource = item as Partial<PrefetchManifestResource>;
      if (
        typeof resource.path !== "string" ||
        resource.path.startsWith("/") ||
        resource.path.includes("..") ||
        typeof resource.contentType !== "string" ||
        typeof resource.integrity !== "string" ||
        !integrityDigest(resource.integrity) ||
        (resource.version !== undefined && !/^[0-9a-f]{64}$/u.test(resource.version))
      ) {
        throw new Error(`panel prefetch ${label} entry is malformed`);
      }
      return resource as PrefetchManifestResource;
    });
  };
  return {
    artifacts: parseResources(candidate.artifacts, "artifacts"),
    runtimeHelpers:
      candidate.runtimeHelpers === undefined
        ? []
        : parseResources(candidate.runtimeHelpers, "runtimeHelpers"),
  };
}

function integrityDigest(integrity: string): string | null {
  return integrity.match(SHA256_INTEGRITY)?.[1] ?? null;
}

function escapeHtml(value: string): string {
  const replacements: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (char) => replacements[char] ?? char);
}

function writePassthrough(
  reqPath: string,
  res: http.ServerResponse,
  response: FetchedResponse,
  controller: AbortController,
  stallMs: number
): void {
  res.writeHead(
    response.status,
    buildResponseHeaders(response.contentType, response.gzip, response.replayHeaders)
  );
  if (!response.body) {
    res.end();
    return;
  }
  // Pipe the streamed body straight to the webview (Node uses chunked transfer
  // since Content-Length was stripped). Tear down on error either way.
  const nodeBody = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);

  // Stall backstop: arm on start, re-arm on every chunk. Only a genuine
  // no-progress gap (server wedged mid-transfer) trips it — a slow-but-steady
  // transfer keeps it disarmed indefinitely.
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  const clearStall = () => {
    if (stallTimer) {
      clearTimeout(stallTimer);
      stallTimer = undefined;
    }
  };
  const armStall = () => {
    clearStall();
    stallTimer = setTimeout(() => {
      log.warn(
        `Panel asset stream stalled for ${reqPath} (>${stallMs / 1000}s, no progress) — aborting`
      );
      controller.abort();
      nodeBody.destroy(new AssetBackstopError("panel asset stream stalled"));
    }, stallMs);
  };
  armStall();
  nodeBody.on("data", armStall);
  nodeBody.on("end", clearStall);
  nodeBody.on("close", clearStall);
  nodeBody.on("error", (err) => {
    clearStall();
    log.warn(`Panel asset stream errored for ${reqPath}: ${err.message}`);
    if (!res.writableEnded) res.destroy(err);
  });
  // Webview canceled the panel mid-boot: stop pulling bytes over the pipe by
  // destroying the source (Readable.fromWeb cancels the underlying web stream).
  res.on("close", () => {
    clearStall();
    if (!res.writableEnded && !nodeBody.destroyed) nodeBody.destroy();
  });
  nodeBody.pipe(res);
}
