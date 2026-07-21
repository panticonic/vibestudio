import { afterEach, describe, expect, it, vi } from "vitest";
import { DurableObjectBase, rpc, type AlarmSchedule } from "./index.js";
import { createTestDO } from "./test-utils.js";

class AlarmProbeDO extends DurableObjectBase {
  nextAlarm: AlarmSchedule | null = null;

  protected createTables(): void {}

  runtimeId(): string {
    return this.rpcSelfId;
  }

  override async alarm(): Promise<AlarmSchedule | null> {
    return this.nextAlarm;
  }

  @rpc({ principals: ["host"], sensitivity: "write" })
  schedule(wakeAt: number): string {
    this.setAlarmAt(wakeAt);
    return "scheduled";
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DurableObjectBase alarm dispatch", () => {
  it("attributes outbound RPC to the concrete durable object entity", async () => {
    const { instance } = await createTestDO(AlarmProbeDO, {
      WORKER_SOURCE: "workers/alarm-probe",
      WORKER_CLASS_NAME: "AlarmProbeDO",
      __objectKey: "object-7",
    });

    expect(instance.runtimeId()).toBe("do:workers/alarm-probe:AlarmProbeDO:object-7");
  });

  it("returns the handler's explicit next schedule without RPC or a concurrency gate", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { instance, call } = await createTestDO(AlarmProbeDO);
    const concurrencyGate = vi.spyOn(
      (instance as unknown as { ctx: { blockConcurrencyWhile: () => unknown } }).ctx,
      "blockConcurrencyWhile"
    );
    instance.nextAlarm = { wakeAt: 200 };

    await expect(call("__alarm")).resolves.toEqual({
      nextAlarm: { wakeAt: 200 },
    });
    expect(concurrencyGate).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns no next alarm when the handler is complete", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { call } = await createTestDO(AlarmProbeDO);

    await expect(call("__alarm")).resolves.toEqual({ nextAlarm: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails the request when its durable scheduling write fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("workspace alarm store unavailable", { status: 503 })
    );
    const { call } = await createTestDO(AlarmProbeDO, {
      WORKER_SOURCE: "workers/alarm-probe",
      WORKER_CLASS_NAME: "AlarmProbeDO",
      __objectKey: "object-7",
    });

    await expect(call("schedule", 200)).rejects.toThrow();
  });
});
