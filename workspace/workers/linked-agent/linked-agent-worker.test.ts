import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { AGENTIC_EVENT_PAYLOAD_KIND, AGENTIC_PROTOCOL_VERSION } from "@workspace/agentic-protocol";
import { readChannelSubscriptionRecords } from "@workspace/pubsub";

import { LinkedAgentWorker, LINKED_PERMISSION_TIMEOUT_MS } from "./linked-agent-worker.js";

const ENTITY = "session-entity-1";
const OBJECT_KEY = ENTITY; // vessel is keyed by the entity it serves

class TestableLinkedAgentWorker extends LinkedAgentWorker {
  static override schemaVersion = LinkedAgentWorker.schemaVersion;

  testCallerId: string | null = `agent:${ENTITY}`;
  testCallerKind: string | null = "agent";

  readonly gadCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
  readonly published: Array<{ event: unknown }> = [];
  readonly signals: Array<{ event: unknown }> = [];
  /** Pending workspace-approval resolvers, keyed by requestId. */
  readonly approvalResolvers = new Map<string, (verdict: { behavior: string }) => void>();
  /** onSubagentComplete relays to the parent vessel. */
  readonly parentCompletions: Array<{ target: string; payload: Record<string, unknown> }> = [];
  failLogAppend = false;

  channelConfig: Record<string, unknown> | null = null;

  protected override get rpcCallerId(): string | null {
    return this.testCallerId;
  }
  protected override get rpcCallerKind(): string | null {
    return this.testCallerKind;
  }

  readonly rpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
    if (method === "onSubagentComplete") {
      this.parentCompletions.push({ target, payload: (args[0] ?? {}) as Record<string, unknown> });
      return undefined;
    }
    if (target === "main" && method === "userlandApproval.requestExternal") {
      const req = (args[0] ?? {}) as { requestId?: string };
      return await new Promise((resolve) => {
        this.approvalResolvers.set(String(req.requestId), (verdict) => resolve(verdict));
      });
    }
    if (target === "main" && method === "userlandApproval.settleExternal") {
      return { settled: true };
    }
    if (target === "main" && method.startsWith("workspace-state.alarm")) return undefined;
    throw new Error(`unexpected rpc ${target}.${method}`);
  });

  protected override get rpc(): never {
    return {
      call: this.rpcCall,
    } as never;
  }

  protected override async callGad<T>(method: string, ...args: unknown[]): Promise<T> {
    this.gadCalls.push({ method, args: (args[0] ?? {}) as Record<string, unknown> });
    if (method === "appendLogEvent") {
      if (this.failLogAppend) throw new Error("simulated replay append failure");
      const input = (args[0] ?? {}) as { events?: Array<{ envelopeId: string }> };
      return {
        envelopes: (input.events ?? []).map((event, index) => ({
          envelopeId: event.envelopeId,
          seq: index + 1,
        })),
        published: [],
      } as never;
    }
    throw new Error(`unexpected gad call ${method}`);
  }

  protected override createChannelClient() {
    return {
      openSubscription: async () => ({
        result: { ok: true },
        closed: new Promise<void>(() => {}),
        close: () => undefined,
      }),
      getParticipants: async () => [],
      getPolicyState: async () => ({
        state: {
          lastCompletedSender: null,
          lastCompletedSeq: null,
          previousCompletedSender: null,
        },
      }),
      getConfig: async () => this.channelConfig,
      getMessageSender: async () => null,
      publishAgenticEvent: async (_participantId: string, event: unknown) => {
        this.published.push({ event });
        return { id: this.published.length };
      },
      sendSignalEvent: async (_participantId: string, _payloadKind: string, event: unknown) => {
        this.signals.push({ event });
      },
      send: async () => undefined,
      broadcastStoredEnvelopes: async () => undefined,
    } as never;
  }

  protected override get driver(): never {
    return {
      handleIncoming: vi.fn(async () => undefined),
      wake: vi.fn(async () => undefined),
      loop: async () => {
        throw new Error("no driver loop in linked-agent tests");
      },
      outbox: { getForChannel: () => null },
      dropLoop: vi.fn(),
      foldCache: { delete: vi.fn() },
    } as never;
  }

  seedSubscription(channelId: string) {
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions (channel_id, context_id, subscribed_at, config, participant_id)
       VALUES (?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      Date.now(),
      null,
      this.selfParticipantId()
    );
  }

  selfParticipantId(): string {
    return this.participantId();
  }

  bootstrapIdentityForTest(): void {
    this.ensureIdentity();
  }

  queueRows(): Array<Record<string, unknown>> {
    return this.sql.exec(`SELECT * FROM linked_bridge_queue ORDER BY seq`).toArray();
  }

  seedBridgeQueue(count: number, contentBytes: number): void {
    const content = "x".repeat(contentBytes);
    for (let index = 0; index < count; index += 1) {
      this.sql.exec(
        `INSERT INTO linked_bridge_queue (dedupe_key, kind, channel_id, payload, created_at)
         VALUES (?, 'message', 'ch-1', ?, ?)`,
        `seed:${index}`,
        JSON.stringify({ content, triggerMessageId: `message-${index}`, meta: {} }),
        Date.now()
      );
    }
  }

  bridgeDesiredSize(): number | null | undefined {
    return (
      this as unknown as {
        bridgeStream: { controller: ReadableStreamDefaultController<Uint8Array> } | null;
      }
    ).bridgeStream?.controller.desiredSize;
  }

  permissionRows(): Array<Record<string, unknown>> {
    return this.sql.exec(`SELECT * FROM linked_permissions`).toArray();
  }

  appendedEvents(): Array<Record<string, unknown>> {
    return this.gadCalls
      .filter((call) => call.method === "appendLogEvent")
      .flatMap((call) => call.args["events"] as Array<Record<string, unknown>>);
  }

  shrinkPermissionDeadlines(at: number) {
    this.sql.exec(`UPDATE linked_permissions SET deadline_at = ?`, at);
  }

  async fireLinkedAlarm(now: number) {
    // The alarm source is registered privately; drive the handler directly.
    await (this as unknown as { linkedAlarm(now: number): Promise<void> }).linkedAlarm(now);
  }
}

