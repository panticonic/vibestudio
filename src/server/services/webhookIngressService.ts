import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import type { CallerKind, ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { hasPanelHostingAuthority } from "@vibestudio/shared/serviceAuthorityChecks";
import {
  createWebhookIngressSubscriptionSchema as createSubscriptionSchema,
  rotateWebhookIngressSecretSchema as rotateSecretSchema,
  webhookIngressMethods,
} from "@vibestudio/service-schemas/webhookIngress";
import type { ServiceRouteDecl } from "../routeRegistry.js";
import { doTargetId, type RpcCallerLike } from "@vibestudio/shared/userlandServiceRpc";
import { WEBHOOK_STORE_DO_SOURCE } from "../internalDOs/productBootManifest.js";
import {
  getHeader,
  summarizeWebhookIngressSubscription,
  timingSafeStringEqual,
  verifyWebhookPayload,
  type CreateWebhookIngressSubscriptionRequest,
  type RotateWebhookIngressSecretRequest,
  type RotateWebhookIngressSecretResult,
  type WebhookDeliveredPayload,
  type WebhookDeliveryEvent,
  type WebhookIngressSubscription,
  type WebhookIngressSubscriptionSummary,
  type WebhookReplayKey,
  type WebhookTarget,
} from "../../../packages/shared/src/webhooks/ingress.js";
import type { RelayWebhookFrame, WebhookAck } from "./relayBackhaulClient.js";
import type { DoDispatcher } from "@vibestudio/shared/doDispatcher";

/**
 * Skew tolerance for the relay envelope timestamp. Generous fail-loud backstop:
 * wide enough that a slow-but-healthy buffered redelivery is never rejected,
 * tight enough that a stale/replayed frame eventually fails closed.
 */
const RELAY_ENVELOPE_TOLERANCE_MS = 5 * 60 * 1000;
/** Remember processed deliveryIds so a relay retry re-acks without re-dispatching. */
const DELIVERY_DEDUPE_TTL_MS = 15 * 60 * 1000;

type JwkWithKeyId = crypto.JsonWebKey & { kid?: string };

export interface WebhookIngressStore {
  create(
    input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">
  ): WebhookIngressSubscription | Promise<WebhookIngressSubscription>;
  get(
    subscriptionId: string
  ): WebhookIngressSubscription | null | Promise<WebhookIngressSubscription | null>;
  list(
    ownerCallerId?: string
  ): WebhookIngressSubscription[] | Promise<WebhookIngressSubscription[]>;
  replace(subscription: WebhookIngressSubscription): void | Promise<void>;
}

export class InMemoryWebhookIngressStore implements WebhookIngressStore {
  private readonly subscriptions = new Map<string, WebhookIngressSubscription>();

  create(
    input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">
  ): WebhookIngressSubscription {
    const now = Date.now();
    const subscription: WebhookIngressSubscription = {
      ...input,
      subscriptionId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.subscriptions.set(subscription.subscriptionId, subscription);
    return subscription;
  }

  get(subscriptionId: string): WebhookIngressSubscription | null {
    return this.subscriptions.get(subscriptionId) ?? null;
  }

  list(ownerCallerId?: string): WebhookIngressSubscription[] {
    return [...this.subscriptions.values()].filter((subscription) =>
      ownerCallerId ? subscription.ownerCallerId === ownerCallerId : true
    );
  }

  replace(subscription: WebhookIngressSubscription): void {
    this.subscriptions.set(subscription.subscriptionId, subscription);
  }
}

export class DOWebhookIngressStore implements WebhookIngressStore {
  private readonly ref = {
    source: WEBHOOK_STORE_DO_SOURCE,
    className: "WebhookStoreDO",
    objectKey: "global",
  };

  constructor(
    private readonly rpc?: RpcCallerLike,
    private readonly doDispatch?: DoDispatcher
  ) {
    if (!rpc && !doDispatch) {
      throw new Error("DOWebhookIngressStore requires an RPC relay or direct server DO dispatch");
    }
  }

  private call(method: string, args: unknown[]): Promise<unknown> {
    // The host activates this exact product entity before constructing the
    // service. Direct dispatch preserves the server caller envelope; the
    // shared dispatch preflight verifies that the durable entity is still
    // active and restores only its recorded immutable artifact.
    if (this.doDispatch) return this.doDispatch.dispatch(this.ref, method, ...args);
    if (!this.rpc) throw new Error("DOWebhookIngressStore has no configured RPC relay");
    return this.rpc.call(doTargetId(this.ref), method, args);
  }

  create(
    input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">
  ): Promise<WebhookIngressSubscription> {
    return this.call("create", [input]) as Promise<WebhookIngressSubscription>;
  }

  get(subscriptionId: string): Promise<WebhookIngressSubscription | null> {
    return this.call("get", [subscriptionId]) as Promise<WebhookIngressSubscription | null>;
  }

  list(ownerCallerId?: string): Promise<WebhookIngressSubscription[]> {
    return this.call("list", [ownerCallerId]) as Promise<WebhookIngressSubscription[]>;
  }

  async replace(subscription: WebhookIngressSubscription): Promise<void> {
    await this.call("replace", [subscription]);
  }
}

/** Registers/unregisters relay-mode subscriptions over the backhaul (§7). */
export interface WebhookRelayRegistrar {
  registerWebhook(subscriptionId: string): void;
  unregisterWebhook(subscriptionId: string): void;
}

export interface WebhookIngressServiceDeps {
  relaySigningSecret?: string;
  /**
   * The single apex relay origin (VIBESTUDIO_RELAY_URL), e.g.
   * `https://vibestudio.app`. Relay-mode subscriptions publish
   * `<relayOrigin>/i/<subscriptionId>` as their provider-facing URL; inbound
   * deliveries then ride the backhaul, not a public server endpoint.
   */
  relayOrigin?: string;
  directPublicBaseUrl?: string | null;
  store?: WebhookIngressStore;
  rpc?: RpcCallerLike;
  /** Server-internal path for the host-owned WebhookStoreDO product entity. */
  doDispatch?: DoDispatcher;
  now?: () => number;
  /**
   * Resolve a trusted internal runtime (currently an owner-scoped EvalDO) to
   * the runtime on whose behalf its ergonomic client operates. The resolver is
   * host-supplied and must use server-authored entity lineage, never call args.
   */
  resolveDelegatedCaller?: (callerId: string) => Promise<{
    callerId: string;
    callerKind: CallerKind;
    repoPath: string;
  } | null>;
  dispatchToTarget?: (target: WebhookTarget, event: WebhookDeliveryEvent) => Promise<unknown>;
  /** Backhaul registrar; relay-mode subscriptions register through it. */
  relayRegistrar?: WebhookRelayRegistrar;
}

export function createWebhookIngressService(deps: WebhookIngressServiceDeps = {}): {
  definition: ServiceDefinition;
  routes: ServiceRouteDecl[];
  internal: {
    store: WebhookIngressStore;
    /** Verify + dispatch a backhaul-delivered webhook; returns the relay ack. */
    deliverRelayWebhook(frame: RelayWebhookFrame): Promise<WebhookAck>;
    /** Re-announce every live relay-mode subscription (call on backhaul connect/boot). */
    reannounceRelaySubscriptions(): Promise<void>;
    revokeForCaller(callerId: string): Promise<number>;
  };
} {
  const store =
    deps.store ??
    (deps.doDispatch || deps.rpc
      ? new DOWebhookIngressStore(deps.rpc, deps.doDispatch)
      : new InMemoryWebhookIngressStore());
  const relayOrigin = deps.relayOrigin ? normalizeBaseUrl(deps.relayOrigin) : null;
  const directPublicBaseUrl = deps.directPublicBaseUrl
    ? normalizeBaseUrl(deps.directPublicBaseUrl)
    : null;
  const now = deps.now ?? Date.now;
  const seenReplayKeys = new Map<string, number>();
  const seenDeliveries = new Map<string, { ack: WebhookAck; expiresAt: number }>();
  const jwksCache = new Map<string, { expiresAt: number; keys: JwkWithKeyId[] }>();

  function toSummary(subscription: WebhookIngressSubscription): WebhookIngressSubscriptionSummary {
    return summarizeWebhookIngressSubscription(subscription);
  }

  type ResolvedCallerScope = {
    ownerCallerId: string;
    ownerCallerKind: CallerKind;
    targetSource: string | null;
  };

  async function callerScope(ctx: ServiceContext): Promise<ResolvedCallerScope> {
    const delegated = await deps.resolveDelegatedCaller?.(ctx.caller.runtime.id);
    return delegated
      ? {
          ownerCallerId: delegated.callerId,
          ownerCallerKind: delegated.callerKind,
          targetSource: delegated.repoPath,
        }
      : {
          ownerCallerId: ctx.caller.runtime.id,
          ownerCallerKind: ctx.caller.runtime.kind,
          targetSource: ctx.caller.code?.repoPath ?? null,
        };
  }

  async function ensureOwner(
    ctx: ServiceContext,
    subscription: WebhookIngressSubscription
  ): Promise<void> {
    if (await hasPanelHostingAuthority(ctx)) return;
    const scope = await callerScope(ctx);
    if (subscription.ownerCallerId !== scope.ownerCallerId) {
      throw new Error("webhook subscription is not owned by caller");
    }
  }

  async function ensureTargetIsCallerSource(
    ctx: ServiceContext,
    target: WebhookTarget,
    resolvedScope?: ResolvedCallerScope
  ): Promise<void> {
    if (await hasPanelHostingAuthority(ctx)) return;
    const scope = resolvedScope ?? (await callerScope(ctx));
    if (!scope.targetSource) {
      throw new Error("webhook target source cannot be verified for caller");
    }
    if (scope.targetSource !== target.source) {
      throw new Error("webhook subscription target must belong to caller source");
    }
  }

  async function createSubscription(
    ctx: ServiceContext,
    input: CreateWebhookIngressSubscriptionRequest
  ): Promise<WebhookIngressSubscriptionSummary> {
    const parsed = createSubscriptionSchema.parse(input) as CreateWebhookIngressSubscriptionRequest;
    const scope = await callerScope(ctx);
    await ensureTargetIsCallerSource(ctx, parsed.target, scope);
    const resolvedBase = parsed.delivery.mode === "direct" ? directPublicBaseUrl : relayOrigin;
    if (resolvedBase === null || resolvedBase === undefined) {
      throw new Error(
        parsed.delivery.mode === "direct"
          ? "direct webhook subscriptions require a co-located gateway URL"
          : "relay webhook subscriptions require VIBESTUDIO_RELAY_URL to be configured"
      );
    }
    const pendingBase = resolvedBase;
    const subscription = await store.create({
      label: parsed.label,
      ownerCallerId: scope.ownerCallerId,
      ownerCallerKind: scope.ownerCallerKind,
      target: parsed.target,
      delivery: parsed.delivery,
      payload: parsed.payload,
      verifier: parsed.verifier,
      replay: parsed.replay,
      response: parsed.response,
      publicUrl: `${pendingBase}/i/pending`,
    });
    const base = resolvedBase;
    const withUrl = {
      ...subscription,
      publicUrl:
        parsed.delivery.mode === "direct"
          ? `${base}/_r/s/webhookIngress/${encodeURIComponent(subscription.subscriptionId)}`
          : `${base}/i/${encodeURIComponent(subscription.subscriptionId)}`,
      updatedAt: now(),
    };
    await store.replace(withUrl);
    // Relay-mode subscriptions are delivered over the backhaul: claim ownership
    // now (first-writer-wins on the relay) so a provider POST to
    // <relayOrigin>/i/<id> can be routed back to this server.
    if (parsed.delivery.mode === "relay") {
      deps.relayRegistrar?.registerWebhook(withUrl.subscriptionId);
    }
    return toSummary(withUrl);
  }

  async function listSubscriptions(
    ctx: ServiceContext,
    options: { includeRevoked?: boolean } = {}
  ): Promise<WebhookIngressSubscriptionSummary[]> {
    const owner = (await hasPanelHostingAuthority(ctx))
      ? undefined
      : (await callerScope(ctx)).ownerCallerId;
    const rows = await store.list(owner);
    return rows
      .filter((subscription) => options.includeRevoked === true || subscription.revokedAt == null)
      .map(toSummary);
  }

  async function revokeSubscription(ctx: ServiceContext, subscriptionId: string): Promise<void> {
    const subscription = await store.get(subscriptionId);
    if (!subscription) return;
    await ensureOwner(ctx, subscription);
    await store.replace({ ...subscription, revokedAt: now() });
    if (subscription.delivery.mode === "relay") {
      deps.relayRegistrar?.unregisterWebhook(subscriptionId);
    }
  }

  async function rotateSecret(
    ctx: ServiceContext,
    input: RotateWebhookIngressSecretRequest
  ): Promise<RotateWebhookIngressSecretResult> {
    const parsed = rotateSecretSchema.parse(input) as RotateWebhookIngressSecretRequest;
    const subscription = await store.get(parsed.subscriptionId);
    if (!subscription || subscription.revokedAt) {
      throw new Error("webhook subscription not found");
    }
    await ensureOwner(ctx, subscription);
    const secret = parsed.secret ?? crypto.randomBytes(32).toString("base64url");
    if (subscription.verifier.type === "oidc-jwt") {
      throw new Error("oidc-jwt webhook subscriptions do not have a rotatable secret");
    }
    const verifier =
      subscription.verifier.type === "bearer" || subscription.verifier.type === "query-token"
        ? { ...subscription.verifier, token: secret }
        : { ...subscription.verifier, secret };
    const updated = {
      ...subscription,
      verifier,
      updatedAt: now(),
    };
    await store.replace(updated);
    return {
      subscription: toSummary(updated),
      secret,
    };
  }

  /**
   * Verify the relay envelope carried IN a backhaul webhook frame. The relay
   * signs `canonical(method,path,query,timestamp,bodySha256)` with the shared
   * secret; we recompute the body hash from the decoded body (integrity) and
   * the HMAC (authenticity), and bound the timestamp skew. Fails closed.
   */
  function verifyRelayFrameEnvelope(frame: RelayWebhookFrame, rawBody: Buffer): boolean {
    if (!deps.relaySigningSecret) return false;
    const relay = frame.relay;
    if (!relay || !relay.timestamp || !relay.bodySha256 || !relay.signature) return false;
    const parsedTs = Number(relay.timestamp);
    if (!Number.isFinite(parsedTs) || Math.abs(now() - parsedTs) > RELAY_ENVELOPE_TOLERANCE_MS) {
      return false;
    }
    const actualBodySha = crypto.createHash("sha256").update(rawBody).digest("hex");
    if (!timingSafeStringEqual(relay.bodySha256, actualBodySha)) return false;
    const canonical = [
      frame.method.toUpperCase(),
      frame.path,
      frame.query ?? "",
      relay.timestamp,
      relay.bodySha256,
    ].join("\n");
    const expected = `v1=${crypto
      .createHmac("sha256", deps.relaySigningSecret)
      .update(canonical)
      .digest("hex")}`;
    return timingSafeStringEqual(relay.signature, expected);
  }

  function pruneSeenDeliveries(nowMs: number): void {
    for (const [id, entry] of seenDeliveries) {
      if (entry.expiresAt <= nowMs) seenDeliveries.delete(id);
    }
  }

  /**
   * Process a webhook delivered over the backhaul and return the ack the relay
   * needs. Idempotent by deliveryId: a relay retry (its buffered entry survived
   * an ack loss / reconnect) re-acks the cached response WITHOUT re-dispatching.
   */
  async function deliverRelayWebhook(frame: RelayWebhookFrame): Promise<WebhookAck> {
    const nowMs = now();
    pruneSeenDeliveries(nowMs);
    const cached = seenDeliveries.get(frame.deliveryId);
    if (cached) return cached.ack;

    const remember = (ack: WebhookAck): WebhookAck => {
      // Only terminal outcomes (ack / permanent nack) are cached; a transient
      // failure must be retried freshly, not short-circuited.
      if (ack.ok || ack.permanent) {
        seenDeliveries.set(frame.deliveryId, { ack, expiresAt: nowMs + DELIVERY_DEDUPE_TTL_MS });
      }
      return ack;
    };

    const rawBody = Buffer.from(frame.bodyBase64 ?? "", "base64");
    if (!verifyRelayFrameEnvelope(frame, rawBody)) {
      return remember({ ok: false, permanent: true, reason: "invalid-relay-envelope" });
    }
    const subscription = await store.get(frame.subscriptionId);
    if (!subscription || subscription.revokedAt) {
      return remember({ ok: false, permanent: true, reason: "subscription-not-found" });
    }
    if (subscription.delivery.mode !== "relay") {
      return remember({ ok: false, permanent: true, reason: "subscription-not-relay" });
    }

    const headers = frame.headers ?? {};
    const url = `${relayOrigin ?? "https://relay.invalid"}${frame.path}${
      frame.query ? `?${frame.query}` : ""
    }`;
    if (!(await verifySubscriptionRequestRaw(subscription, headers, rawBody, url))) {
      return remember({ ok: false, permanent: true, reason: "invalid-webhook-signature" });
    }

    const payload = parseDeliveryPayload(subscription, rawBody);
    if (!payload) {
      if (subscription.response.malformedPayload === "ack") {
        return remember(
          ackResponse(subscription, { accepted: false, reason: "malformed-payload" })
        );
      }
      return remember({ ok: false, permanent: true, reason: "malformed-payload" });
    }
    if (isReplay(subscription, headers, rawBody, payload, seenReplayKeys, nowMs)) {
      // Provider-level duplicate: already handled once — ack so the relay drops it.
      return remember(ackResponse(subscription, { accepted: false, reason: "replay" }));
    }

    const event: WebhookDeliveryEvent = {
      subscriptionId: frame.subscriptionId,
      publicUrl: subscription.publicUrl,
      receivedAt: nowMs,
      delivery: subscription.delivery,
      headers,
      rawBodyBase64: rawBody.toString("base64"),
      payload,
    };
    if (deps.dispatchToTarget) {
      try {
        await deps.dispatchToTarget(subscription.target, event);
      } catch (err) {
        if (subscription.response.dispatchError === "ack") {
          return remember(
            ackResponse(subscription, {
              accepted: false,
              reason: "dispatch-error",
              error: err instanceof Error ? err.message : String(err),
            })
          );
        }
        // retry: transient nack — the relay keeps the buffered entry and retries.
        return { ok: false, permanent: false, reason: "dispatch-error" };
      }
    }
    return remember(
      ackResponse(subscription, { accepted: true, subscriptionId: frame.subscriptionId })
    );
  }

  /** Re-announce every non-revoked relay-mode subscription over the backhaul. */
  async function reannounceRelaySubscriptions(): Promise<void> {
    if (!deps.relayRegistrar) return;
    for (const sub of await store.list()) {
      if (sub.revokedAt) continue;
      if (sub.delivery.mode === "relay") deps.relayRegistrar.registerWebhook(sub.subscriptionId);
    }
  }

  async function handleIngressRoute(
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>
  ): Promise<void> {
    const subscriptionId = params["subscriptionId"];
    if (!subscriptionId) {
      return sendJson(res, 400, { error: "missing subscriptionId" });
    }
    const rawBody = await readRawBody(req);
    const subscription = await store.get(subscriptionId);
    if (!subscription || subscription.revokedAt) {
      return sendJson(res, 404, { error: "webhook subscription not found" });
    }
    // The co-located HTTP route serves DIRECT subscriptions only. Relay-mode
    // deliveries ride the authenticated backhaul; accepting one here (with no
    // relay envelope) would be an unauthenticated inbound path — reject it.
    if (subscription.delivery.mode !== "direct") {
      return sendJson(res, 404, { error: "webhook subscription not found" });
    }
    if (!(await verifySubscriptionRequest(subscription, req, rawBody))) {
      return sendJson(res, 401, { error: "invalid webhook signature" });
    }

    const payload = parseDeliveryPayload(subscription, rawBody);
    if (!payload) {
      if (subscription.response.malformedPayload === "ack") {
        return sendAccepted(res, subscription, { accepted: false, reason: "malformed-payload" });
      }
      return sendJson(res, 400, { error: "malformed webhook payload" });
    }
    if (isReplay(subscription, req.headers, rawBody, payload, seenReplayKeys, now())) {
      return sendJson(res, 409, { error: "webhook replay rejected" });
    }
    const event: WebhookDeliveryEvent = {
      subscriptionId,
      publicUrl: subscription.publicUrl,
      receivedAt: now(),
      delivery: subscription.delivery,
      headers: req.headers,
      rawBodyBase64: rawBody.toString("base64"),
      payload,
    };
    if (deps.dispatchToTarget) {
      try {
        await deps.dispatchToTarget(subscription.target, event);
      } catch (err) {
        if (subscription.response.dispatchError === "ack") {
          return sendAccepted(res, subscription, {
            accepted: false,
            reason: "dispatch-error",
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return sendJson(res, 502, { error: "webhook target dispatch failed" });
      }
    }
    return sendAccepted(res, subscription, { accepted: true, subscriptionId });
  }

  /**
   * Map a subscription's success policy to the ack the relay forwards to the
   * provider verbatim (challenge/response webhooks rely on the body echo).
   */
  function ackResponse(
    subscription: WebhookIngressSubscription,
    body: Record<string, unknown>
  ): WebhookAck {
    if (subscription.response.successStatus === 204) {
      return { ok: true, response: { status: 204 } };
    }
    return {
      ok: true,
      response: {
        status: subscription.response.successStatus,
        bodyBase64: Buffer.from(JSON.stringify(body), "utf8").toString("base64"),
        contentType: "application/json; charset=utf-8",
      },
    };
  }

  async function verifySubscriptionRequest(
    subscription: WebhookIngressSubscription,
    req: IncomingMessage,
    rawBody: Buffer
  ): Promise<boolean> {
    if (subscription.verifier.type === "oidc-jwt") {
      return verifyOidcJwt(subscription.verifier, req.headers, jwksCache, now());
    }
    return verifyWebhookPayload(subscription.verifier, rawBody, req.headers, {
      now: now(),
      url: req.url ?? "",
    });
  }

  /** Same as verifySubscriptionRequest but from a raw headers map + url (backhaul). */
  async function verifySubscriptionRequestRaw(
    subscription: WebhookIngressSubscription,
    headers: Record<string, string>,
    rawBody: Buffer,
    url: string
  ): Promise<boolean> {
    if (subscription.verifier.type === "oidc-jwt") {
      return verifyOidcJwt(subscription.verifier, headers, jwksCache, now());
    }
    return verifyWebhookPayload(subscription.verifier, rawBody, headers, { now: now(), url });
  }

  const definition: ServiceDefinition = {
    name: "webhookIngress",
    description: "Generic public webhook ingress subscriptions",
    authority: { principals: ["user", "host", "code"] },
    methods: webhookIngressMethods,
    handler: defineServiceHandler("webhookIngress", webhookIngressMethods, {
      createSubscription: (ctx, [input]) => createSubscription(ctx, input),
      listSubscriptions: (ctx, [input]) => listSubscriptions(ctx, input ?? {}),
      revokeSubscription: (ctx, [{ subscriptionId }]) => revokeSubscription(ctx, subscriptionId),
      rotateSecret: (ctx, [input]) => rotateSecret(ctx, input),
    }),
  };

  return {
    definition,
    routes: [
      {
        serviceName: "webhookIngress",
        path: "/:subscriptionId",
        methods: ["POST"],
        auth: "public",
        handler: handleIngressRoute,
      },
    ],
    internal: {
      store,
      deliverRelayWebhook,
      reannounceRelaySubscriptions,
      async revokeForCaller(callerId: string): Promise<number> {
        const subs = await store.list(callerId);
        let revoked = 0;
        for (const sub of subs) {
          if (sub.revokedAt != null) continue;
          await store.replace({ ...sub, revokedAt: Date.now() });
          if (sub.delivery.mode === "relay")
            deps.relayRegistrar?.unregisterWebhook(sub.subscriptionId);
          revoked += 1;
        }
        return revoked;
      },
    },
  };
}

function isReplay(
  subscription: WebhookIngressSubscription,
  headers: IncomingMessage["headers"],
  rawBody: Buffer,
  payload: WebhookDeliveredPayload,
  seen: Map<string, number>,
  now: number
): boolean {
  if (!subscription.replay) return false;
  const ttlMs = subscription.replay.ttlMs;
  for (const [key, expiresAt] of seen) {
    if (expiresAt <= now) seen.delete(key);
  }
  const key = computeReplayKey(subscription.replay.key, headers, rawBody, payload);
  if (!key) return false;
  const replayKey = `${subscription.subscriptionId}:${key}`;
  if (seen.has(replayKey)) {
    return true;
  }
  seen.set(replayKey, now + ttlMs);
  return false;
}

function computeReplayKey(
  key: WebhookReplayKey,
  headers: IncomingMessage["headers"],
  rawBody: Buffer,
  payload: WebhookDeliveredPayload
): string | null {
  switch (key.type) {
    case "header": {
      const value = getHeader(headers, key.name);
      return value ? `header:${key.name.toLowerCase()}:${value}` : null;
    }
    case "json-pointer": {
      const value = jsonPointerValue(payloadToPointerRoot(payload), key.pointer);
      return value === undefined || value === null ? null : `json:${key.pointer}:${String(value)}`;
    }
    case "body-sha256":
      return `sha:${crypto.createHash("sha256").update(rawBody).digest("hex")}`;
  }
}

function payloadToPointerRoot(payload: WebhookDeliveredPayload): unknown {
  if (payload.type === "json") return payload.json;
  if (payload.type === "cloud-pubsub") {
    return {
      subscription: payload.subscription,
      message: {
        messageId: payload.messageId,
        publishTime: payload.publishTime,
        attributes: payload.attributes,
        orderingKey: payload.orderingKey,
        data: payload.dataBase64,
        dataText: payload.dataText,
        dataJson: payload.dataJson,
      },
    };
  }
  return {};
}

function jsonPointerValue(root: unknown, pointer: string): unknown {
  if (pointer === "") return root;
  if (!pointer.startsWith("/")) return undefined;
  let current = root;
  for (const rawPart of pointer.slice(1).split("/")) {
    const part = rawPart.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

function parseDeliveryPayload(
  subscription: WebhookIngressSubscription,
  rawBody: Buffer
): WebhookDeliveredPayload | null {
  switch (subscription.payload.type) {
    case "raw":
      return { type: "raw" };
    case "json": {
      const json = parseJson(rawBody);
      return json === undefined ? null : { type: "json", json };
    }
    case "cloud-pubsub":
      return parseCloudPubSubPayload(rawBody, subscription.payload.decodeData);
  }
}

function parseCloudPubSubPayload(
  rawBody: Buffer,
  decodeData: "base64" | "text" | "json"
): WebhookDeliveredPayload | null {
  const envelope = parseJson(rawBody);
  if (!envelope || typeof envelope !== "object") return null;
  const record = envelope as Record<string, unknown>;
  const message = record["message"];
  if (!message || typeof message !== "object") return null;
  const messageRecord = message as Record<string, unknown>;
  const dataBase64 = typeof messageRecord["data"] === "string" ? messageRecord["data"] : undefined;
  let dataText: string | undefined;
  let dataJson: unknown;
  if (dataBase64 && decodeData !== "base64") {
    try {
      dataText = Buffer.from(dataBase64, "base64").toString("utf8");
      if (decodeData === "json") dataJson = JSON.parse(dataText);
    } catch {
      return null;
    }
  }
  const attributesRaw = messageRecord["attributes"];
  const attributes =
    attributesRaw && typeof attributesRaw === "object"
      ? Object.fromEntries(
          Object.entries(attributesRaw as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string"
          )
        )
      : undefined;
  return {
    type: "cloud-pubsub",
    ...(typeof record["subscription"] === "string" ? { subscription: record["subscription"] } : {}),
    ...(typeof messageRecord["messageId"] === "string"
      ? { messageId: messageRecord["messageId"] }
      : {}),
    ...(typeof messageRecord["publishTime"] === "string"
      ? { publishTime: messageRecord["publishTime"] }
      : {}),
    ...(attributes ? { attributes } : {}),
    ...(typeof messageRecord["orderingKey"] === "string"
      ? { orderingKey: messageRecord["orderingKey"] }
      : {}),
    ...(dataBase64 ? { dataBase64 } : {}),
    ...(dataText !== undefined ? { dataText } : {}),
    ...(dataJson !== undefined ? { dataJson } : {}),
  };
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseJson(rawBody: Buffer): unknown | undefined {
  try {
    return JSON.parse(rawBody.toString("utf8"));
  } catch {
    return undefined;
  }
}

function sendAccepted(
  res: ServerResponse,
  subscription: WebhookIngressSubscription,
  body: Record<string, unknown>
): void {
  if (subscription.response.successStatus === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  sendJson(res, subscription.response.successStatus, body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function verifyOidcJwt(
  config: Extract<WebhookIngressSubscription["verifier"], { type: "oidc-jwt" }>,
  headers: IncomingMessage["headers"],
  cache: Map<string, { expiresAt: number; keys: JwkWithKeyId[] }>,
  now: number
): Promise<boolean> {
  const auth = getHeader(headers, config.headerName ?? "Authorization");
  const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : undefined;
  if (!token) return false;
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    return false;
  }
  if (header["alg"] !== "RS256" || typeof header["kid"] !== "string") return false;
  if (payload["iss"] !== config.issuer) return false;
  if (payload["aud"] !== config.audience) return false;
  if (config.serviceAccountEmail && payload["email"] !== config.serviceAccountEmail) return false;
  if (config.serviceAccountEmail && payload["email_verified"] === false) return false;
  const exp = typeof payload["exp"] === "number" ? payload["exp"] * 1000 : 0;
  const iat = typeof payload["iat"] === "number" ? payload["iat"] * 1000 : 0;
  if (exp <= now || iat - 5 * 60 * 1000 > now) return false;

  const jwk = (await getJwks(config.jwksUrl, cache, now)).find((key) => key.kid === header["kid"]);
  if (!jwk) return false;
  try {
    const publicKey = crypto.createPublicKey({ key: jwk, format: "jwk" });
    return crypto.verify(
      "RSA-SHA256",
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      publicKey,
      Buffer.from(encodedSignature, "base64url")
    );
  } catch {
    return false;
  }
}

async function getJwks(
  url: string,
  cache: Map<string, { expiresAt: number; keys: JwkWithKeyId[] }>,
  now: number
): Promise<JwkWithKeyId[]> {
  const cached = cache.get(url);
  if (cached && cached.expiresAt > now) return cached.keys;
  const response = await fetch(url);
  if (!response.ok) return [];
  const json = (await response.json()) as { keys?: JwkWithKeyId[] };
  const maxAge = parseMaxAge(response.headers.get("cache-control"));
  const keys = Array.isArray(json.keys) ? json.keys : [];
  cache.set(url, { keys, expiresAt: now + (maxAge ?? 5 * 60 * 1000) });
  return keys;
}

function parseMaxAge(header: string | null): number | null {
  if (!header) return null;
  const match = /(?:^|,)\s*max-age=(\d+)/i.exec(header);
  return match ? Number(match[1]) * 1000 : null;
}
