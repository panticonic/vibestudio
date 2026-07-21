import { describe, expect, it } from "vitest";
import initSqlJs from "sql.js";
import { createTestDO } from "@vibestudio/durable/test-utils";
import { WebhookStoreDO } from "./webhookStoreDO.js";
import type { WebhookIngressSubscription } from "../../../packages/shared/src/webhooks/ingress.js";

type CreateInput = Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">;

function input(overrides: Partial<CreateInput> = {}): CreateInput {
  return {
    label: overrides.label ?? "GitHub push",
    ownerCallerId: overrides.ownerCallerId ?? "panel-abc",
    ownerCallerKind: overrides.ownerCallerKind ?? "panel",
    target: overrides.target ?? {
      source: "workspace/workers/github",
      className: "GithubDO",
      objectKey: "main",
      method: "onPush",
    },
    delivery: overrides.delivery ?? { mode: "relay" },
    payload: overrides.payload ?? { type: "json" },
    verifier: overrides.verifier ?? {
      type: "hmac-sha256",
      headerName: "X-Hub-Signature-256",
      secret: "shh",
      prefix: "sha256=",
    },
    replay: overrides.replay,
    response: overrides.response ?? {
      successStatus: 202,
      malformedPayload: "reject",
      dispatchError: "retry",
    },
    publicUrl: overrides.publicUrl ?? "https://example.test/_w/abc",
    revokedAt: overrides.revokedAt,
  };
}

async function v1Database(replay: unknown) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  db.run(`INSERT INTO state (key, value) VALUES ('schema_version', '1')`);
  db.run(`
    CREATE TABLE webhook_ingress_subscriptions (
      subscription_id TEXT PRIMARY KEY,
      label TEXT,
      owner_caller_id TEXT NOT NULL,
      owner_caller_kind TEXT NOT NULL,
      target_json TEXT NOT NULL,
      verifier_json TEXT NOT NULL,
      replay_json TEXT,
      public_url TEXT NOT NULL,
      revoked_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  const target = {
    source: "workspace/workers/github",
    className: "GithubDO",
    objectKey: "main",
    method: "onPush",
  };
  const verifier = {
    type: "hmac-sha256",
    headerName: "X-Hub-Signature-256",
    secret: "preserve-me",
  };
  db.run(
    `INSERT INTO webhook_ingress_subscriptions (
       subscription_id, label, owner_caller_id, owner_caller_kind, target_json,
       verifier_json, replay_json, public_url, revoked_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "legacy-subscription",
      "legacy",
      "panel-owner",
      "panel",
      JSON.stringify(target),
      JSON.stringify(verifier),
      replay === null ? null : JSON.stringify(replay),
      "https://example.test/legacy",
      null,
      10,
      20,
    ]
  );
  return { db, target, verifier };
}

