import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, ServiceError } from "@vibestudio/shared/serviceDispatcher";
import type {
  PendingApproval,
  PendingUnitInstallReviewApproval,
} from "@vibestudio/shared/approvals";
import {
  SHELL_APPROVAL_DECIDE_AUTHORITY_RESOLVER,
  SHELL_APPROVAL_READ_AUTHORITY_RESOLVER,
  shellApprovalMethods,
} from "@vibestudio/service-schemas/shellApproval";
import { createApprovalQueue } from "./approvalQueue.js";
import { createShellApprovalService } from "./shellApprovalService.js";
import { createPushMetrics } from "./pushMetrics.js";

function startupApproval(id = "startup-1"): PendingUnitInstallReviewApproval {
  return {
    kind: "unit-install-review",
    approvalId: id,
    callerId: "system:startup",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "ev:startup",
    requestedAt: 10,
    title: "Workspace apps need approval",
    description: "Approve startup apps.",
    mode: "adopt-root",
    parts: [
      {
        identityKey: "apps/shell@ev",
        kind: "app",
        label: "Client App",
        surfaces: [],
        name: "@workspace-apps/shell",
        title: "Shell",
        purpose: "The desktop app itself.",
        repoPath: "apps/shell",
        effectiveVersion: "ev",
        version: null,
        requiredUnitKeys: [],
        runsInBackground: false,
        target: "electron",
        origin: {
          url: null,
          originKey: "vibestudio",
          registrableDomain: null,
          version: null,
          isHostBuild: true,
          firstEncounter: false,
        },
        notableRows: [],
        everydayRows: [],
        change: "added",
        section: "template",
      },
    ],
    summary: { panels: 0, agents: 0, services: 0, clientApps: 1, extensions: 0 },
    unchangedPartCount: 0,
  };
}

describe("shellApprovalService", () => {
  it("keeps trusted presenters independent of their own approval grants", async () => {
    const approvalQueue = createApprovalQueue({ eventService: { emit: vi.fn() } as never });
    const service = createShellApprovalService({
      approvalQueue,
      hasAppCapability: (callerId, capability) =>
        callerId === "app:apps/shell:desktop" && capability === "panel-hosting",
    });
    const trusted = createVerifiedCaller("app:apps/shell:desktop", "app", {
      callerId: "app:apps/shell:desktop",
      callerKind: "app",
      repoPath: "apps/shell",
      effectiveVersion: "v1",
      requested: [],
    });
    const ordinary = createVerifiedCaller("app:apps/terminal-browser:terminal", "app", {
      callerId: "app:apps/terminal-browser:terminal",
      callerKind: "app",
      repoPath: "apps/terminal-browser",
      effectiveVersion: "v1",
      requested: [],
    });

    expect(shellApprovalMethods.listPending.tier.tier).toBe("open");
    expect(shellApprovalMethods.resolve.tier.tier).toBe("open");
    expect(
      await service.authorityPreparation?.[SHELL_APPROVAL_READ_AUTHORITY_RESOLVER]?.(
        { caller: trusted },
        []
      )
    ).toMatchObject({ selections: [] });
    expect(
      await service.authorityPreparation?.[SHELL_APPROVAL_DECIDE_AUTHORITY_RESOLVER]?.(
        { caller: ordinary },
        []
      )
    ).toMatchObject({
      selections: [{ capability: "approvals.decide", resourceKey: "approvals.decide" }],
    });
  });

  it("returns the host-owned creation review preparation state", async () => {
    const approvalQueue = createApprovalQueue({ eventService: { emit: vi.fn() } as never });
    const service = createShellApprovalService({
      approvalQueue,
      workspaceCreationReviewState: () => ({
        status: "pending",
        approvalId: "approval:creation",
        partCount: 2,
      }),
    });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("system-test", "server") },
        "getWorkspaceCreationReviewState",
        []
      )
    ).resolves.toEqual({
      status: "pending",
      approvalId: "approval:creation",
      partCount: 2,
    });
  });

  it("accepts every approval decision exposed by the consent UI", () => {
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveInstallReview: vi.fn(),
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
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveInstallReview: vi.fn(),
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
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveInstallReview: vi.fn(),
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
        ["credential-1"],
        "once",
      ])
    ).resolves.toEqual([{ approvalId: "credential-1", status: "not-pending" }]);
    expect(resolve).not.toHaveBeenCalled();
  });

  // The launch gate settles through the install-review path like every other
  // review surface: that path is what records admission and mints clearance, so
  // a unit decided here is not left running with no record of the decision.
  it("resolves startup approvals through the shared install-review path", async () => {
    const resolveInstallReview = vi.fn();
    const resolve = vi.fn();
    const metrics = createPushMetrics();
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveInstallReview,
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
      [["startup-1"], "once"]
    );
    // Accepting clears the full slate: the gate asks whose code this is, not
    // what it may reach, so it offers no per-permission choice to carry.
    expect(resolveInstallReview).toHaveBeenCalledWith(
      "startup-1",
      { decision: "adopt-root", allowNow: [{ identityKey: "apps/shell@ev", permissions: [] }] },
      undefined
    );
    expect(resolve).not.toHaveBeenCalled();
    expect(metrics.snapshot().approval_resolved_total).toMatchObject({
      "decision=once,source=app": 1,
    });
  });

  it("cancels the launch gate on deny, leaving nothing admitted", async () => {
    const resolveInstallReview = vi.fn();
    const metrics = createPushMetrics();
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveInstallReview,
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
      [["startup-1"], "deny"]
    );
    expect(resolveInstallReview).toHaveBeenCalledWith(
      "startup-1",
      { decision: "cancel" },
      undefined
    );
  });

  it("continues a partially applied startup decision on retry", async () => {
    const pending = [startupApproval("startup-1"), startupApproval("startup-2")];
    let secondAttempts = 0;
    const resolveInstallReview = vi.fn(async (approvalId: string) => {
      if (approvalId === "startup-2" && secondAttempts++ === 0) {
        throw new Error("transient admission failure");
      }
      const index = pending.findIndex((approval) => approval.approvalId === approvalId);
      if (index >= 0) pending.splice(index, 1);
      return {
        approvalId,
        mode: "adopt-root" as const,
        decision: "accepted" as const,
        heading: "Workspace access approved",
        parts: [],
      };
    });
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveInstallReview,
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => pending),
        cancelForCaller: vi.fn(),
      },
    });
    const ctx = { caller: createVerifiedCaller("bootstrap", "app") };

    await expect(
      service.handler(ctx, "resolveBootstrap", [["startup-1", "startup-2"], "once"])
    ).rejects.toThrow("transient admission failure");
    await expect(
      service.handler(ctx, "resolveBootstrap", [["startup-1", "startup-2"], "once"])
    ).resolves.toEqual([
      { approvalId: "startup-1", status: "not-pending" },
      { approvalId: "startup-2", status: "resolved" },
    ]);
    expect(resolveInstallReview.mock.calls.map(([approvalId]) => approvalId)).toEqual([
      "startup-1",
      "startup-2",
      "startup-2",
    ]);
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
