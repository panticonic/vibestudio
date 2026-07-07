/**
 * gatewayFetchService — loopback panel-asset bridge for remote shells.
 *
 * In REMOTE mode the desktop has no local gateway: panels still load from a
 * loopback origin (`buildPanelUrl` → `http://127.0.0.1:{port}/{source}/`), but
 * the asset bytes live on the server. This service exposes a single `fetch`
 * method that the remote shell's panel-asset façade calls over the WebRTC pipe;
 * the server does a LOOPBACK fetch to its OWN gateway and streams the full
 * response back.
 *
 * The gateway serves panel HTML/bundles/runtime helpers without auth (see
 * `Gateway` request routing — "Everything else → panel HTTP handler"), so no
 * token is required for the loopback fetch. A caller-supplied `Authorization`
 * header (and any other descriptor headers) is forwarded verbatim for the rare
 * asset path that wants it, but it is never injected here.
 *
 * The Response streams back over the pipe's bulk channel (panel bundles are MB).
 * REQUEST bodies stream in the same way (plan §1.6): the caller declares a
 * `bodyStreamId` on its stream-open and pumps the body as bulk DATA frames; the
 * transport assembles it into `ctx.body`, which this handler forwards as the
 * loopback request body. Bodies never travel as base64/plain-string fields
 * inside the descriptor — the schema is strict, so a stale caller still sending
 * `body`/`bodyBase64` fails loudly instead of having its body silently dropped.
 *
 * Callers are the trusted desktop principals (`shell`, Electron-hosted `app`),
 * panels, workers, and DOs. Panels normally tunnel their gateway-relative asset
 * fetches here; server-side worker/DO runtimes usually fetch the loopback gateway
 * directly, but the RPC surface is kept available for caller-kind parity and
 * raw-service use.
 *
 * Content digest for the façade's content-addressed cache (plan §6): the façades
 * key their on-disk cache by a content digest. Build artifacts ARE digest-addressed
 * (each carries a build-time `sha256-…` integrity, see buildStore.ts), but that
 * hash is NOT surfaced as a response header by the loopback gateway
 * (`panelHttpServer.writeArtifact` emits Content-Type / Cache-Control / build
 * revision only). We deliberately do NOT reach into that build metadata here or
 * buffer-and-hash the body on this side — this method must stream (bundles exceed
 * the message-size limit), and hashing here would force a full buffer. Instead the
 * façade hashes immutable-cacheable bodies itself on first receipt (digest-on-write;
 * see AssetDiskCache). If a future gateway change emits `x-vibestudio-content-digest`,
 * it rides through untouched (it is not in STRIP_RESPONSE_HEADERS) and the façade
 * prefers it over hashing — no change needed here.
 */

import { z } from "zod";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError } from "@vibestudio/shared/serviceDispatcher";
import { checkPanelGatewayPath } from "@vibestudio/shared/panel/assetPathPolicy";
import { GZIP_MARKER_HEADER, hasRangeRequestHeader } from "@vibestudio/shared/panel/assetHeaders";

/** Loopback fetch request shape sent by the panel-asset façade. The request
 * body (if any) rides the bulk channel as a stream (`ctx.body`), never in here. */
export interface GatewayFetchDescriptor {
  /** Absolute request path (must start with "/"), e.g. `/apps/shell/?contextId=…`. */
  path: string;
  /** HTTP method (defaults to GET). */
  method?: string;
  /** Headers to forward to the loopback gateway (e.g. an `Authorization` bearer). */
  headers?: Record<string, string>;
  /** Gzip the response on the wire; the caller decompresses (see schema comment). */
  gzip?: boolean;
}

// STRICT: a caller still sending the deleted base64/plain-string body fields
// (`body`/`bodyBase64`) must fail loudly, not have its body silently stripped.
const fetchDescriptorSchema = z
  .object({
    path: z.string(),
    method: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // Gzip the response on the wire. react-native-webrtc serializes its bulk-channel
    // receive (one message per round-trip), so a multi-MB asset streams too slowly
    // over a relay; gzip (~4×) keeps it inside the pipe window. The caller is
    // responsible for decompressing (the mobile native host does, before verifying
    // the *uncompressed* integrity). Signaled back via `x-vibestudio-content-gzip`.
    gzip: z.boolean().optional(),
  })
  .strict();

const MOBILE_APP_BOOTSTRAP_PATH = "/_r/s/auth/mobile-app-bootstrap";

function trustedMobileBootstrapTarget(
  ctx: Parameters<NonNullable<ServiceDefinition["handler"]>>[0],
  descriptor: GatewayFetchDescriptor
): string | null {
  const callerKind = ctx.caller.runtime.kind;
  if (callerKind !== "shell" && callerKind !== "app") return null;
  if ((descriptor.method ?? "GET").toUpperCase() !== "POST") return null;
  return descriptor.path === MOBILE_APP_BOOTSTRAP_PATH ? MOBILE_APP_BOOTSTRAP_PATH : null;
}

