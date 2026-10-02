/**
 * panelAssetFacade — loopback panel-asset server for REMOTE sessions.
 *
 * Panels always load from a fixed loopback origin
 * (`buildPanelUrl` → `http://127.0.0.1:{gatewayPort}/{source}/?contextId=…`).
 * In LOCAL mode that port is the child server's gateway. In REMOTE mode there
 * is no local gateway — the RPC plane rides the Iroh pipe — so this façade
 * stands in for it: a tiny loopback HTTP server that proxies each request to
 * the remote server's own gateway via the `gateway.fetch` STREAMING RPC and
 * pipes the response body straight back to the webview. Streaming (not a
 * buffered base64 return) is mandatory: real panel bundles are multiple MB and
 * would exceed the RPC envelope limit; a dedicated QUIC stream
 * chunks them.
 *
 * On top of that raw proxy the façade adds transport-aware caching (plan §6):
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
import * as fs from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isRpcConnectionLost } from "@vibestudio/rpc/errors";
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
import { AssetDiskCache, type FetchedResponse } from "./assetDiskCache.js";
import type { PanelAssetDiagnostics } from "@vibestudio/shared/panelInterfaces";

/** Minimal streaming seam shared by Electron and headless Node hosts. */
export interface PanelAssetStreamClient {
  stream(
    service: string,
    method: string,
    args?: unknown[],
    options?: Pick<RpcStreamOptions, "signal" | "headTimeoutMs" | "bodyIdleTimeoutMs">
  ): Promise<Response>;
}

const log = createDevLogger("PanelAssetFacade");

interface PrewarmManifestResource {
  path: string;
  contentType: string;
  integrity: string;
  initial?: boolean;
  version?: string;
}

interface PrewarmManifest {
  artifacts: PrewarmManifestResource[];
  runtimeHelpers: PrewarmManifestResource[];
}

interface PinnedEntry {
  buildKey: string;
  artifactRoot: string;
  sourceRoot: string;
}

/** Only demand owns remote asset work. Its lifetime is the browser request or facade. */
const SHA256_INTEGRITY = /^sha256-[0-9a-f]{64}$/u;
const CONTENT_DIGEST_HEADER = "x-vibestudio-content-digest";

