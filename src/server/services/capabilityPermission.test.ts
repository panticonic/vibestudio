import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  normalizeCallerKind,
  panelCapabilityResourceKey,
  requestCapabilityPermission,
} from "./capabilityPermission.js";
import type { ApprovalQueue } from "./approvalQueue.js";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

const DIGEST_A = "1".repeat(64);
const DIGEST_B = "2".repeat(64);

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-capability-"));
}

function createApprovalQueueMock(
  decision: Awaited<ReturnType<ApprovalQueue["request"]>> = "session"
): ApprovalQueue {
  return {
    request: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestUserland: vi.fn(async () => ({ kind: "dismissed" as const })),
    presentDeviceCode: vi.fn(() => ({
      approvalId: "device-code-test",
      cancelled: new AbortController().signal,
      dispose: vi.fn(),
    })),
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
  };
}

describe("capabilityPermission", () => {
  it("stores session approvals as canonical authority grants", () => {
    const store = new CapabilityGrantStore({ statePath: tempStatePath() });
    store.grant(
      "native.notifications",
      "desktop",
      {
        callerId: "app:apps/shell:window-1",
        repoPath: "apps/shell",
        executionDigest: DIGEST_A,
      },
      "session",
      undefined,
      10
    );
    expect(store.listSession()).toEqual([
      expect.objectContaining({
        subject: `code:apps/shell@${DIGEST_A}`,
        capability: "native.notifications",
        resource: { kind: "exact", key: "desktop" },
        effect: "allow",
        createdAt: 10,
        constraints: { sessionId: "app:apps/shell:window-1" },
        binding: {
          kind: "session",
          sessionId: "app:apps/shell:window-1",
          repoPath: "apps/shell",
          executionDigest: DIGEST_A,
        },
      }),
    ]);
  });

  it("stores reusable grants with a stable resource key", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = {
      caller: createVerifiedCaller(
        "panel-source",
        "panel",
        {
          callerId: "panel-source",
          callerKind: "panel",
          repoPath: "panels/source",
          executionDigest: DIGEST_A,
          requested: [
            { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
            { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
          ],
        },
        null,
        { userId: "usr_requester", handle: "requester" }
      ),
      capability: "example-capability",
      resource: {
        type: "example",
        label: "Example",
        value: "Display value",
        key: "stable-key",
      },
      title: "Example action",
      deniedReason: "Denied",
    };

    await expect(requestCapabilityPermission(deps, request)).resolves.toMatchObject({
      allowed: true,
    });
    await expect(requestCapabilityPermission(deps, request)).resolves.toMatchObject({
      allowed: true,
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedByUserId: "usr_requester",
        resource: {
          type: "example",
          label: "Example",
          value: "Display value",
        },
      })
    );
  });

  it("reuses version-scoped capability grants", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = {
      caller: createVerifiedCaller("worker:source", "worker", {
        callerId: "worker:source",
        callerKind: "worker",
        repoPath: "workers/source",
        executionDigest: DIGEST_A,
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
      capability: "example-capability",
      resource: { type: "example", label: "Example", value: "stable-key" },
      title: "Example action",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, request);
    await requestCapabilityPermission(deps, request);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a version grant for a different artifact digest", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = (executionDigest: string) => ({
      caller: createVerifiedCaller("worker:source", "worker", {
        callerId: "worker:source",
        callerKind: "worker" as const,
        repoPath: "workers/source",
        executionDigest,
        requested: [{ capability: "service:*", resource: { kind: "prefix", prefix: "" } }],
      }),
      capability: "example-capability",
      resource: { type: "example", label: "Example", value: "stable-key" },
      title: "Example action",
      deniedReason: "Denied",
    });

    await requestCapabilityPermission(deps, request(DIGEST_A));
    await requestCapabilityPermission(deps, request(DIGEST_B));

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("fails closed before prompting when code has no exact artifact digest", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };

    await expect(
      requestCapabilityPermission(deps, {
        caller: createVerifiedCaller("worker:source", "worker", {
          callerId: "worker:source",
          callerKind: "worker",
          repoPath: "workers/source",
          executionDigest: "unknown",
          requested: [
            { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
            { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
          ],
        }),
        capability: "example-capability",
        resource: { type: "example", label: "Example", value: "stable-key" },
        title: "Example action",
        deniedReason: "Denied",
      })
    ).resolves.toEqual({
      allowed: false,
      reason: "capability caller execution digest must be a full lowercase SHA-256 digest",
    });
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("shares version grants across incarnations of the same exact code artifact", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const baseRequest = {
      capability: "external-browser-open",
      resource: { type: "origin", label: "Origin", value: "https://example.com" },
      title: "Open external browser",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("do:workers/eval:EvalDO:one", "do", {
        callerId: "do:workers/eval:EvalDO:one",
        callerKind: "do",
        repoPath: "workers/eval",
        executionDigest: DIGEST_A,
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("do:workers/eval:EvalDO:one", "do", {
        callerId: "do:workers/eval:EvalDO:one",
        callerKind: "do",
        repoPath: "workers/eval",
        executionDigest: DIGEST_A,
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("do:workers/eval:EvalDO:two", "do", {
        callerId: "do:workers/eval:EvalDO:two",
        callerKind: "do",
        repoPath: "workers/eval",
        executionDigest: DIGEST_A,
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("refuses the retired caller-bound grant format without rewriting it", () => {
    const statePath = tempStatePath();
    fs.writeFileSync(
      path.join(statePath, "capability-grants.json"),
      JSON.stringify({
        grants: [
          {
            capability: "external-browser-open",
            resourceKey: "https://example.com",
            resourceScope: { kind: "exact", key: "https://example.com" },
            scope: "version",
            callerId: "do:workers/eval:EvalDO:one",
            repoPath: "workers/eval",
            executionDigest: DIGEST_A,
            grantedAt: 1,
          },
        ],
      })
    );

    const before = fs.readFileSync(path.join(statePath, "capability-grants.json"), "utf8");
    expect(() => new CapabilityGrantStore({ statePath })).toThrow(
      "scoped runtime-foundations reset"
    );
    expect(fs.readFileSync(path.join(statePath, "capability-grants.json"), "utf8")).toBe(before);
  });

  it("refuses retired repository-scoped grants without a compatibility reader", () => {
    const statePath = tempStatePath();
    const filePath = path.join(statePath, "capability-grants.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        grants: [
          {
            capability: "external-browser-open",
            resourceKey: "https://example.com",
            resourceScope: { kind: "exact", key: "https://example.com" },
            scope: "repo",
            repoPath: "workers/source",
            grantedAt: 1,
          },
        ],
      })
    );

    const before = fs.readFileSync(filePath, "utf8");
    expect(() => new CapabilityGrantStore({ statePath })).toThrow(
      "scoped runtime-foundations reset"
    );
    expect(fs.readFileSync(filePath, "utf8")).toBe(before);
  });

  it("keys session-scoped capability grants to the concrete caller identity", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const baseRequest = {
      capability: "example-capability",
      resource: { type: "example", label: "Example", value: "stable-key" },
      title: "Example action",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("panel:first", "panel", {
        callerId: "panel:first",
        callerKind: "panel",
        repoPath: "panels/source",
        executionDigest: DIGEST_A,
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: createVerifiedCaller("panel:second", "panel", {
        callerId: "panel:second",
        callerKind: "panel",
        repoPath: "panels/source",
        executionDigest: DIGEST_A,
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("keeps session network grants scoped to the requested origin", async () => {
    const approvalQueue = createApprovalQueueMock("session");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const caller = createVerifiedCaller("worker:network", "worker", {
      callerId: "worker:network",
      callerKind: "worker",
      repoPath: "workers/network",
      executionDigest: DIGEST_A,
      requested: [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
        { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
      ],
    });
    const requestForOrigin = (origin: string) => ({
      caller,
      capability: "external-network-fetch",
      resource: {
        type: "url-origin",
        label: "Target origin",
        value: origin,
        key: origin,
        scope: { kind: "origin" as const, origin },
      },
      title: `Connect to ${origin}`,
      deniedReason: "Denied",
    });

    await requestCapabilityPermission(deps, requestForOrigin("https://one.example"));
    await requestCapabilityPermission(deps, requestForOrigin("https://one.example"));
    await requestCapabilityPermission(deps, requestForOrigin("https://two.example"));

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        grantResourceKey: "https://one.example",
        resourceScope: { kind: "origin", origin: "https://one.example" },
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        grantResourceKey: "https://two.example",
        resourceScope: { kind: "origin", origin: "https://two.example" },
      })
    );
  });

  it("uses trust decisions for network-wide grants per capability", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const caller = createVerifiedCaller("worker:network", "worker", {
      callerId: "worker:network",
      callerKind: "worker",
      repoPath: "workers/network",
      executionDigest: DIGEST_A,
      requested: [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
        { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
      ],
    });
    const requestFor = (capability: string, origin: string) => ({
      caller,
      capability,
      resource: {
        type: "url-origin",
        label: "Target origin",
        value: origin,
        key: origin,
        scope: { kind: "origin" as const, origin },
      },
      title: `Network access to ${origin}`,
      deniedReason: "Denied",
    });

    await requestCapabilityPermission(
      deps,
      requestFor("external-network-fetch", "https://one.example")
    );
    await requestCapabilityPermission(
      deps,
      requestFor("external-network-fetch", "https://two.example")
    );
    await requestCapabilityPermission(
      deps,
      requestFor("cors-response-read", "https://two.example")
    );

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("shares broad network trust across incarnations of one exact artifact", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const caller = (id: string) =>
      createVerifiedCaller(id, "do", {
        callerId: id,
        callerKind: "do",
        repoPath: "workers/eval",
        executionDigest: DIGEST_A,
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      });
    const requestFor = (id: string, origin: string) => ({
      caller: caller(id),
      capability: "external-network-fetch",
      resource: {
        type: "url-origin",
        label: "Target origin",
        value: origin,
        key: origin,
        scope: { kind: "origin" as const, origin },
      },
      title: `Connect to ${origin}`,
      deniedReason: "Denied",
    });

    await requestCapabilityPermission(
      deps,
      requestFor("do:workers/eval:EvalDO:one", "https://one.example")
    );
    await requestCapabilityPermission(
      deps,
      requestFor("do:workers/eval:EvalDO:one", "https://two.example")
    );
    await requestCapabilityPermission(
      deps,
      requestFor("do:workers/eval:EvalDO:two", "https://two.example")
    );

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("supports requester-entity scoped panel grants even for repo/version approvals", async () => {
    const approvalQueue = createApprovalQueueMock("version");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const targetPanelId = "target-panel";
    const baseRequest = {
      capability: "context.boundary",
      resource: {
        type: "panel",
        label: "Panel",
        value: "Target Panel",
      },
      title: "Automate panel",
      deniedReason: "Denied",
    };

    const firstCaller = createVerifiedCaller("panel:first-entity", "panel", {
      callerId: "panel:first-entity",
      callerKind: "panel",
      repoPath: "panels/source",
      executionDigest: DIGEST_A,
      requested: [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
        { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
      ],
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: firstCaller,
      resource: {
        ...baseRequest.resource,
        key: panelCapabilityResourceKey(targetPanelId, firstCaller.runtime.id),
      },
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: firstCaller,
      resource: {
        ...baseRequest.resource,
        key: panelCapabilityResourceKey(targetPanelId, firstCaller.runtime.id),
      },
    });
    const secondCaller = createVerifiedCaller("panel:second-entity", "panel", {
      callerId: "panel:second-entity",
      callerKind: "panel",
      repoPath: "panels/source",
      executionDigest: DIGEST_A,
      requested: [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
        { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
      ],
    });
    await requestCapabilityPermission(deps, {
      ...baseRequest,
      caller: secondCaller,
      resource: {
        ...baseRequest.resource,
        key: panelCapabilityResourceKey(targetPanelId, secondCaller.runtime.id),
      },
    });

    // Each requester entity is scoped by its own resource key, so a version/repo
    // grant from one requester does not satisfy another's prompt.
    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        grantResourceKey: panelCapabilityResourceKey(targetPanelId, firstCaller.runtime.id),
      })
    );
    expect(approvalQueue.request).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        grantResourceKey: panelCapabilityResourceKey(targetPanelId, secondCaller.runtime.id),
      })
    );
  });

  it("passes capability severity through to approval prompts", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };

    await requestCapabilityPermission(deps, {
      caller: createVerifiedCaller("panel:source", "panel", {
        callerId: "panel:source",
        callerKind: "panel",
        repoPath: "panels/source",
        executionDigest: DIGEST_A,
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
      capability: "context.boundary",
      severity: "severe",
      resource: {
        type: "panel",
        label: "Panel",
        value: "Shell",
        key: panelCapabilityResourceKey("shell-panel", "panel:source"),
      },
      title: "Automate privileged panel",
      deniedReason: "Denied",
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        severity: "severe",
      })
    );
  });

  describe("normalizeCallerKind", () => {
    it("accepts app, panel, worker, do, and extension caller kinds", () => {
      expect(normalizeCallerKind("app")).toBe("app");
      expect(normalizeCallerKind("panel")).toBe("panel");
      expect(normalizeCallerKind("worker")).toBe("worker");
      expect(normalizeCallerKind("do")).toBe("do");
      // Extensions are verified principals (minted code identity), so they
      // participate in capability approvals and grant scoping.
      expect(normalizeCallerKind("extension")).toBe("extension");
    });

    it("rejects shell and server caller kinds", () => {
      expect(normalizeCallerKind("shell")).toBeNull();
      expect(normalizeCallerKind("server")).toBeNull();
    });
  });

  it("does not store allow-once grants", async () => {
    const approvalQueue = createApprovalQueueMock("once");
    const deps = {
      approvalQueue,
      grantStore: new CapabilityGrantStore({ statePath: tempStatePath() }),
    };
    const request = {
      caller: createVerifiedCaller("worker:source", "worker", {
        callerId: "worker:source",
        callerKind: "worker",
        repoPath: "workers/source",
        executionDigest: DIGEST_A,
        requested: [
          { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
          { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
        ],
      }),
      capability: "example-capability",
      resource: { type: "example", label: "Example", value: "stable-key" },
      title: "Example action",
      deniedReason: "Denied",
    };

    await requestCapabilityPermission(deps, request);
    await requestCapabilityPermission(deps, request);

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });
});
