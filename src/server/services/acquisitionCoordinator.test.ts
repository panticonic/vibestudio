import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
} from "@vibestudio/shared/authority/invocationSnapshot";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { AcquisitionCoordinator } from "./acquisitionCoordinator.js";
import type { ApprovalQueue } from "./approvalQueue.js";

function snapshot() {
  return createInvocationSnapshot({
    service: "gateway",
    method: "fetch",
    capability: "service:gateway.fetch",
    resourceKey: "https://example.com",
    args: ["https://example.com"],
    preparedStateDigest: "-",
    callerPrincipal: "session:chat-1",
    sessionId: "chat-1",
    mission: "-",
    snippetDigest: "a".repeat(64),
    codeLineage: { class: "internal", chain: [] },
    contextLineage: { class: "internal", latchEpoch: 0, externalKeys: [] },
    initiatorChain: ["user:u"],
  });
}

function reviewedPresentation() {
  return {
    title: "Use the local service",
    deniedReason: "The service request was denied.",
    resource: {
      type: "network-origin",
      label: "Website",
      value: "https://example.com",
    },
    operation: {
      kind: "network" as const,
      verb: "read from",
      object: {
        type: "network-origin",
        label: "Website",
        value: "https://example.com",
      },
    },
    authorityVocabulary: {
      domain: "web" as const,
      verb: "see" as const,
      declaredBy: "test:gateway.fetch",
    },
  };
}