export interface PanelAssetFacadeOptions {
  /** Persistent immutable cache and stable browser origin. */
  stateDir?: string;
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
): Promise<{ port: number; diagnostics(): PanelAssetDiagnostics; close(): Promise<void> }> {
  let cache: AssetDiskCache | null = null;
  let portFile: string | undefined;
  if (options.stateDir) {
    fs.mkdirSync(options.stateDir, { recursive: true });
    portFile = path.join(options.stateDir, "port");
    cache = new AssetDiskCache({ dir: path.join(options.stateDir, "asset-cache") });
    await cache.init();
  }

  const lifetime = new AbortController();
  const requests = new Set<Promise<void>>();
  const transfers = new Map<
    http.ServerResponse,
    {
      routeClass: string;
      startedAt: number;
      stage: "opening" | "cache" | "body";
    }
  >();
  const prewarmFlights = new Map<string, Promise<void>>();
  const prewarmCompletedBuilds = new Map<string, true>();
  const ensureBuildPrewarm = (entry: PinnedEntry): void => {
    if (
      !cache ||
      lifetime.signal.aborted ||
      prewarmCompletedBuilds.has(entry.buildKey) ||
      prewarmFlights.has(entry.buildKey)
    ) {
      return;
    }
    const flight = prewarmInitialAssets(serverClient, cache, entry, lifetime.signal)
      .then(() => {
        prewarmCompletedBuilds.delete(entry.buildKey);
        prewarmCompletedBuilds.set(entry.buildKey, true);
        if (prewarmCompletedBuilds.size > 4_096) {
          const oldest = prewarmCompletedBuilds.keys().next().value as string | undefined;
          if (oldest) prewarmCompletedBuilds.delete(oldest);
        }
      })
      .catch((error: unknown) => {
        if (lifetime.signal.aborted) return;
        log.warn(
          `Initial asset prewarm failed for build ${entry.buildKey}; ` +
            `demanded assets remain independently available: ${
              error instanceof Error ? error.message : String(error)
            }`
        );
      })
      .finally(() => prewarmFlights.delete(entry.buildKey));
    prewarmFlights.set(entry.buildKey, flight);
  };

  const server = http.createServer((req, res) => {
    const transfer: Pick<
      PanelAssetDiagnostics["requests"][number],
      "routeClass" | "startedAt" | "stage"
    > = {
      routeClass: "unclassified",
      startedAt: Date.now(),
      stage: "opening",
    };
    transfers.set(res, transfer);
    const request = handleRequest(
      serverClient,
      cache,
      ensureBuildPrewarm,
      lifetime.signal,
      req,
      res,
      transfer
    );
    requests.add(request);
    void request
      .finally(() => {
        requests.delete(request);
        transfers.delete(res);
      })
      .catch((error: unknown) => {
        log.warn(`Panel asset request failed: ${String(error)}`);
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
  });

  const port = await listenWithStablePort(server, portFile);
  log.info(`Panel asset façade listening on http://127.0.0.1:${port}`);
  let closing: Promise<void> | null = null;
  return {
    port,
    diagnostics: () => ({
      requests: [...transfers].slice(0, 50).map(([res, transfer]) => ({
        ...transfer,
        headersSent: res.headersSent,
        writableEnded: res.writableEnded,
        destroyed: res.destroyed,
        bufferedBytes: res.writableLength,
      })),
      prewarmBuilds: [...prewarmFlights.keys()].slice(0, 50),
      cache: cache?.diagnostics() ?? null,
    }),
    close: () =>
      (closing ??= (async () => {
        lifetime.abort(new Error("Panel asset facade closed"));
        await new Promise<void>((resolveClose, rejectClose) => {
          server.close((err) => (err ? rejectClose(err) : resolveClose()));
        });
        await Promise.allSettled([...requests]);
        await Promise.allSettled([...prewarmFlights.values()]);
        await cache?.close();
      })()),
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
  ensureBuildPrewarm: (entry: PinnedEntry) => void,
  lifetime: AbortSignal,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  transfer: Pick<PanelAssetDiagnostics["requests"][number], "routeClass" | "startedAt" | "stage">
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
  transfer.routeClass = gatewayPath.split(/[/?]/u)[1] ?? "root";
  const pinnedEntry = parsePinnedEntry(gatewayPath);
  if (pinnedEntry) ensureBuildPrewarm(pinnedEntry);

  // Worker routes may be panel-reachable through bridge-tunneled gatewayFetch,
  // but they are dynamic surfaces and never belong on this unauthenticated
  // origin. This mirrors the mobile facade exactly.
  if (gatewayPath.startsWith("/_r/w/")) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Blocked: worker routes require the authenticated panel bridge");
    return;
  }

  const forwardHeaders = collectForwardHeaders(req);

  const controller = new AbortController();
  const abort = (): void => controller.abort(lifetime.reason);
  lifetime.addEventListener("abort", abort, { once: true });
  if (lifetime.aborted) abort();
  res.on("close", () => {
    if (!res.writableEnded) controller.abort(new Error("Panel asset request closed"));
  });
  const fetcher = async (signal = controller.signal): Promise<FetchedResponse> => {
    const response = await serverClient.stream(
      "gateway",
      "fetch",
      [{ path: gatewayPath, method, headers: forwardHeaders, gzip: true }],
      { signal, headTimeoutMs: 0, bodyIdleTimeoutMs: null }
    );
    return normalizeResponse(response);
  };

  try {
    if (cache) {
      transfer.stage = "cache";
      const outcome = await cache.serve(
        panelAssetCacheKey(gatewayPath, forwardHeaders),
        fetcher,
        controller.signal
      );
      if (outcome.kind === "asset") {
        transfer.stage = "body";
        const { asset } = outcome;
        res.writeHead(
          asset.status,
          buildResponseHeaders(asset.contentType, asset.gzip, asset.replayHeaders)
        );
        await pipeline(fs.createReadStream(asset.bodyPath), res, { signal: controller.signal });
        return;
      }
      transfer.stage = "body";
      await writePassthrough(res, outcome.response, controller.signal);
      return;
    }

    const response = await fetcher();
    transfer.stage = "body";
    await writePassthrough(res, response, controller.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A webview cancel aborts the controller too; that's not an error worth a body.
    if (res.writableEnded || res.destroyed) return;
    const unreachable = isRpcConnectionLost(err);
    log.warn(
      `Panel asset fetch ${unreachable ? "disconnected" : "failed"} for ${reqPath}: ${message}`
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
  } finally {
    lifetime.removeEventListener("abort", abort);
  }
}

function parsePinnedEntry(rawPath: string): PinnedEntry | null {
  const url = new URL(rawPath, "http://panel-facade.invalid");
  const appMatch = url.pathname.match(/^\/_a\/([0-9a-f]{64})\/(?:index\.html)?$/u);
  if (appMatch) {
    const buildKey = appMatch[1]!;
    const artifactRoot = `/_a/${buildKey}/`;
    return { buildKey, artifactRoot, sourceRoot: artifactRoot };
  }

  const buildKey = url.searchParams.get("buildKey");
  if (!buildKey || !/^[0-9a-f]{64}$/u.test(buildKey)) return null;
  const sourceRoot = url.pathname.endsWith("/")
    ? url.pathname
    : url.pathname.endsWith("/index.html")
      ? url.pathname.slice(0, -"index.html".length)
      : null;
  return sourceRoot
    ? {
        buildKey,
        artifactRoot: `/__vibestudio/panel-build/${buildKey}/`,
        sourceRoot,
      }
    : null;
}

/**
 * Fill the same per-path single-flight registry used by live HTTP requests.
 * There is deliberately no bundle transaction or second publication path:
 * prewarm and demand race through AssetDiskCache.serve(cacheKey, fetcher), so
 * exactly one Iroh stream, digest pass, and durable publication owns a key.
 * Each initial resource has its own stream and completion, allowing QUIC to
 * interleave them and preventing a slow artifact from becoming a build barrier.
 */
async function prewarmInitialAssets(
  serverClient: PanelAssetStreamClient,
  cache: AssetDiskCache,
  entry: PinnedEntry,
  lifetime: AbortSignal
): Promise<void> {
  const manifestPath = `${entry.artifactRoot}__manifest.json`;
  const manifestOutcome = await cache.serve(
    panelAssetCacheKey(manifestPath, {}),
    (signal) => fetchPrewarmAsset(serverClient, manifestPath, false, signal),
    lifetime
  );
  let manifestBytes: Uint8Array;
  if (manifestOutcome.kind === "asset") {
    if (manifestOutcome.asset.size > 64 * 1024 * 1024) {
      throw new Error(
        `panel prewarm manifest exceeded catastrophic ${64 * 1024 * 1024}-byte boundary`
      );
    }
    manifestBytes = await fs.promises.readFile(manifestOutcome.asset.bodyPath);
  } else {
    manifestBytes = await readBody(manifestOutcome.response.body, manifestPath, 64 * 1024 * 1024);
  }
  const manifest = parsePrewarmManifest(manifestBytes);

  const paths = [
    ...manifest.artifacts
      .filter((resource) => resource.initial)
      .map((resource) => `${entry.artifactRoot}${resource.path}`),
    ...manifest.runtimeHelpers
      .filter((resource) => resource.initial && resource.version)
      .map((resource) => `${entry.sourceRoot}${resource.path}?v=${resource.version}`),
  ];

  const consumers = new AbortController();
  const abort = () => consumers.abort(lifetime.reason);
  lifetime.addEventListener("abort", abort, { once: true });
  if (lifetime.aborted) abort();
  try {
    const results = await Promise.allSettled(
      paths.map(async (assetPath) => {
        try {
          const outcome = await cache.serve(
            panelAssetCacheKey(assetPath, {}),
            (signal) => fetchPrewarmAsset(serverClient, assetPath, true, signal),
            consumers.signal
          );
          if (outcome.kind === "asset") return;
          if (outcome.response.status !== 200) {
            await outcome.response.body?.cancel().catch(() => undefined);
            throw new Error(`prewarm ${assetPath} was not an HTTP 200 response`);
          }
          await readBody(outcome.response.body, assetPath, Number.POSITIVE_INFINITY, false);
        } catch (error) {
          // Retire this operation's remaining speculative consumers. Demanded
          // readers keep their independently owned shared transfers alive.
          consumers.abort(error);
          throw error;
        }
      })
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw consumers.signal.reason;
  } finally {
    lifetime.removeEventListener("abort", abort);
  }
}

async function fetchPrewarmAsset(
  serverClient: PanelAssetStreamClient,
  assetPath: string,
  gzip: boolean,
  lifetime: AbortSignal
): Promise<FetchedResponse> {
  const controller = new AbortController();
  const abort = (): void => controller.abort(lifetime.reason);
  lifetime.addEventListener("abort", abort, { once: true });
  if (lifetime.aborted) abort();
  try {
    const response = await serverClient.stream(
      "gateway",
      "fetch",
      [{ path: assetPath, method: "GET", headers: {}, gzip }],
      { signal: controller.signal, headTimeoutMs: 0, bodyIdleTimeoutMs: null }
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`prewarm ${assetPath} returned HTTP ${response.status}`);
    }
    return normalizeResponse(bindBodyToLifetime(response, lifetime));
  } finally {
    lifetime.removeEventListener("abort", abort);
  }
}

function bindBodyToLifetime(response: Response, lifetime: AbortSignal): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    lifetime.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const abort = (): void => {
    void reader.cancel(lifetime.reason).then(settle, settle);
  };
  lifetime.addEventListener("abort", abort, { once: true });
  if (lifetime.aborted) abort();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settle();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        settle();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function readBody(
  body: ReadableStream<Uint8Array> | null,
  assetPath: string,
  maxBytes = Number.POSITIVE_INFINITY,
  retainBytes = true
): Promise<Buffer> {
  if (!body) return Buffer.alloc(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        throw new Error(`prewarm response exceeded ${maxBytes} bytes for ${assetPath}`);
      }
      if (retainBytes) chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  return retainBytes
    ? Buffer.concat(
        chunks.map((chunk) => Buffer.from(chunk)),
        total
      )
    : Buffer.alloc(0);
}

function parsePrewarmManifest(bytes: Uint8Array): PrewarmManifest {
  const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object") {
    throw new Error("panel prewarm manifest is not an object");
  }
  const candidate = parsed as { artifacts?: unknown; runtimeHelpers?: unknown };
  const parseResources = (value: unknown, label: string): PrewarmManifestResource[] => {
    if (!Array.isArray(value)) throw new Error(`panel prewarm manifest ${label} is not an array`);
    return value.map((item) => {
      if (!item || typeof item !== "object") {
        throw new Error(`panel prewarm ${label} entry is invalid`);
      }
      const resource = item as Partial<PrewarmManifestResource>;
      if (
        typeof resource.path !== "string" ||
        resource.path.startsWith("/") ||
        resource.path.includes("..") ||
        typeof resource.contentType !== "string" ||
        typeof resource.integrity !== "string" ||
        !SHA256_INTEGRITY.test(resource.integrity) ||
        (resource.version !== undefined && !/^[0-9a-f]{64}$/u.test(resource.version))
      ) {
        throw new Error(`panel prewarm ${label} entry is malformed`);
      }
      return resource as PrewarmManifestResource;
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

async function writePassthrough(
  res: http.ServerResponse,
  response: FetchedResponse,
  signal: AbortSignal
): Promise<void> {
  res.writeHead(
    response.status,
    buildResponseHeaders(response.contentType, response.gzip, response.replayHeaders)
  );
  if (!response.body) {
    res.end();
    return;
  }
  // pipeline owns backpressure, browser cancellation, source errors, and settlement.
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res, {
    signal,
  });
}
