import { describe, expect, it, vi } from "vitest";
import type { EntityRecord } from "@natstack/shared/runtime/entitySpec";
import { cleanupRuntimeEntity } from "./runtimeEntityCleanup.js";

function record(kind: EntityRecord["kind"], id = `${kind}:one`): EntityRecord {
  return {
    id,
    kind,
    source: { repoPath: `${kind}s/example`, effectiveVersion: "v1" },
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
    credentialSessionGrantStore: {
      dropForCaller: vi.fn(),
    },
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
      credentialSessionGrantStore: d.credentialSessionGrantStore,
      tokenManager: d.tokenManager,
      connectionGrants: d.connectionGrants,
      getFsService: () => d.fsService as never,
      getWebhookIngress: () => d.webhookIngress,
      getWorkerdManager: () => d.workerdManager as never,
    });

    expect(d.panelRuntimeCoordinator.retireRuntimeEntity).toHaveBeenCalledWith("panel:one");
    expect(d.egressProxy.dropCaller).toHaveBeenCalledWith("panel:one");
    expect(d.approvalQueue.cancelForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.credentialSessionGrantStore.dropForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.connectionGrants.revokeForPrincipal).toHaveBeenCalledWith("panel:one");
    expect(d.fsService.closeHandlesForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.webhookIngress.internal.revokeForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.tokenManager.revokeToken).toHaveBeenCalledWith("panel:one");
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
      tokenManager: doDeps.tokenManager,
      connectionGrants: doDeps.connectionGrants,
      getFsService: () => doDeps.fsService as never,
      getWebhookIngress: () => doDeps.webhookIngress,
      getWorkerdManager: () => doDeps.workerdManager as never,
    });
    expect(doDeps.workerdManager.destroyDOEntity).toHaveBeenCalledWith("do:one");
  });

  it("continues best-effort cleanup when one cleanup step throws", async () => {
    const d = deps();
    d.fsService.closeHandlesForCaller.mockImplementation(() => {
      throw new Error("fs cleanup failed");
    });
    d.webhookIngress.internal.revokeForCaller.mockRejectedValue(new Error("webhook failed"));

    await expect(
      cleanupRuntimeEntity(record("panel", "panel:one"), {
        panelRuntimeCoordinator: d.panelRuntimeCoordinator as never,
        egressProxy: d.egressProxy,
        approvalQueue: d.approvalQueue,
        credentialSessionGrantStore: d.credentialSessionGrantStore,
        tokenManager: d.tokenManager,
        connectionGrants: d.connectionGrants,
        getFsService: () => d.fsService as never,
        getWebhookIngress: () => d.webhookIngress,
        getWorkerdManager: () => d.workerdManager as never,
      })
    ).resolves.toBeUndefined();

    expect(d.fsService.closeHandlesForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.webhookIngress.internal.revokeForCaller).toHaveBeenCalledWith("panel:one");
    expect(d.tokenManager.revokeToken).toHaveBeenCalledWith("panel:one");
  });
});
