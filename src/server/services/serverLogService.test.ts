import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createServerLogService } from "./serverLogService.js";
import { createServerLogStore } from "./serverLogStore.js";

const ctx: ServiceContext = { caller: createVerifiedCaller("panel-1", "panel") };

function makeService() {
  const store = createServerLogStore({ now: () => 42 });
  const emit = vi.fn();
  const service = createServerLogService({
    store,
    eventService: { emit } as never,
    workspaceId: "ws-1",
    serverBootId: "boot-1",
    startedAt: 40,
  });
  return { store, emit, service };
}

describe("serverLogService", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("wraps query/tail results in the process-metadata envelope", async () => {
    const { store, service } = makeService();
    store.append("info", ["[X] hello"]);

    const result = (await service.handler(ctx, "tail", [10])) as Record<string, unknown>;
    expect(result).toMatchObject({
      latestSeq: 1,
      workspaceId: "ws-1",
      serverBootId: "boot-1",
      pid: process.pid,
      startedAt: 40,
    });
    expect((result["records"] as unknown[]).length).toBe(1);

    const filtered = (await service.handler(ctx, "query", [{ level: "warn" }])) as {
      records: unknown[];
    };
    expect(filtered.records).toEqual([]);
  });

  it("validates query args against the schema", async () => {
    const { service } = makeService();
    await expect(service.handler(ctx, "query", [{ limit: 0 }])).rejects.toThrow();
  });

  it("batches appended records into server-log:append events", async () => {
    const { store, emit } = makeService();
    store.append("info", ["a"]);
    store.append("warn", ["b"]);
    expect(emit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(150);
    expect(emit).toHaveBeenCalledTimes(1);
    const [event, payload] = emit.mock.calls[0] as [string, { records: Array<{ seq: number }> }];
    expect(event).toBe("server-log:append");
    expect(payload.records.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("flushes immediately when a burst hits the batch cap", () => {
    const { store, emit } = makeService();
    for (let i = 0; i < 200; i++) store.append("info", [`m${i}`]);
    expect(emit).toHaveBeenCalledTimes(1);
    expect((emit.mock.calls[0]![1] as { records: unknown[] }).records).toHaveLength(200);
  });

  it("stop() detaches from the store", async () => {
    const { store, emit, service } = makeService();
    service.stop();
    store.append("info", ["after stop"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(emit).not.toHaveBeenCalled();
  });
});
