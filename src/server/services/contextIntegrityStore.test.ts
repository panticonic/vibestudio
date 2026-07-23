import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { ContextIntegrityStore, recordContextIngestionForCaller } from "./contextIntegrityStore.js";
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
