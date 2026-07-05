import { describe, expect, it } from "vitest";
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

function makeStore(handlers: Record<string, (...args: unknown[]) => unknown>) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const doDispatch = {
    async dispatch(_ref: unknown, method: string, ...args: unknown[]) {
      calls.push({ method, args });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected dispatch ${method}`);
      return handler(...args);
    },
  } as unknown as DODispatch;
  const entityCache = new EntityCache();
  const store = new WorkspaceEntityStore({ doDispatch, workspaceId: "ws_1", entityCache });
  return { store, entityCache, calls };
}

describe("WorkspaceEntityStore", () => {
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
