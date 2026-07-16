import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import {
  InMemoryWebhookIngressStore,
  createWebhookIngressService,
  type WebhookIngressServiceDeps,
} from "./webhookIngressService.js";
import type { RelayWebhookFrame } from "./relayBackhaulClient.js";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceContext } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { WEBHOOK_STORE_DO_SOURCE } from "../internalDOs/productBootManifest.js";
import type {
  CreateWebhookIngressSubscriptionRequest,
  WebhookDeliveryEvent,
  WebhookIngressSubscriptionSummary,
  WebhookTarget,
} from "../../../packages/shared/src/webhooks/ingress.js";

const RELAY_SECRET = "relay-secret-for-tests-only";
const RELAY_BASE_URL = "https://hooks.test";
const DIRECT_BASE_URL = "https://direct.test";

function shellCtx(callerId = "shell"): ServiceContext {
  return createTestServiceContext(createVerifiedCaller(callerId, "shell"));
}

function panelCtx(callerId: string): ServiceContext {
  return createTestServiceContext(
    createVerifiedCaller(callerId, "panel", {
      callerId,
      callerKind: "panel",
      repoPath: TARGET.source,
      executionDigest: "ev-test",
      delegations: [],
      requested: [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
        { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
      ],
    })
  );
}

function _workerCtx(callerId: string): ServiceContext {
  return createTestServiceContext(
    createVerifiedCaller(callerId, "worker", {
      callerId,
      callerKind: "worker",
      repoPath: TARGET.source,
      executionDigest: "ev-test",
      delegations: [],
      requested: [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
        { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
      ],
    })
  );
}

const TARGET: WebhookTarget = {
  source: "workers/github",
  className: "GithubDO",
  objectKey: "main",
  method: "onPush",
};

interface CapturedResponse {
  status: number;
  body: unknown;
  headers: Record<string, string | number | string[]>;
}

function createMockReqRes(
  method: string,
  path: string,
  body: Buffer,
  headers: Record<string, string>
): {
  req: IncomingMessage;
  res: ServerResponse;
  captured: CapturedResponse;
} {
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) lowerHeaders[k.toLowerCase()] = v;

  const req = Object.assign(Readable.from([body]), {
    method,
    url: path,
    headers: lowerHeaders,
  }) as unknown as IncomingMessage;

  const captured: CapturedResponse = { status: 0, body: undefined, headers: {} };
  const writeHead = (status: number, headersOrMessage?: unknown, maybeHeaders?: unknown) => {
    captured.status = status;
    const headersOut =
      typeof headersOrMessage === "object" && headersOrMessage !== null
        ? (headersOrMessage as Record<string, string | number | string[]>)
        : typeof maybeHeaders === "object" && maybeHeaders !== null
          ? (maybeHeaders as Record<string, string | number | string[]>)
          : undefined;
    if (headersOut) Object.assign(captured.headers, headersOut);
    return resStub as ServerResponse;
  };
  const end = (chunk?: unknown) => {
    if (typeof chunk === "string" || Buffer.isBuffer(chunk)) {
      try {
        captured.body = JSON.parse(String(chunk));
      } catch {
        captured.body = String(chunk);
      }
    }
    return resStub as ServerResponse;
  };
  const resStub: Partial<ServerResponse> = {
    writeHead: writeHead as unknown as ServerResponse["writeHead"],
    end: end as unknown as ServerResponse["end"],
  };

  return { req, res: resStub as ServerResponse, captured };
}

/**
 * Build a backhaul webhook frame exactly as the relay's RelayRegistry would —
 * with a valid relay envelope (HMAC over canonical(method,path,query,ts,sha)).
 * This is the on-the-wire contract the server must accept.
 */
function buildRelayFrame(opts: {
  subscriptionId: string;
  body: Buffer;
  providerHeaders?: Record<string, string>;
  query?: string;
  deliveryId?: string;
  ts?: number;
  secret?: string;
  signBodySha?: string;
}): RelayWebhookFrame {
  const method = "POST";
  const path = `/i/${opts.subscriptionId}`;
  const query = opts.query ?? "";
  const ts = opts.ts ?? Date.now();
  const secret = opts.secret ?? RELAY_SECRET;
  const bodySha = crypto.createHash("sha256").update(opts.body).digest("hex");
  const signedSha = opts.signBodySha ?? bodySha;
  const canonical = [method, path, query, String(ts), signedSha].join("\n");
  const signature = `v1=${crypto.createHmac("sha256", secret).update(canonical).digest("hex")}`;
  return {
    t: "webhook",
    deliveryId: opts.deliveryId ?? crypto.randomUUID(),
    subscriptionId: opts.subscriptionId,
    method,
    path,
    query,
    headers: opts.providerHeaders ?? {},
    bodyBase64: opts.body.toString("base64"),
    relay: { timestamp: String(ts), bodySha256: signedSha, signature },
  };
}

function setup(extra: Partial<WebhookIngressServiceDeps> = {}) {
  const store = new InMemoryWebhookIngressStore();
  const dispatched: Array<{ target: WebhookTarget; event: WebhookDeliveryEvent }> = [];
  const registered: string[] = [];
  const unregistered: string[] = [];
  const svc = createWebhookIngressService({
    relaySigningSecret: RELAY_SECRET,
    relayOrigin: RELAY_BASE_URL,
    directPublicBaseUrl: DIRECT_BASE_URL,
    store,
    relayRegistrar: {
      registerWebhook: (id) => registered.push(id),
      unregisterWebhook: (id) => unregistered.push(id),
    },
    dispatchToTarget: async (target, event) => {
      dispatched.push({ target, event });
    },
    ...extra,
  });
  return { store, dispatched, svc, registered, unregistered };
}

/** Decode a WebhookAck's relayed response body back to JSON. */
function ackBody(ack: { response?: { bodyBase64?: string } }): unknown {
  const b64 = ack.response?.bodyBase64;
  return b64 ? JSON.parse(Buffer.from(b64, "base64").toString("utf8")) : undefined;
}

describe("webhookIngressService — RPC surface", () => {
  it("uses direct server dispatch for the infrastructure-owned storage DO", async () => {
    const dispatch = vi.fn(async (_ref, method: string) => (method === "list" ? [] : undefined));
    const svc = createWebhookIngressService({
      doDispatch: { dispatch },
      relayOrigin: RELAY_BASE_URL,
    });

    await expect(svc.definition.handler(shellCtx(), "listSubscriptions", [])).resolves.toEqual([]);
    expect(dispatch).toHaveBeenCalledWith(
      {
        source: WEBHOOK_STORE_DO_SOURCE,
        className: "WebhookStoreDO",
        objectKey: "global",
      },
      "list",
      undefined
    );
  });

  it("attributes an owner-scoped EvalDO lifecycle to its host-verified owner", async () => {
    const evalId = "do:vibestudio/internal:EvalDO:owner-hash";
    const ownerId = "do:workers/github:GithubDO:agent-1";
    const resolveDelegatedCaller = vi.fn(async (callerId: string) =>
      callerId === evalId
        ? { callerId: ownerId, callerKind: "do" as const, repoPath: TARGET.source }
        : null
    );
    const { svc, store } = setup({ resolveDelegatedCaller });
    const ctx = createTestServiceContext(
      createVerifiedCaller(evalId, "do", {
        callerId: evalId,
        callerKind: "do",
        repoPath: "vibestudio/internal",
        executionDigest: "internal",
        delegations: [],
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      })
    );

    const created = (await svc.definition.handler(ctx, "createSubscription", [
      {
        target: TARGET,
        delivery: { mode: "relay" },
        payload: { type: "json" },
        verifier: { type: "bearer", headerName: "Authorization", token: "test-token" },
        response: { successStatus: 202, malformedPayload: "reject", dispatchError: "retry" },
      },
    ])) as WebhookIngressSubscriptionSummary;

    expect(await store.list(evalId)).toEqual([]);
    expect(await store.list(ownerId)).toHaveLength(1);
    await expect(svc.definition.handler(ctx, "listSubscriptions", [])).resolves.toHaveLength(1);
    await svc.definition.handler(ctx, "rotateSecret", [{ subscriptionId: created.subscriptionId }]);
    await svc.definition.handler(ctx, "revokeSubscription", [
      { subscriptionId: created.subscriptionId },
    ]);
    expect((await store.list(ownerId))[0]?.revokedAt).toBeTypeOf("number");
    await expect(svc.definition.handler(ctx, "listSubscriptions", [])).resolves.toEqual([]);
    await expect(
      svc.definition.handler(ctx, "listSubscriptions", [{ includeRevoked: true }])
    ).resolves.toEqual([expect.objectContaining({ subscriptionId: created.subscriptionId })]);
    expect(resolveDelegatedCaller).toHaveBeenCalledWith(evalId);
  });

  it("keeps the raw RPC transport out of agent-facing discovery", () => {
    const { svc } = setup();
    expect(
      Object.values(svc.definition.methods).every((method) => method.agentFacing === false)
    ).toBe(true);
  });

  it("creates, lists, revokes, and rotates subscriptions for a shell caller", async () => {
    const { svc } = setup();
    const ctx = shellCtx();

    const created = (await svc.definition.handler(ctx, "createSubscription", [
      {
        label: "github",
        target: TARGET,
        delivery: { mode: "relay" },
        payload: { type: "json" },
        verifier: {
          type: "hmac-sha256",
          headerName: "X-Hub-Signature-256",
          secret: "shh",
          prefix: "sha256=",
        },
        response: { successStatus: 202, malformedPayload: "reject", dispatchError: "retry" },
      } satisfies CreateWebhookIngressSubscriptionRequest,
    ])) as WebhookIngressSubscriptionSummary;

    expect(created.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.publicUrl).toBe(
      `${RELAY_BASE_URL}/i/${encodeURIComponent(created.subscriptionId)}`
    );
    expect(created.verifier).toMatchObject({ type: "hmac-sha256", hasSecret: true });
    // Secret is stripped from the summary surface
    expect((created.verifier as Record<string, unknown>)["secret"]).toBeUndefined();

    const list = (await svc.definition.handler(
      ctx,
      "listSubscriptions",
      []
    )) as WebhookIngressSubscriptionSummary[];
    expect(list).toHaveLength(1);

    const rotated = (await svc.definition.handler(ctx, "rotateSecret", [
      { subscriptionId: created.subscriptionId },
    ])) as { subscription: WebhookIngressSubscriptionSummary; secret: string };
    expect(rotated.secret).toBeTruthy();
    expect(rotated.secret.length).toBeGreaterThan(20);
    expect(rotated.subscription.subscriptionId).toBe(created.subscriptionId);

    await svc.definition.handler(ctx, "revokeSubscription", [
      { subscriptionId: created.subscriptionId },
    ]);
    const after = (await svc.definition.handler(
      ctx,
      "listSubscriptions",
      []
    )) as WebhookIngressSubscriptionSummary[];
    expect(after).toEqual([]);
    const history = (await svc.definition.handler(ctx, "listSubscriptions", [
      { includeRevoked: true },
    ])) as WebhookIngressSubscriptionSummary[];
    expect(history[0]!.revokedAt).toBeTruthy();
  });

  it("scopes panel callers to their own subscriptions and forbids cross-owner revoke", async () => {
    const { svc } = setup();
    const a = panelCtx("panel-a");
    const b = panelCtx("panel-b");

    const subA = (await svc.definition.handler(a, "createSubscription", [
      {
        target: TARGET,
        delivery: { mode: "relay" },
        payload: { type: "raw" },
        verifier: { type: "bearer", headerName: "Authorization", token: "tok-a", scheme: "Bearer" },
        response: { successStatus: 202, malformedPayload: "reject", dispatchError: "retry" },
      },
    ])) as WebhookIngressSubscriptionSummary;
    await svc.definition.handler(b, "createSubscription", [
      {
        target: TARGET,
        delivery: { mode: "relay" },
        payload: { type: "raw" },
        verifier: { type: "bearer", headerName: "Authorization", token: "tok-b", scheme: "Bearer" },
        response: { successStatus: 202, malformedPayload: "reject", dispatchError: "retry" },
      },
    ]);

    const aList = (await svc.definition.handler(
      a,
      "listSubscriptions",
      []
    )) as WebhookIngressSubscriptionSummary[];
    expect(aList).toHaveLength(1);
    expect(aList[0]!.subscriptionId).toBe(subA.subscriptionId);

    await expect(
      svc.definition.handler(b, "revokeSubscription", [{ subscriptionId: subA.subscriptionId }])
    ).rejects.toThrow(/not owned by caller/);
  });

  it("rejects targets that do not match the caller source for non-shell callers", async () => {
    const { svc } = setup();
    const wrongSourceCtx = createTestServiceContext(
      createVerifiedCaller("worker:1", "worker", {
        callerId: "worker:1",
        callerKind: "worker",
        repoPath: "workers/elsewhere",
        executionDigest: "ev-test",
        delegations: [],
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      })
    );
    await expect(
      svc.definition.handler(wrongSourceCtx, "createSubscription", [
        {
          target: TARGET,
          delivery: { mode: "relay" },
          payload: { type: "raw" },
          verifier: { type: "hmac-sha256", headerName: "X-Sig", secret: "s" },
          response: { successStatus: 202, malformedPayload: "reject", dispatchError: "retry" },
        },
      ])
    ).rejects.toThrow(/must belong to caller source/);
  });
});

describe("webhookIngressService — public ingress route", () => {
  async function provision(
    svc: ReturnType<typeof setup>["svc"],
    verifier: CreateWebhookIngressSubscriptionRequest["verifier"],
    replay?: CreateWebhookIngressSubscriptionRequest["replay"],
    overrides: Partial<
      Pick<CreateWebhookIngressSubscriptionRequest, "delivery" | "payload" | "response">
    > = {}
  ) {
    return (await svc.definition.handler(shellCtx(), "createSubscription", [
      {
        target: TARGET,
        delivery: overrides.delivery ?? { mode: "relay" },
        payload: overrides.payload ?? { type: "json" },
        verifier,
        replay,
        response: overrides.response ?? {
          successStatus: 202,
          malformedPayload: "reject",
          dispatchError: "retry",
        },
      },
    ])) as WebhookIngressSubscriptionSummary;
  }

  function findRoute(svc: ReturnType<typeof setup>["svc"]) {
    const route = svc.routes[0]!;
    return route.handler;
  }

  it("registers a relay subscription with the backhaul on create and unregisters on revoke", async () => {
    const { svc, registered, unregistered } = setup();
    const sub = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    expect(registered).toEqual([sub.subscriptionId]);
    await svc.definition.handler(shellCtx(), "revokeSubscription", [
      { subscriptionId: sub.subscriptionId },
    ]);
    expect(unregistered).toEqual([sub.subscriptionId]);
  });

  it("rejects a backhaul frame whose relay envelope signature is forged (permanent nack)", async () => {
    const { svc, dispatched } = setup();
    const sub = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    const body = Buffer.from(`{"hello":"world"}`);
    const frame = buildRelayFrame({
      subscriptionId: sub.subscriptionId,
      body,
      secret: "wrong-secret",
    });
    const ack = await svc.internal.deliverRelayWebhook(frame);
    expect(ack).toMatchObject({ ok: false, permanent: true, reason: "invalid-relay-envelope" });
    expect(dispatched).toHaveLength(0);
  });

  it("rejects a backhaul frame whose body hash does not match the signed envelope", async () => {
    const { svc } = setup();
    const sub = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    const body = Buffer.from(`{"hello":"world"}`);
    // Sign over a DIFFERENT body sha than the actual body — integrity failure.
    const frame = buildRelayFrame({
      subscriptionId: sub.subscriptionId,
      body,
      signBodySha: crypto.createHash("sha256").update("tampered").digest("hex"),
    });
    const ack = await svc.internal.deliverRelayWebhook(frame);
    expect(ack).toMatchObject({ ok: false, permanent: true, reason: "invalid-relay-envelope" });
  });

  it("accepts a valid HMAC delivery over the backhaul, dispatches once, echoes the response, and dedupes provider replays", async () => {
    const { svc, dispatched } = setup();
    const sub = await provision(
      svc,
      { type: "hmac-sha256", headerName: "X-Sig", secret: "shh", prefix: "sha256=" },
      { key: { type: "header", name: "X-Delivery-Id" }, ttlMs: 60_000 }
    );
    const body = Buffer.from(`{"event":"push"}`);
    const sig = `sha256=${crypto.createHmac("sha256", "shh").update(body).digest("hex")}`;

    const frame = buildRelayFrame({
      subscriptionId: sub.subscriptionId,
      body,
      providerHeaders: {
        "x-sig": sig,
        "x-delivery-id": "delivery-1",
        "content-type": "application/json",
      },
    });
    const ack = await svc.internal.deliverRelayWebhook(frame);
    expect(ack.ok).toBe(true);
    expect(ack.response?.status).toBe(202);
    expect(ackBody(ack)).toEqual({ accepted: true, subscriptionId: sub.subscriptionId });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.target).toEqual(TARGET);
    expect(dispatched[0]!.event.payload).toEqual({ type: "json", json: { event: "push" } });

    // A relay RETRY of the SAME deliveryId re-acks the cached response without re-dispatching.
    const retry = await svc.internal.deliverRelayWebhook(frame);
    expect(retry.ok).toBe(true);
    expect(dispatched).toHaveLength(1);

    // A provider DUPLICATE (new deliveryId, same replay key) is acked but not re-dispatched.
    const dupe = buildRelayFrame({
      subscriptionId: sub.subscriptionId,
      body,
      providerHeaders: { "x-sig": sig, "x-delivery-id": "delivery-1" },
    });
    const dupeAck = await svc.internal.deliverRelayWebhook(dupe);
    expect(dupeAck.ok).toBe(true);
    expect(dispatched).toHaveLength(1);
  });

  it("permanently rejects a backhaul frame with a wrong provider HMAC signature", async () => {
    const { svc, dispatched } = setup();
    const sub = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    const body = Buffer.from(`{"event":"push"}`);
    const frame = buildRelayFrame({
      subscriptionId: sub.subscriptionId,
      body,
      providerHeaders: { "x-sig": "deadbeef" },
    });
    const ack = await svc.internal.deliverRelayWebhook(frame);
    expect(ack).toMatchObject({ ok: false, permanent: true, reason: "invalid-webhook-signature" });
    expect(dispatched).toHaveLength(0);
  });

  it("permanently rejects backhaul deliveries to revoked or unknown subscriptions", async () => {
    const { svc } = setup();
    const sub = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    await svc.definition.handler(shellCtx(), "revokeSubscription", [
      { subscriptionId: sub.subscriptionId },
    ]);
    const body = Buffer.from(`{}`);
    const revoked = await svc.internal.deliverRelayWebhook(
      buildRelayFrame({ subscriptionId: sub.subscriptionId, body })
    );
    expect(revoked).toMatchObject({ ok: false, permanent: true, reason: "subscription-not-found" });

    const unknown = await svc.internal.deliverRelayWebhook(
      buildRelayFrame({ subscriptionId: "00000000-0000-0000-0000-000000000000", body })
    );
    expect(unknown).toMatchObject({ ok: false, permanent: true });
  });

  it("re-announces every live relay subscription (backhaul reconnect / boot)", async () => {
    const { svc, registered } = setup();
    const a = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    const b = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh2" });
    await svc.definition.handler(shellCtx(), "revokeSubscription", [
      { subscriptionId: b.subscriptionId },
    ]);
    registered.length = 0;
    await svc.internal.reannounceRelaySubscriptions();
    // Only the non-revoked relay subscription is re-announced.
    expect(registered).toEqual([a.subscriptionId]);
  });

  it("does NOT serve relay-mode subscriptions over the co-located HTTP route (no unauthenticated inbound)", async () => {
    const { svc, dispatched } = setup();
    const sub = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    const handler = findRoute(svc);
    const body = Buffer.from(`{}`);
    const { req, res, captured } = createMockReqRes("POST", `/i/${sub.subscriptionId}`, body, {
      "content-type": "application/json",
    });
    await handler(req, res, { subscriptionId: sub.subscriptionId });
    expect(captured.status).toBe(404);
    expect(dispatched).toHaveLength(0);
  });

  it("accepts direct query-token deliveries without the relay envelope", async () => {
    const { svc, dispatched } = setup();
    const sub = await provision(
      svc,
      { type: "query-token", paramName: "token", token: "tok" },
      { key: { type: "body-sha256" }, ttlMs: 60_000 },
      { delivery: { mode: "direct" }, payload: { type: "json" } }
    );
    expect(sub.publicUrl).toBe(
      `${DIRECT_BASE_URL}/_r/s/webhookIngress/${encodeURIComponent(sub.subscriptionId)}`
    );
    const handler = findRoute(svc);
    const body = Buffer.from(`{"provider":"direct"}`);
    const path = `/_r/s/webhookIngress/${sub.subscriptionId}?token=tok`;
    const { req, res, captured } = createMockReqRes("POST", path, body, {
      "content-type": "application/json",
    });
    await handler(req, res, { subscriptionId: sub.subscriptionId });
    expect(captured.status).toBe(202);
    expect(dispatched[0]!.event.delivery).toEqual({ mode: "direct" });
    expect(dispatched[0]!.event.payload).toEqual({
      type: "json",
      json: { provider: "direct" },
    });
  });

  it("decodes Cloud Pub/Sub envelopes generically", async () => {
    const { svc, dispatched } = setup();
    const sub = await provision(
      svc,
      { type: "query-token", paramName: "token", token: "tok" },
      { key: { type: "json-pointer", pointer: "/message/messageId" }, ttlMs: 60_000 },
      {
        delivery: { mode: "direct" },
        payload: { type: "cloud-pubsub", decodeData: "json" },
        response: { successStatus: 204, malformedPayload: "ack", dispatchError: "ack" },
      }
    );
    const body = Buffer.from(
      JSON.stringify({
        message: {
          data: Buffer.from(
            JSON.stringify({ emailAddress: "me@example.com", historyId: "h1" })
          ).toString("base64"),
          messageId: "m-1",
          publishTime: "2026-06-17T10:00:00Z",
          attributes: { source: "gmail" },
        },
        subscription: "projects/p/subscriptions/s",
      })
    );
    const first = createMockReqRes(
      "POST",
      `/_r/s/webhookIngress/${sub.subscriptionId}?token=tok`,
      body,
      {}
    );
    await findRoute(svc)(first.req, first.res, { subscriptionId: sub.subscriptionId });
    expect(first.captured.status).toBe(204);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.event.payload).toMatchObject({
      type: "cloud-pubsub",
      subscription: "projects/p/subscriptions/s",
      messageId: "m-1",
      dataJson: { emailAddress: "me@example.com", historyId: "h1" },
    });

    const replay = createMockReqRes(
      "POST",
      `/_r/s/webhookIngress/${sub.subscriptionId}?token=tok`,
      body,
      {}
    );
    await findRoute(svc)(replay.req, replay.res, { subscriptionId: sub.subscriptionId });
    expect(replay.captured.status).toBe(409);
    expect(dispatched).toHaveLength(1);
  });
});
