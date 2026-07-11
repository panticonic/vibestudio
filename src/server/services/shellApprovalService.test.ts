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
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveUserland: vi.fn(),
        requestExternalAgent: vi.fn(async () => ({ behavior: "deny" as const })),
        resolveExternalAgent: vi.fn(),
        settleExternalAgent: vi.fn(() => 0),
        resolveExternalAgentByRequest: vi.fn(async () => 0),
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

  it("validates userland choices against the pending prompt", async () => {
    const resolve = vi.fn();
    const resolveUserland = vi.fn();
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveUserland,
        requestExternalAgent: vi.fn(async () => ({ behavior: "deny" as const })),
        resolveExternalAgent: vi.fn(),
        settleExternalAgent: vi.fn(() => 0),
        resolveExternalAgentByRequest: vi.fn(async () => 0),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => [
          {
            approvalId: "approval-1",
            callerId: "worker:alpha",
            callerKind: "worker" as const,
            repoPath: "workers/alpha",
            effectiveVersion: "hash-1",
            requestedAt: 10,
            kind: "userland" as const,
            subject: { id: "team-x:foo" },
            title: "Allow foo?",
            promptOptions: "choices" as const,
            options: [{ value: "allow", label: "Allow" }],
          },
        ]),
        cancelForCaller: vi.fn(),
      },
      deviceLabelFor: (deviceId) => (deviceId === "dev_1" ? "Gabriel's phone" : undefined),
    });

    // WP5 §4: the verified subject is threaded to the queue as the resolver, so
    // the resolution is attributable (userId + surface).
    await expect(
      service.handler(
        {
          caller: createVerifiedCaller("shell:dev_1", "shell", null, null, {
            userId: "usr_1",
            handle: "gabriel",
          }),
          wsClient: { clientPlatform: "mobile" } as never,
        },
        "resolveUserland",
        ["approval-1", "allow"]
      )
    ).resolves.toBeUndefined();
    expect(resolveUserland).toHaveBeenCalledWith("approval-1", "allow", {
      subject: { userId: "usr_1", handle: "gabriel" },
      via: "mobile-notification",
      deviceId: "dev_1",
      deviceLabel: "Gabriel's phone",
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolveUserland", [
        "approval-1",
        "synthetic",
      ])
    ).rejects.toMatchObject({ name: "ServiceError", code: "EINVAL" });

    // A subject-less bootstrap-era caller yields no resolver (undefined).
    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolveUserland", [
        "approval-1",
        "dismiss",
      ])
    ).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledWith("approval-1", "dismiss", undefined);
  });

  it("uses typed errors for missing userland approvals and unknown methods", async () => {
    const service = createShellApprovalService({
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve: vi.fn(),
        resolveUserland: vi.fn(),
        requestExternalAgent: vi.fn(async () => ({ behavior: "deny" as const })),
        resolveExternalAgent: vi.fn(),
        settleExternalAgent: vi.fn(() => 0),
        resolveExternalAgentByRequest: vi.fn(async () => 0),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
        cancelForCaller: vi.fn(),
      },
    });

    await expect(
      service.handler({ caller: createVerifiedCaller("shell", "shell") }, "resolveUserland", [
        "approval-1",
        "allow",
      ])
    ).rejects.toMatchObject({ name: "ServiceError", code: "ENOENT" });
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
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveUserland: vi.fn(),
        requestExternalAgent: vi.fn(async () => ({ behavior: "deny" as const })),
        resolveExternalAgent: vi.fn(),
        settleExternalAgent: vi.fn(() => 0),
        resolveExternalAgentByRequest: vi.fn(async () => 0),
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
        requestUserland: vi.fn(),
        presentDeviceCode: vi.fn(),
        onPendingChanged: vi.fn(),
        resolve,
        resolveUserland: vi.fn(),
        requestExternalAgent: vi.fn(async () => ({ behavior: "deny" as const })),
        resolveExternalAgent: vi.fn(),
        settleExternalAgent: vi.fn(() => 0),
        resolveExternalAgentByRequest: vi.fn(async () => 0),
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

  it("resolveExternalAgentByRequest resolves the pending relay by (channelId, requestId, resolveToken) as a panel", async () => {
    const approvalQueue = createApprovalQueue({ eventService: { emit: vi.fn() } as never });
    const metrics = createPushMetrics();
    const service = createShellApprovalService({ approvalQueue, metrics });
    const verdict = approvalQueue.requestExternalAgent({
      kind: "external-agent",
      callerId: "do:workers/agent:AgentWorker:entity-1",
      callerKind: "do",
      repoPath: "workers/linked",
      effectiveVersion: "hash-1",
      entityId: "entity-1",
      channelId: "channel-1",
      capability: "external-agent.tool",
      operationName: "Bash",
      requestId: "req-1",
      resolveToken: "resolve-token-123",
    });
    expect(approvalQueue.listPending()).toHaveLength(1);

    // The inline conversation card is a panel caller and knows the request selector plus token.
    const result = await service.handler(
      { caller: createVerifiedCaller("panel-1", "panel") },
      "resolveExternalAgentByRequest",
      [{ channelId: "channel-1", requestId: "req-1", resolveToken: "resolve-token-123" }, "allow"]
    );

    expect(result).toEqual({ resolved: true });
    await expect(verdict).resolves.toEqual({ behavior: "allow" });
    expect(approvalQueue.listPending()).toEqual([]);
    expect(metrics.snapshot().approval_resolved_total).toMatchObject({
      "decision=allow,source=panel": 1,
    });
  });

  it("resolveExternalAgentByRequest reports resolved:false and records nothing when no card matches", async () => {
    const approvalQueue = createApprovalQueue({ eventService: { emit: vi.fn() } as never });
    const metrics = createPushMetrics();
    const service = createShellApprovalService({ approvalQueue, metrics });
    const result = await service.handler(
      { caller: createVerifiedCaller("panel-1", "panel") },
      "resolveExternalAgentByRequest",
      [{ channelId: "channel-1", requestId: "absent", resolveToken: "resolve-token-123" }, "deny"]
    );
    expect(result).toEqual({ resolved: false });
    expect(metrics.snapshot().approval_resolved_total).not.toHaveProperty(
      "decision=deny,source=panel"
    );
  });
});
