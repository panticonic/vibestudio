/**
 * chatOp — the agent-side proxy for an EvalDO sandbox `chat` binding.
 *
 * Server-side `eval` runs in a per-channel EvalDO that has no channel identity,
 * so its `chat` binding forwards every op here via
 * `rpc.callTarget(agentId, "chatOp", [channelId, op, args])`. The agent performs
 * the op AS itself (correct @agent attribution) using its own channel
 * machinery, and relays the result. These tests cover the auth gate, the card
 * dispatch, message-type publishing, and the result-awaiting callMethod relay.
 */
import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { ids } from "@workspace/agent-loop";
import type { DeferrableRpcClient } from "@vibestudio/rpc";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  sha256Hex,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import type { ChannelEvent, ParticipantDescriptor } from "@workspace/harness";
import { AgentVesselBase } from "./agent-vessel.js";
import type { ChannelClient } from "./channel-client.js";
import type { AgentLoopDriver } from "./agent-loop-driver.js";

/** Wait until the relay has issued its channel call (auth uses an async sha256,
 *  so the call is enqueued a few microtasks after chatOp is invoked). */
async function waitForCall(vessel: TestVessel): Promise<{ callId: string; method: string }> {
  for (let i = 0; i < 100; i++) {
    const call = vessel.channelStub.calls[0];
    if (call) return call;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("relay never issued a channel call");
}

const AGENT_ID = "do:test:TestAgent:agent-key";
const CHANNEL = "chan-1";
const TEST_AGENT_ENV = {
  __objectKey: "agent-key",
  WORKER_SOURCE: "test",
  WORKER_CLASS_NAME: "TestAgent",
} as const;

const WEATHER_TYPE = {
  typeId: "weather",
  displayMode: "row" as const,
  stateSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
    additionalProperties: false,
  },
};

/** A test vessel that lets us drive chatOp directly: it pins the agent's
 *  participant id, lets the test set the verified caller id, and swaps the
 *  ChannelClient for an in-memory stub whose callMethod we settle by feeding a
 *  terminal back through processChannelEvent (mirroring the live broadcast). */
class TestVessel extends AgentVesselBase {
  callerIdForTest: string | null = null;
  callerKindForTest: string | null = null;
  readonly channelPublishFailures = new Set<string>();
  readonly channelStub = {
    published: [] as Array<{
      event: AgenticEvent;
      idempotencyKey?: string;
    }>,
    messageTypes: new Map<string, Record<string, unknown>>(),
    calls: [] as Array<{ callId: string; targetPid: string; method: string; args: unknown }>,
    participants: [] as Array<{ participantId: string; metadata: Record<string, unknown> }>,
    subscriptions: [] as Array<{ channelId: string; participantId: string }>,
    replay: new Map<string, ChannelEvent[]>(),
    envelopes: new Map<string, ChannelEvent>(),
  };
  readonly operationLog: string[] = [];

  protected override get rpcCallerId(): string | null {
    return this.callerIdForTest;
  }

  protected override get rpcCallerKind(): string | null {
    return this.callerKindForTest;
  }

  protected override participantId(): string {
    return AGENT_ID;
  }

  protected override getParticipantInfo(): ParticipantDescriptor {
    return { type: "agent", name: "TestAgent", handle: "testagent" } as ParticipantDescriptor;
  }

  protected override createChannelClient(channelId: string): ChannelClient {
    return this.makeChannelStub(channelId) as unknown as ChannelClient;
  }

  /** Register a subscription row (so getParticipantId returns a non-null
   *  participant id for the card publish path) WITHOUT running the heavy
   *  post-subscribe machinery (prompt artifacts, driver wake) that needs a live
   *  gateway/GAD. */
  async registerSubscriptionForTest(channelId = CHANNEL, config?: unknown): Promise<void> {
    this.ensureIdentity();
    await this.subscriptions.subscribe({
      channelId,
      contextId: "ctx-1",
      descriptor: this.getParticipantInfo(),
      config,
      replay: false,
    });
  }

  private makeChannelStub(channelId: string) {
    const stub = this.channelStub;
    const failures = this.channelPublishFailures;
    const operationLog = this.operationLog;
    const getReplayAfter = vi.fn(
      async (request: { after: number; limit?: number; throughSeq?: number }) => {
        const all = (stub.replay.get(channelId) ?? []).filter(
          (event) =>
            (event.id ?? 0) > request.after &&
            (request.throughSeq === undefined || (event.id ?? 0) <= request.throughSeq)
        );
        const snapshotLastSeq =
          request.throughSeq ??
          all.reduce((maximum, event) => Math.max(maximum, event.id ?? 0), request.after);
        const logEvents = all.slice(0, request.limit ?? 500);
        return {
          mode: "after" as const,
          logEvents,
          snapshots: [],
          ready: {
            totalCount: all.length,
            envelopeCount: all.length,
            snapshotLastSeq,
            replayToId: logEvents.at(-1)?.id,
            hasMoreAfter: logEvents.length < all.length,
          },
        };
      }
    );
    return {
      publishAgenticEvent: vi.fn(
        async (_pid: string, event: AgenticEvent, opts?: { idempotencyKey?: string }) => {
          if (opts?.idempotencyKey && failures.has(opts.idempotencyKey)) {
            throw new Error(`publish failed: ${opts.idempotencyKey}`);
          }
          stub.published.push({
            event,
            idempotencyKey: opts?.idempotencyKey,
          });
          return { id: stub.published.length };
        }
      ),
      getMessageType: vi.fn(async (typeId: string) => stub.messageTypes.get(typeId) ?? null),
      getMessageTypes: vi.fn(async () => [...stub.messageTypes.values()]),
      getParticipants: vi.fn(async () => stub.participants),
      callMethod: vi.fn(
        async (
          _callerPid: string,
          targetPid: string,
          callId: string,
          method: string,
          args: unknown
        ) => {
          stub.calls.push({ callId, targetPid, method, args });
        }
      ),
      getReplayAfter,
      replayAfterPages: async function* (request: {
        after: number;
        limit?: number;
        throughSeq?: number;
      }) {
        let after = request.after;
        let throughSeq = request.throughSeq;
        for (;;) {
          const page = await getReplayAfter({ ...request, after, throughSeq });
          yield page;
          if (!page.ready.hasMoreAfter) return;
          after = page.ready.replayToId!;
          throughSeq ??= page.ready.snapshotLastSeq;
        }
      },
      getEnvelope: vi.fn(async (envelopeId: string) => stub.envelopes.get(envelopeId) ?? null),
      send: vi.fn(async () => undefined),
      recordTaskProvenance: vi.fn(async () => undefined),
      subscribe: vi.fn(async (participantId: string) => {
        operationLog.push(`channel:${channelId}:subscribe`);
        stub.subscriptions.push({ channelId, participantId });
        return {
          ok: true,
          channelConfig: {},
          envelope: { logEvents: [], ready: { totalCount: 0, envelopeCount: 0 } },
          participantId,
        };
      }),
      unsubscribe: vi.fn(async () => undefined),
      getConfig: vi.fn(async () => ({})),
    };
  }

  /** Feed a terminal event the way the live channel broadcast would, to settle
   *  a pending relay call. */
  async deliverTerminal(
    transportCallId: string,
    kind:
      | "invocation.completed"
      | "invocation.failed"
      | "invocation.cancelled"
      | "invocation.abandoned",
    payload: Record<string, unknown>
  ): Promise<void> {
    const event: ChannelEvent = {
      id: 1,
      messageId: transportCallId,
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind,
        actor: { kind: "agent", id: AGENT_ID },
        causality: { invocationId: transportCallId, transportCallId },
        payload,
        createdAt: new Date().toISOString(),
      } as unknown as AgenticEvent,
      senderId: AGENT_ID,
      ts: Date.now(),
    };
    await this.processChannelEvent(CHANNEL, event);
  }
}

class PromptEventProbe extends TestVessel {
  readonly handleIncomingSpy = vi.fn(async (_channelId: string, _incoming: unknown) => {});

  protected override async shouldRespond(): Promise<boolean> {
    return true;
  }

  protected override async ensurePromptArtifacts(): Promise<void> {}

  protected override get driver(): AgentLoopDriver {
    return {
      handleIncoming: this.handleIncomingSpy,
    } as unknown as AgentLoopDriver;
  }

  markEmptyRosterFresh(channelId: string): void {
    this.setStateValue(`agent:roster:${channelId}`, "[]");
  }
}

class ReadyWakeProbe extends TestVessel {
  readonly wakeSpy = vi.fn(async (_channelId: string) => {});