type BridgeAck = {
  ok: boolean;
  cursor: number;
  replayFromSeq: number;
  pendingCount: number;
  primaryChannelId: string | null;
};

type TestBridge = {
  ack: BridgeAck;
  records: AsyncGenerator<
    | { kind: "subscribed"; result: BridgeAck }
    | { kind: "message"; payload: Record<string, unknown> },
    void,
    void
  >;
};

async function openTestBridge(
  worker: TestableLinkedAgentWorker,
  sessionInfo: Record<string, unknown> = {}
): Promise<TestBridge> {
  const response = await worker.openBridge({ sessionInfo });
  const records = readChannelSubscriptionRecords<BridgeAck, Record<string, unknown>>(response);
  const first = await records.next();
  if (first.done || first.value.kind !== "subscribed") {
    throw new Error("linked bridge did not start with its subscription ACK");
  }
  return { ack: first.value.result, records };
}

async function nextBridgePayload(bridge: TestBridge): Promise<Record<string, unknown>> {
  const next = await bridge.records.next();
  if (next.done || next.value.kind !== "message") {
    throw new Error("linked bridge closed before its next payload");
  }
  return next.value.payload;
}

async function makeWorker(env?: Record<string, unknown>) {
  const { instance } = await createTestDO(TestableLinkedAgentWorker, {
    __objectKey: OBJECT_KEY,
    WORKER_SOURCE: "workers/linked-agent",
    WORKER_CLASS_NAME: "LinkedAgentWorker",
    ...(env ?? {}),
  });
  const worker = instance as TestableLinkedAgentWorker;
  worker.bootstrapIdentityForTest();
  worker.seedSubscription("ch-1");
  return worker;
}

