import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcMethodAuthority } from "@vibestudio/rpc";
import { DurableObjectBase, rpc, type AlarmSchedule } from "./index.js";
import { createTestDO, createTestDirectAuthority } from "./test-utils.js";

class AlarmProbeDO extends DurableObjectBase {
  nextAlarm: AlarmSchedule | null = null;
  releaseDeferred!: () => void;
  deferredOutbound: Promise<unknown> | null = null;

  protected createTables(): void {}

  runtimeId(): string {
    return this.rpcSelfId;
  }

  override async alarm(): Promise<AlarmSchedule | null> {
    return this.nextAlarm;
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  schedule(wakeAt: number): string {
    this.setAlarmAt(wakeAt);
    return "scheduled";
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  deferOutbound(): string {
    const released = new Promise<void>((resolve) => {
      this.releaseDeferred = resolve;
    });
    this.deferredOutbound = released.then(() => this.rpc.call("main", "probe.deferred", []));
    this.ctx.waitUntil?.(this.deferredOutbound);
    return "deferred";
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

  it("exposes the host-only durable-work capability probe from the framework base", async () => {
    const { instance, call } = await createTestDO(AlarmProbeDO);

    await expect(call("durableWorkCapabilities")).resolves.toEqual([]);
    expect(rpcMethodAuthority(instance, "durableWorkCapabilities")).toMatchObject({
      principals: ["host"],
      effect: { kind: "open" },
      tier: "open",
      sensitivity: "read",
    });
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

  it("rejects a body-supplied server kind without a host attestation", async () => {
    const { instance } = await createTestDO(AlarmProbeDO);
    const response = await (
      instance as unknown as { fetch(request: Request): Promise<Response> }
    ).fetch(
      new Request("http://test/test-key/__alarm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          args: [],
          __instanceToken: "token",
          __instanceId: "do:test:TestDO:test-key",
          __caller: { callerId: "main", callerKind: "server" },
        }),
      })
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      errorCode: "EACCES",
      errorKind: "access",
      error: expect.stringMatching(/host attestation required/),
      errorData: {
        authorityFailure: {
          reasonCode: "attestation-invalid",
          remediation: { kind: "retry-through-host" },
        },
      },
    });
  });

  it("persists host-control nonce consumption across object reconstruction", async () => {
    const first = await createTestDO(AlarmProbeDO);
    const caller = {
      callerId: "main",
      callerKind: "server" as const,
      authorization: createTestDirectAuthority({
        callerKind: "server",
        method: "__alarm",
      }),
    };
    const dispatch = (instance: AlarmProbeDO) =>
      (instance as unknown as { fetch(request: Request): Promise<Response> }).fetch(
        new Request("http://test/test-key/__alarm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            args: [],
            __instanceToken: "token",
            __instanceId: "do:test:TestDO:test-key",
            __caller: caller,
          }),
        })
      );

    await expect(dispatch(first.instance)).resolves.toMatchObject({ status: 200 });
    const reconstructed = await createTestDO(AlarmProbeDO, undefined, { db: first.db });
    const replay = await dispatch(reconstructed.instance);
    expect(replay.status).toBe(403);
    await expect(replay.json()).resolves.toMatchObject({
      errorCode: "EACCES",
      errorKind: "access",
      error: expect.stringMatching(/replayed/),
      errorData: {
        authorityFailure: {
          reasonCode: "attestation-invalid",
          remediation: { kind: "retry-through-host" },
        },
      },
    });
  });

  it("does not leak a consumed host attestation into deferred waitUntil work", async () => {
    let outboundBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      outboundBody = String(init?.body ?? "");
      return new Response("deferred probe stopped", { status: 500 });
    });
    const { instance, call } = await createTestDO(AlarmProbeDO);

    await expect(call("deferOutbound")).resolves.toBe("deferred");
    instance.releaseDeferred();
    await expect(instance.deferredOutbound).rejects.toThrow();

    expect(outboundBody).not.toContain("authorityParentNonce");
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
