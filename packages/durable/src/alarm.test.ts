import { afterEach, describe, expect, it, vi } from "vitest";
import { rpcMethodAuthority } from "@vibestudio/rpc";
import type { ResidentChannelDeliveryInput } from "@vibestudio/shared/residentSession";
import { defineReceiverServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { z } from "zod";
import { createModels } from "@panticonic/pi-ai";
import { BACKGROUND_CONTEXT } from "@panticonic/pi-chord/context";
import { createRegistry, Harness, MemoryStorage } from "@panticonic/pi-durable";
import { DurableObjectBase, rpc, schemaRpc, type AlarmSchedule } from "./index.js";
import { createTestDO, createTestDirectAuthority, successfulTestRpcFetch } from "./test-utils.js";

class AlarmProbeDO extends DurableObjectBase {
  nextAlarm: AlarmSchedule | null = null;
  releaseDeferred!: () => void;
  deferredOutbound: Promise<unknown> | null = null;

  protected createTables(): void {}

  runtimeId(): string {
    return this.rpcSelfId;
  }

  openResidentReceiver(channelId: string, receiver: (payload: unknown) => void): () => void {
    return this.registerResidentChannelSession(channelId, receiver);
  }

  override async alarm(): Promise<AlarmSchedule | null> {
    return this.nextAlarm;
  }

  @rpc({
    website: { kind: "eligible", rationale: "Explicit receiver exposure for this test fixture." },
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
    website: { kind: "eligible", rationale: "Explicit receiver exposure for this test fixture." },
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

  @rpc({
    website: { kind: "eligible", rationale: "Explicit receiver exposure for this test fixture." },
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  startOutbound(throwAfterStart = false): string {
    void this.rpc.call("main", "probe.immediate", []);
    if (throwAfterStart) throw new Error("parent failed after starting child");
    return "started";
  }
}

class OpenSchemaProbeDO extends DurableObjectBase {
  static override rpcMethods = defineReceiverServiceMethods({
    inspect: {
      website: {
        kind: "eligible",
        rationale: "Explicit receiver policy for this test fixture.",
      } as const,
      args: z.tuple([]),
      returns: z.string(),
      authority: { principals: ["host"] },
      tier: { tier: "open", session: "family", rationale: "Open typed receiver test." },
      access: { sensitivity: "read" },
    },
  });

  protected createTables(): void {}

  @schemaRpc()
  inspect(): string {
    return "ready";
  }

  inspectAuthority() {
    return this.rpcAuthorityDeclaration("inspect", OpenSchemaProbeDO.rpcMethods["inspect"]);
  }
}

class AsyncWakeProbeDO extends AlarmProbeDO {
  publishWake: () => Promise<AlarmSchedule | null | undefined> = async () => undefined;

  protected override nextAlarmAfterRequest(): Promise<AlarmSchedule | null | undefined> {
    return this.publishWake();
  }

  @rpc({
    website: { kind: "closed", reason: "Test request wake ownership." },
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  complete(): string {
    return "complete";
  }

  startWakeChild(): void {
    void this.rpc.call("main", "probe.wake", []);
  }

  observedCallerId(): string | null {
    return this.rpcCallerId;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DurableObjectBase alarm dispatch", () => {
  it("joins an asynchronous wake before acknowledging the request and persists its exact schedule", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(successfulTestRpcFetch);
    const { instance, call, db } = await createTestDO(AsyncWakeProbeDO);
    let entered!: () => void;
    const publishing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    instance.publishWake = async () => {
      entered();
      await held;
      expect(instance.observedCallerId()).toBe("main");
      return { wakeAt: 271 };
    };
    let settled = false;
    const request = call("complete").finally(() => {
      settled = true;
    });
    try {
      await publishing;
      expect(settled).toBe(false);
      expect(globalThis.fetch).not.toHaveBeenCalled();
      release();
      await expect(request).resolves.toBe("complete");
      const body = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body));
      expect(body.message.args[0].wakeAt).toBe(271);
    } finally {
      release();
      await request;
      db.close();
    }
  });

  it("keeps causal wake RPCs owned after the asynchronous hook returns", async () => {
    let entered!: () => void;
    const childEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let outboundBody = "";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      outboundBody = String(init?.body);
      entered();
      await held;
      return successfulTestRpcFetch(input, init);
    });
    const { instance, call, db } = await createTestDO(AsyncWakeProbeDO);
    instance.publishWake = async () => {
      await Promise.resolve();
      instance.startWakeChild();
      return undefined;
    };
    let settled = false;
    const request = call("complete").finally(() => {
      settled = true;
    });
    try {
      await childEntered;
      expect(settled).toBe(false);
      expect(outboundBody).toContain("authorityParentNonce");
      release();
      await expect(request).resolves.toBe("complete");
    } finally {
      release();
      await request;
      db.close();
    }
  });

  it("propagates the original asynchronous wake failure through the request error boundary", async () => {
    const { instance, call, db } = await createTestDO(AsyncWakeProbeDO);
    const original = Object.assign(new Error("Original native wake publication failed"), {
      code: "WAKE_FAILED",
    });
    instance.publishWake = async () => {
      throw original;
    };
    const fetched = vi.spyOn(instance, "fetch");
    try {
      await expect(call("complete")).rejects.toThrow(original.message);
      await expect(fetched.mock.results[0]!.value).resolves.toMatchObject({ status: 500 });
    } finally {
      db.close();
    }
  });

  it("maps a genuinely closed native alarm pass through the existing request error boundary", async () => {
    const harness = await Harness.open(
      new MemoryStorage(),
      {
        registry: createRegistry(),
        models: createModels(),
      },
      BACKGROUND_CONTEXT
    );
    const { instance, call, db } = await createTestDO(AlarmProbeDO);
    let entered!: () => void;
    const running = new Promise<void>((resolve) => {
      entered = resolve;
    });
    instance.alarm = async () => {
      const pass = harness.runPass(BACKGROUND_CONTEXT);
      entered();
      const schedule = await pass;
      return schedule.wakeAt === null ? null : { wakeAt: schedule.wakeAt };
    };
    const fetched = vi.spyOn(instance, "fetch");
    const request = call("__alarm");
    const failed = expect(request).rejects.toThrow("Harness is closed");
    try {
      await running;
      await harness.close(BACKGROUND_CONTEXT);
      await failed;
      await expect(fetched.mock.results[0]!.value).resolves.toMatchObject({ status: 500 });
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await failed;
      db.close();
    }
  });

  it("maps an original lifecycle release rejection through the request error boundary", async () => {
    const { instance, db } = await createTestDO(AlarmProbeDO);
    const original = new Error("Original activation release failed");
    instance.releaseForLifecycle = async () => {
      throw original;
    };
    try {
      const response = await instance.fetch(
        new Request("http://test/test-key/__lifecycle/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            args: [{ mode: "suspend", reason: "shutdown", deadlineMs: 0 }],
            __instanceToken: "token",
            __instanceId: "do:internal/WorkspaceDO:test-key",
            __caller: {
              callerId: "main",
              callerKind: "server",
              authorization: createTestDirectAuthority({
                callerKind: "server",
                method: "__lifecycle/prepare",
              }),
            },
          }),
        })
      );
      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({ error: original.message });
    } finally {
      db.close();
    }
  });

  it("accepts an explicitly open typed receiver without a ceremonial capability", async () => {
    const { instance } = await createTestDO(OpenSchemaProbeDO);

    expect(instance.inspectAuthority()).toMatchObject({
      effect: { kind: "open" },
      tier: "open",
      sensitivity: "read",
    });
  });

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
      website: { kind: "closed" },
      principals: ["host"],
      effect: { kind: "open" },
      tier: "open",
      sensitivity: "read",
    });
  });

  it("exposes finite host delivery for explicitly resident operations", async () => {
    const { instance } = await createTestDO(AlarmProbeDO);

    expect(rpcMethodAuthority(instance, "acceptChannelDelivery")).toMatchObject({
      website: { kind: "closed" },
      principals: ["host"],
      effect: { kind: "open" },
      tier: "open",
      sensitivity: "write",
    });
  });

  it("delivers through the receiver registered by the exact object activation", async () => {
    const { instance } = await createTestDO(AlarmProbeDO);
    const received: unknown[] = [];
    const close = instance.openResidentReceiver("channel-1", (payload) => received.push(payload));
    const input = {
      deliveryId: "delivery-1",
      channelId: "channel-1",
      channelRef: {
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: "channel-1",
      },
      participantId: instance.runtimeId(),
      subscriptionRevision: 1,
      eventSequence: 1,
      envelope: { kind: "message.completed" },
      agenticContext: null,
    } satisfies ResidentChannelDeliveryInput;

    await expect(instance.acceptChannelDelivery(input)).resolves.toEqual({
      processed: true,
      recipientExecutionStartedAt: expect.any(Number),
    });
    expect(received).toEqual([
      {
        channelId: "channel-1",
        message: { kind: "message.completed" },
      },
    ]);

    close();
    await expect(instance.acceptChannelDelivery(input)).rejects.toMatchObject({
      code: "ResidentSessionUnavailable",
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

  it.each([
    ["successful", false],
    ["failed", true],
  ])("keeps a %s invocation open until its immediate child RPC settles", async (_label, fail) => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await blocked;
      return new Response("child failed", { status: 503 });
    });
    const { call } = await createTestDO(AlarmProbeDO);
    let settled = false;
    const result = call("startOutbound", fail).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
    expect(settled).toBe(false);
    release();
    if (fail) await expect(result).rejects.toThrow("parent failed after starting child");
    else await expect(result).resolves.toBe("started");
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