describe("WebhookStoreDO", () => {
  it("migrates v1 subscriptions without losing identity, secrets, or replay behavior", async () => {
    const { db, target, verifier } = await v1Database({
      deliveryIdHeader: "X-Delivery-Id",
      ttlMs: 1234,
    });

    const { instance, sql } = await createTestDO(WebhookStoreDO, undefined, { db });
    expect(instance.list()).toEqual([
      expect.objectContaining({
        subscriptionId: "legacy-subscription",
        target,
        verifier,
        delivery: { mode: "relay" },
        payload: { type: "json" },
        replay: { key: { type: "header", name: "X-Delivery-Id" }, ttlMs: 1234 },
        response: { successStatus: 202, malformedPayload: "ack", dispatchError: "retry" },
      }),
    ]);
    expect(sql.exec(`SELECT value FROM state WHERE key = 'schema_version'`).one()).toEqual({
      value: "2",
    });
    expect(sql.exec(`PRAGMA table_info(webhook_ingress_subscriptions)`).toArray()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "delivery_json", notnull: 1 }),
        expect.objectContaining({ name: "payload_json", notnull: 1 }),
        expect.objectContaining({ name: "response_json", notnull: 1 }),
      ])
    );
  });

  it.each([
    ["wrong-typed ttl", { ttlMs: "86400000" }],
    ["non-positive ttl", { ttlMs: 0 }],
    ["wrong-typed header", { deliveryIdHeader: 42 }],
    ["unknown replay field", { ttlMs: 1000, unknown: true }],
  ])("rejects corrupt v1 replay data and rolls the migration back: %s", async (_label, replay) => {
    const { db } = await v1Database(replay);

    await expect(createTestDO(WebhookStoreDO, undefined, { db })).rejects.toThrow(
      /invalid replay_json/
    );
    expect(db.exec(`SELECT value FROM state WHERE key = 'schema_version'`)[0]!.values).toEqual([
      ["1"],
    ]);
    expect(
      db.exec(`PRAGMA table_info(webhook_ingress_subscriptions)`)[0]!.values.map((row) => row[1])
    ).not.toContain("delivery_json");
  });

  it("creates, reads, lists, replaces, and revokes subscriptions", async () => {
    const { call } = await createTestDO(WebhookStoreDO);

    const a = await call<WebhookIngressSubscription>("create", input({ label: "alpha" }));
    expect(a.subscriptionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(a.createdAt).toBeGreaterThan(0);
    expect(a.updatedAt).toBe(a.createdAt);

    const b = await call<WebhookIngressSubscription>(
      "create",
      input({ label: "beta", ownerCallerId: "panel-other" })
    );
    expect(b.subscriptionId).not.toBe(a.subscriptionId);

    const fetched = await call<WebhookIngressSubscription | null>("get", a.subscriptionId);
    expect(fetched).toMatchObject({ subscriptionId: a.subscriptionId, label: "alpha" });

    const all = await call<WebhookIngressSubscription[]>("list");
    expect(all).toHaveLength(2);
    const ownerScoped = await call<WebhookIngressSubscription[]>("list", "panel-abc");
    expect(ownerScoped).toHaveLength(1);
    expect(ownerScoped[0]!.label).toBe("alpha");

    const rotated: WebhookIngressSubscription = {
      ...a,
      verifier: { type: "hmac-sha256", headerName: "X-Hub-Signature-256", secret: "rotated" },
      updatedAt: a.updatedAt + 1,
    };
    await call("replace", rotated);
    const reread = await call<WebhookIngressSubscription | null>("get", a.subscriptionId);
    expect((reread!.verifier as { secret: string }).secret).toBe("rotated");

    const revoked: WebhookIngressSubscription = {
      ...rotated,
      revokedAt: Date.now(),
      updatedAt: rotated.updatedAt + 1,
    };
    await call("replace", revoked);
    const afterRevoke = await call<WebhookIngressSubscription | null>("get", a.subscriptionId);
    expect(afterRevoke!.revokedAt).toBeTruthy();
  });

  it("returns null for unknown subscription ids", async () => {
    const { call } = await createTestDO(WebhookStoreDO);
    expect(await call("get", "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await call("list")).toEqual([]);
  });

  it("preserves complex verifier and replay payloads through JSON round-trip", async () => {
    const { call } = await createTestDO(WebhookStoreDO);
    const created = await call<WebhookIngressSubscription>(
      "create",
      input({
        verifier: {
          type: "timestamped-hmac-sha256",
          signatureHeaderName: "X-Slack-Signature",
          timestampHeaderName: "X-Slack-Request-Timestamp",
          secret: "slack-secret",
          encoding: "hex",
          signedPayload: "slack-v0",
          toleranceMs: 300000,
        },
        delivery: { mode: "direct" },
        payload: { type: "cloud-pubsub", decodeData: "json" },
        replay: { key: { type: "json-pointer", pointer: "/message/messageId" }, ttlMs: 60000 },
        response: { successStatus: 204, malformedPayload: "ack", dispatchError: "ack" },
      })
    );

    const fetched = await call<WebhookIngressSubscription | null>("get", created.subscriptionId);
    expect(fetched!.verifier).toMatchObject({
      type: "timestamped-hmac-sha256",
      toleranceMs: 300000,
      signedPayload: "slack-v0",
    });
    expect(fetched!.delivery).toEqual({ mode: "direct" });
    expect(fetched!.payload).toEqual({ type: "cloud-pubsub", decodeData: "json" });
    expect(fetched!.replay).toEqual({
      key: { type: "json-pointer", pointer: "/message/messageId" },
      ttlMs: 60000,
    });
    expect(fetched!.response).toEqual({
      successStatus: 204,
      malformedPayload: "ack",
      dispatchError: "ack",
    });
  });
});
