import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { isLineageSetKey } from "@vibestudio/shared/authority/contextIntegrity";
import { stateLayout } from "../stateLayout.js";
import {
  ContextIntegrityStore,
  recordContextIngestionForCaller,
  recordContextIngestionsForCaller,
} from "./contextIntegrityStore.js";
import { createContextIntegrityService } from "./contextIntegrityService.js";

describe("ContextIntegrityStore", () => {
  it("records only model-bound callers and preserves explicit external classification", () => {
    const store = new ContextIntegrityStore({
      statePath: mkdtempSync(join(tmpdir(), "context-integrity-")),
    });
    recordContextIngestionForCaller(
      store,
      { agentBinding: { channelId: "chat" } } as VerifiedCaller,
      {
        key: "log:server",
        via: "server-log:tail",
        classification: "external",
      }
    );
    recordContextIngestionForCaller(store, {} as VerifiedCaller, {
      key: "web:ignored.example",
      via: "not-a-model-session",
      classification: "external",
    });

    expect(store.fact("chat")).toEqual({
      class: "external",
      latchEpoch: 1,
      externalKeys: ["log:server"],
    });
    expect(store.fact("")).toEqual({
      class: "internal",
      latchEpoch: 0,
      externalKeys: [],
    });
    store.close();
  });

  it("persists the monotone server latch across reopen", () => {
    const statePath = mkdtempSync(join(tmpdir(), "context-integrity-"));
    let store = new ContextIntegrityStore({ statePath });
    store.ingest({
      sessionId: "chat",
      key: "web:example.com",
      class: "external",
      via: "gateway-fetch",
      at: new Date(0),
    });
    store.close();
    store = new ContextIntegrityStore({ statePath });
    expect(store.fact("chat")).toEqual({
      class: "external",
      latchEpoch: 1,
      externalKeys: ["web:example.com"],
    });
    store.close();
  });

  it("adopts exact aggregate lineage storage without carrying unverifiable v3 state", () => {
    const statePath = mkdtempSync(join(tmpdir(), "context-integrity-"));
    const databasePath = stateLayout(statePath).governance.contentTrustDb;
    mkdirSync(dirname(databasePath), { recursive: true });
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE session_latches (
        session_id TEXT PRIMARY KEY,
        class TEXT NOT NULL CHECK (class IN ('internal','external')),
        latch_epoch INTEGER NOT NULL CHECK (latch_epoch >= 0),
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE session_lineage (
        session_id TEXT NOT NULL REFERENCES session_latches(session_id) ON DELETE CASCADE,
        lineage_key TEXT NOT NULL,
        class TEXT NOT NULL CHECK (class IN ('internal','external')),
        first_seen TEXT NOT NULL,
        via TEXT NOT NULL,
        count INTEGER NOT NULL CHECK (count > 0),
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (session_id, lineage_key)
      );
      CREATE INDEX session_lineage_order ON session_lineage(session_id, ordinal);
      CREATE TABLE vouches (
        id TEXT PRIMARY KEY,
        subject_kind TEXT NOT NULL CHECK (subject_kind IN ('repo','pkg','blob','file','cutover')),
        subject_key TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        via_prompt TEXT,
        revoked_at TEXT,
        UNIQUE (subject_kind, subject_key)
      );
      CREATE TABLE trust_policies (
        id TEXT PRIMARY KEY,
        pattern_kind TEXT NOT NULL CHECK (pattern_kind IN ('pkg-name','repo-remote')),
        pattern_key TEXT NOT NULL,
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        ceremony TEXT NOT NULL,
        revoked_at TEXT,
        UNIQUE (pattern_kind, pattern_key)
      );
      CREATE TABLE content_trust_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        recorded_at INTEGER NOT NULL
      );
      INSERT INTO session_latches VALUES ('chat', 'external', 1, 1);
      INSERT INTO session_lineage
        VALUES ('chat', 'web:legacy.example', 'external', '1970-01-01T00:00:00.000Z', 'test', 1, 0);
      INSERT INTO vouches
        VALUES ('legacy-vouch', 'blob', 'blob:${"a".repeat(64)}', 'u', '1970-01-01T00:00:00.000Z', NULL, NULL);
      INSERT INTO trust_policies
        VALUES ('policy', 'pkg-name', 'pkg:npm:future', 'u', '1970-01-01T00:00:00.000Z', '{"confirmed":true}', NULL);
      INSERT INTO content_trust_meta
        VALUES ('grandfather-root', 'state:${"b".repeat(64)}', 1);
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const store = new ContextIntegrityStore({ statePath });
    expect(store.fact("chat")).toEqual({
      class: "internal",
      latchEpoch: 0,
      externalKeys: [],
    });
    expect(store.isTrusted(`blob:${"a".repeat(64)}`)).toBe(false);
    expect(store.cutoverRoot()).toBe(`state:${"b".repeat(64)}`);
    store.ingestResolved({
      sessionId: "future",
      key: `pkg:npm:future@1.0.0#${"c".repeat(64)}`,
      via: "package",
    });
    expect(store.fact("future").class).toBe("internal");
    store.close();
  });

  it("records more than 256 exact outside sources as one expandable aggregate", () => {
    const store = new ContextIntegrityStore({
      statePath: mkdtempSync(join(tmpdir(), "context-integrity-")),
    });
    const caller = { agentBinding: { channelId: "chat" } } as VerifiedCaller;
    const inputs = Array.from({ length: 257 }, (_, index) => ({
      key: `web:source-${index}.example`,
      via: "fs-readdir",
      classification: "external" as const,
    }));

    recordContextIngestionsForCaller(store, caller, inputs);

    const fact = store.fact("chat");
    expect(fact).toMatchObject({ class: "external", latchEpoch: 1 });
    expect(fact.externalKeys).toHaveLength(1);
    expect(isLineageSetKey(fact.externalKeys[0]!)).toBe(true);
    expect(store.expandLineageKey(fact.externalKeys[0]!)).toEqual(
      inputs.map((input) => input.key).sort()
    );
    const first = store.explainLineage({
      sessionId: "chat",
      key: fact.externalKeys[0],
      limit: 2,
    });
    expect(first).toMatchObject({
      aggregate: true,
      memberCount: 257,
      digestVerified: true,
      session: { class: "external", via: "fs-readdir", count: 257 },
      pageInfo: { offset: 0, limit: 2, hasMore: true },
    });
    const second = store.explainLineage({
      sessionId: "chat",
      key: fact.externalKeys[0],
      cursor: first.pageInfo.nextCursor!,
      limit: 2,
    });
    expect(second.pageInfo.offset).toBe(2);
    expect([...first.items, ...second.items].map((item) => item.key)).toEqual(
      inputs
        .map((input) => input.key)
        .sort()
        .slice(0, 4)
    );
    expect(() =>
      store.explainLineage({
        sessionId: "chat",
        key: fact.externalKeys[0],
        cursor: Buffer.from(JSON.stringify({ key: "web:other.example", offset: 2 })).toString(
          "base64url"
        ),
      })
    ).toThrow(/Invalid lineage cursor/);
    store.close();
  });

  it("grows one durable aggregate monotonically across successive ingestion", () => {
    const statePath = mkdtempSync(join(tmpdir(), "context-integrity-"));
    let store = new ContextIntegrityStore({ statePath });
    store.ingest({
      sessionId: "chat",
      key: "web:a.example",
      class: "external",
      via: "first",
    });
    store.ingest({
      sessionId: "chat",
      key: "web:b.example",
      class: "external",
      via: "second",
    });
    const beforeRestart = store.fact("chat");
    expect(beforeRestart).toMatchObject({ class: "external", latchEpoch: 2 });
    expect(store.expandLineageKey(beforeRestart.externalKeys[0]!)).toEqual([
      "web:a.example",
      "web:b.example",
    ]);
    store.close();

    store = new ContextIntegrityStore({ statePath });
    store.ingest({
      sessionId: "chat",
      key: "web:c.example",
      class: "external",
      via: "third",
    });
    const afterRestart = store.fact("chat");
    expect(afterRestart).toMatchObject({ class: "external", latchEpoch: 3 });
    expect(store.expandLineageKey(afterRestart.externalKeys[0]!)).toEqual([
      "web:a.example",
      "web:b.example",
      "web:c.example",
    ]);
    store.close();
  });

  it("rejects an unknown aggregate without partially advancing the latch", () => {
    const store = new ContextIntegrityStore({
      statePath: mkdtempSync(join(tmpdir(), "context-integrity-")),
    });
    const caller = { agentBinding: { channelId: "chat" } } as VerifiedCaller;

    expect(() =>
      recordContextIngestionsForCaller(store, caller, [
        {
          key: "web:valid.example",
          via: "fs-readdir",
          classification: "external",
        },
        {
          key: `lineage-set:${"a".repeat(64)}`,
          via: "fs-readdir",
          classification: "external",
        },
      ])
    ).toThrow(/Unknown aggregate lineage set/);
    expect(store.fact("chat")).toEqual({
      class: "internal",
      latchEpoch: 0,
      externalKeys: [],
    });
    expect(() =>
      store.ingest({
        sessionId: "internal",
        key: `lineage-set:${"a".repeat(64)}`,
        class: "internal",
        via: "test",
      })
    ).toThrow(/Unknown aggregate lineage set/);
    expect(store.fact("internal")).toEqual({
      class: "internal",
      latchEpoch: 0,
      externalKeys: [],
    });
    store.close();
  });

  it("permits exact vouches only for content-addressed keys and bounded policy kinds", () => {
    const store = new ContextIntegrityStore({
      statePath: mkdtempSync(join(tmpdir(), "context-integrity-")),
    });
    expect(() => store.vouch({ key: "web:example.com", decidedBy: "u" })).toThrow(
      /not content-addressed/
    );
    const key = `blob:${"a".repeat(64)}`;
    const id = store.vouch({ key, decidedBy: "u" });
    expect(store.isTrusted(key)).toBe(true);
    expect(store.revoke(id)).toBe(true);
    expect(store.isTrusted(key)).toBe(false);

    store.ingestMany({
      sessionId: "set",
      entries: [
        { key: "web:a.example", class: "external", via: "test" },
        { key: "web:b.example", class: "external", via: "test" },
      ],
    });
    const setKey = store.fact("set").externalKeys[0]!;
    const setVouch = store.vouch({ key: setKey, decidedBy: "u" });
    expect(store.isTrusted(setKey)).toBe(true);
    expect(store.revoke(setVouch)).toBe(true);
    expect(store.isTrusted(setKey)).toBe(false);
    store.close();
  });

  it("records the one-way cutover marker without changing its grandfathered root", () => {
    const statePath = mkdtempSync(join(tmpdir(), "context-integrity-"));
    let store = new ContextIntegrityStore({ statePath });
    expect(store.isCutoverComplete()).toBe(false);
    store.ensureCutover(`state:${"a".repeat(64)}`, 10);
    store.ensureCutover(`state:${"b".repeat(64)}`, 20);
    expect(store.isCutoverComplete()).toBe(true);
    expect(store.cutoverRoot()).toBe(`state:${"a".repeat(64)}`);
    store.close();

    store = new ContextIntegrityStore({ statePath });
    expect(store.cutoverRoot()).toBe(`state:${"a".repeat(64)}`);
    store.close();
  });

  it("joins server and runtime facts and floors an unblessed conduit to external", () => {
    const store = new ContextIntegrityStore({
      statePath: mkdtempSync(join(tmpdir(), "context-integrity-")),
    });
    store.ingest({
      sessionId: "chat",
      key: `blob:${"b".repeat(64)}`,
      class: "internal",
      via: "blobstore",
      at: new Date(0),
    });
    expect(
      store.effectiveFact({
        sessionId: "chat",
        attested: { class: "external", latchEpoch: 2, externalKeys: ["web:example.com"] },
        conduitBlessed: true,
      })
    ).toEqual({ class: "external", latchEpoch: 2, externalKeys: ["web:example.com"] });
    expect(
      store.effectiveFact({
        sessionId: "chat",
        attested: { class: "internal", latchEpoch: 3, externalKeys: [] },
        conduitBlessed: false,
      })
    ).toEqual({ class: "external", latchEpoch: 3, externalKeys: ["session:chat"] });
    store.close();
  });

  it("uses exact vouches and bounded policies only for future ingestion", () => {
    const store = new ContextIntegrityStore({
      statePath: mkdtempSync(join(tmpdir(), "context-integrity-")),
    });
    const exact = `pkg:npm:example@1.0.0#${"c".repeat(64)}`;
    store.vouch({ key: exact, decidedBy: "u" });
    store.ingestResolved({ sessionId: "exact", key: exact, via: "package" });
    expect(store.fact("exact").class).toBe("internal");

    store.addTrustPolicy({
      patternKind: "pkg-name",
      patternKey: "pkg:npm:future",
      decidedBy: "u",
      ceremony: { confirmed: true },
    });
    store.ingestResolved({
      sessionId: "future",
      key: `pkg:npm:future@1.0.0#${"d".repeat(64)}`,
      via: "package",
    });
    expect(store.fact("future").class).toBe("internal");
    store.ingestResolved({
      sessionId: "other",
      key: `pkg:npm:other@1.0.0#${"e".repeat(64)}`,
      via: "package",
    });
    expect(store.fact("other").class).toBe("external");
    store.close();
  });

  it("resolves a durable message class before advancing the receiving session", async () => {
    const store = new ContextIntegrityStore({
      statePath: mkdtempSync(join(tmpdir(), "context-integrity-")),
    });
    const service = createContextIntegrityService({
      store,
      resolveMessageClass: async ({ channelId, messageId }) => {
        expect({ channelId, messageId }).toEqual({ channelId: "team", messageId: "env-7" });
        return "external";
      },
    });
    const ctx = {
      authorization: {
        authorizingOrigin: { kind: "code", principal: `code:workers/agent@${"a".repeat(64)}` },
        session: { id: "reader" },
        agentBinding: {
          entity: "entity:reader",
          contextId: "ctx-reader",
          channelId: "reader",
        },
      },
    } as never;

    await service.handler(ctx, "ingest", [
      { key: "msg:team/env-7", via: "channel-message", classification: "derived" },
    ]);

    expect(store.fact("reader")).toEqual({
      class: "external",
      latchEpoch: 1,
      externalKeys: ["msg:team/env-7"],
    });
    store.close();
  });
});
