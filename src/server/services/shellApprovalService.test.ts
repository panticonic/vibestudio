import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, ServiceError } from "@vibestudio/shared/serviceDispatcher";
import type { PendingApproval, PendingUnitBatchApproval } from "@vibestudio/shared/approvals";
import { createApprovalQueue } from "./approvalQueue.js";
import { createShellApprovalService } from "./shellApprovalService.js";
import { createPushMetrics } from "./pushMetrics.js";

function startupApproval(id = "startup-1"): PendingUnitBatchApproval {
  return {
    kind: "unit-batch",
    approvalId: id,
    callerId: "system:startup",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "ev:startup",
    requestedAt: 10,
    title: "Workspace apps need approval",
    description: "Approve startup apps.",
    trigger: "startup",
    units: [
      {
        unitKind: "app",
        unitName: "@workspace-apps/shell",
        displayName: "Shell",
        source: { kind: "workspace-repo", repo: "apps/shell", ref: "HEAD" },
        ev: "ev:startup",
        capabilities: ["panel-hosting"],
      },
    ],
  };
}

describe("shellApprovalService", () => {
  it("accepts every approval decision exposed by the consent UI", () => {
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestMissionReview: vi.fn(async () => ({ decision: "cancelled" as const })),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveMissionReview: vi.fn(),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
        cancelForCaller: vi.fn(),
      },
    });

    for (const decision of ["once", "session", "version", "deny", "dismiss"] as const) {
      expect(() => service.methods["resolve"]?.args.parse(["approval-1", decision])).not.toThrow();
    }
  });

  it("uses typed errors for unknown methods", async () => {
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestMissionReview: vi.fn(async () => ({ decision: "cancelled" as const })),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveMissionReview: vi.fn(),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
        cancelForCaller: vi.fn(),
      },
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "missing", [])
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it("refuses to resolve non-bootstrap approvals through the bootstrap method", async () => {
    const resolve = vi.fn();
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestMissionReview: vi.fn(async () => ({ decision: "cancelled" as const })),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveMissionReview: vi.fn(),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => [
          {
            kind: "credential",
            approvalId: "credential-1",
            callerId: "worker:alpha",
            callerKind: "worker",
            repoPath: "workers/alpha",
            effectiveVersion: "ev:worker",
            requestedAt: 10,
            credentialId: "openai",
            credentialLabel: "ChatGPT Codex model credential",
          } as PendingApproval,
        ]),
        cancelForCaller: vi.fn(),
      },
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("bootstrap", "app") }, "resolveBootstrap", [
        "credential-1",
        "once",
      ])
    ).rejects.toMatchObject({ name: "ServiceError", code: "ENOENT" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves startup approvals through the bootstrap method", async () => {
    const resolve = vi.fn();
    const metrics = createPushMetrics();
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestMissionReview: vi.fn(async () => ({ decision: "cancelled" as const })),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveMissionReview: vi.fn(),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => [startupApproval("startup-1")]),
        cancelForCaller: vi.fn(),
      },
      metrics,
    });

    await service.handler(
      { caller: createVerifiedCaller("bootstrap", "app") },
      "resolveBootstrap",
      ["startup-1", "once"]
    );
    expect(resolve).toHaveBeenCalledWith("startup-1", "once", undefined);
    expect(metrics.snapshot().approval_resolved_total).toMatchObject({
      "decision=once,source=app": 1,
    });
  });

  it("rejects a second verdict and records only the accepted resolution", async () => {
    const approvalQueue = createApprovalQueue({ eventService: { emit: vi.fn() } as never });
    const metrics = createPushMetrics();
    const service = createShellApprovalService({ approvalQueue, metrics });
    const pendingPromise = approvalQueue.request({
      kind: "capability",
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "hash-1",
      capability: "external-browser-open",
      title: "Open external browser",
    });
    const approvalId = approvalQueue.listPending()[0]!.approvalId;

    await service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolve", [
      approvalId,
      "once",
    ]);
    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolve", [
        approvalId,
        "deny",
      ])
    ).rejects.toMatchObject({ name: "ServiceError", code: "ENOENT" });

    await expect(pendingPromise).resolves.toBe("once");
    expect(approvalQueue.listPending()).toEqual([]);
    expect(metrics.snapshot().approval_resolved_total).toMatchObject({
      "decision=once,source=shell": 1,
    });
    expect(metrics.snapshot().approval_resolved_total).not.toHaveProperty(
      "decision=deny,source=shell"
    );
  });
});
