import { describe, expect, it, vi } from "vitest";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { cleanupRuntimeEntity } from "./runtimeEntityCleanup.js";

function record(kind: EntityRecord["kind"], id = `${kind}:one`): EntityRecord {
  return {
    id,
    kind,
    source: { repoPath: `${kind}s/example` },
    contextId: "ctx-one",
    key: "one",
    createdAt: 1,
    status: "retired",
    cleanupComplete: false,
  };
}

function deps() {
  return {
    panelRuntimeCoordinator: {
      retireRuntimeEntity: vi.fn(),
    },
    egressProxy: {
      dropCaller: vi.fn(async () => {}),
    },
    approvalQueue: {
      cancelForCaller: vi.fn(),
    },
    deferrals: {
      cancelForCaller: vi.fn(),
    },
    credentialSessionGrantStore: {
      dropForCaller: vi.fn(),
    },
    revokeAgentCredentials: vi.fn(async () => {}),
    tokenManager: {
      revokeToken: vi.fn(),
    },
    connectionGrants: {
      revokeForPrincipal: vi.fn(),
    },
    fsService: {
      closeHandlesForCaller: vi.fn(),
    },
    webhookIngress: {
      internal: {
        revokeForCaller: vi.fn(async () => 1),
      },
    },
    workerdManager: {
      stopWorker: vi.fn(async () => {}),
      destroyDOEntity: vi.fn(async () => {}),
    },
  };
}

describe("cleanupRuntimeEntity", () => {
  it("cleans all panel runtime-owned resources from one owner", async () => {
    const d = deps();
    await cleanupRuntimeEntity(record("panel", "panel:one"), {
      panelRuntimeCoordinator: d.panelRuntimeCoordinator as never,
      egressProxy: d.egressProxy,
      approvalQueue: d.approvalQueue,
      deferrals: d.deferrals,
      credentialSessionGrantStore: d.credentialSessionGrantStore,
      revokeAgentCredentials: d.revokeAgentCredentials,
      tokenManager: d.tokenManager,
      connectionGrants: d.connectionGrants,
      getFsService: () => d.fsService as never,
      getWebhookIngress: () => d.webhookIngress,
      getWorkerdManager: () => d.workerdManager as never,
    });

    expect(d.panelRuntimeCoordinator.retireRuntimeEntity).toHaveBeenCalledWith("panel:one");
    expect(d.egressProxy.dropCaller).toHaveBeenCalledWith("panel:one");
    expect(d.approvalQueue.cancelForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.deferrals.cancelForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.credentialSessionGrantStore.dropForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.revokeAgentCredentials).toHaveBeenCalledWith("panel:one");
    expect(d.connectionGrants.revokeForPrincipal).toHaveBeenCalledWith("panel:one");
    expect(d.fsService.closeHandlesForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.webhookIngress.internal.revokeForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.tokenManager.revokeToken).toHaveBeenCalledWith("panel:one");
    expect(d.tokenManager.revokeToken).toHaveBeenCalledWith("agent:panel:one");
    expect(d.workerdManager.stopWorker).not.toHaveBeenCalled();
    expect(d.workerdManager.destroyDOEntity).not.toHaveBeenCalled();
  });

  it("also stops worker and DO runtime resources by entity kind", async () => {
    const workerDeps = deps();
    await cleanupRuntimeEntity(record("worker", "worker:one"), {
      panelRuntimeCoordinator: workerDeps.panelRuntimeCoordinator as never,
      egressProxy: workerDeps.egressProxy,
      approvalQueue: workerDeps.approvalQueue,
      credentialSessionGrantStore: workerDeps.credentialSessionGrantStore,
      revokeAgentCredentials: workerDeps.revokeAgentCredentials,
      tokenManager: workerDeps.tokenManager,
      connectionGrants: workerDeps.connectionGrants,
      getFsService: () => workerDeps.fsService as never,
      getWebhookIngress: () => workerDeps.webhookIngress,
      getWorkerdManager: () => workerDeps.workerdManager as never,
    });
    expect(workerDeps.workerdManager.stopWorker).toHaveBeenCalledWith("worker:one");

    const doDeps = deps();
    await cleanupRuntimeEntity(record("do", "do:one"), {
      panelRuntimeCoordinator: doDeps.panelRuntimeCoordinator as never,
      egressProxy: doDeps.egressProxy,
      approvalQueue: doDeps.approvalQueue,
      credentialSessionGrantStore: doDeps.credentialSessionGrantStore,
      revokeAgentCredentials: doDeps.revokeAgentCredentials,
      tokenManager: doDeps.tokenManager,
      connectionGrants: doDeps.connectionGrants,
      getFsService: () => doDeps.fsService as never,
      getWebhookIngress: () => doDeps.webhookIngress,
      getWorkerdManager: () => doDeps.workerdManager as never,
    });
    expect(doDeps.workerdManager.destroyDOEntity).toHaveBeenCalledWith("do:one");
  });

  it("runs every cleanup step but reports aggregate failure so the reaper retries", async () => {
    const d = deps();
    d.fsService.closeHandlesForCaller.mockImplementation(() => {
      throw new Error("fs cleanup failed");
    });
    d.webhookIngress.internal.revokeForCaller.mockRejectedValue(new Error("webhook failed"));

    const cleanup = cleanupRuntimeEntity(record("panel", "panel:one"), {
      panelRuntimeCoordinator: d.panelRuntimeCoordinator as never,
      egressProxy: d.egressProxy,
      approvalQueue: d.approvalQueue,
      credentialSessionGrantStore: d.credentialSessionGrantStore,
      revokeAgentCredentials: d.revokeAgentCredentials,
      tokenManager: d.tokenManager,
      connectionGrants: d.connectionGrants,
      getFsService: () => d.fsService as never,
      getWebhookIngress: () => d.webhookIngress,
      getWorkerdManager: () => d.workerdManager as never,
    });

    await expect(cleanup).rejects.toThrow(
      "Runtime entity cleanup was incomplete for panel:one (2 steps failed)"
    );

    expect(d.fsService.closeHandlesForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.webhookIngress.internal.revokeForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.tokenManager.revokeToken).toHaveBeenCalledWith("panel:one");
    expect(d.tokenManager.revokeToken).toHaveBeenCalledWith("agent:panel:one");
  });
});
