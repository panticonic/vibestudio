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
 *    artifacts from disk on a repeat request — zero pipe bytes. `no-store` HTML
 *    entry documents are never cached. The cache stores the body EXACTLY as
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
import type { ServerClient } from "./serverClient.js";
import {
  FORWARD_REQUEST_HEADERS,
  STRIP_RESPONSE_HEADERS,
  GZIP_MARKER_HEADER,
} from "@vibestudio/shared/panel/assetHeaders";
import { checkPanelGatewayPath } from "@vibestudio/shared/panel/assetPathPolicy";
import { AssetDiskCache, type FetchedResponse } from "./assetDiskCache.js";

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

function assetCacheKey(reqPath: string, forwardHeaders: Record<string, string>): string {
  const vary = Object.entries(forwardHeaders)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (vary.length === 0) return reqPath;
  const digest = createHash("sha256").update(JSON.stringify(vary)).digest("hex").slice(0, 24);
  return `${reqPath}#h=${digest}`;
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
    // Immutable artifacts carry `Cache-Control: …, immutable`; the SPA HTML entry
    // is `no-store` and must never be cached.
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
  serverClient: Pick<ServerClient, "stream">,
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
  const server = http.createServer((req, res) => {
    void handleRequest(serverClient, cache, backstops, req, res);
  });

  const port = await listenWithStablePort(server, portFile);
  log.info(`Panel asset façade listening on http://127.0.0.1:${port}`);
  return {
    port,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((err) => (err ? rejectClose(err) : resolveClose()));
      }),
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
  serverClient: Pick<ServerClient, "stream">,
  cache: AssetDiskCache | null,
  backstops: ResolvedBackstops,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const reqPath = req.url ?? "/";
  const method = (req.method ?? "GET").toUpperCase();

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

  const forwardHeaders = collectForwardHeaders(req);

  // Request bodies stream through end-to-end (plan §1.6): non-GET/HEAD requests
  // forward the raw node request stream as the gateway.fetch upload body — a
  // panel POSTing to its asset origin no longer has its body silently dropped.
  const requestBody =
    method !== "GET" && method !== "HEAD"
      ? (Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>)
      : null;

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
            ...(requestBody ? { body: requestBody } : {}),
          }
        ),
      controller,
      reqPath,
      backstops.connectMs
    );
    return normalizeResponse(response);
  };

  try {
    // Only GET assets are cacheable. Non-GET (and body-bearing) requests bypass
    // the cache and stream straight through.
    if (cache && method === "GET") {
      const outcome = await cache.serve(assetCacheKey(gatewayPath, forwardHeaders), fetcher);
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
