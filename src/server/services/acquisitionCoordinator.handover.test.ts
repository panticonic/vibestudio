import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  createInvocationSnapshot,
  invocationSnapshotDigest,
} from "@vibestudio/shared/authority/invocationSnapshot";
import { AcquisitionCoordinator } from "./acquisitionCoordinator.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { ApprovalQueue, ApprovalQueueRequest } from "./approvalQueue.js";

function fixture(kind: "ordinary" | "target") {
  const statePath = mkdtempSync(join(tmpdir(), "authority-handover-"));
  const grantStore = new CapabilityGrantStore({ statePath });
  const targetRequests = kind === "target" ? grantStore.targetRequests : null;
  let decide!: (decision: "deny") => void;
  const decision = new Promise<"deny">((resolve) => {
    decide = resolve;
  });
  const notifyOwner = vi.fn((): void => undefined);
  const coordinator = new AcquisitionCoordinator({
    grantStore,
    approvalQueue: {
      request: (request: ApprovalQueueRequest) => {
        const cancel = () => decide("deny");
        if (request.signal?.aborted) cancel();
        else request.signal?.addEventListener("abort", cancel, { once: true });
        return decision.finally(() => request.signal?.removeEventListener("abort", cancel));
      },
    } as unknown as ApprovalQueue,
    notifyOwner,
  });
  const caller = createVerifiedCaller("do:workers/test:Agent:owner", "do");
  const target = `mission:handover@${"a".repeat(64)}` as const;
  const snapshot = createInvocationSnapshot({
    service: "gateway",
    method: "fetch",
    capability: "service:gateway.fetch",
    capabilityDefinitionDigest: "-",
    resourceType: "network",
    provider: "-",
    providerExecutionDigest: "-",
    resourceKey: "https://example.com",
    args: ["https://example.com"],
    preparedStateDigest: "-",
    callerPrincipal: "session:chat-1",
    sessionId: "chat-1",
    missionSubject: kind === "target" ? target : "-",
    snippetDigest: "a".repeat(64),
    codeLineage: { class: "internal", chain: [] },
    initiatorChain: ["user:u"],
  });
  const resource = { kind: "exact" as const, key: snapshot.resourceKey };
  let targetRequestId: string | undefined;
  if (kind === "target") {
    targetRequestId = coordinator.requestForTarget({
      targetSubject: target,
      authorityPlanDigest: "b".repeat(64),
      operationKey: "gateway.fetch",
      capability: snapshot.capability,
      capabilityDefinitionDigest: snapshot.capabilityDefinitionDigest,
      resource,
      tier: "gated",
      sourceUser: "user:u",
      renderedAction: "read example.com",
      review: { domain: "web", verb: "see", action: "read example.com", declaredBy: "test" },
    }).requestId;
  }
  const info = coordinator.request({
    snapshot,
    snapshotDigest: invocationSnapshotDigest(snapshot),
    tier: "gated",
    caller,
    renderedAction: "read example.com",
    resource,
    presentation: {
      title: "Read example.com",
      deniedReason: "The request was denied.",
      resource: { type: "network-origin", label: "Website", value: snapshot.resourceKey },
      operation: {
        kind: "network",
        verb: "read from",
        object: { type: "network-origin", label: "Website", value: snapshot.resourceKey },
      },
      authorityVocabulary: { domain: "web", verb: "see", declaredBy: "test" },
    },
  });
  const waiters: Promise<unknown>[] = [];
  const wait = (signal?: AbortSignal) => {
    const result = coordinator.awaitDecision({
      sessionId: "chat-1",
      acquisitionId: info.acquisitionId,
      ownerRuntimeId: caller.runtime.id,
      ...(signal ? { signal } : {}),
    });
    waiters.push(result.catch(() => undefined));
    return result;
  };
  return {
    statePath,
    grantStore,
    targetRequests,
    targetRequestId,
    coordinator,
    notifyOwner,
    info,
    caller,
    decide,
    wait,
    waiters,
  };
}

