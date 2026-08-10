/**
 * panelAssetFacade — loopback panel-asset HTTP/1.1 server for React Native.
 *
 * The mobile sibling of `src/node/panelAssets/panelAssetFacade.ts`. Panels load from a fixed
 * loopback origin (`buildPanelUrl` → `http://127.0.0.1:<facadePort>/{source}/…`).
 * On mobile there is no local gateway — the RPC plane rides the WebRTC pipe — so
 * this tiny loopback TCP server stands in for it: it parses each webview asset
 * request, proxies it to the remote gateway over the pipe via the STREAMING
 * `gateway.fetch` RPC, and streams the response back chunked.
 *
 * Panel bundles are multiple MB. Requesting `gzip` on the wire + chunked transfer
 * keeps each payload inside react-native-webrtc's serialized-receive throughput
 * (the same constraint that forced gzip on the Part A native bundle stream). The
 * gateway marks a gzipped body with `x-vibestudio-content-gzip` (NOT
 * `Content-Encoding`, so the pipe's fetch never auto-inflates it); we translate
 * that to a real `Content-Encoding: gzip` and the webview inflates natively — the
 * façade never touches the bytes.
 *
 * Two cache layers ride on top (plan §6):
 *  - A native durable content-addressed store for immutable artifacts. A warm
 *    hit costs zero pipe bytes and `writeStoredAsset` sends the body without
 *    materializing it in Hermes. Build-pinned entries are immutable; unpinned
 *    developer entries remain `no-store` and never enter the store.
 *  - A stable loopback port persisted in AsyncStorage and re-bound across launches,
 *    so the webview's own HTTP cache (keyed by origin) survives app restarts.
 *
 * The only client is the in-app webview (loopback, one request per connection),
 * so the HTTP/1.1 handling is deliberately minimal. Panel RPC still rides the
 * postMessage shell bridge, so this socket carries no management surface and
 * needs no per-request auth.
 */

import TcpSocket from "react-native-tcp-socket";
import { Buffer } from "buffer";
import {
  FORWARD_REQUEST_HEADERS,
  STRIP_RESPONSE_HEADERS,
  GZIP_MARKER_HEADER,
} from "@vibestudio/shared/panel/assetHeaders";
import {
  checkPanelGatewayPath,
  panelAssetCacheKey,
} from "@vibestudio/shared/panel/assetPathPolicy";
export { panelAssetCacheKey } from "@vibestudio/shared/panel/assetPathPolicy";
import type { MobileRpcClient } from "./mobileTransport";
import { getNativeAppStorage } from "./nativeAppStorage";
import {
  MobileAssetStore,
  type MobileAssetStoreNamespace,
  type MobileStoredAsset,
  type MobileStoredAssetMetadata,
} from "./mobileAssetStore";

// The connected-socket type — `Socket` is a member of the default export's
// namespace, not a top-level named export, so derive the instance type from it.
type TcpSocketConn = InstanceType<typeof TcpSocket.Socket> & {
  writeStoredAsset(handle: string, callback?: (error?: Error) => void): boolean;
};

const MAX_REQUEST_HEAD_BYTES = 64 * 1024;
const CONTENT_DIGEST_HEADER = "x-vibestudio-content-digest";
const PERSISTED_PORT_KEY = "vibestudio:panel-asset-facade:port";

export interface PanelAssetFacade {
  port: number;
  /** Enforce the durable store byte cap after a native memory warning. */
  trimCache(): void;
  close(): Promise<void>;
}

// --------------------------------------------------------------------------
// Persisted port (AsyncStorage — a stable loopback origin keeps the webview
// HTTP cache warm across app launches).
// --------------------------------------------------------------------------