  protected override async ensurePromptArtifacts(): Promise<void> {}

  protected override get driver(): AgentLoopDriver {
    return {
      wake: this.wakeSpy,
    } as unknown as AgentLoopDriver;
  }
}

async function makeVessel(): Promise<TestVessel> {
  const { instance } = await createTestDO(TestVessel, TEST_AGENT_ENV);
  // Register a subscription row so the card path has a participant id, without
  // booting the driver/prompt machinery.
  await instance.registerSubscriptionForTest();
  return instance;
}

async function makePromptProbe(): Promise<PromptEventProbe> {
  const { instance } = await createTestDO(PromptEventProbe, TEST_AGENT_ENV);
  await instance.registerSubscriptionForTest();
  instance.markEmptyRosterFresh(CHANNEL);
  return instance;
}

/** The EvalDO objectKey the eval service derives, and the caller id chatOp
 *  expects: sha256(`${agentRuntimeId}\0${channelId}`) hex, first 40. */
async function expectedEvalCaller(): Promise<string> {
  const key = (await sha256Hex(`${AGENT_ID}\0${CHANNEL}`)).slice(0, 40);
  return `do:vibestudio/internal:EvalDO:${key}`;
}

describe("AgentVesselBase channel ready wake policy", () => {
  it("wakes every-envelope subscriptions after subscribe replay", async () => {
    const { instance } = await createTestDO(ReadyWakeProbe, TEST_AGENT_ENV);

    await instance.subscribeChannel({
      channelId: CHANNEL,
      contextId: "ctx-1",
      replay: false,
    });

    expect(instance.wakeSpy).toHaveBeenCalledWith(CHANNEL);
  });

  it("does not generic-wake turn-final supervisor subscriptions after subscribe replay", async () => {
    const { instance } = await createTestDO(ReadyWakeProbe, TEST_AGENT_ENV);

    await instance.subscribeChannel({
      channelId: CHANNEL,
      contextId: "ctx-1",
      config: { wakePolicy: "turn-final" },
      replay: false,
    });

    expect(instance.wakeSpy).not.toHaveBeenCalled();
  });

  it("wakes every-envelope subscriptions when the channel reports ready", async () => {
    const { instance } = await createTestDO(ReadyWakeProbe, TEST_AGENT_ENV);
    await instance.registerSubscriptionForTest(CHANNEL);
    instance.callerKindForTest = "do";
    instance.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";

    await instance.onChannelEnvelope(CHANNEL, {
      kind: "control",
      type: "ready",
      ready: { totalCount: 0, envelopeCount: 0 },
    });

    expect(instance.wakeSpy).toHaveBeenCalledWith(CHANNEL);
  });

  it("does not generic-wake turn-final supervisor subscriptions on ready", async () => {
    const { instance } = await createTestDO(ReadyWakeProbe, TEST_AGENT_ENV);
    await instance.registerSubscriptionForTest(CHANNEL, { wakePolicy: "turn-final" });
    instance.callerKindForTest = "do";
    instance.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";

    await instance.onChannelEnvelope(CHANNEL, {
      kind: "control",
      type: "ready",
      ready: { totalCount: 0, envelopeCount: 0 },
    });

    expect(instance.wakeSpy).not.toHaveBeenCalled();
  });
});

describe("AgentVesselBase.chatOp", () => {
  it("rejects a caller that is not this agent's own EvalDO", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = "do:vibestudio/internal:EvalDO:someoneelse";
    await expect(vessel.chatOp(CHANNEL, "getMessageTypes", [])).rejects.toThrow(
      /only this agent's own EvalDO/
    );
  });

  it("rejects when there is no verified caller", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = null;
    await expect(vessel.chatOp(CHANNEL, "getMessageTypes", [])).rejects.toThrow(/refusing caller/);
  });

  it("accepts the agent's own EvalDO (key matches the eval service formula)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.messageTypes.set("weather", WEATHER_TYPE);
    const types = await vessel.chatOp(CHANNEL, "getMessageTypes", []);
    expect(Array.isArray(types)).toBe(true);
    expect((types as unknown[]).length).toBe(1);
  });

  it("replayEnvelope returns one durable envelope by id and null when absent", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const event = {
      id: 7,
      type: "message",
      payload: { text: "hello" },
      senderId: "panel:user",
      ts: Date.now(),
    } as ChannelEvent;
    vessel.channelStub.envelopes.set("env-7", event);

    await expect(vessel.chatOp(CHANNEL, "replayEnvelope", ["env-7"])).resolves.toEqual(event);
    await expect(vessel.chatOp(CHANNEL, "replayEnvelope", ["missing"])).resolves.toBeNull();
    await expect(vessel.chatOp(CHANNEL, "replayEnvelope", [""])).resolves.toBeNull();
  });

  it("configureAgent + describeSelf expose per-agent config to the eval `agent` binding", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();

    const updated = (await vessel.chatOp(CHANNEL, "configureAgent", [
      { model: "openai:gpt-5.3", thinkingLevel: "high" },
    ])) as { model: string; thinkingLevel: string };
    expect(updated.model).toBe("openai:gpt-5.3");
    expect(updated.thinkingLevel).toBe("high");

    const snapshot = (await vessel.chatOp(CHANNEL, "describeSelf", [])) as {
      identity: { id: string };
      config: { model: string };
      channels: Array<{ channelId: string }>;
    };
    expect(snapshot.identity.id).toBe(AGENT_ID);
    // Per-agent: the model set above is what describeSelf reports.
    expect(snapshot.config.model).toBe("openai:gpt-5.3");
    expect(snapshot.channels.some((c) => c.channelId === CHANNEL)).toBe(true);
  });

  it("configureAgent validates its patch (rejects an empty model)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await expect(vessel.chatOp(CHANNEL, "configureAgent", [{ model: "" }])).rejects.toThrow(
      /model/
    );
  });

  it("registerMessageType publishes messageType.registered AS the agent", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.chatOp(CHANNEL, "registerMessageType", [
      {
        typeId: "weather",
        displayMode: "row",
        source: { type: "file", path: "renderers/weather.tsx" },
        stateSchema: WEATHER_TYPE.stateSchema,
      },
    ]);
    const published = vessel.channelStub.published;
    expect(published).toHaveLength(1);
    expect(published[0]!.event.kind).toBe("messageType.registered");
    expect(published[0]!.event.actor.kind).toBe("agent");
    expect(published[0]!.event.actor.id).toBe(AGENT_ID);
  });

  it("publishCustomMessage routes through the card manager and returns { messageId, pubsubId }", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.messageTypes.set("weather", WEATHER_TYPE);
    const result = (await vessel.chatOp(CHANNEL, "publishCustomMessage", [
      { typeId: "weather", initialState: { city: "Berlin" } },
    ])) as { messageId: string; pubsubId: number | undefined };
    expect(typeof result.messageId).toBe("string");
    // The stub returns { id: published.length }; the first publish is id 1, and
    // the handle must surface it (harmonized with the panel client).
    expect(result.pubsubId).toBe(1);
    const started = vessel.channelStub.published.find((p) => p.event.kind === "custom.started");
    expect(started).toBeDefined();
    expect(started!.event.actor.kind).toBe("agent");
  });

  it("updateCustomMessage publishes custom.updated AS the agent and returns its pubsubId", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    vessel.channelStub.messageTypes.set("weather", WEATHER_TYPE);
    const created = (await vessel.chatOp(CHANNEL, "publishCustomMessage", [
      { typeId: "weather", initialState: { city: "Berlin" } },
    ])) as { messageId: string };
    const pubsubId = await vessel.chatOp(CHANNEL, "updateCustomMessage", [
      created.messageId,
      { city: "Paris" },
    ]);
    // Second publish on this channel → stub id 2.
    expect(pubsubId).toBe(2);
    const updated = vessel.channelStub.published.find((p) => p.event.kind === "custom.updated");
    expect(updated).toBeDefined();
    expect(updated!.event.actor.kind).toBe("agent");
  });

  it("focusMessage is panel-only and resolves false", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await expect(vessel.chatOp(CHANNEL, "focusMessage", ["msg-1"])).resolves.toBe(false);
  });

  it("callMethod initiates a channel call and resolves with the delivered content", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const promise = vessel.chatOp(CHANNEL, "callMethod", ["panel-pid", "doThing", { x: 1 }]);
    const call = await waitForCall(vessel);
    expect(call.method).toBe("doThing");
    await vessel.deliverTerminal(call.callId, "invocation.completed", { result: { ok: 42 } });
    await expect(promise).resolves.toEqual({ ok: 42 });
  });

  it("callMethodResult resolves with the full ChatMethodResult envelope", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const promise = vessel.chatOp(CHANNEL, "callMethodResult", ["panel-pid", "doThing", {}]);
    const call = await waitForCall(vessel);
    await vessel.deliverTerminal(call.callId, "invocation.completed", { result: "hello" });
    await expect(promise).resolves.toEqual({ content: "hello" });
  });

  it("callMethod rejects when the channel terminal is an error", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    const promise = vessel.chatOp(CHANNEL, "callMethod", ["panel-pid", "boom", {}]);
    const call = await waitForCall(vessel);
    await vessel.deliverTerminal(call.callId, "invocation.failed", { error: "kaboom" });
    await expect(promise).rejects.toThrow(/kaboom/);
  });
});