const SUBAGENT_STATE_ARGS = {
  STATE_ARGS: {
    linkedEntityId: ENTITY,
    subagent: {
      runId: "run-9",
      parentRef: "do:parent-vessel",
      parentChannelId: "ch-parent",
      parentContextId: "ctx-parent",
      depth: 1,
      mode: "fresh",
    },
  },
};

function completedMessageEvent(opts: {
  id: number;
  messageId: string;
  senderId: string;
  text: string;
  to?: Array<{ kind: string; participantId?: string }>;
  mentions?: string[];
  senderMetadata?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}) {
  return {
    id: opts.id,
    messageId: opts.messageId,
    type: AGENTIC_EVENT_PAYLOAD_KIND,
    senderId: opts.senderId,
    senderMetadata: opts.senderMetadata ?? { handle: "alice", type: "panel" },
    ts: Date.now(),
    payload: {
      kind: "message.completed",
      actor: { kind: "user", id: opts.senderId, displayName: "Alice" },
      causality: { messageId: opts.messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "user",
        blocks: [{ type: "text", content: opts.text }],
        outcome: "completed",
        ...(opts.to ? { to: opts.to } : {}),
        ...(opts.mentions ? { mentions: opts.mentions } : {}),
      },
      createdAt: new Date().toISOString(),
    },
    ...(opts.annotations ? { annotations: opts.annotations } : {}),
  };
}

function permissionPendingSignals(worker: TestableLinkedAgentWorker): Array<{ event: unknown }> {
  return worker.signals.filter((signal) => {
    const event = signal.event as { payload?: Record<string, unknown> };
    return event.payload?.["kind"] === "linked-agent.permission_pending";
  });
}

