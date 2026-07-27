/**
 * Server → apex-relay backhaul WebSocket client (plan §7).
 *
 * The home server has NO public inbound endpoint. Every third-party callback
 * (OAuth redirects, provider webhooks) arrives at the apex relay
 * (apps/webhook-relay) and is pushed down a persistent, authenticated
 * WebSocket this module holds open to `wss://<relay>/backhaul`. This is the
 * trust anchor: the relay verifies a fresh signature from the workspace's
 * persistent P-256 identity, and webhook ownership is first-writer-wins on its
 * self-certifying relay id (see apps/webhook-relay/src/registry.ts).
 *
 * Responsibilities:
 *   - Dial `/backhaul` with the auth handshake the worker verifies
 *     (`verifyBackhaulAuth`: relayId = SHA-256(publicKey), signature over id+ts).
 *   - Announce desired registrations (`register-webhook`, `register-oauth`) and
 *     RE-ANNOUNCE them on every reconnect (the relay flushes anything buffered
 *     while we were offline on re-registration).
 *   - Receive inbound `webhook` / `oauth-callback` frames, hand them to the
 *     server-side handlers, and reply `ack`/`nack` for webhooks so the relay can
 *     drain its durable buffer (OAuth is single-shot; the relay consumes on its
 *     side, no reply needed).
 *   - Reconnect with exponential backoff and FAIL LOUD (structured logs) while
 *     down — never silently swallow a dead backhaul.
 *
 * Frame schemas mirror the worker EXACTLY (apps/webhook-relay/src/registry.ts).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { WebSocket } from "ws";
import { PAIR_LINK_ORIGIN } from "@vibestudio/shared/connect";

/** Canonical env var naming the apex relay origin (OAuth + webhook + backhaul). */
export const RELAY_URL_ENV = "VIBESTUDIO_RELAY_URL";
export const DEFAULT_RELAY_ORIGIN = PAIR_LINK_ORIGIN;

/**
 * Resolve the relay origin. The Vibestudio apex is the product default; an
 * override is used only for local or staging deployments.
 */
export function getRelayOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env[RELAY_URL_ENV];
  const trimmed = raw?.trim();
  if (!trimmed) return DEFAULT_RELAY_ORIGIN;
  return trimmed.replace(/\/+$/, "");
}

export interface RelayBackhaulIdentity {
  relayId: string;
  publicKey: string;
  sign(payload: string): string;
}

/** Load the workspace's persistent self-certifying relay identity. */
export function loadRelayBackhaulIdentity(identityPemFile: string): RelayBackhaulIdentity {
  const pem = fs.readFileSync(identityPemFile, "utf8");
  const certificate = new crypto.X509Certificate(pem);
  const publicKeyDer = certificate.publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = publicKeyDer.toString("base64url");
  const relayId = `rly_${crypto.createHash("sha256").update(publicKeyDer).digest("hex")}`;
  return {
    relayId,
    publicKey,
    sign: (payload) =>
      crypto
        .sign("sha256", Buffer.from(payload), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        })
        .toString("base64url"),
  };
}

/** Derive the backhaul WebSocket URL (with proof-of-possession auth query). */
export function buildBackhaulUrl(
  origin: string,
  identity: RelayBackhaulIdentity,
  nowMs: number
): string {
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/backhaul";
  const ts = String(nowMs);
  const sig = identity.sign(`${identity.relayId}\n${ts}`);
  url.search = "";
  url.searchParams.set("relayId", identity.relayId);
  url.searchParams.set("ts", ts);
  url.searchParams.set("key", identity.publicKey);
  url.searchParams.set("sig", sig);
  return url.toString();
}

export type OAuthPlatform = "mobile" | "desktop";

export interface RelayWebhookFrame {
  t: "webhook";
  deliveryId: string;
  subscriptionId: string;
  method: string;
  path: string;
  query: string;
  headers: Record<string, string>;
  bodyBase64: string;
  relay: { timestamp: string; bodySha256: string };
}

export interface RelayOAuthCallbackFrame {
  t: "oauth-callback";
  transactionId: string;
  state?: string;
  code?: string;
  error?: string;
}

