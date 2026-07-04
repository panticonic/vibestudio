/**
 * panelAssetFacade — loopback panel-asset HTTP/1.1 server for React Native.
 *
 * The mobile sibling of `src/main/panelAssetFacade.ts`. Panels load from a fixed
 * loopback origin (`buildPanelUrl` → `http://127.0.0.1:<facadePort>/{source}/…`).
 * On mobile there is no local gateway — the RPC plane rides the WebRTC pipe — so
 * this tiny loopback TCP server stands in for it: it parses each webview asset
 * request, proxies it to the remote gateway over the pipe via the STREAMING
 * `gateway.fetch` RPC, and streams the response back chunked.
 *
 * Panel bundles are multiple MB. Requesting `gzip` on the wire + chunked transfer
 * keeps each payload inside react-native-webrtc's serialized-receive throughput
 * (the same constraint that forced gzip on the Part A native bundle stream). The
 * gateway marks a gzipped body with `x-vibez1-content-gzip` (NOT
 * `Content-Encoding`, so the pipe's fetch never auto-inflates it); we translate
 * that to a real `Content-Encoding: gzip` and the webview inflates natively — the
 * façade never touches the bytes.
 *
 * Two cache layers ride on top (plan §6):
 *  - A content-addressed cache for immutable artifacts so a repeat request costs
 *    zero pipe bytes. Mobile has NO filesystem dependency (only AsyncStorage,
 *    which is a small key/value store unsuited to multi-MB binary blobs), so this
 *    is an IN-MEMORY LRU (256 MiB) rather than an on-disk cache — see
 *    {@link MobileAssetMemoryCache}. `no-store` HTML entry documents are never cached.
 *  - A stable loopback port persisted in AsyncStorage and re-bound across launches,
 *    so the webview's own HTTP cache (keyed by origin) survives app restarts.
 *
 * The only client is the in-app webview (loopback, one request per connection),
 * so the HTTP/1.1 handling is deliberately minimal. Panel RPC still rides the
 * postMessage shell bridge, so this socket carries no management surface and
 * needs no per-request auth.
 */

import TcpSocket from "react-native-tcp-socket";
import {
  FORWARD_REQUEST_HEADERS,
  STRIP_RESPONSE_HEADERS,
  GZIP_MARKER_HEADER,
} from "@vibez1/shared/panel/assetHeaders";
import { checkPanelGatewayPath } from "@vibez1/shared/panel/assetPathPolicy";
import type { MobileRpcClient } from "./mobileTransport";

declare const require: (moduleName: string) => unknown;

// The connected-socket type — `Socket` is a member of the default export's
// namespace, not a top-level named export, so derive the instance type from it.
type TcpSocketConn = InstanceType<typeof TcpSocket.Socket>;

const MAX_REQUEST_HEAD_BYTES = 64 * 1024;
/**
 * Cap on a buffered request BODY (plan §1.6). The RN facade parses raw TCP, so
 * bodies are buffered to completion before being re-streamed over the pipe
 * (incremental raw-socket body streaming isn't worth the complexity for webview
 * form/JSON posts); the cap keeps a runaway upload from ballooning JS memory.
 * Mirrors the pipe's 8 MiB upload receive cap.
 */
const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const CONTENT_DIGEST_HEADER = "x-vibez1-content-digest";
const PERSISTED_PORT_KEY = "vibez1:panel-asset-facade:port";
const MAX_CACHE_BYTES = 256 * 1024 * 1024; // 256 MiB in-memory LRU

class MobileCachePopulationTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`cacheable asset exceeded mobile cache byte budget (${maxBytes} bytes)`);
    this.name = "MobileCachePopulationTooLargeError";
  }
}

export interface PanelAssetFacade {
  port: number;
  close(): Promise<void>;
}

// --------------------------------------------------------------------------
// Persisted port (AsyncStorage — a stable loopback origin keeps the webview
// HTTP cache warm across app launches).
// --------------------------------------------------------------------------

interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

