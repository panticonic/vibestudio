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
  deferrals?: { cancelForCaller(callerId: string): number };
  credentialSessionGrantStore: Pick<CredentialSessionGrantStore, "dropForCaller">;
  /** Revoke every durable agent credential bound to this runtime entity. */
  revokeAgentCredentials?: (entityId: string) => void | Promise<void>;
  tokenManager: Pick<TokenManager, "revokeToken">;
  connectionGrants?: Pick<ConnectionGrantService, "revokeForPrincipal">;
  entityTitleService?: Pick<EntityTitleService, "clear">;
  getWorkerdManager(): Pick<WorkerdManager, "stopWorker" | "destroyDOEntity"> | null;
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
  const failures: Error[] = [];
  const step = async (name: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
    try {
      await fn();
    } catch (cause) {
      failures.push(
        new Error(`Runtime entity cleanup step ${name} failed for ${record.id}`, { cause })
      );
    }
  };

  if (record.kind === "panel") {
    await step("panel-runtime", () => deps.panelRuntimeCoordinator?.retireRuntimeEntity(record.id));
  }
  await step("egress", () => deps.egressProxy.dropCaller(record.id));
  await step("deferrals", () => deps.deferrals?.cancelForCaller(record.id));
  await step("approvals", () => deps.approvalQueue.cancelForCaller(record.id));
  await step("credential-session-grants", () =>
    deps.credentialSessionGrantStore.dropForCaller(record.id)
  );
  await step("agent-credentials", () => deps.revokeAgentCredentials?.(record.id));
  await step("connection-grants", () => deps.connectionGrants?.revokeForPrincipal(record.id));
  await step("filesystem-handles", () => deps.getFsService()?.closeHandlesForCaller(record.id));
  await step("webhook-subscriptions", () =>
    deps.getWebhookIngress()?.internal?.revokeForCaller?.(record.id)
  );
  await step("runtime-token", () => deps.tokenManager.revokeToken(record.id));
  await step("agent-runtime-token", () => deps.tokenManager.revokeToken(`agent:${record.id}`));
  await step("entity-title", () => deps.entityTitleService?.clear(record.id));
  const workerdManager = deps.getWorkerdManager();
  if (record.kind === "worker") {
    await step("worker-runtime", () => workerdManager?.stopWorker(record.id));
  }
  if (record.kind === "do") {
    await step("durable-object-runtime", () => workerdManager?.destroyDOEntity(record.id));
  }

  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Runtime entity cleanup was incomplete for ${record.id} (${failures.length} step${
        failures.length === 1 ? "" : "s"
      } failed)`
    );
  }
}
