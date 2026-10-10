import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";

import { WorkspaceDO } from "@panticonic/builtin/workspace-state";
import { WorkspaceDOTestable } from "@panticonic/builtin/workspace-state/test-fixture";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import {
  createEntityRetirementCleanup,
  type EntityRetirementCleanup,
} from "./entityRetirementCleanup.js";
import {
  createStartupReconciliationWorkspaceState,
  runStartupReconciliation,
} from "./startupReconciliation.js";

describe("runStartupReconciliation", () => {
  let workspaceDO: WorkspaceDO;
  let cleanup: EntityRetirementCleanup;
  beforeEach(async () => {
    ({ instance: workspaceDO } = await createTestDO(WorkspaceDOTestable));
    cleanup = createEntityRetirementCleanup({
      resolveRecord: async (id) => workspaceDO.entityResolve(id),
      cleanup: async () => {},
      complete: async (id, lifetime) => {
        workspaceDO.entityCleanupComplete(id, lifetime);
      },
    });
  });

  function dispatchWorkspaceDO(method: string, args: unknown[] = []): Promise<unknown> {
    const fn = (workspaceDO as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== "function") {
      return Promise.reject(new Error(`Unknown WorkspaceDO method: ${method}`));
    }
    return Promise.resolve(fn.apply(workspaceDO, args));
  }

  function workspaceState() {
    return createStartupReconciliationWorkspaceState(dispatchWorkspaceDO);
  }

  it("rehydrates a sealed preparation as an image owner without restoring runnable execution", async () => {
    const input = {
      kind: "panel" as const,
      source: { repoPath: "panels/clone", effectiveVersion: "" },
      contextId: "prepared-context",
      key: "prepared-key",
    };
    workspaceDO.entityReserve(input);
    const prepared = workspaceDO.entityPrepareExecution({
      ...input,
      source: { ...input.source, effectiveVersion: "prepared-version" },
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "e".repeat(64),
      activeAuthority: { provides: [], requests: [] },
    });
    const entityCache = new EntityCache();
    const restoreRuntimes = vi.fn(async () => {});
    await runStartupReconciliation({
      workspaceState: workspaceState(),
      entityCache,
      onRetire: cleanup.retire,
      restoreRuntimes,
    });
    expect(entityCache.listExecutionOwners()).toEqual([prepared]);
    expect(entityCache.resolveActive(prepared.id)).toBeNull();
    expect(restoreRuntimes).toHaveBeenCalledWith([]);
  });

  it("hydrates active entities, GCs expired retired rows, and marks incomplete cleanups complete", async () => {
    // Seed: one active panel entity.
    workspaceDO.entityActivate({
      durableWorkQueues: [],
      kind: "panel",
      source: { repoPath: "panels/chat", effectiveVersion: "v1" },
      contextId: "ctx-active",
      key: "nav-active",
    });

    // Seed: a retired entity from BEFORE the grace window (will be GC'd).
    const expiredRetired = workspaceDO.entityActivate({
      durableWorkQueues: [],
      kind: "panel",
      source: { repoPath: "panels/old", effectiveVersion: "v1" },
      contextId: "ctx-expired",
      key: "nav-expired",
    });
    workspaceDO.entityRetire(expiredRetired.id);
    // Backdate retired_at to ~1h ago so it's outside the default 5-minute grace.
    const longAgo = Date.now() - 60 * 60 * 1000;
    (workspaceDO as unknown as { sql: { exec(s: string, ...b: unknown[]): unknown } }).sql.exec(
      `UPDATE entities SET retired_at = ?, cleanup_complete = 1 WHERE id = ?`,
      longAgo,
      expiredRetired.id
    );

    // Seed: a recently-retired entity (still within grace; survives).
    const recentRetired = workspaceDO.entityActivate({
      durableWorkQueues: [],
      kind: "panel",
      source: { repoPath: "panels/recent", effectiveVersion: "v1" },
      contextId: "ctx-recent",
      key: "nav-recent",
    });
    workspaceDO.entityRetire(recentRetired.id);
    // Mark cleanup complete so it's not picked up by step 2.
    workspaceDO.entityCleanupComplete(recentRetired.id, recentRetired.authoritySessionId!);

    // Seed: a retired entity with cleanup_complete=0 (simulates crash mid-cleanup).
    const incompleteCleanup = workspaceDO.entityActivate({
      durableWorkQueues: [],
      kind: "panel",
      source: { repoPath: "panels/crash", effectiveVersion: "v1" },
      contextId: "ctx-crash",
      key: "nav-crash",
    });
    workspaceDO.entityRetire(incompleteCleanup.id);
    // entityRetire sets cleanup_complete=0, leave it.
    expect(workspaceDO.entityResolve(incompleteCleanup.id)?.cleanupComplete).toBe(false);

    const entityCache = new EntityCache();
    const warnings: string[] = [];

    const result = await runStartupReconciliation({
      onRetire: cleanup.retire,
      workspaceState: workspaceState(),
      entityCache,
      logger: { warn: (msg) => warnings.push(msg) },
    });

    // 1. Active panel is in cache.
    const activeId = canonicalEntityId({ kind: "panel", key: "nav-active" });
    expect(entityCache.resolve(activeId)?.status).toBe("active");
    expect(result.hydratedCount).toBe(1);
    expect(result.lifecycleRecovered).toBe(false);

    // 2. Incomplete cleanup is now marked complete in the DO.
    expect(result.incompleteCleanupIds).toContain(incompleteCleanup.id);
    expect(workspaceDO.entityResolve(incompleteCleanup.id)?.cleanupComplete).toBe(true);

    // 3a. The old retired entity is hard-deleted.
    expect(result.gcDeletedIds).toContain(expiredRetired.id);
    expect(workspaceDO.entityResolve(expiredRetired.id)).toBeNull();

    // 3b. The recently-retired entity survives (within grace window).
    expect(result.gcDeletedIds).not.toContain(recentRetired.id);
    expect(workspaceDO.entityResolve(recentRetired.id)?.status).toBe("retired");

    // 3c. Active rows are never deleted.
    expect(result.gcDeletedIds).not.toContain(activeId);

    expect(warnings).toEqual([]);
  });

  it("retains incomplete canonical cleanup when the shared resource owner fails after restart", async () => {
    const record = workspaceDO.entityActivate({
      durableWorkQueues: [],
      kind: "panel",
      source: { repoPath: "panels/failed", effectiveVersion: "one" },
      contextId: "ctx-one",
      key: "failed",
    });
    workspaceDO.entityRetire(record.id);
    const failure = new Error("approval retirement SQL refused");
    const owner = createEntityRetirementCleanup({
      resolveRecord: async (id) => workspaceDO.entityResolve(id),
      cleanup: async () => {
        throw failure;
      },
      complete: async (id, lifetime) => {
        workspaceDO.entityCleanupComplete(id, lifetime);
      },
    });
    const warn = vi.fn();
    await runStartupReconciliation({
      workspaceState: workspaceState(),
      entityCache: new EntityCache(),
      onRetire: owner.retire,
      logger: { warn },
    });
    expect(workspaceDO.entityResolve(record.id)?.cleanupComplete).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(record.id), failure);
    expect(() =>
      workspaceDO.entityActivate({
        durableWorkQueues: [],
        kind: "panel",
        source: record.source,
        contextId: record.contextId,
        key: record.key,
      })
    ).toThrow("before retirement cleanup completes");
    await owner.quiesce();
  });

  it("does not erase an activation committed while the active snapshot is in flight", async () => {
    const entityCache = new EntityCache();
    let resolveSnapshot!: (records: EntityRecord[]) => void;
    const snapshot = new Promise<EntityRecord[]>((resolve) => {
      resolveSnapshot = resolve;
    });
    const workspaceState = createStartupReconciliationWorkspaceState((method, args) =>
      method === "entityListActive" ? snapshot : dispatchWorkspaceDO(method, args)
    );

    const reconciliation = runStartupReconciliation({
      onRetire: cleanup.retire,
      workspaceState,
      entityCache,
    });
    const concurrent = workspaceDO.entityActivate({
      durableWorkQueues: [],
      kind: "panel",
      source: { repoPath: "panels/concurrent", effectiveVersion: "v1" },
      contextId: "ctx-concurrent",
      key: "nav-concurrent",
    });
    entityCache._onActivate(concurrent);
    resolveSnapshot([]);
    await reconciliation;

    expect(entityCache.resolveActive(concurrent.id)).toEqual(concurrent);
  });

  it("returns warnings (does not throw) when WorkspaceDO methods fail", async () => {
    const entityCache = new EntityCache();
    const warnings: Array<{ msg: string; args: unknown[] }> = [];
    const failingWorkspaceState = createStartupReconciliationWorkspaceState(() =>
      Promise.reject(new Error("boom"))
    );

    const result = await runStartupReconciliation({
      onRetire: cleanup.retire,
      workspaceState: failingWorkspaceState,
      entityCache,
      logger: {
        warn: (msg, ...args) => warnings.push({ msg, args }),
      },
    });

    expect(result.hydratedCount).toBe(0);
    expect(result.incompleteCleanupIds).toEqual([]);
    expect(result.gcDeletedIds).toEqual([]);
    expect(result.lifecycleRecovered).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("runs lifecycle recovery after WorkspaceDO reconciliation when provided", async () => {
    const entityCache = new EntityCache();
    const recoverLifecycle = vi.fn().mockResolvedValue(undefined);

    const result = await runStartupReconciliation({
      onRetire: cleanup.retire,
      workspaceState: workspaceState(),
      entityCache,
      recoverLifecycle,
    });

    expect(recoverLifecycle).toHaveBeenCalledTimes(1);
    expect(result.lifecycleRecovered).toBe(true);
  });

  it("restores active runtime images before lifecycle recovery", async () => {
    workspaceDO.entityActivate({
      durableWorkQueues: [],
      kind: "do",
      source: { repoPath: "workers/agent-worker", effectiveVersion: "v1" },
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "a".repeat(64),
      activeAuthority: { requests: [], provides: [] },
      contextId: "ctx-agent",
      className: "AiChatWorker",
      key: "agent-1",
    });
    const order: string[] = [];
    const restoreRuntimes = vi.fn(async () => {
      order.push("restore");
    });
    const recoverLifecycle = vi.fn(async () => {
      order.push("recover");
    });

    await runStartupReconciliation({
      onRetire: cleanup.retire,
      workspaceState: workspaceState(),
      entityCache: new EntityCache(),
      restoreRuntimes,
      recoverLifecycle,
    });

    expect(restoreRuntimes).toHaveBeenCalledWith([
      expect.objectContaining({ className: "AiChatWorker", key: "agent-1" }),
    ]);
    expect(order).toEqual(["restore", "recover"]);
  });

  it("does not admit lifecycle recovery when runtime restoration fails", async () => {
    const recoverLifecycle = vi.fn();
    await expect(
      runStartupReconciliation({
        onRetire: cleanup.retire,
        workspaceState: workspaceState(),
        entityCache: new EntityCache(),
        restoreRuntimes: () => Promise.reject(new Error("sealed image unavailable")),
        recoverLifecycle,
      })
    ).rejects.toThrow("sealed image unavailable");
    expect(recoverLifecycle).not.toHaveBeenCalled();
  });

  it("warns but does not fail when lifecycle recovery fails", async () => {
    const entityCache = new EntityCache();
    const warnings: Array<{ msg: string; args: unknown[] }> = [];

    const result = await runStartupReconciliation({
      onRetire: cleanup.retire,
      workspaceState: workspaceState(),
      entityCache,
      recoverLifecycle: () => Promise.reject(new Error("recover failed")),
      logger: {
        warn: (msg, ...args) => warnings.push({ msg, args }),
      },
    });

    expect(result.lifecycleRecovered).toBe(false);
    expect(warnings).toEqual([
      expect.objectContaining({ msg: "[Bootstrap] lifecycle startup recovery failed:" }),
    ]);
  });
});