describe("AgentVesselBase.processChannelEvent", () => {
  it("forwards message metadata into the loop command", async () => {
    const vessel = await makePromptProbe();
    const event: ChannelEvent = {
      id: 1,
      messageId: "env-after-turn",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "message.completed",
        actor: { kind: "user", id: "panel:user", participantId: "panel:user" },
        causality: { messageId: "msg-after-turn" },
        payload: {
          protocol: "agentic.trajectory.v1",
          role: "user",
          blocks: [{ type: "text", content: "next please" }],
          outcome: "completed",
          metadata: { deliverAfterTurn: true },
        },
        createdAt: new Date().toISOString(),
      } as unknown as AgenticEvent,
      senderId: "panel:user",
      ts: Date.now(),
    };

    await vessel.processChannelEvent(CHANNEL, event);

    expect(vessel.handleIncomingSpy).toHaveBeenCalledTimes(1);
    expect(vessel.handleIncomingSpy.mock.calls[0]?.[1]).toMatchObject({
      type: "command",
      command: {
        kind: "prompt",
        source: { envelopeId: "env-after-turn" },
        sourceMessageId: "msg-after-turn",
        metadata: { deliverAfterTurn: true },
      },
    });
  });
});

describe("AgentVesselBase.onEvalComplete (deferred-eval resume)", () => {
  /** Replace the lazily-built driver with a spy so we can assert the delivered outcome. */
  function stubDriver(vessel: TestVessel): ReturnType<typeof vi.fn> {
    const deliverSpy = vi.fn(async () => {});
    (vessel as unknown as { _driver: unknown })._driver = {
      deliverEffectOutcome: deliverSpy,
      connectSpecProvider: undefined, // the driver getter sets this each access
    };
    return deliverSpy;
  }

  it("delivers the formatted result to the parked invocation effect (runId IS the invocationId)", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "server";

    await vessel.onEvalComplete({
      runId: "inv-77",
      result: { success: true, console: "out", returnValue: 7, scopeKeys: ["a"] },
      channelId: CHANNEL,
    });

    expect(deliverSpy).toHaveBeenCalledTimes(1);
    const [effectId, outcome, address] = deliverSpy.mock.calls[0]!;
    expect(effectId).toBe(ids.invocationEffect("inv-77"));
    expect(outcome).toMatchObject({
      kind: "tool",
      isError: false,
      // The formatted protocol content + the raw result on details (for the harness).
      result: { details: { success: true } },
    });
    expect(address).toEqual({ channelId: CHANNEL });
  });

  it("delivers a failed eval as a structured tool failure", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "server";
    await vessel.onEvalComplete({
      runId: "inv-78",
      result: { success: false, console: "", error: "boom" },
      channelId: CHANNEL,
    });
    expect(deliverSpy.mock.calls[0]![1]).toMatchObject({
      kind: "tool",
      isError: true,
      result: { details: { success: false, error: "boom" } },
    });
  });

  it("is a no-op without a channelId or result (can't route the resume)", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "server";
    await vessel.onEvalComplete({ runId: "inv-79", result: { success: true, console: "" } });
    await vessel.onEvalComplete({ runId: "inv-79", channelId: CHANNEL });
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("refuses a non-server caller (open relay; only the server settles an eval)", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    vessel.callerKindForTest = "do"; // another DO trying to forge a completion
    await expect(
      vessel.onEvalComplete({
        runId: "inv-80",
        result: { success: true, console: "" },
        channelId: CHANNEL,
      })
    ).rejects.toThrow(/server-only/);
    expect(deliverSpy).not.toHaveBeenCalled();
  });

  it("deliverEffectOutcome accepts server + the agent's PubSubChannel DO, refuses other DOs", async () => {
    const vessel = await makeVessel();
    const deliverSpy = stubDriver(vessel);
    const outcome = { kind: "tool", result: "ok", isError: false } as never;

    vessel.callerKindForTest = "server";
    await vessel.deliverEffectOutcome("eff-1", outcome);
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";
    await vessel.deliverEffectOutcome("eff-2", outcome);
    expect(deliverSpy).toHaveBeenCalledTimes(2);

    vessel.callerIdForTest = "do:agents/evil:EvilAgent:x"; // a foreign agent forging
    await expect(vessel.deliverEffectOutcome("eff-3", outcome)).rejects.toThrow(/refusing caller/);
    expect(deliverSpy).toHaveBeenCalledTimes(2);
  });

  it("credentialConnected reports whether it actually resumed a pending credential wait", async () => {
    const vessel = await makeVessel();
    const deliverSpy = vi.fn(async () => true);
    const wakeSpy = vi.fn(async () => {});
    (vessel as unknown as { _driver: unknown })._driver = {
      deliverEffectOutcome: deliverSpy,
      wake: wakeSpy,
      connectSpecProvider: undefined,
    };
    vessel.callerKindForTest = "do";
    vessel.callerIdForTest = "do:workers/pubsub-channel:PubSubChannel:chan-1";

    await expect(
      vessel.onMethodCall(CHANNEL, "call-1", "credentialConnected", {
        providerId: "openai-codex",
      })
    ).resolves.toEqual({ result: { resumed: true } });
    expect(deliverSpy).toHaveBeenCalledWith(
      ids.credentialWaitEffect(ids.credKey(CHANNEL, "openai-codex")),
      { kind: "credential", resolved: true },
      { channelId: CHANNEL }
    );
    expect(wakeSpy).toHaveBeenCalledWith(CHANNEL);

    deliverSpy.mockResolvedValueOnce(false);
    wakeSpy.mockClear();
    await expect(
      vessel.onMethodCall(CHANNEL, "call-2", "credentialConnected", {
        providerId: "openai-codex",
      })
    ).resolves.toEqual({ result: { resumed: false } });
    expect(wakeSpy).not.toHaveBeenCalled();
  });

  it("onDeferredResult refuses a non-server caller", async () => {
    const vessel = await makeVessel();
    vessel.callerKindForTest = "panel";
    await expect(vessel.onDeferredResult({ requestId: "req-1", result: "x" })).rejects.toThrow(
      /server-only/
    );
  });
});

/** Vessel whose `rpc.call` is a recording stub, so we can drive `runDeferredEval` (the eval gate). */
class EvalGateProbe extends TestVessel {
  rpcCalls: Array<{ method: string; args: unknown[] }> = [];
  getRunStatus: { status: string; result?: unknown } = { status: "pending" };
  /** When set, `eval.getRun` REJECTS with this error (a transient store/RPC hiccup). */
  getRunError: Error | null = null;
  /** When set, `eval.startRun` REJECTS with this error (the kick-off itself failed). */
  startRunError: Error | null = null;
  /** When set, `eval.cancel`/`eval.forceReset` REJECT with this error. */
  cancelError: Error | null = null;
  protected override get rpc(): DeferrableRpcClient {
    return {
      call: async (_target: string, method: string, args: unknown[]) => {
        this.rpcCalls.push({ method, args });
        if (method === "eval.getRun") {
          if (this.getRunError) throw this.getRunError;
          return this.getRunStatus;
        }
        if (method === "eval.startRun" && this.startRunError) throw this.startRunError;
        if (method === "eval.cancel" || method === "eval.forceReset") {
          if (this.cancelError) throw this.cancelError;
          return { ok: true };
        }
        return { runId: (args[0] as { runId: string }).runId, status: "pending" };
      },
    } as unknown as DeferrableRpcClient;
  }
  callGate(channelId: string, invocationId: string, args: unknown) {
    return this.runDeferredEval(channelId, invocationId, args);
  }
  /** Drive a channel-callable agent method (cancelEval / pause / …) directly. */
  callAgentMethod(channelId: string, methodName: string, args: unknown) {
    return this.handleStandardAgentMethodCall(channelId, methodName, args);
  }
  /** Replace the lazily-built driver with a spy so `pause` doesn't boot the real
   *  driver (which needs a live gateway/GAD). `inFlight` models whether a model
   *  call was running when the flush hit (drives the conditional-abort path). */
  stubDriverForPause(opts: { inFlight?: boolean } = {}): {
    abortChannel: ReturnType<typeof vi.fn>;
    handleIncoming: ReturnType<typeof vi.fn>;
  } {
    const abortChannel = vi.fn();
    const handleIncoming = vi.fn(async () => {});
    const loop = vi.fn(async () => ({
      state: { inFlightModelCall: opts.inFlight ? { messageId: "m" } : null },
    }));
    (this as unknown as { _driver: unknown })._driver = { abortChannel, handleIncoming, loop };
    return { abortChannel, handleIncoming };
  }
}

