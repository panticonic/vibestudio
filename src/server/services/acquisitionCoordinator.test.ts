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
        evalCeilings: [],
      }),
      renderedAction: "use the local service",
      resource: { kind: "exact", key: codeSnapshot.resourceKey },
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

  it("deduplicates exact asks, waits without a deadline, and mints a session grant", async () => {
    let resolve!: (decision: "session") => void;
    const request = vi.fn(
      () =>
        new Promise<"session">((done) => {
          resolve = done;
        })
    );
    const approvalQueue = { request } as never;
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-acq-")),
    });
    const coordinator = new AcquisitionCoordinator({ approvalQueue, grantStore });
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
    };
    const first = coordinator.request(input);
    const second = coordinator.request(input);
    expect(second.acquisitionId).toBe(first.acquisitionId);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ groupKey: "acquire:chat-1" }),
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
    resolve("session");
    await expect(waiting).resolves.toEqual({ state: "decided", decision: "session" });
    expect(grantStore.grantsForSubjects(["session:chat-1"], snap.capability)).toHaveLength(1);
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
    });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: expect.objectContaining({ groupKey: `confirm:${digest}` }),
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
});
