import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import { createTestDO } from "@vibestudio/durable/test-utils";

import { WorkspaceDO } from "../internalDOs/workspaceDO.js";
import { WorkspaceDOTestable } from "../internalDOs/workspaceDO.testFixture.js";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import { runStartupReconciliation } from "./startupReconciliation.js";

describe("runStartupReconciliation", () => {
  let workspaceDO: WorkspaceDO;
  beforeEach(async () => {
    ({ instance: workspaceDO } = await createTestDO(WorkspaceDOTestable));
  });

  function dispatchWorkspaceDO<T>(method: string, ...args: unknown[]): Promise<T> {
    const fn = (workspaceDO as unknown as Record<string, (...a: unknown[]) => unknown>)[method];
    if (typeof fn !== "function") {
      return Promise.reject(new Error(`Unknown WorkspaceDO method: ${method}`));
    }
    return Promise.resolve(fn.apply(workspaceDO, args)) as Promise<T>;
  }

  it("hydrates active entities, GCs expired retired rows, and marks incomplete cleanups complete", async () => {
    // Seed: one active panel entity.
    workspaceDO.entityActivate({
      kind: "panel",
      source: { repoPath: "panels/chat" },
      activeExecutionDigest: "v1",
      contextId: "ctx-active",
      key: "nav-active",
    });

    // Seed: a retired entity from BEFORE the grace window (will be GC'd).
    const expiredRetired = workspaceDO.entityActivate({
      kind: "panel",
      source: { repoPath: "panels/old" },
      activeExecutionDigest: "v1",
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
      kind: "panel",
      source: { repoPath: "panels/recent" },
      activeExecutionDigest: "v1",
      contextId: "ctx-recent",
      key: "nav-recent",
    });
    workspaceDO.entityRetire(recentRetired.id);
    // Mark cleanup complete so it's not picked up by step 2.
    workspaceDO.entityCleanupComplete(recentRetired.id);

    // Seed: a retired entity with cleanup_complete=0 (simulates crash mid-cleanup).
    const incompleteCleanup = workspaceDO.entityActivate({
      kind: "panel",
      source: { repoPath: "panels/crash" },
      activeExecutionDigest: "v1",
      contextId: "ctx-crash",
      key: "nav-crash",
    });
    workspaceDO.entityRetire(incompleteCleanup.id);
    // entityRetire sets cleanup_complete=0, leave it.
    expect(workspaceDO.entityResolve(incompleteCleanup.id)?.cleanupComplete).toBe(false);

    const entityCache = new EntityCache();
    const warnings: string[] = [];

    const result = await runStartupReconciliation({
      dispatchWorkspaceDO,
      entityCache,
      cleanupRetiredEntity: async () => {},
      logger: { warn: (msg) => warnings.push(msg) },
    });

    // 1. Active panel is in cache.
    const activeId = canonicalEntityId({ kind: "panel", key: "nav-active" });
    expect(entityCache.resolve(activeId)?.status).toBe("active");
    expect(result.hydratedCount).toBe(1);
    expect(result.lifecycleRecovered).toBe(false);
    expect(result.incompleteContextCleanupIds).toEqual([]);

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

  it("returns warnings (does not throw) when WorkspaceDO methods fail", async () => {
    const entityCache = new EntityCache();
    const warnings: Array<{ msg: string; args: unknown[] }> = [];
    const failingDispatch = (): Promise<never> => Promise.reject(new Error("boom"));

    const result = await runStartupReconciliation({
      dispatchWorkspaceDO: failingDispatch,
      entityCache,
      logger: {
        warn: (msg, ...args) => warnings.push({ msg, args }),
      },
    });

    expect(result.hydratedCount).toBe(0);
    expect(result.incompleteCleanupIds).toEqual([]);
    expect(result.incompleteContextCleanupIds).toEqual([]);
    expect(result.gcDeletedIds).toEqual([]);
    expect(result.lifecycleRecovered).toBe(false);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });

  it("preserves both retry ledgers when startup cleanup still fails", async () => {
    const retired = workspaceDO.entityActivate({
      kind: "panel",
      source: { repoPath: "panels/retry" },
      contextId: "ctx-retry",
      key: "retry",
    });
    workspaceDO.entityRetire(retired.id);
    workspaceDO.contextCleanupBegin({ contextId: "ctx-retry", kind: "destroy" });
    const cleanupRetiredEntity = vi.fn(async () => {
      throw new Error("entity backend down");
    });
    const cleanupContext = vi.fn(async () => {
      throw new Error("context backend down");
    });

    const result = await runStartupReconciliation({
      dispatchWorkspaceDO,
      entityCache: new EntityCache(),
      cleanupRetiredEntity,
      cleanupContext,
      gcGraceMs: 0,
      logger: { warn: vi.fn() },
    });

    expect(result.incompleteCleanupIds).toEqual([retired.id]);
    expect(result.incompleteContextCleanupIds).toEqual(["ctx-retry"]);
    expect(workspaceDO.entityResolve(retired.id)?.cleanupComplete).toBe(false);
    expect(workspaceDO.contextCleanupListPending()).toHaveLength(1);
    expect(result.gcDeletedIds).not.toContain(retired.id);
  });

  it("runs lifecycle recovery after WorkspaceDO reconciliation when provided", async () => {
    const entityCache = new EntityCache();
    const recoverLifecycle = vi.fn().mockResolvedValue(undefined);

    const result = await runStartupReconciliation({
      dispatchWorkspaceDO,
      entityCache,
      recoverLifecycle,
    });

    expect(recoverLifecycle).toHaveBeenCalledTimes(1);
    expect(result.lifecycleRecovered).toBe(true);
  });

  it("warns but does not fail when lifecycle recovery fails", async () => {
    const entityCache = new EntityCache();
    const warnings: Array<{ msg: string; args: unknown[] }> = [];

    const result = await runStartupReconciliation({
      dispatchWorkspaceDO,
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