async function makeGateProbe(): Promise<EvalGateProbe> {
  const { instance } = await createTestDO(EvalGateProbe, TEST_AGENT_ENV);
  return instance;
}

class SubagentSpawnProbe extends TestVessel {
  rpcCalls: Array<{ target: string; method: string; args: unknown[] }> = [];
  gadLogHead: Record<string, unknown> | null = null;
  failClaudeLaunch = false;
  ownerRuntimeContextId = "ctx-1";
  readonly handleIncomingSpy = vi.fn(async (_channelId: string, _incoming: unknown) => {});
  protected override async ensurePromptArtifacts(): Promise<void> {}
  protected override get driver(): AgentLoopDriver {
    return {
      wake: vi.fn(async () => {}),
      deliverEffectOutcome: vi.fn(async () => true),
      handleIncoming: this.handleIncomingSpy,
      dropLoop: vi.fn(),
      foldCache: { delete: vi.fn() },
    } as unknown as AgentLoopDriver;
  }
  protected override get rpc(): DeferrableRpcClient {
    return {
      call: async (target: string, method: string, args: unknown[]) => {
        this.rpcCalls.push({ target, method, args });
        this.operationLog.push(`rpc:${target}:${method}`);
        if (target === "main" && method === "runtime.resolveContext") {
          return this.ownerRuntimeContextId;
        }
        if (
          target === "main" &&
          (method === "workspace-state.alarmSet" || method === "workspace-state.alarmClear")
        ) {
          return undefined;
        }
        if (target === "main" && method === "runtime.createSubagentContext") {
          return { contextId: "ctx-child" };
        }
        if (target === "main" && method === "runtime.createEntity") {
          return {
            id: "do:workers/agent-worker:AiChatWorker:subagent-inv-1",
            targetId: "do:workers/agent-worker:AiChatWorker:subagent-inv-1",
          };
        }
        if (target === "main" && method === "workers.resolveService") {
          return {
            kind: "durable-object",
            source: "workers/gad-store",
            className: "GadWorkspaceDO",
            objectKey: "workspace-main",
            targetId: "gad",
          };
        }
        if (target === "gad" && method === "getLogHead") {
          return this.gadLogHead;
        }
        if (target === "gad" && method === "forkLog") {
          const input = args[0] as { atSeq?: number };
          return { forkSeq: input.atSeq ?? 0, forkHash: "fork-hash", inherited: 0 };
        }
        if (target === "main" && method === "extensions.invokeProvider") {
          const [provider, providerMethod] = args as [string, string, unknown[]];
          if (provider === "claudeCode" && providerMethod === "launchSubagent") {
            if (this.failClaudeLaunch) throw new Error("launchSubagent boom");
            return {
              entityId: "session:cc-1",
              contextId: "ctx-child",
              channelId: "task-inv-cc",
              vesselRef: "do:workers/linked-agent:LinkedAgentWorker:linked:session-cc-1",
              vesselEntityId: "do:workers/linked-agent:LinkedAgentWorker:linked:session-cc-1",
              vesselParticipantId: "participant-linked",
              launchId: "claude-code:inv-cc",
              pid: 4242,
              logPath: "/state/agent-launch/session:cc-1/headless.log",
            };
          }
          if (provider === "claudeCode" && providerMethod === "release") {
            return { released: true };
          }
        }
        if (target === "main" && method === "extensions.invoke") {
          const [ext, extMethod] = args as [string, string, unknown[]];
          if (ext === "@workspace-extensions/codex" && extMethod === "launchSubagent") {
            return {
              entityId: "session:codex-1",
              contextId: "ctx-child",
              channelId: "task-inv-codex",
              vesselRef: "do:workers/linked-agent:LinkedAgentWorker:linked:session-codex-1",
              vesselEntityId: "do:workers/linked-agent:LinkedAgentWorker:linked:session-codex-1",
              vesselParticipantId: "participant-linked",
              launchId: "codex:inv-codex",
              pid: 4242,
              logPath: "/state/agent-launch/session:codex-1/headless.log",
            };
          }
          if (ext === "@workspace-extensions/codex" && extMethod === "release") {
            return { released: true };
          }
        }
        return { ok: true, participantId: "participant-child" };
      },
    } as unknown as DeferrableRpcClient;
  }
  async spawnForTest(channelId: string, invocationId: string, args: unknown) {
    return this.runDeferredSpawn(channelId, invocationId, args);
  }
  subagentRunForTest(runId: string) {
    return this.subagentRuns.get(runId);
  }
  seedSubagentStartedInParentChannelForTest(runId: string) {
    this.channelStub.replay.set(CHANNEL, [
      {
        id: 1,
        messageId: `ik:subagent-started:${runId}`,
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: {
          kind: "invocation.started",
          actor: { kind: "agent", id: AGENT_ID, displayName: "TestAgent" },
          causality: { invocationId: runId },
          payload: {
            protocol: "agentic.trajectory.v1",
            name: "spawn_subagent",
            subagent: {
              runId,
              mode: "fresh",
              taskChannelId: `task-${runId}`,
              contextId: `ctx-${runId}`,
              parentContextId: "ctx-1",
              childEntityId: `do:workers/agent-worker:AiChatWorker:subagent-${runId}`,
              label: "recovered subagent",
            },
          },
          createdAt: new Date().toISOString(),
        } as unknown as AgenticEvent,
        senderId: AGENT_ID,
        ts: Date.now(),
      },
    ]);
  }
  insertSubagentRunForTest(row: {
    runId: string;
    status: "starting" | "running";
    lastActivityAt?: number;
  }) {
    const now = Date.now();
    this.subagentRuns.insert({
      runId: row.runId,
      taskChannelId: `task-${row.runId}`,
      parentContextId: "ctx-1",
      childContextId: `ctx-${row.runId}-stale`,
      childEntityId: `do:workers/agent-worker:AiChatWorker:subagent-${row.runId}`,
      childParticipantId: "participant-child",
      parentChannelId: CHANNEL,
      mode: "fresh",
      label: "stale subagent",
      depth: 1,
      status: row.status,
      merge: null,
      startedAt: now,
      lastActivityAt: row.lastActivityAt ?? now,
      agentKind: "pi",
      externalSessionEntityId: null,
    });
  }
  async inspectSubagentForTest(runId: string, query: string, parentChannelId = CHANNEL) {
    return this.inspectSubagent(runId, query, parentChannelId);
  }
  async readSubagentForTest(runId: string, afterSeq: number, parentChannelId = CHANNEL) {
    return this.readSubagent(runId, afterSeq, parentChannelId);
  }
  async completeSubagentForTest(runId: string, report: string, outcome: "success" | "failed") {
    const run = this.subagentRuns.get(runId);
    if (!run) throw new Error(`missing run ${runId}`);
    this.callerIdForTest = run.childEntityId;
    await this.onSubagentComplete({ runId, report, outcome });
  }
  async closeSubagentForTest(runId: string, discard = false) {
    return (
      this as unknown as {
        closeSubagent(runId: string, discard: boolean): Promise<unknown>;
      }
    ).closeSubagent(runId, discard);
  }
  async drainSubagentProgressForTest(now = Date.now()) {
    return (
      this as unknown as { drainSubagentProgress(at: number): Promise<void> }
    ).drainSubagentProgress(now);
  }
  subagentProgressDiagnosticsForTest() {
    return this.subagentRuns.progressDiagnostics();
  }
}

async function makeSubagentSpawnProbe(config?: unknown): Promise<SubagentSpawnProbe> {
  const { instance } = await createTestDO(SubagentSpawnProbe, TEST_AGENT_ENV);
  await instance.registerSubscriptionForTest(CHANNEL, config);
  return instance;
}