describe("LinkedAgentWorker", () => {
  it("makes the response lifetime the exact attachment lifetime", async () => {
    const worker = await makeWorker();
    const bridge = await openTestBridge(worker, { host: "laptop" });
    expect(bridge.ack.ok).toBe(true);
    expect(bridge.ack.primaryChannelId).toBe("ch-1");
    expect((await worker.linkedStatus()).attached).toBe(true);

    await bridge.records.return();
    expect((await worker.linkedStatus()).attached).toBe(false);
  });

  it("rejects bridge opening from a foreign agent credential", async () => {
    const worker = await makeWorker();
    worker.testCallerId = "agent:someone-else";
    await expect(worker.openBridge({})).rejects.toThrow(/does not own this vessel/);
    worker.testCallerKind = "panel";
    worker.testCallerId = "panel:x";
    await expect(worker.openBridge({})).rejects.toThrow(/not a linked bridge/);
  });

  it("replaces the complete bridge generation without letting old cancellation detach the new one", async () => {
    const worker = await makeWorker();
    const first = await openTestBridge(worker, { bridge: "bridge-1" });
    const second = await openTestBridge(worker, { bridge: "bridge-2" });

    await first.records.return();
    expect(await worker.linkedStatus()).toMatchObject({
      attached: true,
      sessionInfo: { bridge: "bridge-2" },
    });
    await second.records.return();
    expect((await worker.linkedStatus()).attached).toBe(false);
  });

  it("buffers addressed input while detached and replays from the turn boundary on attach", async () => {
    const worker = await makeWorker();
    // Detached: addressed message (explicit `to` us) buffers.
    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 10,
        messageId: "m-1",
        senderId: "panel:alice",
        text: "hello agent",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );
    expect(worker.queueRows()).toHaveLength(1);

    // Opening the response replays the pending row after its ACK.
    const bridge = await openTestBridge(worker);
    const replayed = await nextBridgePayload(bridge);
    expect(replayed["content"]).toBe("hello agent");
    const meta = replayed["meta"] as Record<string, unknown>;
    expect(meta["from_handle"]).toBe("alice");
    expect(meta["channel_id"]).toBe("ch-1");
    const replayTurn = worker
      .appendedEvents()
      .find((event) => event["payloadKind"] === "turn.opened")!;
    expect((replayTurn["causality"] as Record<string, unknown>)["messageId"]).toBe("m-1");
    expect(
      worker.appendedEvents().filter((event) => event["payloadKind"] === "message.completed")
    ).toHaveLength(0);

    // Ack + turn boundary (Stop) prunes the queue.
    const seq = Number(replayed["seq"]);
    await worker.ackDelivery({ seq });
    await worker.ingestHookEvent({
      sessionId: "s-1",
      seq: 1,
      event: { hook: "Stop", finalText: "done", turnKey: "turn-1" },
    });
    expect(worker.queueRows()).toHaveLength(0);
  });

  it("clears the installed bridge generation when replay setup fails", async () => {
    const worker = await makeWorker();
    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 10,
        messageId: "m-replay-failure",
        senderId: "panel:alice",
        text: "replay me",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );
    worker.failLogAppend = true;

    const response = await worker.openBridge({ sessionInfo: { bridge: "failed" } });
    let failure: unknown;
    try {
      for await (const _record of readChannelSubscriptionRecords(response)) {
        // Drain until the demand-driven replay reports its failure.
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      expect.objectContaining({ message: "simulated replay append failure" })
    );
    expect(await worker.linkedStatus()).toMatchObject({ attached: false });
    expect(worker.queueRows()).toHaveLength(1);
  });

  it("pages a backlog larger than the response buffer as the bridge drains", async () => {
    const worker = await makeWorker();
    worker.seedBridgeQueue(96, 16_000);

    const response = await worker.openBridge();
    await vi.waitFor(() => expect(worker.bridgeDesiredSize()).toBeLessThanOrEqual(1_024 * 1_024));
    expect(worker.bridgeDesiredSize()).toBeGreaterThanOrEqual(0);

    let messages = 0;
    for await (const record of readChannelSubscriptionRecords(response)) {
      if (record.kind !== "message") continue;
      messages += 1;
      if (messages === 96) break;
    }
    expect(messages).toBe(96);
  });

  it("does not forward un-addressed input in a moderated conversation (addressing gate)", async () => {
    const worker = await makeWorker();
    worker.channelConfig = { conversationPolicy: "moderated" };
    await openTestBridge(worker);

    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 11,
        messageId: "m-2",
        senderId: "panel:alice",
        text: "not for you",
      }) as never
    );
    expect(worker.queueRows()).toHaveLength(0);
  });

  it("does not forward the subagent task seed (delivered out-of-band as the -p prompt)", async () => {
    const worker = await makeWorker();
    await openTestBridge(worker);

    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 12,
        messageId: "subagent-seed:run-1",
        senderId: "do:parent",
        text: "the task",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );
    expect(worker.queueRows()).toHaveLength(0);
  });

  it("does not forward externally-fed webhook input even when explicitly addressed", async () => {
    const worker = await makeWorker();
    await openTestBridge(worker);

    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 12,
        messageId: "m-webhook",
        senderId: "panel:webhook-feed",
        senderMetadata: { handle: "feed", type: "external", source: "webhook-ingress" },
        text: "run this from the webhook",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );

    expect(worker.queueRows()).toHaveLength(0);
  });

  it("refuses addressed input without a canonical source message identity", async () => {
    const worker = await makeWorker();
    const input = completedMessageEvent({
      id: 13,
      messageId: "transport-envelope-only",
      senderId: "panel:alice",
      text: "do not invent my identity",
      to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
    });
    delete (input.payload as { causality?: unknown }).causality;

    await expect(worker.processChannelEvent("ch-1", input as never)).rejects.toThrow(
      /no canonical source message identity/
    );
    expect(worker.queueRows()).toHaveLength(0);
  });

  it("opens a live turn for channel-driven input and groups tool events under it", async () => {
    const worker = await makeWorker();
    const bridge = await openTestBridge(worker, { bridge: "bridge-1" });
    worker.gadCalls.length = 0;

    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 30,
        messageId: "m-channel-turn",
        senderId: "panel:alice",
        text: "please inspect this",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );

    const opened = worker
      .appendedEvents()
      .filter((event) => event["payloadKind"] === "turn.opened");
    expect(opened).toHaveLength(1);
    const openedCausality = opened[0]!["causality"] as Record<string, unknown>;
    const turnId = (openedCausality["turnId"] ?? "").toString();
    expect(turnId).toContain("channel:m-channel-turn");
    expect(openedCausality["messageId"]).toBe("m-channel-turn");
    expect(
      worker.appendedEvents().filter((event) => event["payloadKind"] === "message.completed")
    ).toHaveLength(0);
    const pushed = await nextBridgePayload(bridge);
    expect(pushed["kind"]).toBe("message");

    await worker.ingestHookEvent({
      sessionId: "s-chan",
      seq: 1,
      event: { hook: "PreToolUse", toolName: "Read", toolUseId: "tu-channel" },
    });

    const invocation = worker
      .appendedEvents()
      .find((event) => event["payloadKind"] === "invocation.started")!;
    expect((invocation["causality"] as Record<string, unknown>)["turnId"]).toBe(turnId);

    await worker.ingestHookEvent({
      sessionId: "s-chan",
      seq: 2,
      event: { hook: "Stop", finalText: "done", turnKey: "claude-generated-key" },
    });

    const kinds = worker.appendedEvents().map((event) => event["payloadKind"]);
    expect(kinds.filter((kind) => kind === "turn.opened")).toHaveLength(1);
    const closed = worker.appendedEvents().find((event) => event["payloadKind"] === "turn.closed")!;
    expect((closed["causality"] as Record<string, unknown>)["turnId"]).toBe(turnId);
  });

  it("closes an open turn when its response is cancelled", async () => {
    const worker = await makeWorker();
    const bridge = await openTestBridge(worker, { bridge: "bridge-1" });
    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 31,
        messageId: "m-detach-turn",
        senderId: "panel:alice",
        text: "start this",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );
    worker.gadCalls.length = 0;

    await bridge.records.return();

    const closed = worker.appendedEvents().find((event) => event["payloadKind"] === "turn.closed");
    expect(closed).toBeTruthy();
    expect((await worker.linkedStatus()).attached).toBe(false);
  });

  it("authors idempotent trajectory events from hook reports", async () => {
    const worker = await makeWorker();
    await openTestBridge(worker);

    const prompt = {
      sessionId: "s-1",
      seq: 2,
      event: { hook: "UserPromptSubmit", promptText: "fix the bug", turnKey: "turn-9" } as const,
    };
    await worker.ingestHookEvent(prompt);
    const appended = worker.gadCalls.filter((call) => call.method === "appendLogEvent");
    expect(appended).toHaveLength(1);
    const events = appended[0]!.args["events"] as Array<Record<string, unknown>>;
    expect(events.map((event) => event["payloadKind"])).toEqual([
      "message.completed",
      "turn.opened",
    ]);
    const promptMessageId = String(
      (events[0]!["causality"] as Record<string, unknown>)["messageId"]
    );
    const turnCausality = events[1]!["causality"] as Record<string, unknown>;
    expect(turnCausality["messageId"]).toBe(promptMessageId);
    const turnOpenId = String(events[1]!["envelopeId"]);
    expect(turnOpenId).toMatch(/^turn:t:ch-1:hook:s-1:turn-9:/);

    // Redelivery of the same hook seq is a no-op.
    const duplicate = await worker.ingestHookEvent(prompt);
    expect(duplicate.duplicate).toBe(true);
    expect(worker.gadCalls.filter((call) => call.method === "appendLogEvent")).toHaveLength(1);

    // Tool lifecycle + Stop close the turn with the mirrored final message.
    await worker.ingestHookEvent({
      sessionId: "s-1",
      seq: 3,
      event: {
        hook: "PreToolUse",
        toolName: "Bash",
        toolUseId: "tu-1",
        request: { command: "ls", timeout: 1_000 },
      },
    });
    await worker.ingestHookEvent({
      sessionId: "s-1",
      seq: 4,
      event: { hook: "PostToolUse", toolUseId: "tu-1", ok: true, outputSummary: "ok" },
    });
    await worker.ingestHookEvent({
      sessionId: "s-1",
      seq: 5,
      event: { hook: "Stop", finalText: "all fixed", turnKey: "turn-9" },
    });
    const kinds = worker.gadCalls
      .filter((call) => call.method === "appendLogEvent")
      .flatMap((call) =>
        (call.args["events"] as Array<Record<string, unknown>>).map((event) =>
          String(event["payloadKind"])
        )
      );
    expect(kinds).toEqual([
      "message.completed",
      "turn.opened",
      "invocation.started",
      "invocation.completed",
      "message.completed",
      "turn.closed",
    ]);
    const invocation = worker
      .appendedEvents()
      .find((event) => event["payloadKind"] === "invocation.started")!;
    expect((invocation["payload"] as Record<string, unknown>)["request"]).toEqual({
      command: "ls",
      timeout: 1_000,
    });
    // Mirrored final message is secondary-tier, never say-salient.
    const stopAppend = worker.gadCalls.filter((call) => call.method === "appendLogEvent").at(-1)!;
    const finalMessage = (stopAppend.args["events"] as Array<Record<string, unknown>>).find(
      (event) => event["payloadKind"] === "message.completed"
    )!;
    const payload = finalMessage["payload"] as Record<string, unknown>;
    expect(payload["tier"]).toBe("secondary");
    expect(payload["saliency"]).toBeUndefined();
  });

  it("auto-denies a pending permission on timeout and keeps first-verdict-wins", async () => {
    const worker = await makeWorker();
    const bridge = await openTestBridge(worker);

    await worker.requestPermission({
      requestId: "req-1",
      toolName: "Bash",
      description: "run npm install",
      inputPreview: "npm install",
    });
    expect(worker.permissionRows()[0]!["status"]).toBe("pending");
    // The conversation sees the pending relay as an ephemeral signal.
    expect(worker.signals).toHaveLength(1);

    // Permission expiry is the alarm's only responsibility. Bridge liveness is
    // owned entirely by its response resource.
    const soon = Date.now() + 1_000;
    worker.shrinkPermissionDeadlines(soon);
    await worker.fireLinkedAlarm(soon + 500);
    expect(worker.permissionRows()[0]!["status"]).toBe("deny");
    const verdict = await nextBridgePayload(bridge);
    expect(verdict).toMatchObject({ kind: "permission", behavior: "deny" });

    // A late workspace verdict must not double-settle.
    worker.approvalResolvers.get("req-1")?.({ behavior: "allow" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.permissionRows()[0]!["status"]).toBe("deny");
  });

  it("labels approval requests with the bridge-provided permission capability", async () => {
    const worker = await makeWorker();
    await openTestBridge(worker, {
      bridge: "bridge-1",
      agentKind: "codex",
      permissionCapability: "codex.tool",
    });

    await worker.requestPermission({ requestId: "req-capability", toolName: "Shell" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const request = worker.rpcCall.mock.calls.find(
      (call) => call[1] === "userlandApproval.requestExternal"
    );
    const payload = (request?.[2] as unknown[] | undefined)?.[0] as
      | Record<string, unknown>
      | undefined;
    expect(payload?.["capability"]).toBe("codex.tool");
  });

  it("dedupes repeated permission request ids without creating another approval card", async () => {
    const worker = await makeWorker();
    const bridge = await openTestBridge(worker);

    await worker.requestPermission({ requestId: "req-dupe", toolName: "Bash" });
    const repeat = await worker.requestPermission({ requestId: "req-dupe", toolName: "Bash" });

    expect(repeat).toEqual({ ok: true, pending: true });
    expect(worker.permissionRows()).toHaveLength(1);
    expect(permissionPendingSignals(worker)).toHaveLength(1);
    expect(
      worker.rpcCall.mock.calls.filter((call) => call[1] === "userlandApproval.requestExternal")
    ).toHaveLength(1);

    worker.approvalResolvers.get("req-dupe")?.({ behavior: "allow" });
    expect(await nextBridgePayload(bridge)).toMatchObject({
      kind: "permission",
      requestId: "req-dupe",
      behavior: "allow",
    });

    const afterSettle = await worker.requestPermission({ requestId: "req-dupe", toolName: "Bash" });
    expect(afterSettle).toEqual({ ok: true, pending: false });
    expect(permissionPendingSignals(worker)).toHaveLength(1);
    expect(await nextBridgePayload(bridge)).toMatchObject({
      kind: "permission",
      requestId: "req-dupe",
      behavior: "allow",
      reason: "duplicate-settled",
    });
  });

  it("resolves a relayed permission as answered-at-terminal when the tool proceeds", async () => {
    const worker = await makeWorker();
    await openTestBridge(worker);
    await worker.requestPermission({ requestId: "req-2", toolName: "Bash" });

    await worker.ingestHookEvent({
      sessionId: "s-1",
      seq: 10,
      event: { hook: "PreToolUse", toolName: "Bash", toolUseId: "tu-9" },
    });
    expect(worker.permissionRows()[0]!["status"]).toBe("terminal-answered");
    // The terminal already answered, so the workspace approval is withdrawn.
    expect(
      worker.rpcCall.mock.calls.some((call) => {
        const arg = (call[2] as unknown[] | undefined)?.[0] as { requestId?: string } | undefined;
        return call[1] === "userlandApproval.settleExternal" && arg?.requestId === "req-2";
      })
    ).toBe(true);
  });

  it("only withdraws the oldest pending permission for a matching terminal tool event", async () => {
    const worker = await makeWorker();
    await openTestBridge(worker);
    await worker.requestPermission({ requestId: "req-a", toolName: "Bash" });
    await worker.requestPermission({ requestId: "req-b", toolName: "Bash" });

    await worker.ingestHookEvent({
      sessionId: "s-1",
      seq: 10,
      event: { hook: "PreToolUse", toolName: "Bash", toolUseId: "tu-9" },
    });

    const rows = worker
      .permissionRows()
      .sort((a, b) => String(a["request_id"]).localeCompare(String(b["request_id"])));
    expect(rows.map((row) => [row["request_id"], row["status"]])).toEqual([
      ["req-a", "terminal-answered"],
      ["req-b", "pending"],
    ]);
    const withdrawn = worker.rpcCall.mock.calls.filter((call) => {
      const arg = (call[2] as unknown[] | undefined)?.[0] as { requestId?: string } | undefined;
      return call[1] === "userlandApproval.settleExternal" && arg?.requestId;
    });
    expect(
      withdrawn.map((call) => ((call[2] as unknown[])[0] as { requestId: string }).requestId)
    ).toEqual(["req-a"]);

    worker.approvalResolvers.get("req-a")?.({ behavior: "allow" });
    worker.approvalResolvers.get("req-b")?.({ behavior: "deny" });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("relays prompt/interrupt/status methods and fails closed when detached", async () => {
    const worker = await makeWorker();
    // onMethodCall arrives via the channel DO / server delivery boundary.
    worker.testCallerKind = "server";
    worker.testCallerId = "main";
    // Detached: prompt/interrupt error cleanly.
    const offline = await worker.onMethodCall("ch-1", "tc-1", "prompt", { text: "hi" });
    expect(offline.isError).toBe(true);
    expect(String((offline.result as { error: string }).error)).toMatch(/offline/);

    const bridge = await openTestBridge(worker);
    const queued = await worker.onMethodCall("ch-1", "tc-2", "prompt", { text: "hi" });
    expect(queued.isError).toBeUndefined();
    expect(await nextBridgePayload(bridge)).toMatchObject({ kind: "prompt", content: "hi" });

    const status = await worker.onMethodCall("ch-1", "tc-3", "status", {});
    expect((status.result as { attached: boolean }).attached).toBe(true);

    // Pi-loop standard methods are pruned on the linked vessel.
    const unknown = await worker.onMethodCall("ch-1", "tc-4", "setModel", { model: "x:y" });
    expect(unknown.isError).toBe(true);
  });

  it("clears attachment and bridge state when forked", async () => {
    const worker = await makeWorker();
    await openTestBridge(worker);
    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 20,
        messageId: "m-3",
        senderId: "panel:alice",
        text: "queued",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );
    expect(worker.queueRows()).toHaveLength(1);

    await (
      worker as unknown as {
        onChannelForked(ctx: {
          oldChannelId: string;
          newChannelId: string;
          forkPointPubsubId: number;
        }): Promise<void>;
      }
    ).onChannelForked({ oldChannelId: "ch-1", newChannelId: "ch-2", forkPointPubsubId: 5 });

    expect((await worker.linkedStatus()).attached).toBe(false);
    expect(worker.queueRows()).toHaveLength(0);
  });

  it("settles the run as failed when the headless process exits without complete", async () => {
    const worker = await makeWorker(SUBAGENT_STATE_ARGS);
    worker.testCallerKind = "extension";
    worker.testCallerId = "extension:@workspace-extensions/claude-code";

    const result = await worker.reportExternalExit({ runId: "run-9", code: 1, signal: null });
    expect(result).toEqual({ ok: true, settled: true });
    expect(worker.parentCompletions).toHaveLength(1);
    expect(worker.parentCompletions[0]).toMatchObject({
      target: "do:parent-vessel",
      payload: { runId: "run-9", channelId: "ch-parent", outcome: "failed" },
    });
    expect(String(worker.parentCompletions[0]!.payload["report"])).toContain("exit code 1");

    // A duplicate report no-ops.
    const again = await worker.reportExternalExit({ runId: "run-9", code: 1, signal: null });
    expect(again).toEqual({ ok: true, settled: false });
    expect(worker.parentCompletions).toHaveLength(1);
  });

  it("ignores an exit report after a real complete, without duty, or for a foreign run", async () => {
    const worker = await makeWorker(SUBAGENT_STATE_ARGS);
    // Real completion via the bridge first (agent caller).
    await worker.completeFromBridge({ report: "done", outcome: "success" });
    expect(worker.parentCompletions).toHaveLength(1);

    worker.testCallerKind = "extension";
    worker.testCallerId = "extension:@workspace-extensions/claude-code";
    const afterComplete = await worker.reportExternalExit({ runId: "run-9", code: 0 });
    expect(afterComplete).toEqual({ ok: true, settled: false });
    expect(worker.parentCompletions).toHaveLength(1);

    // Foreign runId on a fresh duty-bearing vessel: refused.
    const other = await makeWorker(SUBAGENT_STATE_ARGS);
    other.testCallerKind = "extension";
    other.testCallerId = "extension:@workspace-extensions/claude-code";
    expect(await other.reportExternalExit({ runId: "run-OTHER", code: 1 })).toEqual({
      ok: true,
      settled: false,
    });
    expect(other.parentCompletions).toHaveLength(0);

    // No subagent duty at all: no-op.
    const plain = await makeWorker();
    plain.testCallerKind = "extension";
    plain.testCallerId = "extension:@workspace-extensions/claude-code";
    expect(await plain.reportExternalExit({ code: 1 })).toEqual({ ok: true, settled: false });
    expect(plain.parentCompletions).toHaveLength(0);
  });
});
