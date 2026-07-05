import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";

import {
  InMemoryWebhookIngressStore,
  createWebhookIngressService,
  type WebhookIngressServiceDeps,
} from "./webhookIngressService.js";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
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
  return { caller: createVerifiedCaller(callerId, "shell") };
}

function panelCtx(callerId: string): ServiceContext {
  return {
    caller: createVerifiedCaller(callerId, "panel", {
      callerId,
      callerKind: "panel",
      repoPath: TARGET.source,
      effectiveVersion: "ev-test",
    }),
  };
}

function _workerCtx(callerId: string): ServiceContext {
  return {
    caller: createVerifiedCaller(callerId, "worker", {
      callerId,
      callerKind: "worker",
      repoPath: TARGET.source,
      effectiveVersion: "ev-test",
    }),
  };
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

function signRelayEnvelope(
  method: string,
  path: string,
  query: string,
  body: Buffer,
  secret: string,
  ts = Date.now()
) {
  const bodySha = crypto.createHash("sha256").update(body).digest("hex");
  const canonical = [method.toUpperCase(), path, query, String(ts), bodySha].join("\n");
  const sig = `v1=${crypto.createHmac("sha256", secret).update(canonical).digest("hex")}`;
  return {
    "x-vibestudio-relay-method": method,
    "x-vibestudio-relay-path": path,
    "x-vibestudio-relay-query": query,
    "x-vibestudio-relay-timestamp": String(ts),
    "x-vibestudio-relay-body-sha256": bodySha,
    "x-vibestudio-relay-signature": sig,
  };
}

function setup(extra: Partial<WebhookIngressServiceDeps> = {}) {
  const store = new InMemoryWebhookIngressStore();
  const dispatched: Array<{ target: WebhookTarget; event: WebhookDeliveryEvent }> = [];
  const svc = createWebhookIngressService({
    relaySigningSecret: RELAY_SECRET,
    relayPublicBaseUrl: RELAY_BASE_URL,
    directPublicBaseUrl: DIRECT_BASE_URL,
    store,
    dispatchToTarget: async (target, event) => {
      dispatched.push({ target, event });
    },
    ...extra,
  });
  return { store, dispatched, svc };
}

describe("webhookIngressService — RPC surface", () => {
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
    expect(after[0]!.revokedAt).toBeTruthy();
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
    const wrongSourceCtx: ServiceContext = {
      caller: createVerifiedCaller("worker:1", "worker", {
        callerId: "worker:1",
        callerKind: "worker",
        repoPath: "workers/elsewhere",
        effectiveVersion: "ev-test",
      }),
    };
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

  it("rejects deliveries without a valid relay envelope", async () => {
    const { svc } = setup();
    const sub = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    const handler = findRoute(svc);
    const body = Buffer.from(`{"hello":"world"}`);
    const { req, res, captured } = createMockReqRes("POST", `/i/${sub.subscriptionId}`, body, {
      "x-sig": "anything",
      "content-type": "application/json",
    });
    await handler(req, res, { subscriptionId: sub.subscriptionId });
    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ error: "invalid relay envelope" });
  });

  it("accepts a valid HMAC delivery, dispatches once, and rejects replays", async () => {
    const { svc, dispatched } = setup();
    const sub = await provision(
      svc,
      { type: "hmac-sha256", headerName: "X-Sig", secret: "shh", prefix: "sha256=" },
      { key: { type: "header", name: "X-Delivery-Id" }, ttlMs: 60_000 }
    );
    const handler = findRoute(svc);
    const body = Buffer.from(`{"event":"push"}`);
    const sig = `sha256=${crypto.createHmac("sha256", "shh").update(body).digest("hex")}`;
    const path = `/i/${sub.subscriptionId}`;

    const headersA = {
      ...signRelayEnvelope("POST", path, "", body, RELAY_SECRET),
      "x-sig": sig,
      "x-delivery-id": "delivery-1",
      "content-type": "application/json",
    };

    const first = createMockReqRes("POST", path, body, headersA);
    await handler(first.req, first.res, { subscriptionId: sub.subscriptionId });
    expect(first.captured.status).toBe(202);
    expect(first.captured.body).toEqual({ accepted: true, subscriptionId: sub.subscriptionId });
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]!.target).toEqual(TARGET);
    expect(dispatched[0]!.event.payload).toEqual({ type: "json", json: { event: "push" } });

    // Replay with the same delivery id must be rejected
    const second = createMockReqRes("POST", path, body, {
      ...signRelayEnvelope("POST", path, "", body, RELAY_SECRET),
      "x-sig": sig,
      "x-delivery-id": "delivery-1",
    });
    await handler(second.req, second.res, { subscriptionId: sub.subscriptionId });
    expect(second.captured.status).toBe(409);
    expect(second.captured.body).toEqual({ error: "webhook replay rejected" });
    expect(dispatched).toHaveLength(1);
  });

  it("rejects payloads with a wrong HMAC signature", async () => {
    const { svc, dispatched } = setup();
    const sub = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    const handler = findRoute(svc);
    const body = Buffer.from(`{"event":"push"}`);
    const path = `/i/${sub.subscriptionId}`;
    const { req, res, captured } = createMockReqRes("POST", path, body, {
      ...signRelayEnvelope("POST", path, "", body, RELAY_SECRET),
      "x-sig": "deadbeef",
    });
    await handler(req, res, { subscriptionId: sub.subscriptionId });
    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ error: "invalid webhook signature" });
    expect(dispatched).toHaveLength(0);
  });

  it("rejects deliveries to revoked or unknown subscriptions", async () => {
    const { svc } = setup();
    const sub = await provision(svc, { type: "hmac-sha256", headerName: "X-Sig", secret: "shh" });
    await svc.definition.handler(shellCtx(), "revokeSubscription", [
      { subscriptionId: sub.subscriptionId },
    ]);
    const handler = findRoute(svc);
    const body = Buffer.from(`{}`);
    const path = `/i/${sub.subscriptionId}`;
    const { req, res, captured } = createMockReqRes("POST", path, body, {
      ...signRelayEnvelope("POST", path, "", body, RELAY_SECRET),
      "x-sig": "x",
    });
    await handler(req, res, { subscriptionId: sub.subscriptionId });
    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({ error: "webhook subscription not found" });

    const unknownPath = "/i/00000000-0000-0000-0000-000000000000";
    const unknown = createMockReqRes("POST", unknownPath, body, {
      ...signRelayEnvelope("POST", unknownPath, "", body, RELAY_SECRET),
      "x-sig": "x",
    });
    await handler(unknown.req, unknown.res, {
      subscriptionId: "00000000-0000-0000-0000-000000000000",
    });
    expect(unknown.captured.status).toBe(404);
  });

  it("accepts a valid bearer token delivery", async () => {
    const { svc, dispatched } = setup();
    const sub = await provision(svc, {
      type: "bearer",
      headerName: "Authorization",
      token: "tok",
      scheme: "Bearer",
    });
    const handler = findRoute(svc);
    const body = Buffer.from(`{}`);
    const path = `/i/${sub.subscriptionId}`;
    const { req, res, captured } = createMockReqRes("POST", path, body, {
      ...signRelayEnvelope("POST", path, "", body, RELAY_SECRET),
      authorization: "Bearer tok",
    });
    await handler(req, res, { subscriptionId: sub.subscriptionId });
    expect(captured.status).toBe(202);
    expect(dispatched).toHaveLength(1);
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
