import type { FsService } from "@vibestudio/shared/fsService";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type { WorkerdManager } from "./workerdManager.js";
import type { EgressProxy } from "./services/egressProxy.js";
import type { ApprovalQueue } from "./services/approvalQueue.js";
import type { CredentialSessionGrantStore } from "./services/credentialSessionGrants.js";
import type { EntityTitleService } from "./services/entityTitleService.js";

export interface RuntimeEntityCleanupDeps {
  panelRuntimeCoordinator?: PanelRuntimeCoordinator | null;
  egressProxy: Pick<EgressProxy, "dropCaller">;
  approvalQueue: Pick<ApprovalQueue, "cancelForCaller">;
  credentialSessionGrantStore: Pick<CredentialSessionGrantStore, "dropForCaller">;
  tokenManager: Pick<TokenManager, "revokeToken">;
  connectionGrants?: Pick<ConnectionGrantService, "revokeForPrincipal">;
  entityTitleService?: Pick<EntityTitleService, "clear">;
  getWorkerdManager(): Pick<WorkerdManager, "stopWorker" | "retireDOEntity"> | null;
  getFsService(): FsService | null;
  getWebhookIngress(): {
    internal?: { revokeForCaller?: (callerId: string) => Promise<number> };
  } | null;
}

/**
 * Single server-side owner for retiring runtime entity resources.
 *
 * RuntimeService commits the entity row to retired first, then calls this. The
 * cleanup reaper calls the same function for incomplete retirements, so every
 * lifecycle transition uses the same cleanup ordering.
 */
export async function cleanupRuntimeEntity(
  record: EntityRecord,
  deps: RuntimeEntityCleanupDeps
): Promise<void> {
  const failures: unknown[] = [];
  const attempt = async (fn: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      failures.push(error);
    }
  };

  if (record.kind === "panel") {
    await attempt(() => deps.panelRuntimeCoordinator?.retireRuntimeEntity(record.id));
  }
  await attempt(() => deps.egressProxy.dropCaller(record.id));
  await attempt(() => deps.approvalQueue.cancelForCaller(record.id));
  await attempt(() => deps.credentialSessionGrantStore.dropForCaller(record.id));
  await attempt(() => deps.connectionGrants?.revokeForPrincipal(record.id));
  await attempt(() => deps.getFsService()?.closeHandlesForCaller(record.id));
  await attempt(() => deps.getWebhookIngress()?.internal?.revokeForCaller?.(record.id));
  await attempt(() => deps.tokenManager.revokeToken(record.id));
  await attempt(() => deps.entityTitleService?.clear(record.id));
  const workerdManager = deps.getWorkerdManager();
  if (record.kind === "worker") {
    await attempt(() => workerdManager?.stopWorker(record.id));
  }
  if (record.kind === "do") {
    const { className, key: objectKey } = record;
    if (!className || !objectKey) {
      failures.push(new Error(`Durable Object entity ${record.id} has no class or object key`));
    } else {
      await attempt(() =>
        workerdManager?.retireDOEntity({
          source: record.source.repoPath,
          className,
          objectKey,
        })
      );
    }
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Runtime entity cleanup failed for ${record.id} (${failures.length} step${
        failures.length === 1 ? "" : "s"
      })`
    );
  }
}