/** Result the webhook handler returns; shapes the `ack`/`nack` sent to the relay. */
export interface WebhookAck {
  /** Delivered + processed. The relay drops the buffered entry. */
  ok: boolean;
  /** Terminal rejection (bad signature, unknown sub): drop, do not retry. */
  permanent?: boolean;
  /** Optional response relayed back to the provider verbatim (challenge echo). */
  response?: { status: number; bodyBase64?: string; contentType?: string };
  reason?: string;
}

export interface RelayBackhaulLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export interface RelayBackhaulDeps {
  /** Relay origin, e.g. `https://vibestudio.app`. */
  relayOrigin: string;
  /** Self-certifying persistent workspace identity. */
  identity: RelayBackhaulIdentity;
  /** Verify + dispatch an inbound webhook; the ack is sent to the relay. */
  onWebhook: (frame: RelayWebhookFrame) => Promise<WebhookAck>;
  /** Resolve a desktop OAuth transaction pushed down the backhaul. */
  onOAuthCallback: (frame: RelayOAuthCallbackFrame) => void | Promise<void>;
  /** First-writer-wins conflict: another server already owns this id. Fail loud. */
  onRegisterRejected?: (kind: "webhook" | "oauth", id: string, reason?: string) => void;
  now?: () => number;
  logger?: RelayBackhaulLogger;
  /** Injectable for tests. */
  WebSocketCtor?: typeof WebSocket;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /**
   * Fail-loud backstop for a handshake that never opens. GENEROUS — a slow but
   * healthy TLS+upgrade must not be aborted; this only catches a wedged socket.
   */
  handshakeTimeoutMs?: number;
}

export interface RelayBackhaulClient {
  start(): void;
  stop(): Promise<void>;
  registerWebhook(subscriptionId: string): void;
  unregisterWebhook(subscriptionId: string): void;
  registerOAuth(transactionId: string, platform: OAuthPlatform): void;
  readonly connected: boolean;
}

export interface RelayBackhaulHandle {
  client: RelayBackhaulClient;
  start(): void;
  stop(): Promise<void>;
}

export interface StartRelayBackhaulDeps {
  /** Combined certificate/private-key PEM for the persistent workspace identity. */
  identityPemFile: string;
  /** Verify + dispatch an inbound webhook and return the ack for the relay. */
  onWebhook: (frame: RelayWebhookFrame) => Promise<WebhookAck>;
  /** Resolve a desktop OAuth transaction pushed down the backhaul. */
  onOAuthCallback: (frame: RelayOAuthCallbackFrame) => void | Promise<void>;
  env?: NodeJS.ProcessEnv;
  logger?: RelayBackhaulLogger;
  WebSocketCtor?: typeof WebSocket;
}

/**
 * Convenience wiring for src/server/index.ts. Resolves the product-default
 * relay origin and loads the workspace's persistent signing identity.
 *
 * The returned `client` doubles as both the webhook `relayRegistrar` and the
 * credential `relayOAuthRegistrar`. It is NOT auto-started: create the client,
 * hand it to both services as their registrar, THEN call `start()` (and
 * `reannounceRelaySubscriptions()`), so no frame can arrive before the handlers
 * are reachable.
 */
export function startRelayBackhaul(deps: StartRelayBackhaulDeps): RelayBackhaulHandle {
  const env = deps.env ?? process.env;
  const log = deps.logger ?? consoleLogger;
  const relayOrigin = getRelayOrigin(env);
  const identity = loadRelayBackhaulIdentity(deps.identityPemFile);
  const client = createRelayBackhaulClient({
    relayOrigin,
    identity,
    onWebhook: deps.onWebhook,
    onOAuthCallback: deps.onOAuthCallback,
    logger: log,
    ...(deps.WebSocketCtor ? { WebSocketCtor: deps.WebSocketCtor } : {}),
  });
  return {
    client,
    start: () => client.start(),
    stop: () => client.stop(),
  };
}

const DEFAULT_MIN_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;

