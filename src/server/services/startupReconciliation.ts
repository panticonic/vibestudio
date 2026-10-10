/**
 * Startup reconciliation for WorkspaceDO state.
 *
 * Runs once during server bootstrap. The order is load-bearing:
 *   1. Hydrate the in-memory entityCache from the DO's active set.
 *   2. Reconcile rows whose cleanup hooks didn't complete before a crash —
 *      run the same canonical retirement owner before permitting reactivation.
 *   3. Safety GC sweep — hard-delete retired rows older than the grace window
 *      that no slot_history row references. Fires no hooks.
 *   4. Optionally run lifecycle crash/server-restart recovery after WorkspaceDO
 *      is reachable and entity metadata has been reconciled.
 *
 * Extracted from `src/server/index.ts` so both the boot path and tests can
 * call it without standing up the full container.
 */
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { workspaceStateEngineMethods } from "@vibestudio/service-schemas/workspaceStateEngine";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";

export type StartupReconciliationWorkspaceState = Pick<
  TypedServiceClient<typeof workspaceStateEngineMethods>,
  "entityListActive" | "entityListPreparing" | "entityFindIncompleteCleanups" | "entityGc"
>;

export function createStartupReconciliationWorkspaceState(
  dispatch: (method: string, args: unknown[]) => Promise<unknown>
): StartupReconciliationWorkspaceState {
  return createTypedServiceClient(
    "workspace-state",
    workspaceStateEngineMethods,
    (_service, method, args) => dispatch(method, args)
  );
}

export interface StartupReconciliationDeps {
  workspaceState: StartupReconciliationWorkspaceState;
  entityCache: EntityCache;
  /** The shared cleanup owner performs teardown and exact lifetime completion. */
  onRetire: (record: EntityRecord) => Promise<void>;
  /** Optional safety-sweep grace window (ms). Default: DO's own DEFAULT_GRACE_MS. */
  gcGraceMs?: number;
  recoverLifecycle?: () => Promise<void>;
  /** Restore exact active runtime images before any lifecycle/alarm admission. */
  restoreRuntimes?: (records: EntityRecord[]) => Promise<void>;
  logger?: { warn: (msg: string, ...args: unknown[]) => void };
}

export interface StartupReconciliationResult {
  hydratedCount: number;
  incompleteCleanupIds: string[];
  gcDeletedIds: string[];
  lifecycleRecovered: boolean;
}

export async function runStartupReconciliation(
  deps: StartupReconciliationDeps
): Promise<StartupReconciliationResult> {
  const log = deps.logger ?? { warn: (msg, ...args) => console.warn(msg, ...args) };

  // 1. Hydrate live identities, including non-executable preparation owners.
  let hydratedCount = 0;
  try {
    // Runtime services are already live while this durable read is in flight.
    // Preserve any activation/retirement that commits after this fence instead
    // of letting the older snapshot erase that newer cache mutation.
    const hydrationFence = deps.entityCache.beginHydration();
    const active = await deps.workspaceState.entityListActive();
    const preparing = await deps.workspaceState.entityListPreparing();
    deps.entityCache.hydrate([...active, ...preparing], hydrationFence);
    hydratedCount = active.length;
  } catch (err) {
    log.warn("[Bootstrap] entityCache hydrate failed:", err);
  }

  // 2. Reconcile partial cleanups from a prior crash.
  const incompleteCleanupIds: string[] = [];
  try {
    const incomplete = await deps.workspaceState.entityFindIncompleteCleanups();
    for (const record of incomplete) {
      incompleteCleanupIds.push(record.id);
      try {
        await deps.onRetire(record);
      } catch (err) {
        log.warn(`[Bootstrap] entity retirement cleanup failed for ${record.id}:`, err);
      }
    }
  } catch (err) {
    log.warn("[Bootstrap] entityFindIncompleteCleanups failed:", err);
  }

  // 3. Safety GC sweep.
  let gcDeletedIds: string[] = [];
  try {
    const gcOpts: { all: true; graceMs?: number } =
      deps.gcGraceMs !== undefined ? { all: true, graceMs: deps.gcGraceMs } : { all: true };
    gcDeletedIds = await deps.workspaceState.entityGc(gcOpts);
  } catch (err) {
    log.warn("[Bootstrap] entityGc safety sweep failed:", err);
  }

  if (deps.restoreRuntimes) {
    const active = await deps.workspaceState.entityListActive();
    await deps.restoreRuntimes(active);
  }

  let lifecycleRecovered = false;
  if (deps.recoverLifecycle) {
    try {
      await deps.recoverLifecycle();
      lifecycleRecovered = true;
    } catch (err) {
      log.warn("[Bootstrap] lifecycle startup recovery failed:", err);
    }
  }

  return { hydratedCount, incompleteCleanupIds, gcDeletedIds, lifecycleRecovered };
}
