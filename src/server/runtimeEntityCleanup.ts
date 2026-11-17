import type { FsService } from "./services/fsService.js";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { PanelRuntimeCoordinator } from "./panelRuntimeCoordinator.js";
import type { RuntimeManager } from "./runtimeManager.js";
import type { EgressProxy } from "./services/egressProxy.js";
import type { ApprovalQueue } from "./services/approvalQueue.js";
import type { AcquisitionOwner } from "./services/authorityAcquisitionStore.js";
import type { CredentialSessionGrantStore } from "./services/credentialSessionGrants.js";
import { createDevLogger } from "@vibestudio/dev-log";

const log = createDevLogger("RuntimeEntityCleanup");

export interface RuntimeEntityCleanupDeps {
  retireAuthorityOwner(owner: AcquisitionOwner): void | Promise<void>;
  panelRuntimeCoordinator?: PanelRuntimeCoordinator | null;
  egressProxy: Pick<EgressProxy, "dropCaller">;
  approvalQueue: Pick<ApprovalQueue, "cancelForCaller">;
  credentialSessionGrantStore: Pick<CredentialSessionGrantStore, "dropForCaller">;
  tokenManager: Pick<TokenManager, "revokeToken">;
  connectionGrants?: Pick<ConnectionGrantService, "revokeForPrincipal">;
  clearPresentationTitle?(entityId: string): Promise<void>;
  releaseBlobRetentions(runtime: Pick<EntityRecord, "kind" | "id">): Promise<void>;
  resourceHandles?: {
    revokeReceiver(
      workspaceId: string,
      receiver: { source: string; className: string; objectKey: string },
      reason: string
    ): number;
  };
  workspaceId?: string;
  getRuntimeManager(): Pick<
    RuntimeManager,
    "stopWorker" | "retireDOEntity" | "retireEgressCaller"
  > | null;
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
  if (!record.authoritySessionId)
    throw new Error(`Entity ${record.id} has no retired authority lifetime`);
  // Commit the canonical terminal boundary before withdrawing its review surface.
  await deps.retireAuthorityOwner({
    ownerRuntimeId: record.id,
    sessionId: record.authoritySessionId,
  });
  const failures: unknown[] = [];
  const failedSteps: string[] = [];
  const attempt = async (step: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (error) {
      failures.push(error);
      failedSteps.push(step);
      log.error(`Entity ${record.id} failed cleanup step "${step}":`, error);
    }
  };

  const runtimeManager = deps.getRuntimeManager();
  await attempt("retire egress caller", () => runtimeManager?.retireEgressCaller(record.id));
  await attempt("drop egress proxy caller", () => deps.egressProxy.dropCaller(record.id));
  if (record.kind === "panel") {
    await attempt("retire panel runtime", () =>
      deps.panelRuntimeCoordinator?.retireRuntimeEntity(record.id)
    );
  }
  await attempt("cancel approvals", () =>
    deps.approvalQueue.cancelForCaller(record.id, new Error(`Runtime entity ${record.id} retired`))
  );
  await attempt("drop credential session grants", () =>
    deps.credentialSessionGrantStore.dropForCaller(record.id)
  );
  await attempt("revoke connection grants", () =>
    deps.connectionGrants?.revokeForPrincipal(record.id)
  );
  await attempt("close filesystem handles", () =>
    deps.getFsService()?.closeHandlesForCaller(record.id)
  );
  await attempt("revoke webhook ingress", () =>
    deps.getWebhookIngress()?.internal?.revokeForCaller?.(record.id)
  );
  await attempt("revoke bearer token", () => deps.tokenManager.revokeToken(record.id));
  await attempt("clear presentation title", () => deps.clearPresentationTitle?.(record.id));
  if (record.kind === "worker") {
    await attempt("stop worker", () => runtimeManager?.stopWorker(record.id));
  }
  if (record.kind === "do") {
    const { className, key: objectKey } = record;
    if (!className || !objectKey) {
      failures.push(new Error(`Durable Object entity ${record.id} has no class or object key`));
      failedSteps.push("validate Durable Object identity");
    } else {
      const resourceHandles = deps.resourceHandles;
      const workspaceId = deps.workspaceId;
      if (resourceHandles && workspaceId) {
        await attempt("revoke receiver resource handles", () =>
          resourceHandles.revokeReceiver(
            workspaceId,
            {
              source: record.source.repoPath,
              className,
              objectKey,
            },
            "logical receiver retired"
          )
        );
      }
      await attempt("retire Durable Object facets", () =>
        runtimeManager?.retireDOEntity({
          source: record.source.repoPath,
          className,
          objectKey,
        })
      );
    }
  }

  // No content owner may disappear while a producer can still recreate it.
  // Failed teardown retains roots until this same cleanup is retried by the reaper.
  if (failures.length === 0) {
    await attempt("release blob retentions", () =>
      deps.releaseBlobRetentions({ kind: record.kind, id: record.id })
    );
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Runtime entity cleanup failed for ${record.id} (${failures.length} step${
        failures.length === 1 ? "" : "s"
      }): ${failedSteps.join(", ")}`
    );
  }
}