describe("AgentVesselBase.runDeferredEval (the agent's eval-tool deferral gate)", () => {
  it("kicks off eval.startRun with runId===invocationId (subKey=channelId) and defers while pending", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };

    const out = await probe.callGate(CHANNEL, "inv-1", { code: "1+1" });

    expect(out).toEqual({ deferred: true });
    const start = probe.rpcCalls.find((c) => c.method === "eval.startRun");
    expect(start?.args[0]).toMatchObject({
      runId: "inv-1",
      channelId: CHANNEL,
      subKey: CHANNEL,
      code: "1+1",
    });
    // The poll backstop check happened even on the first dispatch.
    expect(probe.rpcCalls.some((c) => c.method === "eval.getRun")).toBe(true);
  });

  it("completes INLINE when getRun already reports done (the lost-push poll backstop)", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = {
      status: "done",
      result: { success: true, console: "out", returnValue: 5 },
    };

    const out = await probe.callGate(CHANNEL, "inv-2", { code: "5" });

    expect((out as { deferred?: boolean }).deferred).toBeUndefined();
    expect(out).toMatchObject({ isError: false });
    expect((out as { result: { details: unknown } }).result).toMatchObject({
      details: { success: true },
    });
  });

  it("reports an inline failed eval as a tool failure", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = {
      status: "done",
      result: { success: false, console: "", error: "boom" },
    };

    await expect(
      probe.callGate(CHANNEL, "inv-failed", { code: "throw new Error('boom')" })
    ).resolves.toMatchObject({
      isError: true,
      result: { details: { success: false, error: "boom" } },
    });
  });

  it("returns a terminal error when getRun reports cancelled (reset)", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "cancelled" };
    const out = await probe.callGate(CHANNEL, "inv-3", { code: "x" });
    expect(out).toMatchObject({ isError: true, result: expect.stringContaining("cancelled") });
  });

  it("uses path as an inline source hint and rejects only a missing source", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };
    await expect(
      probe.callGate(CHANNEL, "inv-4", { code: "x", path: "meta", sourcePath: "src/probe.ts" })
    ).resolves.toEqual({ deferred: true });
    expect(probe.rpcCalls.find((call) => call.method === "eval.startRun")?.args[0]).toMatchObject({
      code: "x",
      path: undefined,
      sourcePath: "src/probe.ts",
    });

    const missing = await probe.callGate(CHANNEL, "inv-missing", {});
    expect(missing).toMatchObject({ isError: true });
  });

  it("treats an empty path emitted beside inline code as omitted", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };
    await expect(
      probe.callGate(CHANNEL, "inv-empty-path", { code: "1+1", path: "" })
    ).resolves.toEqual({
      deferred: true,
    });
    expect(probe.rpcCalls.find((call) => call.method === "eval.startRun")?.args[0]).toMatchObject({
      code: "1+1",
      path: undefined,
    });
  });

  it("threads an atomic reset flag into the deferred eval start", async () => {
    const probe = await makeGateProbe();
    probe.getRunStatus = { status: "pending" };

    await expect(
      probe.callGate(CHANNEL, "inv-reset", { reset: true, code: "return Object.keys(scope)" })
    ).resolves.toEqual({ deferred: true });

    expect(probe.rpcCalls.find((call) => call.method === "eval.startRun")?.args[0]).toMatchObject({
      runId: "inv-reset",
      reset: true,
      code: "return Object.keys(scope)",
    });
  });

  it("F4: PARKS (deferred) when the getRun poll throws AFTER startRun succeeded — never a spurious error", async () => {
    // The run is already in flight server-side (startRun returned). A transient getRun hiccup must
    // NOT surface as the tool result (that would settle the invocation with a fake error AND drop the
    // real eval result when the held run later completes). It parks for the push / deferRedrive.
    const probe = await makeGateProbe();
    probe.getRunError = new Error("transient store load failed");

    const out = await probe.callGate(CHANNEL, "inv-park", { code: "1+1" });

    // Parked, not errored.
    expect(out).toEqual({ deferred: true });
    expect((out as { isError?: boolean }).isError).toBeUndefined();
    // startRun still kicked off the run (so the result can arrive out-of-band).
    expect(probe.rpcCalls.find((c) => c.method === "eval.startRun")?.args[0]).toMatchObject({
      runId: "inv-park",
      channelId: CHANNEL,
    });
    // The poll WAS attempted (and threw).
    expect(probe.rpcCalls.some((c) => c.method === "eval.getRun")).toBe(true);
  });

  it("F4: a startRun failure still propagates (the run was never kicked off — fail fast)", async () => {
    // startRun throwing means the eval never started; there's nothing parked to settle later, so the
    // error must propagate to the tool executor (which renders it as the tool outcome). We only park
    // for a getRun hiccup AFTER a successful startRun.
    const probe = await makeGateProbe();
    probe.startRunError = new Error("startRun dispatch failed");
    await expect(probe.callGate(CHANNEL, "inv-fail", { code: "1+1" })).rejects.toThrow(
      /startRun dispatch failed/
    );
    // The getRun poll was never reached.
    expect(probe.rpcCalls.some((c) => c.method === "eval.getRun")).toBe(false);
  });
});

