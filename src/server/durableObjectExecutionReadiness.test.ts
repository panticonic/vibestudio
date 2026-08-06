import { describe, expect, it, vi } from "vitest";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { DurableObjectExecutionReadiness } from "./durableObjectExecutionReadiness.js";

function unavailable(message = "sealed execution unavailable"): Error & { code: string } {
  return Object.assign(new Error(message), { code: "RUNTIME_IMAGE_UNAVAILABLE" });
}

const RECORD: EntityRecord = {
  id: "do:workers/pubsub-channel:PubSubChannel:chat-1",
  kind: "do",
  source: { repoPath: "workers/pubsub-channel", effectiveVersion: "ev-1" },
  contextId: "ctx-1",
  className: "PubSubChannel",
  key: "chat-1",
  activeBuildKey: "b".repeat(64),
  activeExecutionDigest: "e".repeat(64),
  activeAuthority: { provides: [], requests: [] },
  createdAt: 1,
  status: "active",
  cleanupComplete: true,
};

const REF = {
  source: "workers/pubsub-channel",
  className: "PubSubChannel",
  objectKey: "chat-1",
};

describe("DurableObjectExecutionReadiness", () => {
  it("reports one permanent incident per sealed incarnation", async () => {
    const onPermanentFailure = vi.fn();
    const restoreExactExecution = vi.fn(async () => {
      throw unavailable();
    });
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity: async () => RECORD,
      restoreExactExecution,
      onPermanentFailure,
    });

    await expect(readiness.ensureReady(REF)).rejects.toMatchObject({
      code: "RUNTIME_IMAGE_UNAVAILABLE",
    });
    await expect(readiness.ensureReady(REF)).rejects.toMatchObject({
      code: "RUNTIME_IMAGE_UNAVAILABLE",
    });

    expect(onPermanentFailure).toHaveBeenCalledOnce();
    expect(onPermanentFailure).toHaveBeenCalledWith({
      entityId: RECORD.id,
      buildKey: RECORD.activeBuildKey,
      executionDigest: RECORD.activeExecutionDigest,
      message: "sealed execution unavailable",
      incidentCount: 1,
    });
    expect(readiness.inspect()).toEqual({
      restoreAttempts: 2,
      restoreSuccesses: 0,
      restoreFailures: 2,
      permanentIncidents: 1,
      blockedIncarnations: 1,
    });
  });

  it("reports recovery and permits a later incident for the same incarnation", async () => {
    const onPermanentFailure = vi.fn();
    const onRecovered = vi.fn();
    const restoreExactExecution = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(unavailable("first loss"))
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(unavailable("second loss"));
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity: async () => RECORD,
      restoreExactExecution,
      onPermanentFailure,
      onRecovered,
    });

    await expect(readiness.ensureReady(REF)).rejects.toMatchObject({
      code: "RUNTIME_IMAGE_UNAVAILABLE",
    });
    await readiness.ensureReady(REF);
    await expect(readiness.ensureReady(REF)).rejects.toMatchObject({
      code: "RUNTIME_IMAGE_UNAVAILABLE",
    });

    expect(onPermanentFailure).toHaveBeenCalledTimes(2);
    expect(onRecovered).toHaveBeenCalledWith({
      entityId: RECORD.id,
      buildKey: RECORD.activeBuildKey,
      executionDigest: RECORD.activeExecutionDigest,
      incidentCount: 1,
    });
    expect(readiness.inspect()).toMatchObject({
      permanentIncidents: 2,
      blockedIncarnations: 1,
    });
  });

  it("re-derives disposable readiness from the active row on every invocation", async () => {
    const resolveActiveEntity = vi.fn(async () => RECORD);
    const restoreExactExecution = vi.fn(async () => undefined);
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity,
      restoreExactExecution,
    });

    await readiness.ensureReady(REF);
    await readiness.ensureReady(REF);

    expect(resolveActiveEntity).toHaveBeenCalledTimes(2);
    expect(restoreExactExecution).toHaveBeenNthCalledWith(1, RECORD);
    expect(restoreExactExecution).toHaveBeenNthCalledWith(2, RECORD);
  });

  it("fails closed before restoration when the durable identity is retired", async () => {
    const restoreExactExecution = vi.fn(async () => undefined);
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity: async () => null,
      restoreExactExecution,
    });

    await expect(readiness.ensureReady(REF)).rejects.toThrow(/no active durable execution/);
    expect(restoreExactExecution).not.toHaveBeenCalled();
  });

  it("rejects incomplete active rows instead of rebuilding from a mutable selector", async () => {
    const restoreExactExecution = vi.fn(async () => undefined);
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity: async () => ({ ...RECORD, activeExecutionDigest: undefined }),
      restoreExactExecution,
    });

    await expect(readiness.ensureReady(REF)).rejects.toThrow(/no sealed active execution identity/);
    expect(restoreExactExecution).not.toHaveBeenCalled();
  });

  it("rejects a resolver result that does not match the requested durable identity", async () => {
    const restoreExactExecution = vi.fn(async () => undefined);
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity: async () => ({ ...RECORD, id: `${RECORD.id}-other` }),
      restoreExactExecution,
    });

    await expect(readiness.ensureReady(REF)).rejects.toThrow(/readiness resolved/);
    expect(restoreExactExecution).not.toHaveBeenCalled();
  });

  it("materializes a committed row through the same exact restoration port", async () => {
    const restoreExactExecution = vi.fn(async () => undefined);
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity: async () => {
        throw new Error("publication must not re-resolve its committed record");
      },
      restoreExactExecution,
    });

    await readiness.materialize(RECORD);
    expect(restoreExactExecution).toHaveBeenCalledWith(RECORD);
  });
});