const consoleLogger: RelayBackhaulLogger = {
  info: (m, meta) => console.log(`[relay-backhaul] ${m}`, meta ?? ""),
  warn: (m, meta) => console.warn(`[relay-backhaul] ${m}`, meta ?? ""),
  error: (m, meta) => console.error(`[relay-backhaul] ${m}`, meta ?? ""),
};

/**
 * Build the backhaul client. It is inert until `start()`. Registrations may be
 * queued before connect; they are (re)sent whenever the socket opens.
 */
export function createRelayBackhaulClient(deps: RelayBackhaulDeps): RelayBackhaulClient {
  const now = deps.now ?? Date.now;
  const log = deps.logger ?? consoleLogger;
  const WsCtor = deps.WebSocketCtor ?? WebSocket;
  const minBackoff = deps.minBackoffMs ?? DEFAULT_MIN_BACKOFF_MS;
  const maxBackoff = deps.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const handshakeTimeout = deps.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

  // Desired registration state, re-announced on every (re)connect.
  const webhookSubs = new Set<string>();
  const oauthTxs = new Map<string, OAuthPlatform>();

  let ws: WebSocket | null = null;
  let stopped = false;
  let backoff = minBackoff;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let handshakeTimer: NodeJS.Timeout | null = null;
  let open = false;

  function safeSend(frame: unknown): boolean {
    if (!ws || ws.readyState !== WsCtor.OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch (err) {
      log.warn("send failed", { err: String(err) });
      return false;
    }
  }

  function announceAll(): void {
    for (const subscriptionId of webhookSubs) safeSend({ t: "register-webhook", subscriptionId });
    for (const [transactionId, platform] of oauthTxs) {
      safeSend({ t: "register-oauth", transactionId, platform });
    }
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(maxBackoff, backoff * 2);
    log.warn("backhaul down; reconnecting", { delayMs: delay });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    // Do not keep the event loop alive solely for a reconnect timer.
    reconnectTimer.unref?.();
  }

  function clearHandshakeTimer(): void {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
  }

  function teardown(socket: WebSocket): void {
    try {
      socket.removeAllListeners?.();
    } catch {
      /* noop */
    }
    try {
      socket.terminate?.();
    } catch {
      /* noop */
    }
  }

  function connect(): void {
    if (stopped || open || (ws && ws.readyState === WsCtor.CONNECTING)) return;
    let url: string;
    try {
      url = buildBackhaulUrl(deps.relayOrigin, deps.identity, now());
    } catch (err) {
      log.error("cannot build backhaul url — relay origin invalid", { err: String(err) });
      return; // Configuration error; do not spin.
    }
    log.info("dialing backhaul", {
      origin: deps.relayOrigin,
      relayId: deps.identity.relayId,
    });
    const socket = new WsCtor(url);
    ws = socket;

    handshakeTimer = setTimeout(() => {
      log.error("backhaul handshake timed out", { timeoutMs: handshakeTimeout });
      teardown(socket);
      if (ws === socket) {
        ws = null;
        open = false;
        scheduleReconnect();
      }
    }, handshakeTimeout);
    handshakeTimer.unref?.();

    socket.on("open", () => {
      if (ws !== socket) return;
      clearHandshakeTimer();
      open = true;
      backoff = minBackoff;
      log.info("backhaul connected", { relayId: deps.identity.relayId });
      announceAll();
    });

    socket.on("message", (data: unknown) => {
      void handleMessage(String(data));
    });

    socket.on("close", (code: number, reason: Buffer) => {
      if (ws !== socket) return;
      clearHandshakeTimer();
      const wasOpen = open;
      open = false;
      ws = null;
      const reasonText = reason?.toString?.() ?? "";
      if (code === 1006 || !wasOpen) {
        // 1006 / never-opened often signals an auth (401) rejection.
        log.error("backhaul closed (possibly rejected)", { code, reason: reasonText });
      } else {
        log.warn("backhaul closed", { code, reason: reasonText });
      }
      scheduleReconnect();
    });

    socket.on("error", (err: unknown) => {
      log.error("backhaul socket error", { err: String(err) });
      // 'close' follows 'error'; reconnect is scheduled there.
    });
  }

  async function handleMessage(text: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(text) as Record<string, unknown>;
    } catch {
      log.warn("dropping non-JSON backhaul frame");
      return;
    }
    switch (frame["t"]) {
      case "registered":
        log.info("registration acked", { kind: frame["kind"], id: frame["id"] });
        return;
      case "unregistered":
        log.info("registration removed", { kind: frame["kind"], id: frame["id"] });
        return;
      case "unregister-rejected":
      case "register-rejected": {
        const kind = frame["kind"] === "oauth" ? "oauth" : "webhook";
        const id = String(frame["id"] ?? "");
        log.error(`${String(frame["t"])} (relay ownership conflict)`, {
          kind,
          id,
          reason: frame["reason"],
        });
        deps.onRegisterRejected?.(kind, id, frame["reason"] as string | undefined);
        return;
      }
      case "webhook":
        return handleWebhookFrame(frame as unknown as RelayWebhookFrame);
      case "oauth-callback":
        return handleOAuthFrame(frame as unknown as RelayOAuthCallbackFrame);
      default:
        log.warn("dropping unknown backhaul frame", { t: frame["t"] });
        return;
    }
  }

  async function handleWebhookFrame(frame: RelayWebhookFrame): Promise<void> {
    const deliveryId = frame.deliveryId;
    if (!deliveryId) {
      log.warn("webhook frame missing deliveryId; dropping");
      return;
    }
    try {
      const ack = await deps.onWebhook(frame);
      if (ack.ok) {
        safeSend({ t: "ack", deliveryId, response: ack.response });
        log.info("webhook delivered", { subscriptionId: frame.subscriptionId, deliveryId });
      } else if (ack.permanent) {
        safeSend({ t: "nack", deliveryId, reason: ack.reason, permanent: true });
        log.warn("webhook permanently rejected", {
          subscriptionId: frame.subscriptionId,
          deliveryId,
          reason: ack.reason,
        });
      } else {
        // Transient failure: nack without permanent so the relay retries.
        safeSend({ t: "nack", deliveryId, reason: ack.reason, permanent: false });
        log.warn("webhook transient failure; will retry", {
          subscriptionId: frame.subscriptionId,
          deliveryId,
          reason: ack.reason,
        });
      }
    } catch (err) {
      // Handler threw — treat as transient so the relay keeps the buffered entry.
      safeSend({ t: "nack", deliveryId, reason: String(err), permanent: false });
      log.error("webhook handler threw; nacked (transient)", { deliveryId, err: String(err) });
    }
  }

  async function handleOAuthFrame(frame: RelayOAuthCallbackFrame): Promise<void> {
    if (!frame.transactionId) {
      log.warn("oauth-callback frame missing transactionId; dropping");
      return;
    }
    try {
      await deps.onOAuthCallback(frame);
      log.info("oauth callback resolved", { transactionId: frame.transactionId });
    } catch (err) {
      log.error("oauth callback handler threw", {
        transactionId: frame.transactionId,
        err: String(err),
      });
    }
  }

  return {
    start(): void {
      if (stopped) throw new Error("relay backhaul client already stopped");
      connect();
    },
    async stop(): Promise<void> {
      stopped = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearHandshakeTimer();
      const socket = ws;
      ws = null;
      open = false;
      if (socket) {
        try {
          socket.close(1000, "server shutdown");
        } catch {
          teardown(socket);
        }
      }
    },
    registerWebhook(subscriptionId: string): void {
      webhookSubs.add(subscriptionId);
      safeSend({ t: "register-webhook", subscriptionId });
    },
    unregisterWebhook(subscriptionId: string): void {
      webhookSubs.delete(subscriptionId);
      safeSend({ t: "unregister-webhook", subscriptionId });
    },
    registerOAuth(transactionId: string, platform: OAuthPlatform): void {
      oauthTxs.set(transactionId, platform);
      safeSend({ t: "register-oauth", transactionId, platform });
    },
    get connected(): boolean {
      return open;
    },
  };
}
