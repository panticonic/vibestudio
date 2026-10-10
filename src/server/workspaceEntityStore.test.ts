import { describe, expect, it, vi } from "vitest";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { DODispatch } from "./doDispatch.js";
import { WorkspaceEntityStore } from "./workspaceEntityStore.js";

const RECORD: EntityRecord = {
  id: "do:vibestudio/internal:EvalDO:abc",
  authoritySessionId: "authority:entity-test",
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
  it("commits cleanup against the exact captured retired authority lifetime", async () => {
    const { store, calls } = makeStore({ entityCleanupComplete: () => undefined });
    await store.cleanupComplete(RECORD.id, "retired-lifetime");
    expect(calls).toEqual([
      { method: "entityCleanupComplete", args: [RECORD.id, "retired-lifetime"] },
    ]);
  });

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
    const first = {
      ...RECORD,
      source: { repoPath: "workers/a", effectiveVersion: "internal" },
      id: "do:workers/a:A:one",
      className: "A",
      key: "one",
    };
    const second = { ...first, id: "do:workers/a:A:two", key: "two" };
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

  it("resolves a mirrored preparing reservation without another WorkspaceDO read", async () => {
    const preparing = { ...RECORD, status: "preparing" as const };
    const { store, entityCache, calls } = makeStore({
      entityReserve: () => preparing,
    });
    await store.reserve({
      kind: preparing.kind,
      source: preparing.source,
      contextId: preparing.contextId,
      className: "EvalDO",
      key: preparing.key,
    });

    await expect(store.resolveCurrentRecord(preparing.id)).resolves.toEqual(preparing);
    expect(entityCache.resolve(preparing.id)).toEqual(preparing);
    expect(calls.map((call) => call.method)).toEqual(["entityReserve"]);
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
  it("admits an immutable owner publication without a nested durable read", async () => {
    const returned = { ...RECORD, source: { ...RECORD.source } };
    const { store, entityCache, calls } = makeStore({ entityActivate: () => returned });
    await store.activate({
      kind: "do",
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    });
    returned.source.effectiveVersion = "tampered";
    expect((await store.resolveInvocationRecord(RECORD.id))?.source.effectiveVersion).toBe(
      "internal"
    );
    expect(Object.isFrozen(entityCache.resolve(RECORD.id)?.source)).toBe(true);
    await store.resolveInvocationRecord(RECORD.id);
    expect(calls.map(({ method }) => method)).toEqual(["entityActivate"]);
  });

  it.each([false, true])(
    "refreshes owner admission after hydration replaces its snapshot (fenced=%s)",
    async (fenced) => {
      const { store, entityCache, calls } = makeStore({
        entityActivate: () => RECORD,
        entityResolve: () => RECORD,
      });
      await store.activate({
        kind: "do",
        source: RECORD.source,
        contextId: RECORD.contextId,
        className: "EvalDO",
        key: RECORD.key,
      });
      const original = await store.resolveInvocationRecord(RECORD.id);
      const hydrated = structuredClone(RECORD);
      hydrated.source.effectiveVersion = "unpublished";
      entityCache.hydrate([hydrated], fenced ? entityCache.beginHydration() : undefined);
      const [first, second] = await Promise.all([
        store.resolveInvocationRecord(RECORD.id),
        store.resolveInvocationRecord(RECORD.id),
      ]);
      expect(first).not.toBe(original);
      expect(first).not.toBe(hydrated);
      expect(first).toBe(second);
      expect(first?.source.effectiveVersion).toBe("internal");
      expect(Object.isFrozen(first)).toBe(true);
      expect(Object.isFrozen(first?.source)).toBe(true);
      await store.resolveInvocationRecord(RECORD.id);
      expect(calls.map(({ method }) => method)).toEqual(["entityActivate", "entityResolve"]);
    }
  );

  it("recovers durable absence when hydration removes a published record", async () => {
    const { store, entityCache, calls } = makeStore({
      entityActivate: () => RECORD,
      entityResolve: () => null,
    });
    await store.activate({
      kind: "do",
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    });
    entityCache.hydrate([], entityCache.beginHydration());
    await expect(store.resolveInvocationRecord(RECORD.id)).resolves.toBeNull();
    expect(entityCache.resolve(RECORD.id)).toBeNull();
    expect(calls.map(({ method }) => method)).toEqual(["entityActivate", "entityResolve"]);
  });

  it("returns the owned recovery receipt even if a publication listener hydrates the cache", async () => {
    const { store, entityCache, calls } = makeStore({ entityResolve: () => RECORD });
    const incidental = Object.freeze({
      ...RECORD,
      source: Object.freeze({ ...RECORD.source, effectiveVersion: "incidental" }),
    });
    let replaced = false;
    entityCache.onChange(() => {
      if (replaced) return;
      replaced = true;
      entityCache.hydrate([incidental], entityCache.beginHydration());
    });
    const receipt = await store.resolveInvocationRecord(RECORD.id);
    expect(receipt?.source.effectiveVersion).toBe("internal");
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(entityCache.resolve(RECORD.id)).toBe(incidental);
    const current = await store.resolveInvocationRecord(RECORD.id);
    expect(current?.source.effectiveVersion).toBe("internal");
    expect(current).not.toBe(receipt);
    expect(current).toBe(entityCache.resolve(RECORD.id));
    expect(calls.map(({ method }) => method)).toEqual(["entityResolve", "entityResolve"]);
  });

  it("coalesces cold durable admission and rejects bootstrap-only identity", async () => {
    let release!: (record: EntityRecord | null) => void;
    const { store, entityCache, calls } = makeStore({
      entityResolve: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    entityCache._onActivate(RECORD);
    const first = store.resolveInvocationRecord(RECORD.id);
    const second = store.resolveInvocationRecord(RECORD.id);
    await Promise.resolve();
    expect(calls.map(({ method }) => method)).toEqual(["entityResolve"]);
    release(RECORD);
    expect(await first).toEqual(RECORD);
    expect(await second).toEqual(RECORD);
    await store.resolveInvocationRecord(RECORD.id);
    expect(calls).toHaveLength(1);
  });

  it("joins a held retirement before admitting another invocation", async () => {
    let release!: (record: EntityRecord) => void;
    const { store, calls } = makeStore({
      entityActivate: () => RECORD,
      entityRetire: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await store.activate({
      kind: "do",
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    });
    const retirement = store.retire(RECORD.id);
    let admitted = false;
    const read = store.resolveInvocationRecord(RECORD.id).then((value) => {
      admitted = true;
      return value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(admitted).toBe(false);
    release({ ...RECORD, status: "retired", retiredAt: 2 });
    await retirement;
    expect((await read)?.status).toBe("retired");
    expect(calls.map(({ method }) => method)).toEqual(["entityActivate", "entityRetire"]);
  });

  it("propagates a failed owner mutation and verifies ambiguous durable state on the next call", async () => {
    const failure = new Error("retirement response disconnected");
    let reject!: (error: Error) => void;
    const retired = { ...RECORD, status: "retired" as const, retiredAt: 2 };
    const { store, calls } = makeStore({
      entityActivate: () => RECORD,
      entityRetire: () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
      entityResolve: () => retired,
    });
    await store.activate({
      kind: "do",
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    });
    const write = store.retire(RECORD.id);
    const read = store.resolveInvocationRecord(RECORD.id);
    const writeFailure = expect(write).rejects.toBe(failure);
    const readFailure = expect(read).rejects.toBe(failure);
    await Promise.resolve();
    await Promise.resolve();
    reject(failure);
    await Promise.all([writeFailure, readFailure]);
    expect((await store.resolveInvocationRecord(RECORD.id))?.status).toBe("retired");
    expect(calls.map(({ method }) => method)).toEqual([
      "entityActivate",
      "entityRetire",
      "entityResolve",
    ]);
  });

  it("serializes overlapping batch replacement while allowing unrelated entity work", async () => {
    const input = {
      kind: "do" as const,
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    };
    const next = { ...RECORD, source: { ...RECORD.source, effectiveVersion: "replacement" } };
    let release!: (records: EntityRecord[]) => void;
    const { store, calls } = makeStore({
      entityActivate: () => RECORD,
      entityAdvanceExecutions: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      entityAdvanceExecution: () => next,
      entityResolve: () => null,
    });
    await store.activate(input);
    const batch = store.advanceExecutions([input]);
    const read = store.resolveInvocationRecord(RECORD.id);
    const replace = store.advanceExecution(input);
    await store.resolveInvocationRecord("do:unrelated");
    expect(calls.map(({ method }) => method)).toEqual([
      "entityActivate",
      "entityAdvanceExecutions",
      "entityResolve",
    ]);
    release([RECORD]);
    await batch;
    expect((await read)?.source.effectiveVersion).toBe("internal");
    await replace;
    expect((await store.resolveInvocationRecord(RECORD.id))?.source.effectiveVersion).toBe(
      "replacement"
    );
  });

  it("does not expose the previous executable while replacement is committing", async () => {
    let release!: (record: EntityRecord) => void;
    const input = {
      kind: "do" as const,
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    };
    const replacement = { ...RECORD, activeExecutionDigest: "e".repeat(64) };
    const { store, calls } = makeStore({
      entityActivate: () => RECORD,
      entityAdvanceExecution: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    await store.activate(input);
    const write = store.advanceExecution(input);
    let settled = false;
    const read = store.resolveInvocationRecord(RECORD.id).then((record) => {
      settled = true;
      return record;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    release(replacement);
    await write;
    expect((await read)?.activeExecutionDigest).toBe(replacement.activeExecutionDigest);
    expect(calls.map(({ method }) => method)).toEqual(["entityActivate", "entityAdvanceExecution"]);
  });

  it("invalidates publication on cache lifecycle changes and rejects a misaddressed durable response", async () => {
    const input = {
      kind: "do" as const,
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    };
    const { store, entityCache } = makeStore({
      entityActivate: () => RECORD,
      entityResolve: () => ({ ...RECORD, id: "do:wrong" }),
    });
    await store.activate(input);
    entityCache._onDelete(RECORD.id);
    await expect(store.resolveInvocationRecord(RECORD.id)).rejects.toThrow(/resolved do:wrong/);
    expect(entityCache.resolve(RECORD.id)).toBeNull();
  });
  it("revokes synchronous authority after an ambiguous mutation and publishes recovered absence", async () => {
    const failure = new Error("entity deletion committed but response disconnected");
    const { store, entityCache, calls } = makeStore({
      entityActivate: () => RECORD,
      entityRetire: () => {
        throw failure;
      },
      entityResolve: () => null,
    });
    await store.activate({
      kind: "do",
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    });
    const changes: string[] = [];
    entityCache.onChange((_id, change) => {
      changes.push(change);
    });
    const hydration = entityCache.beginHydration();
    await expect(store.retire(RECORD.id)).rejects.toBe(failure);
    expect(entityCache.resolveActive(RECORD.id)).toBeNull();
    expect(entityCache.resolve(RECORD.id)).toBeNull();
    expect(changes).toEqual(["invalidate"]);
    entityCache.hydrate([RECORD], hydration);
    expect(entityCache.resolveActive(RECORD.id)).toBeNull();
    await expect(store.resolveInvocationRecord(RECORD.id)).resolves.toBeNull();
    expect(entityCache.resolveActive(RECORD.id)).toBeNull();
    expect(changes).toEqual(["invalidate", "delete"]);
    expect(calls.map(({ method }) => method)).toEqual([
      "entityActivate",
      "entityRetire",
      "entityResolve",
    ]);
  });
  it("publishes durable absence over an incidental active cache record", async () => {
    const { store, entityCache } = makeStore({ entityResolve: () => null });
    entityCache._onActivate(RECORD);
    expect(entityCache.resolveActive(RECORD.id)).toEqual(RECORD);
    await expect(store.resolveInvocationRecord(RECORD.id)).resolves.toBeNull();
    expect(entityCache.resolve(RECORD.id)).toBeNull();
    expect(entityCache.resolveContext(RECORD.id)).toBeNull();
  });
  it("keeps a healthy current agent admitted when new executable preparation is refused", async () => {
    const refusal = new Error("new executable retention reservation refused");
    const entityCache = new EntityCache();
    const dispatch = vi.fn(async (_ref: unknown, method: string) => {
      if (method === "entityActivate") return RECORD;
      throw new Error(`unexpected durable dispatch ${method}`);
    });
    const store = new WorkspaceEntityStore({
      doDispatch: { dispatch } as unknown as DODispatch,
      workspaceId: "ws_1",
      entityCache,
      materializeExecution: async () => undefined,
      executionPublicationPort: {
        reserve() {
          throw refusal;
        },
        finalize() {},
      },
    });
    const current = {
      kind: "do" as const,
      source: RECORD.source,
      contextId: RECORD.contextId,
      className: "EvalDO",
      key: RECORD.key,
    };
    await store.activate(current);
    const admitted = await store.resolveInvocationRecord(RECORD.id);
    const changes: string[] = [];
    entityCache.onChange((_id, change) => {
      changes.push(change);
    });
    const candidate = {
      ...current,
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "e".repeat(64),
    };
    await expect(store.prepareExecution(candidate)).rejects.toBe(refusal);
    await expect(store.advanceExecution(candidate)).rejects.toBe(refusal);
    await expect(store.advanceExecutions([candidate])).rejects.toBe(refusal);
    await expect(store.activate(candidate)).rejects.toBe(refusal);
    expect(entityCache.resolveActive(RECORD.id)).toBe(admitted);
    expect(await store.resolveInvocationRecord(RECORD.id)).toBe(admitted);
    expect(changes).toEqual([]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("retains a known committed identity if retention finalization subsequently fails", async () => {
    const failure = new Error("retention finalization failed after owner commit");
    const entityCache = new EntityCache();
    const store = new WorkspaceEntityStore({
      doDispatch: { dispatch: async () => RECORD } as unknown as DODispatch,
      workspaceId: "ws_1",
      entityCache,
      materializeExecution: async () => undefined,
      executionPublicationPort: {
        reserve() {
          return { reservationId: "reservation", epoch: 1 };
        },
        finalize() {
          throw failure;
        },
      },
    });
    await expect(
      store.activate({
        kind: "do",
        source: RECORD.source,
        contextId: RECORD.contextId,
        className: "EvalDO",
        key: RECORD.key,
        activeBuildKey: "b".repeat(64),
        activeExecutionDigest: "e".repeat(64),
      })
    ).rejects.toBe(failure);
    expect(entityCache.resolveActive(RECORD.id)).toEqual(RECORD);
    expect(await store.resolveInvocationRecord(RECORD.id)).toBe(
      entityCache.resolveActive(RECORD.id)
    );
  });
});