describe("AgentVesselBase.runDeferredSpawn", () => {
  it("inherits the parent's effective Pi model, unattended settings, and system prompt", async () => {
    const probe = await makeSubagentSpawnProbe({
      systemPrompt: "system-test-parent-prompt",
      systemPromptMode: "append",
    });
    probe.callerIdForTest = await expectedEvalCaller();
    await probe.chatOp(CHANNEL, "configureAgent", [
      {
        model: "openai-codex:gpt-5.3-codex-spark",
        thinkingLevel: "high",
        fallbackModel: "anthropic:claude-sonnet-4-6",
        fallbackThinkingLevel: "minimal",
        fallbackOn: ["usage_limit_terminal"],
        fallbackScope: "all-turns",
        approvalLevel: 2,
      },
    ]);

    const out = await probe.spawnForTest(CHANNEL, "inv-inherit", {
      mode: "fresh",
      task: "exercise the inherited child configuration",
    });

    expect(out).toMatchObject({ isError: false });
    const create = probe.rpcCalls.find(
      (call) => call.target === "main" && call.method === "runtime.createEntity"
    );
    expect(create?.args[0]).toMatchObject({
      stateArgs: {
        agentConfig: {
          model: "openai-codex:gpt-5.3-codex-spark",
          thinkingLevel: "high",
          fallbackModel: "anthropic:claude-sonnet-4-6",
          fallbackThinkingLevel: "minimal",
          fallbackOn: ["usage_limit_terminal"],
          fallbackScope: "all-turns",
          approvalLevel: 2,
          systemPrompt: "system-test-parent-prompt",
          systemPromptMode: "append",
        },
      },
    });
  });

  it("lets explicit Pi child config override inherited behavior", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.callerIdForTest = await expectedEvalCaller();
    await probe.chatOp(CHANNEL, "configureAgent", [
      { model: "openai-codex:gpt-5.3-codex-spark", approvalLevel: 2 },
    ]);

    await probe.spawnForTest(CHANNEL, "inv-override", {
      mode: "fresh",
      task: "exercise an explicit child override",
      config: { model: "openai:gpt-5.3", approvalLevel: 1 },
    });

    const create = probe.rpcCalls.find(
      (call) => call.target === "main" && call.method === "runtime.createEntity"
    );
    expect(create?.args[0]).toMatchObject({
      stateArgs: {
        agentConfig: { model: "openai:gpt-5.3", approvalLevel: 1 },
      },
    });
  });

  it("reuses an existing child trajectory fork point when a forked spawn is retried", async () => {
    const probe = await makeSubagentSpawnProbe();
    const parentLogId = ids.logIdForChannel(CHANNEL);
    const taskChannelId = "task-inv-1";
    const childLogId = ids.logIdForChannel(taskChannelId);
    probe.gadLogHead = {
      logId: childLogId,
      head: childLogId,
      logKind: "trajectory",
      seq: 12,
      hash: "child-head",
      envelopeId: null,
      parentLogId,
      parentHead: parentLogId,
      forkSeq: 7,
      forkHash: "parent-seq-7",
    };

    await probe.initFromTrajectoryFork({
      parentLogId,
      seq: 99,
      taskChannelId,
      contextId: "ctx-child",
    });

    const forkCall = probe.rpcCalls.find(
      (call) => call.target === "gad" && call.method === "forkLog"
    );
    expect(forkCall?.args[0]).toMatchObject({
      fromLogId: parentLogId,
      fromHead: parentLogId,
      toLogId: childLogId,
      toHead: childLogId,
      atSeq: 7,
    });
  });

  it("creates the task trajectory fork before initializing the child or subscribing the supervisor", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fork",
      task: "start the forked child",
    });

    expect(out).toMatchObject({ isError: false });
    const forkIndex = probe.operationLog.findIndex((entry) => entry === "rpc:gad:forkLog");
    const initIndex = probe.operationLog.findIndex((entry) =>
      entry.includes(":initFromTrajectoryFork")
    );
    const supervisorSubscribeIndex = probe.operationLog.findIndex(
      (entry) => entry === "channel:task-inv-1:subscribe"
    );
    expect(forkIndex).toBeGreaterThanOrEqual(0);
    expect(initIndex).toBeGreaterThanOrEqual(0);
    expect(supervisorSubscribeIndex).toBeGreaterThanOrEqual(0);
    expect(forkIndex).toBeLessThan(initIndex);
    expect(initIndex).toBeLessThan(supervisorSubscribeIndex);
  });

  it("fails before context creation when the owner entity and channel subscription contexts diverge", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.ownerRuntimeContextId = "ctx-original";

    const out = await probe.spawnForTest(CHANNEL, "inv-ctx-mismatch", {
      mode: "fork",
      task: "start the forked child",
    });

    expect(out).toMatchObject({
      isError: true,
      result: expect.stringContaining(
        "spawn_subagent context mismatch: owner do:test:TestAgent:agent-key is registered in ctx-original, but channel chan-1 is subscribed as ctx-1"
      ),
    });
    expect(
      probe.rpcCalls.some(
        (call) => call.target === "main" && call.method === "runtime.createSubagentContext"
      )
    ).toBe(false);
  });

  it("fails a forked spawn before child init when the task trajectory has different lineage", async () => {
    const probe = await makeSubagentSpawnProbe();
    const childLogId = ids.logIdForChannel("task-inv-1");
    probe.gadLogHead = {
      logId: childLogId,
      head: childLogId,
      logKind: "trajectory",
      seq: 0,
      hash: "root-head",
      envelopeId: null,
      parentLogId: null,
      parentHead: null,
      forkSeq: null,
      forkHash: null,
    };

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fork",
      task: "start the forked child",
    });

    expect(out).toMatchObject({
      isError: true,
      result: `subagent task trajectory already exists with different fork lineage: ${childLogId}:${childLogId}`,
    });
    expect(probe.operationLog.some((entry) => entry.includes(":initFromTrajectoryFork"))).toBe(
      false
    );
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.destroyContext" &&
          JSON.stringify(call.args).includes("ctx-child")
      )
    ).toBe(true);
  });

  it("launches the child and returns a run handle immediately instead of parking the tool call", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });

    expect((out as { deferred?: boolean }).deferred).toBeUndefined();
    expect(out).toMatchObject({
      isError: false,
      result: {
        details: {
          runId: "inv-1",
          mode: "fresh",
          label: "background audit",
          taskChannelId: "task-inv-1",
          contextId: "ctx-child",
          status: "running",
        },
      },
    });
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      runId: "inv-1",
      status: "running",
      taskChannelId: "task-inv-1",
      childContextId: "ctx-child",
    });
    expect(probe.rpcCalls.some((call) => call.method === "runtime.createEntity")).toBe(true);
    expect(probe.channelStub.published.some((p) => p.event.kind === "invocation.started")).toBe(
      true
    );
    const startedIndex = probe.channelStub.published.findIndex(
      (p) => p.idempotencyKey === "subagent-started:inv-1"
    );
    const seedIndex = probe.channelStub.published.findIndex(
      (p) => p.idempotencyKey === "subagent-seed:inv-1"
    );
    expect(startedIndex).toBeGreaterThanOrEqual(0);
    expect(seedIndex).toBeGreaterThan(startedIndex);
    const seed = probe.channelStub.published.find(
      (p) => p.idempotencyKey === "subagent-seed:inv-1"
    );
    expect(seed?.event).toMatchObject({
      kind: "message.completed",
      actor: { kind: "user", displayName: "Subagent task" },
      payload: {
        role: "user",
        to: [{ kind: "participant", participantId: "participant-child" }],
      },
    });
    expect(probe.rpcCalls.some((call) => call.method === "onChannelEnvelope")).toBe(false);
  });

  it("tears down a stale starting row and retries spawn setup on re-drive", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.insertSubagentRunForTest({ runId: "inv-1", status: "starting" });

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "retry the child setup",
    });

    expect(out).toMatchObject({ isError: false });
    expect(probe.rpcCalls).toContainEqual({
      target: "main",
      method: "runtime.destroyContext",
      args: [{ contextId: "ctx-inv-1-stale", recursive: true }],
    });
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      runId: "inv-1",
      status: "running",
      childContextId: "ctx-child",
    });
  });

  it("keeps a running setup-failure row retryable when terminal publish fails", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.channelPublishFailures.add("subagent-seed:inv-1");
    probe.channelPublishFailures.add("subagent-terminal:inv-1");

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "this seed publish will fail",
    });

    expect(out).toMatchObject({
      isError: true,
      result: "publish failed: subagent-seed:inv-1",
    });
    expect(probe.subagentRunForTest("inv-1")).toMatchObject({
      runId: "inv-1",
      status: "running",
    });
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.destroyContext" &&
          JSON.stringify(call.args).includes("ctx-child")
      )
    ).toBe(false);
  });

  it("tears down setup when the started-card publish fails", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.channelPublishFailures.add("subagent-started:inv-1");

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "this started publish will fail",
    });

    expect(out).toMatchObject({
      isError: true,
      result: "publish failed: subagent-started:inv-1",
    });
    expect(probe.subagentRunForTest("inv-1")).toBeNull();
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.destroyContext" &&
          JSON.stringify(call.args).includes("ctx-child")
      )
    ).toBe(true);
    expect(
      probe.channelStub.published.some((p) => p.idempotencyKey === "subagent-seed:inv-1")
    ).toBe(false);
  });

  it("tears down a running setup-failure row once the retry terminal publishes", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.channelPublishFailures.add("subagent-seed:inv-1");

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "this seed publish will fail",
    });

    expect(out).toMatchObject({
      isError: true,
      result: "publish failed: subagent-seed:inv-1",
    });
    expect(probe.subagentRunForTest("inv-1")).toBeNull();
    expect(
      probe.rpcCalls.some(
        (call) =>
          call.target === "main" &&
          call.method === "runtime.destroyContext" &&
          JSON.stringify(call.args).includes("ctx-child")
      )
    ).toBe(true);
    expect(
      probe.channelStub.published.some((p) => p.idempotencyKey === "subagent-terminal:inv-1")
    ).toBe(true);
  });

  it("retries the idempotent task seed for an existing running run", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.insertSubagentRunForTest({ runId: "inv-1", status: "running" });

    const out = await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      task: "seed retry",
    });

    expect(out).toMatchObject({
      isError: false,
      result: { details: { runId: "inv-1", status: "running" } },
    });
    const seed = probe.channelStub.published.find(
      (p) => p.idempotencyKey === "subagent-seed:inv-1"
    );
    expect(seed?.event).toMatchObject({
      kind: "message.completed",
      payload: {
        role: "user",
        to: [{ kind: "participant", participantId: "participant-child" }],
      },
    });
  });

  it("recovers a missing subagent row from the parent invocation card for inspect", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.seedSubagentStartedInParentChannelForTest("inv-recovered");

    const out = await probe.inspectSubagentForTest("inv-recovered", "status");

    expect(out.details).toMatchObject({ runId: "inv-recovered", query: "status" });
    expect(probe.subagentRunForTest("inv-recovered")).toMatchObject({
      runId: "inv-recovered",
      status: "running",
      taskChannelId: "task-inv-recovered",
      childContextId: "ctx-inv-recovered",
    });
    expect(probe.rpcCalls).toContainEqual({
      target: "main",
      method: "vcs.contextStatus",
      args: [{ contextId: "ctx-inv-recovered", ownerContextId: "ctx-1" }],
    });
  });

  it("recovers a missing subagent row from the parent invocation card for transcript reads", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.seedSubagentStartedInParentChannelForTest("inv-recovered");
    probe.channelStub.replay.set("task-inv-recovered", [
      {
        id: 7,
        messageId: "child-msg-7",
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: {
          kind: "message.completed",
          actor: { kind: "agent", id: "participant-child", displayName: "Child" },
          payload: {
            protocol: "agentic.trajectory.v1",
            role: "assistant",
            blocks: [{ type: "text", content: "Recovered transcript line." }],
          },
          createdAt: new Date().toISOString(),
        } as unknown as AgenticEvent,
        senderId: "participant-child",
        ts: Date.now(),
      },
    ]);

    const out = await probe.readSubagentForTest("inv-recovered", 0);

    expect((out.content[0] as { text?: string } | undefined)?.text).toContain(
      "Recovered transcript line."
    );
    expect(out.details).toMatchObject({
      runId: "inv-recovered",
      nextSeq: 7,
      empty: false,
    });
  });

  it("resolves a long unique trailing-ellipsis run reference to its canonical id", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId =
      "call_nnrl4WyxSSNYE7v57Bm9QPtD|fc_028d12fc097db4d5016a549442191c81918d66c1c1c324a9eb";
    probe.insertSubagentRunForTest({ runId, status: "running" });

    const out = await probe.readSubagentForTest("call_nnrl4WyxSSNYE7v57Bm9P...", 0);

    expect(out.details).toMatchObject({ runId, empty: true });
  });

  it("rejects ambiguous or too-short abbreviated run references", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.insertSubagentRunForTest({
      runId: "call_shared_prefix_1234567890_alpha",
      status: "running",
    });
    probe.insertSubagentRunForTest({
      runId: "call_shared_prefix_1234567890_bravo",
      status: "running",
    });

    await expect(probe.readSubagentForTest("call_shared_prefix_1234567890_...", 0)).rejects.toThrow(
      "ambiguous subagent run reference"
    );
    await expect(probe.readSubagentForTest("call_shared...", 0)).rejects.toThrow(
      "unknown subagent run"
    );
  });

  it("uses the canonical id when an abbreviated run is closed", async () => {
    const probe = await makeSubagentSpawnProbe();
    const runId = "call_close_reference_1234567890_terminal";
    probe.insertSubagentRunForTest({ runId, status: "running" });

    const out = await probe.closeSubagentForTest("call_close_reference_1234567890_...");

    expect(out).toMatchObject({ details: { runId } });
    expect(probe.subagentRunForTest(runId)).toBeNull();
  });

  it("relays child task-channel activity onto the parent subagent card", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });

    await probe.processChannelEvent("task-inv-1", {
      id: 42,
      messageId: "turn-opened-child",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "turn.opened",
        actor: { kind: "agent", id: "participant-child", displayName: "Child" },
        causality: { turnId: "turn-child-1" },
        payload: { protocol: "agentic.trajectory.v1" },
        createdAt: new Date().toISOString(),
      } as unknown as AgenticEvent,
      senderId: "participant-child",
      ts: Date.now(),
    });
    await probe.drainSubagentProgressForTest();

    const progress = probe.channelStub.published.find(
      (p) => p.event.kind === "invocation.progress" && p.event.causality?.invocationId === "inv-1"
    );
    expect(progress?.event).toMatchObject({
      kind: "invocation.progress",
      payload: {
        subagent: { kind: "turn-started", messageSeq: 42 },
      },
    });
  });

  it("durably retries child progress in order after a publication failure", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });
    const firstKey = "subagent-progress:inv-1:42:turn.opened";
    probe.channelPublishFailures.add(firstKey);

    await probe.processChannelEvent("task-inv-1", {
      id: 42,
      messageId: "turn-opened-child",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "turn.opened",
        actor: { kind: "agent", id: "participant-child", displayName: "Child" },
        causality: { turnId: "turn-child-1" },
        payload: { protocol: "agentic.trajectory.v1" },
        createdAt: new Date().toISOString(),
      } as unknown as AgenticEvent,
      senderId: "participant-child",
      ts: Date.now(),
    });
    await probe.processChannelEvent("task-inv-1", {
      id: 43,
      messageId: "tool-started-child",
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: {
        kind: "invocation.started",
        actor: { kind: "agent", id: "participant-child", displayName: "Child" },
        causality: { invocationId: "child-tool-1" },
        payload: { protocol: "agentic.trajectory.v1", tool: "eval" },
        createdAt: new Date().toISOString(),
      } as unknown as AgenticEvent,
      senderId: "participant-child",
      ts: Date.now(),
    });
    await probe.drainSubagentProgressForTest();
    expect(probe.channelStub.published).not.toContainEqual(
      expect.objectContaining({ idempotencyKey: firstKey })
    );
    expect(probe.subagentProgressDiagnosticsForTest()).toMatchObject({
      pending: 2,
      failures: [{ idempotencyKey: firstKey, attempts: 1 }],
    });

    probe.channelPublishFailures.delete(firstKey);
    await probe.drainSubagentProgressForTest(Date.now() + 1_000);
    // The second event was blocked behind the first when this batch began. A
    // subsequent alarm drains it, preserving source order across hibernation.
    await probe.drainSubagentProgressForTest(Date.now() + 1_000);
    const progress = probe.channelStub.published.filter(
      (entry) =>
        entry.event.causality?.invocationId === ("inv-1" as never) &&
        entry.event.kind === "invocation.progress"
    );
    expect(progress.map((entry) => entry.idempotencyKey)).toEqual([
      firstKey,
      "subagent-progress:inv-1:43:invocation.started",
    ]);
    expect(probe.subagentProgressDiagnosticsForTest()).toMatchObject({ pending: 0, failures: [] });
  });

  it("wakes the parent channel when the child completes while the parent is suspended", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });

    await probe.completeSubagentForTest("inv-1", "All checks passed.", "success");

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({ status: "completed" });
    expect(
      probe.channelStub.published.some((p) => p.idempotencyKey === "subagent-terminal:inv-1")
    ).toBe(true);
    expect(probe.handleIncomingSpy).toHaveBeenCalledWith(
      CHANNEL,
      expect.objectContaining({
        type: "command",
        command: expect.objectContaining({
          kind: "prompt",
          channelId: CHANNEL,
          source: { envelopeId: "subagent-terminal:inv-1:completed" },
          sourceMessageId: "subagent-terminal:inv-1",
          content: expect.stringContaining("All checks passed."),
        }),
      })
    );
  });

  it("keeps child completion retryable when waking the parent fails", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-1", {
      mode: "fresh",
      label: "background audit",
      task: "audit this in the child",
    });
    probe.handleIncomingSpy.mockRejectedValueOnce(new Error("wake failed"));

    await expect(
      probe.completeSubagentForTest("inv-1", "All checks passed.", "success")
    ).rejects.toThrow("wake failed");

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({ status: "running" });
    expect(
      probe.channelStub.published.some((p) => p.idempotencyKey === "subagent-terminal:inv-1")
    ).toBe(true);

    await probe.completeSubagentForTest("inv-1", "All checks passed.", "success");

    expect(probe.subagentRunForTest("inv-1")).toMatchObject({ status: "completed" });
    expect(probe.handleIncomingSpy).toHaveBeenCalledTimes(2);
  });

  it("agentKind:'claude-code' prepares the linked vessel and headless-launches via the supervisor", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-cc", {
      mode: "fresh",
      agentKind: "claude-code",
      label: "cc audit",
      task: "audit the repo",
      config: { model: "opus", effort: "high" },
    });

    expect(out).toMatchObject({
      isError: false,
      result: {
        details: {
          runId: "inv-cc",
          status: "running",
          agentKind: "claude-code",
          taskChannelId: "task-inv-cc",
          contextId: "ctx-child",
        },
      },
    });

    // Run row records the claude-code kind, the linked vessel as childEntityId
    // (its complete-caller identity), and the external session entity to release.
    expect(probe.subagentRunForTest("inv-cc")).toMatchObject({
      runId: "inv-cc",
      status: "running",
      agentKind: "claude-code",
      childEntityId: "do:workers/linked-agent:LinkedAgentWorker:linked:session-cc-1",
      childParticipantId: "participant-linked",
      externalSessionEntityId: "session:cc-1",
      childContextId: "ctx-child",
    });

    // The extension's subagent launch was invoked on the task channel WITH
    // subagent duty and the task; argv/cwd/env stay private to the extension.
    const launchCall = probe.rpcCalls.find(
      (c) => c.method === "extensions.invokeProvider" && (c.args[1] as string) === "launchSubagent"
    );
    expect(launchCall).toBeDefined();
    expect(launchCall!.args[0]).toBe("claudeCode");
    const launchArg = (launchCall!.args[2] as unknown[])[0] as {
      channelId: string;
      task: string;
      options?: Record<string, unknown>;
      subagent: { runId: string; parentRef: string; parentChannelId: string; depth: number };
    };
    expect(launchArg.channelId).toBe("task-inv-cc");
    expect(launchArg.task).toBe("audit the repo");
    // The spawn `config` reaches the launcher as CLI options (the extension
    // whitelists what its CLI supports).
    expect(launchArg.options).toEqual({ model: "opus", effort: "high" });
    expect(launchArg.subagent).toMatchObject({
      runId: "inv-cc",
      parentChannelId: CHANNEL,
      depth: 1,
    });

    // The started card + task seed still flow through the shared pipeline.
    expect(
      probe.channelStub.published.some((p) => p.idempotencyKey === "subagent-started:inv-cc")
    ).toBe(true);
    expect(
      probe.channelStub.published.some((p) => p.idempotencyKey === "subagent-seed:inv-cc")
    ).toBe(true);
  });

  it("agentKind names an external launcher extension without a vessel branch", async () => {
    const probe = await makeSubagentSpawnProbe();

    const out = await probe.spawnForTest(CHANNEL, "inv-codex", {
      mode: "fresh",
      agentKind: "codex",
      label: "codex audit",
      task: "audit the repo",
    });

    expect(out).toMatchObject({
      isError: false,
      result: {
        details: {
          runId: "inv-codex",
          status: "running",
          agentKind: "codex",
          taskChannelId: "task-inv-codex",
          contextId: "ctx-child",
        },
      },
    });

    const launchCall = probe.rpcCalls.find(
      (c) => c.method === "extensions.invoke" && (c.args[1] as string) === "launchSubagent"
    );
    expect(launchCall!.args[0]).toBe("@workspace-extensions/codex");

    await probe.closeSubagentForTest("inv-codex");
    const releaseCall = probe.rpcCalls.find(
      (c) =>
        c.method === "extensions.invoke" &&
        c.args[0] === "@workspace-extensions/codex" &&
        c.args[1] === "release"
    );
    expect(releaseCall).toBeDefined();
    expect((releaseCall!.args[2] as unknown[])[0]).toMatchObject({ entityId: "session:codex-1" });
  });

  it("tears down the child context when the Claude extension launch fails during setup", async () => {
    const probe = await makeSubagentSpawnProbe();
    probe.failClaudeLaunch = true;

    const out = await probe.spawnForTest(CHANNEL, "inv-cc", {
      mode: "fresh",
      agentKind: "claude-code",
      task: "audit the repo",
    });

    expect(out).toMatchObject({ isError: true });
    // The run row (recorded before prepare) is reclaimed and the child context torn down.
    expect(probe.subagentRunForTest("inv-cc")).toBeNull();
    expect(
      probe.rpcCalls.some(
        (c) => c.method === "runtime.destroyContext" && JSON.stringify(c.args).includes("ctx-child")
      )
    ).toBe(true);
  });

  it("closing a claude-code subagent releases its extension-owned launch", async () => {
    const probe = await makeSubagentSpawnProbe();
    await probe.spawnForTest(CHANNEL, "inv-cc", {
      mode: "fresh",
      agentKind: "claude-code",
      task: "audit the repo",
    });

    await probe.closeSubagentForTest("inv-cc");

    const releaseCall = probe.rpcCalls.find(
      (c) => c.method === "extensions.invokeProvider" && (c.args[1] as string) === "release"
    );
    expect(releaseCall).toBeDefined();
    expect(releaseCall!.args[0]).toBe("claudeCode");
    expect((releaseCall!.args[2] as unknown[])[0]).toMatchObject({ entityId: "session:cc-1" });
    // Context teardown still runs.
    expect(
      probe.rpcCalls.some(
        (c) => c.method === "runtime.destroyContext" && JSON.stringify(c.args).includes("ctx-child")
      )
    ).toBe(true);
    expect(probe.subagentRunForTest("inv-cc")).toBeNull();
  });
});