describe("AcquisitionCoordinator", () => {
  it("rejects an acquisition origin for which no consumable grant subject exists", () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-user-")),
    });
    const request = vi.fn(async () => "session" as const);
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request } as never,
      grantStore,
    });
    const userSnapshot = {
      ...snapshot(),
      callerPrincipal: "user:alice" as const,
      sessionId: "interactive-1",
    };

    expect(() =>
      coordinator.request({
        snapshot: userSnapshot,
        snapshotDigest: invocationSnapshotDigest(userSnapshot),
        tier: "gated",
        caller: createVerifiedCaller("shell:alice", "shell", null, null, {
          userId: "alice",
          handle: "alice",
        }),
        renderedAction: "use the local service",
        resource: { kind: "exact", key: userSnapshot.resourceKey },
      })
    ).toThrow(/no grant decision valid/i);
    expect(request).not.toHaveBeenCalled();
    grantStore.close();
  });

  it("offers installed code only a digest-bound version decision", async () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-code-")),
    });
    const request = vi.fn(async () => "version" as const);
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request } as never,
      grantStore,
    });
    const codeSnapshot = {
      ...snapshot(),
      callerPrincipal: `code:workers/example@${"c".repeat(64)}` as const,
    };
    await coordinator.requestAndWait({
      snapshot: codeSnapshot,
      snapshotDigest: invocationSnapshotDigest(codeSnapshot),
      tier: "gated",
      caller: createVerifiedCaller("do:workers/example:Example:test", "do", {
        callerId: "do:workers/example:Example:test",
        callerKind: "do",
        repoPath: "workers/example",
        effectiveVersion: "ev-test",
        executionDigest: "c".repeat(64),
        requested: [],
      }),
      renderedAction: "use the local service",
      resource: { kind: "exact", key: codeSnapshot.resourceKey },
      presentation: reviewedPresentation(),
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedDecisions: ["version", "deny"],
        title: "Use the local service",
        description: "Requests permission to use the local service.",
      })
    );
    expect(
      grantStore.grantsForSubjects([codeSnapshot.callerPrincipal], codeSnapshot.capability)
    ).toEqual([expect.objectContaining({ subject: codeSnapshot.callerPrincipal })]);
    grantStore.close();
  });

  it("projects rich unit review through the canonical acquisition", async () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-unit-review-")),
    });
    const request = vi.fn(async () => "once" as const);
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request } as never,
      grantStore,
    });
    const snap = snapshot();
    const caller = createVerifiedCaller("do:test", "do");
    await coordinator.requestAndWait({
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      tier: "gated",
      caller,
      renderedAction: "publish panel source",
      resource: { kind: "exact", key: snap.resourceKey },
      presentation: {
        ...reviewedPresentation(),
        unitBatch: {
          trigger: "source-change",
          units: [
            {
              unitKind: "panel",
              unitName: "@workspace-panels/example",
              displayName: "Example",
              source: { kind: "workspace-repo", repo: "panels/example", ref: "main" },
              capabilities: [],
            },
          ],
          configWrite: null,
        },
      },
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "source-change",
        units: [expect.objectContaining({ unitKind: "panel", displayName: "Example" })],
      })
    );
    grantStore.close();
  });

  it("deduplicates exact asks, waits without a deadline, and mints a task grant", async () => {
    let resolve!: (decision: "task") => void;
    const request = vi.fn(
      () =>
        new Promise<"task">((done) => {
          resolve = done;
        })
    );
    const approvalQueue = { request } as never;
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-")),
    });
    const coordinator = new AcquisitionCoordinator({ approvalQueue, grantStore });
    const snap = { ...snapshot(), taskRef: "task:chat-1" };
    const input = {
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      tier: "gated" as const,
      caller: createVerifiedCaller("agent:1", "agent", null, {
        agentId: "a",
        entityId: "e",
        contextId: "c",
        channelId: "chat-1",
      }),
      renderedAction: "access example.com",
      resource: { kind: "origin" as const, origin: "https://example.com" },
      presentation: reviewedPresentation(),
    };
    const first = coordinator.request(input);
    const second = coordinator.request(input);
    expect(second.acquisitionId).toBe(first.acquisitionId);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "network", verb: "read from" }),
      })
    );
    await expect(
      coordinator.awaitDecision({
        acquisitionId: first.acquisitionId,
        ownerRuntimeId: "agent:someone-else",
      })
    ).rejects.toMatchObject({ code: "EACCES" });
    const waiting = coordinator.awaitDecision({
      acquisitionId: first.acquisitionId,
      ownerRuntimeId: input.caller.runtime.id,
    });
    resolve("task");
    await expect(waiting).resolves.toEqual({ state: "decided", decision: "task" });
    expect(grantStore.grantsForSubjects(["session:chat-1"], snap.capability)).toHaveLength(1);
    grantStore.close();
  });

  it("uses only a host-attested per-run test policy for gated reversible invocations", async () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-test-policy-")),
    });
    const request = vi.fn(async () => "deny" as const);
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request } as never,
      grantStore,
    });
    const snap = {
      ...snapshot(),
      callerPrincipal: `code:workers/test-infrastructure@${"d".repeat(64)}` as const,
      executionMode: "test" as const,
      testPolicyId: "test:run-123",
    };
    const input = {
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      tier: "gated" as const,
      caller: {
        ...createVerifiedCaller("do:test-runner", "do", {
          callerId: "do:test-runner",
          callerKind: "do",
          repoPath: "workers/test-infrastructure",
          effectiveVersion: "ev-test",
          executionDigest: "d".repeat(64),
          requested: [],
        }),
        testPolicy: {
          policyId: "test:run-123",
          kind: "orchestrator" as const,
        },
      },
      renderedAction: "read the test fixture",
      resource: { kind: "exact" as const, key: snap.resourceKey },
    };
    const info = coordinator.request(input);
    expect(info.pending).toBe(false);
    await expect(
      coordinator.awaitDecision({
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: input.caller.runtime.id,
      })
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(coordinator.requestAndWait(input)).resolves.toMatchObject({
      state: "decided",
      decision: "once",
      info: { acquisitionId: info.acquisitionId, pending: false },
    });
    expect(request).not.toHaveBeenCalled();
    expect(grantStore.listAuthorityGrants()).toEqual([
      expect.objectContaining({
        subject: snap.callerPrincipal,
        scope: "once",
        provenance: "preauthorization",
        constraints: expect.objectContaining({
          invocationDigest: invocationSnapshotDigest(snap),
        }),
      }),
      expect.objectContaining({
        subject: snap.callerPrincipal,
        scope: "once",
        provenance: "preauthorization",
        constraints: expect.objectContaining({
          invocationDigest: invocationSnapshotDigest(snap),
        }),
      }),
    ]);
    grantStore.close();
  });

  it("admits only an exact case rule and fails an unexpected test prompt", () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-test-case-")),
    });
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request: vi.fn() } as never,
      grantStore,
    });
    const snap = {
      ...snapshot(),
      capability: "user-approval.revoke",
      resourceKey: "user-approval.revoke",
      callerPrincipal: "session:chat-1" as const,
      executionMode: "test" as const,
      testPolicyId: "test:run-123:case:approval",
    };
    const caller = {
      ...createVerifiedCaller("do:test-runner", "do", {
        callerId: "do:test-runner",
        callerKind: "do",
        repoPath: "workers/test-infrastructure",
        effectiveVersion: "ev-test",
        executionDigest: "d".repeat(64),
        requested: [],
      }),
      testPolicy: {
        policyId: snap.testPolicyId,
        kind: "case" as const,
        orchestratorPolicyId: "test:run-123",
        case: {
          testId: "approval",
          authority: [
            {
              ruleId: "revoke",
              capability: snap.capability,
              resource: { kind: "exact" as const, key: snap.resourceKey },
              tier: "critical" as const,
              decision: "once" as const,
            },
          ],
          userland: [],
          unexpectedPrompts: "fail" as const,
        },
      },
    };
    const input = {
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      tier: "critical" as const,
      caller,
      renderedAction: "remove a test decision",
      resource: { kind: "exact" as const, key: snap.resourceKey },
    };

    expect(coordinator.request(input)).toMatchObject({ preauthorized: true, pending: false });
    expect(grantStore.listAuthorityGrants()).toEqual([
      expect.objectContaining({
        capability: snap.capability,
        provenance: "critical-confirmation",
        issuedBy: expect.stringContaining(":revoke"),
      }),
    ]);
    expect(() =>
      coordinator.request({
        ...input,
        snapshot: { ...snap, capability: "unexpected.capability" },
        snapshotDigest: invocationSnapshotDigest({
          ...snap,
          capability: "unexpected.capability",
        }),
      })
    ).toThrow(/Unexpected authority prompt/);
    grantStore.close();
  });

  it("never routes a test-mode invocation with missing or mismatched policy to the UI", () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-test-integrity-")),
    });
    const request = vi.fn();
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request } as never,
      grantStore,
    });
    const snap = {
      ...snapshot(),
      executionMode: "test" as const,
      testPolicyId: "test:expected",
    };
    const base = {
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      tier: "gated" as const,
      renderedAction: "publish source",
      resource: { kind: "exact" as const, key: snap.resourceKey },
    };

    expect(() =>
      coordinator.request({
        ...base,
        caller: createVerifiedCaller("do:test", "do"),
      })
    ).toThrow(expect.objectContaining({ code: "ETESTPOLICYMISSING" }));

    const caller = {
      ...createVerifiedCaller("do:test", "do"),
      testPolicy: { policyId: "test:other", kind: "orchestrator" as const },
    };
    expect(() => coordinator.request({ ...base, caller })).toThrow(
      expect.objectContaining({
        code: "ETESTPOLICYMISMATCH",
        snapshotPolicyId: "test:expected",
        residentPolicyId: "test:other",
      })
    );
    expect(request).not.toHaveBeenCalled();
    grantStore.close();
  });

  it("releases terminal rendezvous state while retaining a bounded awaitDecision race result", async () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-terminal-")),
    });
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request: vi.fn(async () => "deny" as const) } as never,
      grantStore,
    });
    const snap = snapshot();
    const input = {
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      tier: "critical" as const,
      caller: createVerifiedCaller("agent:terminal", "agent", null, {
        agentId: "agent-terminal",
        entityId: "agent:terminal",
        contextId: "ctx-terminal",
        channelId: "chat-1",
      }),
      renderedAction: "access example.com",
      resource: { kind: "origin" as const, origin: "https://example.com" },
      presentation: reviewedPresentation(),
    };

    const info = coordinator.request(input);
    await vi.waitFor(() => expect(coordinator.pending()).toEqual([]));
    await expect(
      coordinator.awaitDecision({
        acquisitionId: info.acquisitionId,
        ownerRuntimeId: input.caller.runtime.id,
      })
    ).resolves.toEqual({ state: "decided", decision: "deny" });

    const internals = coordinator as unknown as {
      byRequestKey: Map<unknown, unknown>;
      byId: Map<unknown, unknown>;
      completedById: Map<unknown, unknown>;
    };
    expect(internals.byRequestKey.size).toBe(0);
    expect(internals.byId.size).toBe(0);
    expect(internals.completedById.size).toBe(1);
    grantStore.close();
  });

  it("bounds terminal acquisition observations for unique requests", async () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-bounded-")),
    });
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request: vi.fn(async () => "deny" as const) } as never,
      grantStore,
    });
    const caller = createVerifiedCaller("agent:bounded", "agent", null, {
      agentId: "agent-bounded",
      entityId: "agent:bounded",
      contextId: "ctx-bounded",
      channelId: "chat-1",
    });

    for (let index = 0; index < 520; index += 1) {
      const resourceKey = `https://example.com/${index}`;
      const snap = { ...snapshot(), resourceKey, args: [resourceKey] };
      await coordinator.requestAndWait({
        snapshot: snap,
        snapshotDigest: invocationSnapshotDigest(snap),
        tier: "critical",
        caller,
        renderedAction: `access request ${index}`,
        resource: { kind: "origin", origin: "https://example.com" },
        presentation: reviewedPresentation(),
      });
    }

    const internals = coordinator as unknown as {
      byRequestKey: Map<unknown, unknown>;
      byId: Map<unknown, unknown>;
      completedById: Map<unknown, unknown>;
    };
    expect(internals.byRequestKey.size).toBe(0);
    expect(internals.byId.size).toBe(0);
    expect(internals.completedById.size).toBe(512);
    grantStore.close();
  });

  it("withdraws a parked acquisition when its invocation is cancelled without recording a deny", async () => {
    const request = vi.fn(
      (req: { signal?: AbortSignal }) =>
        new Promise<"deny">((resolve) => {
          const abort = () => resolve("deny");
          if (req.signal?.aborted) queueMicrotask(abort);
          else req.signal?.addEventListener("abort", abort, { once: true });
        })
    );
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-cancel-")),
    });
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request } as never,
      grantStore,
    });
    const snap = snapshot();
    const controller = new AbortController();
    const waiting = coordinator.requestAndWait(
      {
        snapshot: snap,
        snapshotDigest: invocationSnapshotDigest(snap),
        tier: "gated",
        caller: createVerifiedCaller("agent:cancelled", "agent", null, {
          agentId: "agent-cancelled",
          entityId: "agent:cancelled",
          contextId: "ctx-cancelled",
          channelId: "chat-1",
        }),
        renderedAction: "access example.com",
        resource: { kind: "origin", origin: "https://example.com" },
        presentation: reviewedPresentation(),
      },
      controller.signal
    );

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    controller.abort();

    await expect(waiting).rejects.toMatchObject({ name: "AbortError", code: "ABORT_ERR" });
    await vi.waitFor(() => expect(coordinator.pending()).toEqual([]));
    expect(grantStore.grantsForSubjects(["session:chat-1"], snap.capability)).toEqual([]);
    grantStore.close();
  });

  it("uses the host-derived challenge presentation instead of rebuilding handler copy", async () => {
    const request = vi.fn(async () => "once" as const);
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-presentation-")),
    });
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request } as never,
      grantStore,
    });
    const snap = snapshot();
    const signal = new AbortController().signal;

    await coordinator.requestAndWait({
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      tier: "gated",
      caller: createVerifiedCaller("agent:1", "agent", null),
      renderedAction: "fallback action",
      resource: { kind: "exact", key: snap.resourceKey },
      presentation: {
        ...reviewedPresentation(),
        title: "Open panel in another workspace branch",
        description: "This panel will use another branch.",
        severity: "severe",
        deniedReason: "Opening the panel was denied",
        dedupKey: "context-boundary:one:two",
        resource: { type: "context", label: "Workspace branch", value: "two" },
        operation: {
          kind: "runtime",
          verb: "Open panel",
          object: { type: "context", label: "Workspace branch", value: "two" },
        },
        details: [{ label: "Source", value: "panels/chat" }],
        allowedDecisions: ["once", "deny"],
        signal,
      },
    });

    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Open panel in another workspace branch",
        description: "This panel will use another branch.",
        severity: "severe",
        dedupKey: "context-boundary:one:two",
        resource: { type: "context", label: "Workspace branch", value: "two" },
        operation: expect.objectContaining({ kind: "runtime", verb: "Open panel" }),
        details: [{ label: "Source", value: "panels/chat" }],
        signal,
      })
    );
    grantStore.close();
  });

  it("does not deduplicate the same snapshot across authenticated runtimes", () => {
    const request = vi.fn(() => new Promise<"session">(() => {}));
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-")),
    });
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request } as never,
      grantStore,
    });
    const snap = snapshot();
    const base = {
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      tier: "gated" as const,
      renderedAction: "access example.com",
      resource: { kind: "origin" as const, origin: "https://example.com" },
      presentation: reviewedPresentation(),
    };

    const first = coordinator.request({
      ...base,
      caller: createVerifiedCaller("agent:one", "agent", null),
    });
    const second = coordinator.request({
      ...base,
      caller: createVerifiedCaller("agent:two", "agent", null),
    });

    expect(second.acquisitionId).not.toBe(first.acquisitionId);
    expect(request).toHaveBeenCalledTimes(2);
    grantStore.close();
  });

  it("mints critical confirmation as a single consumable bound to the invocation", async () => {
    const request = vi.fn(async () => "once" as const);
    const approvalQueue = { request } as unknown as ApprovalQueue;
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-")),
    });
    const coordinator = new AcquisitionCoordinator({ approvalQueue, grantStore });
    const snap = snapshot();
    const digest = invocationSnapshotDigest(snap);
    await coordinator.requestAndWait({
      snapshot: snap,
      snapshotDigest: digest,
      tier: "critical",
      caller: createVerifiedCaller("agent:1", "agent", null, {
        agentId: "a",
        entityId: "e",
        contextId: "c",
        channelId: "chat-1",
      }),
      renderedAction: "remove the permission",
      resource: { kind: "exact", key: snap.resourceKey },
      presentation: reviewedPresentation(),
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ kind: "network", verb: "read from" }),
      })
    );
    const [grant] = grantStore.grantsForSubjects(["session:chat-1"], snap.capability);
    expect(grant).toMatchObject({
      provenance: "critical-confirmation",
      constraints: { invocationDigest: digest },
    });
    expect(grantStore.consume(grant!.id!)).toBe(true);
    expect(grantStore.consume(grant!.id!)).toBe(false);
    grantStore.close();
  });

  it("mints an ordinary session deny but never a durable critical deny", async () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-")),
    });
    const snap = snapshot();
    const input = {
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      caller: createVerifiedCaller("agent:1", "agent", null, {
        agentId: "a",
        entityId: "e",
        contextId: "c",
        channelId: "chat-1",
      }),
      renderedAction: "access example.com",
      resource: { kind: "origin" as const, origin: "https://example.com" },
      presentation: reviewedPresentation(),
    };
    await new AcquisitionCoordinator({
      approvalQueue: { request: vi.fn(async () => "deny" as const) } as never,
      grantStore,
    }).requestAndWait({ ...input, tier: "gated" });
    expect(grantStore.grantsForSubjects(["session:chat-1"], snap.capability)).toEqual([
      expect.objectContaining({ effect: "deny", provenance: "acquisition" }),
    ]);

    const criticalSnap = { ...snap, method: "remove", capability: "service:gateway.remove" };
    await new AcquisitionCoordinator({
      approvalQueue: { request: vi.fn(async () => "deny" as const) } as never,
      grantStore,
    }).requestAndWait({
      ...input,
      snapshot: criticalSnap,
      snapshotDigest: invocationSnapshotDigest(criticalSnap),
      tier: "critical",
    });
    expect(grantStore.grantsForSubjects(["session:chat-1"], criticalSnap.capability)).toEqual([]);
    grantStore.close();
  });

  it("treats dismissal as Not now with cooldown and no authority row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const request = vi.fn(async () => "dismiss" as const);
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-")),
    });
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request } as never,
      grantStore,
    });
    const snap = snapshot();
    const input = {
      snapshot: snap,
      snapshotDigest: invocationSnapshotDigest(snap),
      tier: "gated" as const,
      caller: createVerifiedCaller("agent:1", "agent", null, {
        agentId: "a",
        entityId: "e",
        contextId: "c",
        channelId: "chat-1",
      }),
      renderedAction: "access example.com",
      resource: { kind: "origin" as const, origin: "https://example.com" },
      presentation: reviewedPresentation(),
    };
    await expect(coordinator.requestAndWait(input)).resolves.toMatchObject({
      state: "closed",
      info: { pending: true, cooldownUntil: expect.any(Number) },
    });
    expect(grantStore.grantsForSubjects(["session:chat-1"], snap.capability)).toEqual([]);
    const retry = coordinator.request(input);
    expect(retry).toMatchObject({ pending: true, cooldownUntil: expect.any(Number) });
    expect(request).toHaveBeenCalledTimes(1);
    grantStore.close();
    vi.useRealTimers();
  });

  it("wakes the durable owner after settlement without making the hint part of correctness", async () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-wake-")),
    });
    const notifyOwner = vi.fn(async () => {
      throw new Error("owner is restarting");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const snap = snapshot();
    const caller = createVerifiedCaller("agent:durable", "agent", null, {
      agentId: "agent-1",
      entityId: "entity-1",
      contextId: "context-1",
      channelId: "chat-1",
    });
    const coordinator = new AcquisitionCoordinator({
      approvalQueue: { request: vi.fn(async () => "deny" as const) } as never,
      grantStore,
      notifyOwner,
    });

    await expect(
      coordinator.requestAndWait({
        snapshot: snap,
        snapshotDigest: invocationSnapshotDigest(snap),
        tier: "gated",
        caller,
        renderedAction: "access example.com",
        resource: { kind: "origin", origin: "https://example.com" },
        presentation: reviewedPresentation(),
      })
    ).resolves.toMatchObject({ state: "decided", decision: "deny" });
    await Promise.resolve();

    expect(notifyOwner).toHaveBeenCalledOnce();
    expect(notifyOwner).toHaveBeenCalledWith(caller.runtime.id, expect.stringMatching(/^acq:/));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(caller.runtime.id),
      "owner is restarting"
    );
    warn.mockRestore();
    grantStore.close();
  });
});