export function createGatewayFetchService(deps: {
  /** Resolved loopback gateway port (lazy — finalized only after gateway start). */
  getGatewayPort: () => number;
}): ServiceDefinition {
  const serviceName = "gateway";

  return {
    name: serviceName,
    description: "Loopback panel-asset fetch bridge (remote shells)",
    // Reachable by the trusted desktop principals (remote shells call as `shell`
    // via the WebRtcServerClient main session; Electron-hosted runtimes call as
    // `app`) and all userland runtimes. The panel runtime's gatewayFetch tunnels
    // here as the panel principal to load gateway-relative workspace assets.
    // Worker/DO runtimes are server-co-located and normally fetch directly, but
    // allowing the RPC method keeps raw service access and docs aligned with
    // panel rights. The path is forced absolute, checked against the panel-origin
    // allowlist (assetPathPolicy — panel assets, /_r/w/ worker routes, /_a/ app
    // artifacts; NEVER /_r/s/ management routes or /rpc), and appended to the
    // loopback gateway (no external origin), so this grants nothing beyond the
    // same gateway-relative assets. The only management-route exception is the
    // exact mobile native bootstrap POST, and only for trusted shell/app callers.
    policy: { allowed: ["shell", "app", "panel", "worker", "do"] },
    methods: {
      fetch: {
        description:
          "Loopback-fetch a panel asset from the server's own gateway and stream the " +
          "Response back over the pipe's bulk channel (a streaming method). A request " +
          "body streams IN over the same channel (stream-open bodyStreamId → ctx.body).",
        args: z.tuple([fetchDescriptorSchema]),
        // Streaming method: the handler returns a Response whose body is chunked
        // over the bulk channel by handleWsStreamRequest. Node callers use `.stream`
        // (Response); RN callers use `.streamReadable` (the raw ReadableStream).
        returns: z.instanceof(Response),
        access: { sensitivity: "read" },
      },
    },
    handler: async (ctx, method, args) => {
      if (method !== "fetch") {
        throw new ServiceError(serviceName, method, `Unknown gateway method: ${method}`, "ENOSYS");
      }

      const descriptor = args[0] as GatewayFetchDescriptor;
      const trustedTarget = trustedMobileBootstrapTarget(ctx, descriptor);

      // AUTHORITATIVE panel-origin path allowlist (defense in depth — see
      // assetPathPolicy). This service is reachable from the panel/loopback
      // origin, and the gateway namespace it proxies into includes management
      // routes (`/_r/s/*` auth/workspace/webhook, `/rpc`). Panels hold no
      // privileged bearer today, so downstream auth would reject them — but the
      // panel origin must never be able to ADDRESS those routes at all, even if
      // a downstream route's auth regresses. Only panel assets, `/_r/w/` worker
      // routes, and `/_a/` app artifacts pass. The check also normalizes the
      // path exactly like `fetch()` will (dot segments, backslash host escapes
      // like "/\evil.example"), and the normalized `decision.target` — not the
      // raw input — is what gets fetched, so check and fetch cannot diverge.
      // Native mobile shell/app bootstrap is intentionally not a panel-origin
      // asset fetch: it redeems the already paired device credential for the
      // approved React Native app manifest. Keep that hole exact, method-bound,
      // and principal-bound; every other path still uses the panel policy.
      let target = trustedTarget;
      if (!target) {
        const decision = checkPanelGatewayPath(descriptor.path);
        if (!decision.allowed) {
          throw new ServiceError(
            serviceName,
            method,
            `gateway.fetch rejected: ${decision.reason}`,
            decision.denied === "policy" ? "EACCES" : "EINVAL"
          );
        }
        target = decision.target;
      }

      if (!target) {
        throw new ServiceError(
          serviceName,
          method,
          "gateway.fetch rejected: no gateway target resolved",
          "EINVAL"
        );
      }

      const port = deps.getGatewayPort();
      const url = `http://127.0.0.1:${port}${target}`;

      // STREAMING both ways (via the pipe's stream path, handleWsStreamRequest):
      // the response body rides the bulk channel chunked under the data-channel
      // message-size limit, and the request body (ctx.body, plan §1.6) streams in
      // from the same channel. A buffered base64 body in either direction would
      // exceed that limit for real payloads (MB).
      const response = await fetch(url, {
        method: descriptor.method ?? "GET",
        headers: descriptor.headers,
        ...(ctx.body
          ? // undici requires half-duplex to be declared for stream bodies.
            { body: ctx.body, duplex: "half" }
          : {}),
      } as RequestInit);

      const hasRangeSemantics =
        hasRangeRequestHeader(descriptor.headers) ||
        response.status === 206 ||
        response.headers.has("content-range");
      if (descriptor.gzip && response.ok && response.body && !hasRangeSemantics) {
        // Compress on the wire (see schema). The body is re-streamed through a gzip
        // transform; the caller decompresses. Drop content-length — the recompressed
        // length differs and the stream carries no length anyway.
        const headers = new Headers(response.headers);
        headers.set(GZIP_MARKER_HEADER, "1");
        headers.delete("content-length");
        return new Response(response.body.pipeThrough(new CompressionStream("gzip")), {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      return response;
    },
  };
}