async function readPersistedPort(): Promise<number | null> {
  const storage = getNativeAppStorage();
  try {
    const raw = await storage.getItem(PERSISTED_PORT_KEY);
    const port = raw ? Number.parseInt(raw, 10) : NaN;
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

async function writePersistedPort(port: number): Promise<void> {
  const storage = getNativeAppStorage();
  try {
    await storage.setItem(PERSISTED_PORT_KEY, String(port));
  } catch {
    // best-effort
  }
}

export interface MobileFetchedResponse {
  status: number;
  statusText: string;
  gzip: boolean;
  contentType: string;
  replayHeaders: Record<string, string>;
  cacheable: boolean;
  body: ReadableStream<Uint8Array> | null;
}

/**
 * Start the loopback panel-asset façade. Resolves once the port is bound; point
 * `buildPanelUrl` (via `hostConfig.port`) at the returned `port`.
 */
export async function startPanelAssetFacade(
  transport: MobileRpcClient,
  namespace: MobileAssetStoreNamespace
): Promise<PanelAssetFacade> {
  const store = new MobileAssetStore(namespace);
  const preferredPort = await readPersistedPort();
  const activeSockets = new Set<TcpSocketConn>();
  const activeRequests = new Set<Promise<void>>();
  let closing = false;
  let closeFlight: Promise<void> | null = null;

  const server = TcpSocket.createServer((socket) => {
    const connection = socket as TcpSocketConn;
    if (closing) {
      connection.destroy();
      return;
    }
    activeSockets.add(connection);
    connection.once("close", () => activeSockets.delete(connection));
    handleConnection(transport, store, connection, (request) => {
      activeRequests.add(request);
      void request.then(
        () => activeRequests.delete(request),
        () => activeRequests.delete(request)
      );
    });
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
    `[VibestudioMobileSmoke] phase=workspace-panel-facade-listening ${JSON.stringify({ port })}`
  );
  return {
    port,
    trimCache: () => {
      void store
        .trim()
        .then(() =>
          console.log("[VibestudioMobileSmoke] phase=workspace-panel-facade-cache-trimmed")
        )
        .catch((error: unknown) =>
          console.error("[panel-facade] durable asset-store trim failed", error)
        );
    },
    close: () => {
      if (closeFlight) return closeFlight;
      closing = true;
      closeFlight = (async () => {
        const serverClosed = new Promise<void>((resolveClose) => {
          try {
            server.close(() => resolveClose());
          } catch {
            resolveClose();
          }
        });
        for (const socket of activeSockets) socket.destroy();
        await Promise.allSettled([...activeRequests]);
        await store.close();
        await serverClosed;
      })();
      return closeFlight;
    },
  };
}

function handleConnection(
  transport: MobileRpcClient,
  store: MobileAssetStore,
  socket: TcpSocketConn,
  trackRequest: (request: Promise<void>) => void
): void {
  let head = "";
  let dispatched = false;

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

  socket.on("data", (data: string | Uint8Array) => {
    if (dispatched) return;
    const text = typeof data === "string" ? data : Buffer.from(data).toString("latin1");
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
    head = head.slice(0, end);

    const [method = "GET"] = (head.split("\r\n")[0] ?? "").split(" ");
    // Loopback CSRF hardening: the panel-asset façade is an UNAUTHENTICATED local
    // TCP origin (stable port on 127.0.0.1) that any app or browser page on the
    // device can reach. It therefore serves ONLY non-secret GET asset reads.
    // State-changing methods are rejected here (405) before any body is read —
    // real panel RPC, uploads (§1.6), and worker-route calls ride the
    // authenticated WebRTC bridge (postMessage → session.streamReadable), never
    // this socket. See panels' gatewayFetch (tunnels over the bridge, not the
    // loopback origin).
    if (method.toUpperCase() !== "GET") {
      console.warn(`[panel-facade] rejecting non-GET ${method} request — GET-only asset façade`);
      failRequest(405, "Method Not Allowed");
      return;
    }
    dispatched = true;
    trackRequest(handleRequest(transport, store, socket, head));
  });
  socket.on("error", () => {
    try {
      socket.destroy();
    } catch {
      // already gone
    }
  });
}

async function handleRequest(
  transport: MobileRpcClient,
  store: MobileAssetStore,
  socket: TcpSocketConn,
  rawHead: string
): Promise<void> {
  const startedAt = Date.now();
  const lines = rawHead.split("\r\n");
  const [, target = "/"] = (lines[0] ?? "").split(" ");
  const forwardHeaders = collectForwardHeaders(lines.slice(1));
  let headSent = false;
  const decision = checkPanelGatewayPath(target);
  // Belt-and-braces CSRF narrowing: the shared path policy admits `/_r/w/` worker
  // routes (they are panel-reachable over the authenticated bridge), but those
  // are state-changing gateway surfaces that must NOT be proxied through this
  // unauthenticated loopback origin. Reject them at the façade only — the shared
  // policy stays intact so bridge-tunneled gatewayFetch worker calls still work.
  const denyWorkerRoute = decision.allowed && decision.target.startsWith("/_r/w/");
  if (!decision.allowed || denyWorkerRoute) {
    const status = !decision.allowed && decision.denied === "malformed" ? 400 : 403;
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
  const cacheKey = panelAssetCacheKey(gatewayPath, forwardHeaders);
  let tier: "store-hit" | "miss" | "no-store" = "miss";
  let cacheableResponse = false;
  let transferredBytes = 0;
  let bridgeCrossings = 0;
  let ttfbMs: number | null = null;
  const markHeadSent = (): void => {
    headSent = true;
    ttfbMs ??= Date.now() - startedAt;
  };
  const countTransferred = (bytes: number): void => {
    transferredBytes += bytes;
  };

  const fetcher = async (): Promise<MobileFetchedResponse> => {
    // Target the server "main" with the fully-qualified method (the bootstrap's
    // proven bundle-stream call). NOT ("gateway","fetch") — that routes to the
    // streaming endpoint's proxyFetch-only fast path and is rejected. GET-only:
    // no request body ever crosses this façade (uploads ride the bridge).
    bridgeCrossings += 1;
    const result = await transport.streamReadable("main", "gateway.fetch", [
      { path: gatewayPath, method: "GET", headers: forwardHeaders, gzip: true },
    ]);
    return normalizeResult(result);
  };

  try {
    const acquisition = await store.acquire(cacheKey);
    if (acquisition.kind === "hit") {
      tier = "store-hit";
      await writeStoredAsset(socket, acquisition.asset, markHeadSent);
      return;
    }
    try {
      const response = await fetcher();
      if (!response.cacheable || !response.body) {
        tier = "no-store";
        acquisition.complete(null);
        await streamPassthrough(socket, response, markHeadSent, countTransferred);
        return;
      }
      cacheableResponse = true;
      const stored = await streamAndPopulateImmutableAsset(
        socket,
        store,
        cacheKey,
        { ...response, body: response.body },
        markHeadSent,
        countTransferred
      );
      acquisition.complete(stored);
    } catch (error) {
      acquisition.fail(error);
      throw error;
    }
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
  } finally {
    const phase =
      tier === "store-hit"
        ? "workspace-panel-asset-store-hit"
        : tier === "no-store"
          ? "workspace-panel-asset-no-store"
          : "workspace-panel-asset-pipe-miss";
    const telemetry = JSON.stringify({
      routeClass: gatewayPath.split("?", 1)[0]?.split("/", 3)[1] || "root",
      cacheKeyHash: telemetryDigest(cacheKey),
      tier,
      cacheableResponse,
      transferredBytes,
      bridgeCrossings,
      ttfbMs,
      totalMs: Date.now() - startedAt,
    });
    console.log(`[VibestudioMobileSmoke] phase=${phase} ${telemetry}`);
    if (tier === "miss" && cacheableResponse) {
      console.log(
        `[VibestudioMobileSmoke] phase=workspace-panel-cacheable-asset-pipe-miss ${telemetry}`
      );
    }
  }
}

/** Compact opaque request correlation without logging route/query context. */
function telemetryDigest(value: string): string {
  let left = 0x811c9dc5;
  let right = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    left = Math.imul(left ^ code, 0x01000193);
    right = Math.imul(right ^ code, 0x85ebca6b);
  }
  return `${(left >>> 0).toString(16).padStart(8, "0")}${(right >>> 0)
    .toString(16)
    .padStart(8, "0")}`;
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
    cacheable: result.status === 200 && isImmutableCachePolicy(cacheControl),
    body: result.body,
  };
}

function isImmutableCachePolicy(cacheControl: string): boolean {
  const directives = cacheControl.split(",").map((token) => token.trim().toLowerCase());
  return directives.includes("immutable") && !directives.includes("no-store");
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

/** Serve a native-store hit without bringing its body through Hermes. */
async function writeStoredAsset(
  socket: TcpSocketConn,
  asset: MobileStoredAsset,
  onHeadSent: () => void
): Promise<void> {
  const metadata = asset.metadata;
  await writeToSocket(
    socket,
    buildHead(
      metadata.status,
      metadata.statusText,
      metadata.contentType,
      metadata.gzip,
      metadata.replayHeaders,
      {
        contentLength: asset.size,
      }
    )
  );
  onHeadSent();
  await new Promise<void>((resolve, reject) => {
    socket.writeStoredAsset(asset.handle, (error?: Error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  socket.end();
}

/**
 * Cold immutable miss: stream each received chunk to the WebView while also
 * staging it in the durable store. Only the completed, integrity-checked body
 * is published to the cache. A body failure after the HTTP head is visible as
 * an ordinary truncated HTTP response; it is never retried behind the same
 * response and never publishes partial bytes.
 */
export async function streamAndPopulateImmutableAsset(
  socket: TcpSocketConn,
  store: Pick<MobileAssetStore, "openWrite" | "append" | "commit" | "abort">,
  cacheKey: string,
  response: MobileFetchedResponse & { body: ReadableStream<Uint8Array> },
  onHeadSent: () => void,
  onTransferred: (bytes: number) => void
): Promise<MobileStoredAsset> {
  const writeId = await store.openWrite(cacheKey);
  const reader = response.body.getReader();
  let committed = false;
  try {
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
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      onTransferred(value.byteLength);
      await Promise.all([
        store.append(writeId, value),
        writeToSocket(socket, frameHttpChunk(value)),
      ]);
    }
    const metadata: MobileStoredAssetMetadata = {
      status: 200,
      statusText: response.statusText,
      gzip: response.gzip,
      contentType: response.contentType,
      replayHeaders: response.replayHeaders,
    };
    const stored = await store.commit(writeId, metadata);
    committed = true;
    // Do not make the HTTP response complete until atomic cache publication has
    // succeeded. If commit fails, the client sees a truncated response and can
    // retry normally; it can never mistake an uncommitted body for success.
    await writeToSocket(socket, "0\r\n\r\n");
    socket.end();
    return stored;
  } finally {
    reader.releaseLock();
    if (!committed) await store.abort(writeId);
  }
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
  onHeadSent: () => void,
  onTransferred: (bytes: number) => void = () => undefined
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
        onTransferred(value.byteLength);
        await writeToSocket(socket, frameHttpChunk(value));
      }
    }
    await writeToSocket(socket, "0\r\n\r\n");
  } finally {
    reader.releaseLock();
  }
  socket.end();
}

function frameHttpChunk(value: Uint8Array): Uint8Array {
  const prefix = Buffer.from(`${value.byteLength.toString(16)}\r\n`, "ascii");
  const suffix = Buffer.from("\r\n", "ascii");
  const framed = new Uint8Array(prefix.byteLength + value.byteLength + suffix.byteLength);
  framed.set(prefix, 0);
  framed.set(value, prefix.byteLength);
  framed.set(suffix, prefix.byteLength + value.byteLength);
  return framed;
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