describe("AgentVesselBase.cancelEval (pill cancel → server-side eval run)", () => {
  it("routes to eval.cancel for ITSELF (subKey=channelId) with the run id", async () => {
    const probe = await makeGateProbe();
    const out = await probe.callAgentMethod(CHANNEL, "cancelEval", { runId: "inv-9" });
    expect(out).toEqual({ result: { ok: true } });
    const cancel = probe.rpcCalls.find((c) => c.method === "eval.cancel");
    expect(cancel?.args[0]).toEqual({ subKey: CHANNEL, runId: "inv-9" });
  });

  it("rejects a missing/empty runId WITHOUT dispatching a cancel", async () => {
    const probe = await makeGateProbe();
    const out = await probe.callAgentMethod(CHANNEL, "cancelEval", {});
    expect(out).toMatchObject({ isError: true });
    expect(probe.rpcCalls.some((c) => c.method === "eval.cancel")).toBe(false);
  });

  it("surfaces an eval.cancel failure as an error result (without throwing)", async () => {
    const probe = await makeGateProbe();
    probe.cancelError = new Error("cancel dispatch failed");
    const out = await probe.callAgentMethod(CHANNEL, "cancelEval", { runId: "inv-10" });
    expect(out).toMatchObject({ isError: true, result: { error: "cancel dispatch failed" } });
  });
});

