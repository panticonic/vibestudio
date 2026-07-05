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

  const server = http.createServer((req, res) => {
    void handleRequest(serverClient, cache, req, res);
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

  const fetcher = async (): Promise<FetchedResponse> => {
    const response = await serverClient.stream(
      "gateway",
      "fetch",
      [{ path: gatewayPath, method, headers: forwardHeaders, gzip: true }],
      requestBody ? { body: requestBody } : undefined
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
      writePassthrough(reqPath, res, outcome.response);
      return;
    }

    writePassthrough(reqPath, res, await fetcher());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Panel asset fetch failed for ${reqPath}: ${message}`);
    if (res.writableEnded) return;
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    }
    res.end("Panel asset bridge error");
  }
}

function writePassthrough(
  reqPath: string,
  res: http.ServerResponse,
  response: FetchedResponse
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
  nodeBody.on("error", (err) => {
    log.warn(`Panel asset stream errored for ${reqPath}: ${err.message}`);
    if (!res.writableEnded) res.destroy(err);
  });
  nodeBody.pipe(res);
}