const fixtures: ReturnType<typeof fixture>[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    try {
      f.decide("deny");
      await vi.waitFor(() => {
        expect(f.coordinator.pending()).toEqual([]);
        if (f.targetRequests)
          expect(f.targetRequests.get(f.targetRequestId!)?.state).toBe("denied");
      });
      await Promise.all(f.waiters);
      await f.coordinator.joinPresentations();
      await f.coordinator.quiesceOwnerDelivery();
    } finally {
      f.grantStore.close();
      rmSync(f.statePath, { recursive: true });
    }
  }
  vi.restoreAllMocks();
});

describe.each(["ordinary", "target"] as const)("%s acquisition observer handover", (kind) => {
  const create = () => {
    const f = fixture(kind);
    fixtures.push(f);
    return f;
  };

  it("persists an observed inline response as delivery handoff without acknowledging the receipt", async () => {
    const f = create();
    const wait = f.wait();
    f.decide("deny");
    await expect(wait).resolves.toMatchObject({ decision: "deny" });
    await f.coordinator.joinPresentations();
    const receipt = f.grantStore.acquisitions.get(f.info.acquisitionId, {
      ownerRuntimeId: f.caller.runtime.id,
      sessionId: "chat-1",
    })!;
    expect(receipt.deliveryOwner).toBe("in-band");
    expect(receipt.acknowledgedAt).toBeUndefined();
    await f.coordinator.reprojectOwnerDelivery();
    expect(f.notifyOwner).not.toHaveBeenCalled();
  });

  it("restores owner delivery when the sole observer disconnects before decision", async () => {
    const f = create();
    const observer = new AbortController();
    const waited = f.wait(observer.signal);
    observer.abort();
    await expect(waited).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(f.notifyOwner).not.toHaveBeenCalled();
    if (f.targetRequests) expect(f.targetRequests.get(f.targetRequestId!)?.state).toBe("pending");
    else expect(f.coordinator.pending()).toHaveLength(1);
    f.decide("deny");
    await vi.waitFor(() =>
      expect(f.notifyOwner).toHaveBeenCalledExactlyOnceWith(
        f.caller.runtime.id,
        f.info.acquisitionId,
        expect.any(AbortSignal)
      )
    );
    expect(f.grantStore.listAuthorityGrants()).toHaveLength(1);
  });

  it("does not suppress owner delivery for an already disconnected observer", async () => {
    const f = create();
    const observer = new AbortController();
    observer.abort();
    await expect(f.wait(observer.signal)).rejects.toMatchObject({ code: "ABORT_ERR" });
    f.decide("deny");
    await vi.waitFor(() => expect(f.notifyOwner).toHaveBeenCalledOnce());
  });

  it("keeps delivery in-band while another live observer receives the decision", async () => {
    const f = create();
    const observer = new AbortController();
    const abandoned = f.wait(observer.signal);
    const retained = f.wait();
    observer.abort();
    await expect(abandoned).rejects.toMatchObject({ code: "ABORT_ERR" });
    f.decide("deny");
    await expect(retained).resolves.toMatchObject({ state: "decided", decision: "deny" });
    expect(f.notifyOwner).not.toHaveBeenCalled();
  });

  it("delivers one owner hint after every observer disconnects", async () => {
    const f = create();
    const first = new AbortController();
    const second = new AbortController();
    const one = f.wait(first.signal);
    const two = f.wait(second.signal);
    first.abort();
    second.abort();
    await expect(one).rejects.toMatchObject({ code: "ABORT_ERR" });
    await expect(two).rejects.toMatchObject({ code: "ABORT_ERR" });
    f.decide("deny");
    await vi.waitFor(() => expect(f.notifyOwner).toHaveBeenCalledOnce());
  });

  it("hands over a committed decision lost before its observer receives it", async () => {
    const f = create();
    const observer = new AbortController();
    const issue = f.grantStore.issue.bind(f.grantStore);
    vi.spyOn(f.grantStore, "issue").mockImplementation((input) => {
      const grant = issue(input);
      queueMicrotask(() => observer.abort());
      return grant;
    });
    const waited = f.wait(observer.signal);
    f.decide("deny");
    await expect(waited).rejects.toMatchObject({ code: "ABORT_ERR" });
    await vi.waitFor(() => expect(f.notifyOwner).toHaveBeenCalledOnce());
    expect(f.grantStore.listAuthorityGrants()).toHaveLength(1);
  });

  it("releases its abort listener when observation ends, while approval remains pending", async () => {
    const f = create();
    const observer = new AbortController();
    const added = vi.spyOn(observer.signal, "addEventListener");
    const removed = vi.spyOn(observer.signal, "removeEventListener");
    const waited = f.wait(observer.signal);
    const listener = added.mock.calls.find(([event]) => event === "abort")?.[1];
    expect(listener).toBeDefined();
    observer.abort();
    await expect(waited).rejects.toMatchObject({ code: "ABORT_ERR" });
    expect(removed).toHaveBeenCalledWith("abort", listener);
  });

  it("reports synchronous owner-delivery failure without changing the decision", async () => {
    const f = create();
    const error = new Error("owner route unavailable");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.notifyOwner.mockImplementation(() => {
      throw error;
    });
    f.decide("deny");
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(f.caller.runtime.id), error.message)
    );
    expect(f.grantStore.listAuthorityGrants()).toHaveLength(1);
    if (f.targetRequests) expect(f.targetRequests.get(f.targetRequestId!)?.state).toBe("denied");
    else await expect(f.wait()).resolves.toMatchObject({ state: "decided", decision: "deny" });
  });

  it("retains failed live delivery and reprojects it on authoritative routing readiness", async () => {
    const f = create();
    const error = new Error("owner route was replacing");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    f.notifyOwner.mockImplementationOnce(() => {
      throw error;
    });
    f.decide("deny");
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(f.caller.runtime.id), error.message)
    );
    const owner = { ownerRuntimeId: f.caller.runtime.id, sessionId: "chat-1" };
    const canonical = f.grantStore.acquisitions.get(f.info.acquisitionId, owner)!;
    expect(canonical.state).toBe("decided");
    expect(f.grantStore.acquisitions.outstanding(owner)).toEqual([canonical]);
    await f.coordinator.reprojectOwnerDelivery();
    expect(f.notifyOwner).toHaveBeenCalledTimes(2);
    expect(f.grantStore.acquisitions.outstanding(owner)).toEqual([canonical]);
    f.grantStore.acquisitions.acknowledge(
      canonical.acquisitionId,
      owner,
      canonical.resolutionDigest!
    );
    await f.coordinator.reprojectOwnerDelivery();
    expect(f.notifyOwner).toHaveBeenCalledTimes(2);
    expect(f.grantStore.listAuthorityGrants()).toHaveLength(1);
  });

  it("commits runtime retirement before releasing its live waiter, retaining the original failure for retry", async () => {
    const f = create();
    const owner = { ownerRuntimeId: f.caller.runtime.id, sessionId: "chat-1" };
    const canonical = f.grantStore.acquisitions.get(f.info.acquisitionId, owner)!;
    const waiting = f.wait();
    const sql = new DatabaseSync(f.grantStore.databasePath);
    try {
      sql.exec(
        "CREATE TRIGGER reject_runtime_close BEFORE UPDATE ON authority_acquisitions BEGIN SELECT RAISE(ABORT, 'runtime receipt retirement rejected'); END"
      );
      await expect(f.coordinator.closeRuntime(f.caller.runtime.id)).rejects.toThrow(
        "runtime receipt retirement rejected"
      );
      expect(f.coordinator.pending()).toHaveLength(1);
      expect(f.grantStore.acquisitions.get(f.info.acquisitionId, owner)).toEqual(canonical);
    } finally {
      sql.exec("DROP TRIGGER reject_runtime_close");
      sql.close();
    }
    await f.coordinator.closeRuntime(f.caller.runtime.id);
    await expect(waiting).resolves.toMatchObject({ state: "closed" });
    expect(f.coordinator.pending()).toEqual([]);
    expect(f.grantStore.acquisitions.get(f.info.acquisitionId, owner)?.state).toBe("closed");
    expect(f.grantStore.acquisitions.outstanding(owner)).toEqual([]);
    expect(f.notifyOwner).not.toHaveBeenCalled();
  });
});
