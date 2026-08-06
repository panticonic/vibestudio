import { describe, expect, it, vi } from "vitest";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { DODispatch } from "./doDispatch.js";
import { WorkspaceEntityStore } from "./workspaceEntityStore.js";

const RECORD: EntityRecord = {
  id: "do:vibestudio/internal:EvalDO:abc",
  kind: "do",
  source: { repoPath: "vibestudio/internal", effectiveVersion: "internal" },
  contextId: "ctx-1",
  key: "abc",
  createdAt: 1,
  status: "active",
  cleanupComplete: true,
};

function makeStore(
  handlers: Record<string, (...args: unknown[]) => unknown>,
  materializeExecution: (record: EntityRecord) => Promise<void> = async () => undefined,
  entityCache = new EntityCache()
) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const doDispatch = {
    async dispatch(_ref: unknown, method: string, ...args: unknown[]) {
      calls.push({ method, args });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected dispatch ${method}`);
      return handler(...args);
    },
  } as unknown as DODispatch;
  const store = new WorkspaceEntityStore({
    doDispatch,
    workspaceId: "ws_1",
    entityCache,
    materializeExecution,
  });
  return { store, entityCache, calls };
}

describe("WorkspaceEntityStore", () => {
  it("does not dispatch an executable entity write when exact reservation fails", async () => {
    const dispatch = async () => {
      throw new Error("owner write must not run");
    };
    const store = new WorkspaceEntityStore({
      doDispatch: { dispatch } as unknown as DODispatch,
      workspaceId: "ws_1",
      entityCache: new EntityCache(),
      materializeExecution: async () => undefined,
      executionPublicationPort: {
        reserve() {
          throw new Error("execution identity mismatch");
        },
        finalize() {},
      },
    });

    await expect(
      store.activate({
        kind: "worker",
        source: { repoPath: "workers/a", effectiveVersion: "v1" },
        activeBuildKey: "b".repeat(64),
        activeExecutionDigest: "e".repeat(64),
        contextId: "ctx-1",
        key: "one",
      })
    ).rejects.toThrow(/identity mismatch/);
  });

  it("mirrors reservation and activation as one durable panel lifecycle", async () => {
    const reserved = {
      ...RECORD,
      id: "panel:nav-1",
      kind: "panel" as const,
      source: { repoPath: "panels/editor", effectiveVersion: "" },
      key: "nav-1",
      status: "preparing" as const,
    };
    const active = {
      ...reserved,
      source: { repoPath: "panels/editor", effectiveVersion: "ev-1" },
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "e".repeat(64),
      status: "active" as const,
    };
    const { store, entityCache, calls } = makeStore({
      entityReserve: () => reserved,
      entityAdvanceExecution: () => active,
    });

    await store.reserve({
      kind: "panel",
      source: reserved.source,
      contextId: reserved.contextId,
      key: reserved.key,
    });
    expect(entityCache.resolve(reserved.id)?.status).toBe("preparing");
    expect(entityCache.resolveActive(reserved.id)).toBeNull();

    await store.advanceExecution({
      kind: "panel",
      source: active.source,
      activeBuildKey: active.activeBuildKey,
      activeExecutionDigest: active.activeExecutionDigest,
      contextId: active.contextId,
      key: active.key,
    });
    expect(entityCache.resolveActive(active.id)).toEqual(active);
    expect(calls.map((call) => call.method)).toEqual(["entityReserve", "entityAdvanceExecution"]);
  });

  it("mirrors an atomic execution batch only after the durable write returns", async () => {
    const first = { ...RECORD, id: "do:workers/a:A:one", className: "A", key: "one" };
    const second = { ...RECORD, id: "do:workers/a:A:two", className: "A", key: "two" };
    const entityCache = new EntityCache();
    const materialized: string[] = [];
    const made = makeStore(
      { entityAdvanceExecutions: () => [first, second] },
      async (record) => {
        // The whole durable batch is mirrored before any derived attachment is
        // exposed, so cross-object resolution cannot observe a partial batch.
        expect(entityCache.resolveActive(first.id)).toEqual(first);
        expect(entityCache.resolveActive(second.id)).toEqual(second);
        materialized.push(record.id);
      },
      entityCache
    );
    const { store, calls } = made;

    const records = await store.advanceExecutions(
      [first, second].map((record) => ({
        kind: record.kind,
        source: record.source,
        activeBuildKey: "b".repeat(64),
        activeExecutionDigest: "e".repeat(64),
        contextId: record.contextId,
        className: record.className,
        key: record.key,
      }))
    );

    expect(records).toEqual([first, second]);
    expect(entityCache.resolveActive(first.id)).toEqual(first);
    expect(entityCache.resolveActive(second.id)).toEqual(second);
    expect(materialized).toEqual([first.id, second.id]);
    expect(calls[0]?.method).toBe("entityAdvanceExecutions");
  });

  it("activate pairs the durable write with the cache mirror atomically", async () => {
    const { store, entityCache, calls } = makeStore({ entityActivate: () => RECORD });

    // Before activation the cache can't resolve the principal — this is exactly
    // the state that produced the "Unknown principal kind" 403.
    expect(entityCache.resolve(RECORD.id)).toBeNull();

    const result = await store.activate({
      kind: "do",
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    });

    expect(result).toEqual(RECORD);
    // The mirror happened as part of activate — no separate _onActivate call.
    expect(entityCache.resolve(RECORD.id)).toEqual(RECORD);
    expect(entityCache.resolveContext(RECORD.id)).toBe("ctx-1");
    expect(calls).toEqual([
      {
        method: "entityActivate",
        args: [
          {
            kind: "do",
            source: RECORD.source,
            contextId: RECORD.contextId,
            className: "EvalDO",
            key: RECORD.key,
          },
        ],
      },
    ]);
  });

  it("materializes derived execution only after the durable row is cached", async () => {
    const entityCache = new EntityCache();
    const materializeExecution = vi.fn(async (record: EntityRecord) => {
      expect(entityCache.resolveActive(record.id)).toEqual(record);
    });
    const made = makeStore({ entityActivate: () => RECORD }, materializeExecution, entityCache);

    await made.store.activate({
      kind: "do",
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    });

    expect(materializeExecution).toHaveBeenCalledWith(RECORD);
  });

  it("repairs a lost active cache mirror from the durable row", async () => {
    const { store, entityCache, calls } = makeStore({ entityResolveActive: () => RECORD });

    await expect(store.resolveActiveRecord(RECORD.id)).resolves.toEqual(RECORD);
    expect(entityCache.resolveActive(RECORD.id)).toEqual(RECORD);
    await expect(store.resolveActiveRecord(RECORD.id)).resolves.toEqual(RECORD);
    expect(calls.map((call) => call.method)).toEqual(["entityResolveActive"]);
  });

  it("retire mirrors the retirement; a null durable result leaves the cache untouched", async () => {
    const { store, entityCache } = makeStore({
      entityActivate: () => RECORD,
      entityRetire: () => ({ ...RECORD, status: "retired", retiredAt: 2 }),
    });
    await store.activate({
      kind: "do",
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    });
    expect(entityCache.resolveActive(RECORD.id)).toEqual(RECORD);

    const retired = await store.retire(RECORD.id);
    expect(retired?.status).toBe("retired");
    // Retired entity resolves but is no longer "active".
    expect(entityCache.resolveActive(RECORD.id)).toBeNull();
    expect(entityCache.resolve(RECORD.id)?.status).toBe("retired");
  });

  it("retire returning null does not touch the cache", async () => {
    const { store, entityCache, calls } = makeStore({ entityRetire: () => null });
    const result = await store.retire("do:absent");
    expect(result).toBeNull();
    expect(entityCache.resolve("do:absent")).toBeNull();
    expect(calls).toEqual([{ method: "entityRetire", args: ["do:absent"] }]);
  });

  it("resolveContext is cache-first and only falls back to the WorkspaceDO on a miss", async () => {
    let fallbacks = 0;
    const { store, entityCache } = makeStore({
      entityResolveContext: () => {
        fallbacks += 1;
        return "ctx-fallback";
      },
    });

    // Cache miss → DO fallback.
    await expect(store.resolveContext("do:cold")).resolves.toBe("ctx-fallback");
    expect(fallbacks).toBe(1);

    // Cache hit → no fallback dispatch.
    entityCache._onActivate(RECORD);
    await expect(store.resolveContext(RECORD.id)).resolves.toBe("ctx-1");
    expect(fallbacks).toBe(1);
  });
});
