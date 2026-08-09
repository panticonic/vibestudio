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
      cachedExecutions: 0,
      cacheHits: 0,
      cacheMisses: 2,
      coalescedRestores: 0,
      restoreAttempts: 2,
      restoreSuccesses: 0,
      restoreFailures: 2,
      restoreDurationMs: expect.any(Number),
      permanentIncidents: 1,
      blockedIncarnations: 1,
    });
  });

  it("reports recovery and permits a later incident for the same incarnation", async () => {
    let bootGeneration = 1;
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
      getBootGeneration: () => bootGeneration,
      onPermanentFailure,
      onRecovered,
    });

    await expect(readiness.ensureReady(REF)).rejects.toMatchObject({
      code: "RUNTIME_IMAGE_UNAVAILABLE",
    });
    await readiness.ensureReady(REF);
    bootGeneration += 1;
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

  it("re-validates the active row but restores once per sealed boot identity", async () => {
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
    expect(restoreExactExecution).toHaveBeenCalledTimes(1);
    expect(readiness.inspect()).toMatchObject({ cacheHits: 1, cacheMisses: 1 });
  });

  it("restores again after the workerd boot generation changes", async () => {
    let bootGeneration = 4;
    const restoreExactExecution = vi.fn(async () => undefined);
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity: async () => RECORD,
      restoreExactExecution,
      getBootGeneration: () => bootGeneration,
    });

    await readiness.ensureReady(REF);
    bootGeneration = 5;
    await readiness.ensureReady(REF);

    expect(restoreExactExecution).toHaveBeenCalledTimes(2);
    expect(readiness.inspect()).toMatchObject({ cacheHits: 0, cacheMisses: 2 });
  });

  it("forgets cached execution evidence when an entity retires", async () => {
    const restoreExactExecution = vi.fn(async () => undefined);
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity: async () => RECORD,
      restoreExactExecution,
    });

    await readiness.ensureReady(REF);
    expect(readiness.inspect().cachedExecutions).toBe(1);
    readiness.forget(RECORD.id);
    expect(readiness.inspect().cachedExecutions).toBe(0);
    await readiness.ensureReady(REF);
    expect(restoreExactExecution).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent restoration of one sealed boot identity", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const restoreExactExecution = vi.fn(() => gate);
    const readiness = new DurableObjectExecutionReadiness({
      resolveActiveEntity: async () => RECORD,
      restoreExactExecution,
    });

    const first = readiness.ensureReady(REF);
    const second = readiness.ensureReady(REF);
    await vi.waitFor(() => expect(restoreExactExecution).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);

    expect(readiness.inspect()).toMatchObject({
      cacheMisses: 2,
      coalescedRestores: 1,
      restoreAttempts: 1,
      restoreSuccesses: 1,
    });
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
    await readiness.materialize(RECORD);
    expect(restoreExactExecution).toHaveBeenCalledTimes(2);
    expect(restoreExactExecution).toHaveBeenCalledWith(RECORD);
  });
});