function getAsyncStorage(): AsyncStorageLike | null {
  try {
    const mod = require("@react-native-async-storage/async-storage") as {
      default?: AsyncStorageLike;
    } & AsyncStorageLike;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

async function readPersistedPort(): Promise<number | null> {
  const storage = getAsyncStorage();
  if (!storage) return null;
  try {
    const raw = await storage.getItem(PERSISTED_PORT_KEY);
    const port = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function writePersistedPort(port: number): Promise<void> {
  const storage = getAsyncStorage();
  if (!storage) return;
  try {
    await storage.setItem(PERSISTED_PORT_KEY, String(port));
  } catch {
    // best-effort
  }
}

// --------------------------------------------------------------------------
// In-memory content cache
// --------------------------------------------------------------------------

export interface MobileFetchedResponse {
  status: number;
  statusText: string;
  gzip: boolean;
  contentType: string;
  replayHeaders: Record<string, string>;
  cacheable: boolean;
  body: ReadableStream<Uint8Array> | null;
}

export interface MobileCachedAsset {
  status: number;
  statusText: string;
  gzip: boolean;
  contentType: string;
  replayHeaders: Record<string, string>;
  body: Uint8Array;
}

type MobileServeOutcome =
  | { kind: "asset"; asset: MobileCachedAsset }
  | { kind: "passthrough"; response: MobileFetchedResponse };

/**
 * Path-keyed in-memory LRU. Immutable artifacts have content-hashed URL paths, so
 * path → asset is a safe content address (a changed build changes the path). LRU
 * by last access; evicts oldest when over the byte cap. Concurrent misses for the
 * same path are single-flighted so two webview requests trigger one pipe fetch.
 */
export class MobileAssetMemoryCache {
  private readonly entries = new Map<string, MobileCachedAsset>(); // insertion order = LRU
  private bytes = 0;
  private readonly inflight = new Map<string, Promise<MobileCachedAsset | null>>();

  constructor(private readonly maxBytes = MAX_CACHE_BYTES) {}

  async serve(
    urlPath: string,
    fetcher: () => Promise<MobileFetchedResponse>
  ): Promise<MobileServeOutcome> {
    const hit = this.entries.get(urlPath);
    if (hit) {
      // LRU bump: re-insert at the end (most-recent).
      this.entries.delete(urlPath);
      this.entries.set(urlPath, hit);
      return { kind: "asset", asset: hit };
    }

    const existing = this.inflight.get(urlPath);
    if (existing) {
      const asset = await existing;
      if (asset) return { kind: "asset", asset };
      return { kind: "passthrough", response: await fetcher() };
    }

    let settle!: (asset: MobileCachedAsset | null) => void;
    const populated = new Promise<MobileCachedAsset | null>((resolve) => {
      settle = resolve;
    });
    this.inflight.set(urlPath, populated);
    try {
      const response = await fetcher();
      if (!response.cacheable || !response.body) {
        settle(null);
        return { kind: "passthrough", response };
      }
      const [cacheBody, passthroughBody] = response.body.tee();
      let body: Uint8Array;
      try {
        body = await streamToUint8Array(cacheBody, this.maxBytes);
      } catch (err) {
        if (err instanceof MobileCachePopulationTooLargeError) {
          settle(null);
          return {
            kind: "passthrough",
            response: { ...response, cacheable: false, body: passthroughBody },
          };
        }
        void passthroughBody.cancel(err).catch(() => {});
        throw err;
      }
      void passthroughBody.cancel().catch(() => {});
      const asset: MobileCachedAsset = {
        status: response.status,
        statusText: response.statusText,
        gzip: response.gzip,
        contentType: response.contentType,
        replayHeaders: response.replayHeaders,
        body,
      };
      this.store(urlPath, asset);
      settle(asset);
      return { kind: "asset", asset };
    } catch (err) {
      settle(null);
      throw err;
    } finally {
      this.inflight.delete(urlPath);
    }
  }

  private store(urlPath: string, asset: MobileCachedAsset): void {
    const prev = this.entries.get(urlPath);
    if (prev) this.bytes -= prev.body.byteLength;
    this.entries.set(urlPath, asset);
    this.bytes += asset.body.byteLength;
    // Evict oldest until under the cap.
    while (this.bytes > this.maxBytes && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const evicted = this.entries.get(oldest);
      this.entries.delete(oldest);
      if (evicted) this.bytes -= evicted.body.byteLength;
    }
  }
}

export function panelAssetCacheKey(
  urlPath: string,
  forwardHeaders: Record<string, string>
): string {
  const vary = Object.entries(forwardHeaders)
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  if (vary.length === 0) return urlPath;
  return `${urlPath}#headers=${JSON.stringify(vary)}`;
}

/**
 * Start the loopback panel-asset façade. Resolves once the port is bound; point
 * `buildPanelUrl` (via `hostConfig.port`) at the returned `port`.
 */
export async function startPanelAssetFacade(transport: MobileRpcClient): Promise<PanelAssetFacade> {
  const cache = new MobileAssetMemoryCache();
  const preferredPort = await readPersistedPort();

  const server = TcpSocket.createServer((socket) => {
    handleConnection(transport, cache, socket);
  });

  const bind = (requested: number): Promise<number> =>
    new Promise((resolve, reject) => {
      const onError = (err: unknown) => reject(err);
      server.once("error", onError);
      server.listen({ port: requested, host: "127.0.0.1" }, () => {
        server.removeListener("error", onError);
        const address = server.address();
        if (!address || typeof address !== "object" || typeof address.port !== "number") {
          reject(new Error("Panel asset façade failed to bind a TCP port"));
          return;
        }
        resolve(address.port);
      });
    });

  const port =
    preferredPort !== null ? await bind(preferredPort).catch(() => bind(0)) : await bind(0);
  if (port !== preferredPort) void writePersistedPort(port);

  console.log(
    `[Vibez1MobileSmoke] phase=workspace-panel-facade-listening ${JSON.stringify({ port })}`
  );
  return {
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        try {
          server.close(() => resolveClose());
        } catch {
          resolveClose();
        }
      }),
  };
}

/** Lossless latin1-mirror → bytes (each char code is exactly one raw byte). */
function latin1ToBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function handleConnection(
  transport: MobileRpcClient,
  cache: MobileAssetMemoryCache,
  socket: TcpSocketConn
): void {
  let head = "";
  let dispatched = false;
  // Body accumulation (plan §1.6): once the head terminator is seen, non-GET/HEAD
  // requests keep reading `Content-Length` bytes before dispatch. Bodies are
  // buffered (cap 8 MiB) then re-streamed over the pipe — see MAX_REQUEST_BODY_BYTES.
  let expectedBodyBytes = 0;
  const bodyChunks: Uint8Array[] = [];
  let bodyBytes = 0;

  try {
    socket.setNoDelay(true);
  } catch {
    // best-effort
  }

  const failRequest = (status: number, statusText: string): void => {
    dispatched = true;
    try {
      socket.write(
        `HTTP/1.1 ${status} ${statusText}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
      );
      socket.end();
    } catch {
      try {
        socket.destroy();
      } catch {
        // already gone
      }
    }
  };

  const dispatch = (): void => {
    dispatched = true;
    // Trim to Content-Length: anything past it is not part of this request
    // (one request per connection; the facade always answers Connection: close).
    const body =
      bodyBytes > 0
        ? concatChunks(bodyChunks, bodyBytes).subarray(0, expectedBodyBytes)
        : undefined;
    void handleRequest(transport, cache, socket, head, body);
  };

  const acceptBodyBytes = (chunk: Uint8Array): void => {
    if (chunk.byteLength === 0) return;
    bodyBytes += chunk.byteLength;
    if (bodyBytes > MAX_REQUEST_BODY_BYTES) {
      console.warn(
        `[panel-facade] request body exceeds ${MAX_REQUEST_BODY_BYTES} bytes — rejecting (413)`
      );
      failRequest(413, "Payload Too Large");
      return;
    }
    bodyChunks.push(chunk);
    if (bodyBytes >= expectedBodyBytes) dispatch();
  };

  socket.on("data", (data: string | Buffer) => {
    if (dispatched) return;
    const text = typeof data === "string" ? data : data.toString("latin1");
    if (expectedBodyBytes > 0 && head !== "") {
      // Already past the head — everything is body bytes.
      acceptBodyBytes(latin1ToBytes(text));
      return;
    }
    head += text;
    const end = head.indexOf("\r\n\r\n");
    if (end === -1) {
      if (head.length > MAX_REQUEST_HEAD_BYTES) {
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      }
      return;
    }
    const remainder = head.slice(end + 4);
    head = head.slice(0, end);

    const lines = head.split("\r\n");
    const [method = "GET"] = (lines[0] ?? "").split(" ");
    const contentLength = parseContentLength(lines.slice(1));
    if (contentLength === "chunked") {
      // Fail loud: the webview always frames uploads with Content-Length; a
      // chunked request body would be silently mis-parsed as an empty body.
      console.warn("[panel-facade] chunked request bodies are not supported — rejecting (411)");
      failRequest(411, "Length Required");
      return;
    }
    const upper = method.toUpperCase();
    if (upper === "GET" || upper === "HEAD" || contentLength === 0) {
      dispatch();
      return;
    }
    expectedBodyBytes = contentLength;
    acceptBodyBytes(latin1ToBytes(remainder));
  });
  socket.on("error", () => {
    try {
      socket.destroy();
    } catch {
      // already gone
    }
  });
}

/** `Content-Length` (0 when absent) or `"chunked"` for a chunked transfer coding. */
function parseContentLength(headerLines: string[]): number | "chunked" {
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "transfer-encoding" && value.toLowerCase().includes("chunked")) return "chunked";
    if (name === "content-length") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isInteger(parsed) && parsed >= 0) return parsed;
    }
  }
  return 0;
}

function concatChunks(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function handleRequest(
  transport: MobileRpcClient,
  cache: MobileAssetMemoryCache,
  socket: TcpSocketConn,
  rawHead: string,
  requestBody?: Uint8Array
): Promise<void> {
  const lines = rawHead.split("\r\n");
  const [method = "GET", target = "/"] = (lines[0] ?? "").split(" ");
  const forwardHeaders = collectForwardHeaders(lines.slice(1));
  let headSent = false;
  const decision = checkPanelGatewayPath(target);
  if (!decision.allowed) {
    const status = decision.denied === "policy" ? 403 : 400;
    await writeToSocket(
      socket,
      buildHead(
        status,
        status === 403 ? "Forbidden" : "Bad Request",
        "text/plain",
        false,
        {},
        {
          contentLength: 0,
        }
      )
    );
    socket.end();
    return;
  }
  const gatewayPath = decision.target;

  const fetcher = async (): Promise<MobileFetchedResponse> => {
    // Target the server "main" with the fully-qualified method (the bootstrap's
    // proven bundle-stream call). NOT ("gateway","fetch") — that routes to the
    // streaming endpoint's proxyFetch-only fast path and is rejected.
    // A parsed request body (buffered off the raw socket, plan §1.6) is
    // re-streamed as the upload body on the pipe's bulk channel.
    const result = await transport.streamReadable(
      "main",
      "gateway.fetch",
      [{ path: gatewayPath, method, headers: forwardHeaders, gzip: true }],
      requestBody && requestBody.byteLength > 0 ? { body: bytesToStream(requestBody) } : undefined
    );
    return normalizeResult(result);
  };

  try {
    // Only GET assets are cacheable; everything else streams straight through.
    if (method === "GET") {
      const outcome = await cache.serve(panelAssetCacheKey(gatewayPath, forwardHeaders), fetcher);
      if (outcome.kind === "asset") {
        await writeBufferedAsset(socket, outcome.asset, () => {
          headSent = true;
        });
        return;
      }
      await streamPassthrough(socket, outcome.response, () => {
        headSent = true;
      });
      return;
    }

    await streamPassthrough(socket, await fetcher(), () => {
      headSent = true;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[panel-facade] asset fetch failed for ${target}: ${message}`);
    if (!headSent && !socket.destroyed) {
      try {
        socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        socket.end();
        return;
      } catch {
        // fall through to destroy
      }
    }
    try {
      socket.destroy();
    } catch {
      // already gone
    }
  }
}

/** DecodedFramedStream → the façade's normalized, cache-agnostic shape. */
function normalizeResult(result: {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: ReadableStream<Uint8Array>;
}): MobileFetchedResponse {
  let gzip = false;
  let contentType = "application/octet-stream";
  let cacheControl = "";
  const replayHeaders: Record<string, string> = {};
  for (const [key, value] of result.headers) {
    const lower = key.toLowerCase();
    if (lower === GZIP_MARKER_HEADER) {
      gzip = value === "1";
      continue;
    }
    if (lower === "content-type") {
      contentType = value;
      continue;
    }
    if (lower === "cache-control") cacheControl = value;
    if (STRIP_RESPONSE_HEADERS.has(lower) || lower === CONTENT_DIGEST_HEADER) continue;
    replayHeaders[key] = value;
  }
  return {
    status: result.status,
    statusText: result.statusText || "OK",
    gzip,
    contentType,
    replayHeaders,
    cacheable: result.status === 200 && cacheControl.includes("immutable"),
    body: result.body,
  };
}

function buildHead(
  status: number,
  statusText: string,
  contentType: string,
  gzip: boolean,
  replayHeaders: Record<string, string>,
  framing: { contentLength: number } | { chunked: true }
): string {
  const out: string[] = [
    `HTTP/1.1 ${status} ${statusText || "OK"}`,
    `Content-Type: ${contentType}`,
  ];
  for (const [key, value] of Object.entries(replayHeaders)) out.push(`${key}: ${value}`);
  if (gzip) out.push("Content-Encoding: gzip");
  if ("contentLength" in framing) {
    out.push(`Content-Length: ${framing.contentLength}`);
  } else {
    // No Content-Length (the body is streamed) — chunked framing lets the webview
    // detect a complete vs truncated response.
    out.push("Transfer-Encoding: chunked");
  }
  out.push("Connection: close");
  out.push("", "");
  return out.join("\r\n");
}

/**
 * Serve a fully-buffered (cache-hit or just-cached) asset with a Content-Length.
 * `onHeadSent` fires the instant the response head write resolves, so a caller's
 * error handler knows the head is already on the wire even if a later body write
 * throws (writing a second head would corrupt the response — destroy instead).
 */
async function writeBufferedAsset(
  socket: TcpSocketConn,
  asset: MobileCachedAsset,
  onHeadSent: () => void
): Promise<void> {
  await writeToSocket(
    socket,
    buildHead(asset.status, asset.statusText, asset.contentType, asset.gzip, asset.replayHeaders, {
      contentLength: asset.body.byteLength,
    })
  );
  onHeadSent();
  if (asset.body.byteLength > 0) await writeToSocket(socket, asset.body);
  socket.end();
}

/**
 * Stream an uncacheable response through chunked. `onHeadSent` fires the instant
 * the head write resolves — before the body is streamed — so a mid-body throw
 * leaves the caller's `headSent` flag true and its catch destroys the socket
 * instead of writing a second (corrupting) head into the started response.
 */
export async function streamPassthrough(
  socket: TcpSocketConn,
  response: MobileFetchedResponse,
  onHeadSent: () => void
): Promise<void> {
  await writeToSocket(
    socket,
    buildHead(
      response.status,
      response.statusText,
      response.contentType,
      response.gzip,
      response.replayHeaders,
      { chunked: true }
    )
  );
  onHeadSent();
  if (!response.body) {
    await writeToSocket(socket, "0\r\n\r\n");
    socket.end();
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        await writeToSocket(socket, `${value.byteLength.toString(16)}\r\n`);
        await writeToSocket(socket, value);
        await writeToSocket(socket, "\r\n");
      }
    }
    await writeToSocket(socket, "0\r\n\r\n");
  } finally {
    reader.releaseLock();
  }
  socket.end();
}

/** One-chunk ReadableStream over a buffered request body (upload path, §1.6). */
function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function streamToUint8Array(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        if (total + value.byteLength > maxBytes) {
          const err = new MobileCachePopulationTooLargeError(maxBytes);
          void reader.cancel(err).catch(() => {});
          throw err;
        }
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function collectForwardHeaders(headerLines: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!FORWARD_REQUEST_HEADERS.includes(name)) continue;
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

/**
 * Write with backpressure: `socket.write` returns false when the kernel buffer is
 * full, so wait for `drain` before the next write (a multi-MB bundle would
 * otherwise balloon JS memory). Rejects if the socket closes mid-write so the
 * streaming loop tears down instead of hanging on a `drain` that never comes.
 */
function writeToSocket(socket: TcpSocketConn, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.destroyed) {
      reject(new Error("socket closed"));
      return;
    }
    // Resolve only when the write is CONFIRMED written (the native "written"
    // callback), not merely queued. `socket.end()` closes immediately without
    // draining (Socket.end → NativeModules.TcpSockets.end), so resolving on the
    // queued `write()` return value lets end() truncate small still-queued
    // responses — which is why small assets (e.g. __transport.js) intermittently
    // failed to load while large (drain-gated) ones succeeded. Confirming each
    // write also serializes them, which gives implicit backpressure.
    socket.write(data, undefined, (err?: Error) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