describe("AgentVesselBase pause (clears a wedged EvalDO)", () => {
  it("invokes eval.forceReset for ITSELF (subKey=channelId) after aborting the channel", async () => {
    const probe = await makeGateProbe();
    const { abortChannel, handleIncoming } = probe.stubDriverForPause();

    const out = await probe.callAgentMethod(CHANNEL, "pause", {});

    expect(out).toEqual({ result: { paused: true } });
    expect(abortChannel).toHaveBeenCalledWith(CHANNEL);
    expect(handleIncoming).toHaveBeenCalled();
    const forceReset = probe.rpcCalls.find((c) => c.method === "eval.forceReset");
    expect(forceReset?.args[0]).toEqual({ subKey: CHANNEL });
  });

  it("does NOT fail the pause when eval.forceReset throws (best-effort)", async () => {
    const probe = await makeGateProbe();
    probe.stubDriverForPause();
    probe.cancelError = new Error("forceReset hiccup");
    const out = await probe.callAgentMethod(CHANNEL, "pause", {});
    expect(out).toEqual({ result: { paused: true } });
    // It still ATTEMPTED the forceReset.
    expect(probe.rpcCalls.some((c) => c.method === "eval.forceReset")).toBe(true);
  });

  it("flushDeferred WITH a model call in flight aborts (soft flush re-runs with steers)", async () => {
    const probe = await makeGateProbe();
    const { abortChannel } = probe.stubDriverForPause({ inFlight: true });
    await probe.callAgentMethod(CHANNEL, "pause", { flushDeferred: true });
    expect(abortChannel).toHaveBeenCalledWith(CHANNEL);
  });

  it("flushDeferred with NO model call in flight does NOT abort (else it kills the fresh steer turn)", async () => {
    const probe = await makeGateProbe();
    const { abortChannel, handleIncoming } = probe.stubDriverForPause({ inFlight: false });
    await probe.callAgentMethod(CHANNEL, "pause", { flushDeferred: true });
    // The loop's flush opens a fresh turn whose model call delivers the steers;
    // aborting here would kill it. So: interrupt delivered, but no abort.
    expect(handleIncoming).toHaveBeenCalled();
    expect(abortChannel).not.toHaveBeenCalled();
  });
});

describe("AgentVesselBase.onEvalProgress (live eval console streaming)", () => {
  it("publishes an invocation.output event keyed to the eval invocation (runId)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();

    await vessel.onEvalProgress({ runId: "inv-5", channelId: CHANNEL, output: "hello\nworld" });

    const published = vessel.channelStub.published.find(
      (p) => p.event.kind === "invocation.output"
    );
    expect(published?.event).toMatchObject({
      kind: "invocation.output",
      causality: { invocationId: "inv-5" },
      payload: { output: "hello\nworld", channel: "stdout" },
    });
  });

  it("refuses a caller that is not the agent's own EvalDO (same gate as chatOp)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = "do:vibestudio/internal:EvalDO:someoneelse";
    await expect(
      vessel.onEvalProgress({ runId: "inv-6", channelId: CHANNEL, output: "x" })
    ).rejects.toThrow(/only this agent's own EvalDO/);
  });

  it("is a no-op for empty output (no event published)", async () => {
    const vessel = await makeVessel();
    vessel.callerIdForTest = await expectedEvalCaller();
    await vessel.onEvalProgress({ runId: "inv-7", channelId: CHANNEL, output: "" });
    expect(vessel.channelStub.published.some((p) => p.event.kind === "invocation.output")).toBe(
      false
    );
  });
});
