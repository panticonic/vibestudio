import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { AGENTIC_EVENT_PAYLOAD_KIND, AGENTIC_PROTOCOL_VERSION } from "@workspace/agentic-protocol";
import { readChannelSubscriptionRecords } from "@workspace/pubsub";

import { LinkedAgentWorker } from "./linked-agent-worker.js";
import * as workerEntry from "./index.js";

const ENTITY = "session-entity-1";
const OBJECT_KEY = ENTITY; // vessel is keyed by the entity it serves

describe("linked-agent worker entry", () => {
  it("exports only workerd handler/class values at runtime", () => {
    expect(Object.keys(workerEntry).sort()).toEqual(["LinkedAgentWorker", "default"]);
  });
});

class TestableLinkedAgentWorker extends LinkedAgentWorker {
  static override schemaVersion = LinkedAgentWorker.schemaVersion;

  testCallerId: string | null = `agent:${ENTITY}`;
  testCallerKind: string | null = "agent";

  readonly gadCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
  readonly published: Array<{ event: unknown }> = [];
  readonly signals: Array<{ event: unknown }> = [];
  failLogAppend = false;
  appendBarrier: Promise<void> | null = null;

  channelConfig: Record<string, unknown> | null = null;

  protected override get rpcCallerId(): string | null {
    return this.testCallerId;
  }
  protected override get rpcCallerKind(): string | null {
    return this.testCallerKind;
  }

  readonly rpcCall = vi.fn(async (target: string, method: string, args: unknown[]) => {
    if (target === "main" && method === "vcs.status") {
      const contextId = String(
        (args[0] as { contextId?: unknown } | undefined)?.contextId ?? "ctx-1"
      );
      return {
        contextId,
        clean: true,
        committed: { kind: "event", eventId: "child-source-event" },
        workingHead: { kind: "event", eventId: "child-source-event" },
        mainEventId: "main-source-event",
        mainRelation: "ahead",
        workingCounts: { applications: 0, workUnits: 0, changes: 0 },
        integrating: [],
      };
    }
    if (target === "main" && method === "contextIntegrity.ingest") {
      return { class: "internal", latchEpoch: 0, externalKeys: [] };
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
      await this.appendBarrier;
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
      relationshipState: async () => ({ revision: 0, active: false }),
      join: async (input: { participantId: string }) => ({
        ok: true,
        participantId: input.participantId,
      }),
      leave: async () => undefined,
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
    const participantId = this.selfParticipantId();
    this.sql.exec(
      `INSERT OR REPLACE INTO subscriptions
         (channel_id, context_id, revision, subscribed_at, config, relationship_json, participant_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      channelId,
      "ctx-1",
      1,
      Date.now(),
      null,
      JSON.stringify({ test: true }),
      participantId
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

  attemptRows(): Array<Record<string, unknown>> {
    return this.sql.exec(`SELECT * FROM linked_delivery_attempts ORDER BY offered_at`).toArray();
  }

  batchRows(): Array<Record<string, unknown>> {
    return this.sql.exec(`SELECT * FROM linked_delivery_batches ORDER BY created_at`).toArray();
  }

  hookRows(): Array<Record<string, unknown>> {
    return this.sql.exec(`SELECT * FROM linked_hook_seqs ORDER BY session_id, seq`).toArray();
  }

  bridgeSessionRows(): Array<Record<string, unknown>> {
    return this.sql.exec(`SELECT * FROM linked_bridge_sessions ORDER BY created_at`).toArray();
  }

  terminalIntentRows(): Array<Record<string, unknown>> {
    return this.sql
      .exec(
        `SELECT wake_id, channel_id, wake_kind, payload_json, disposition
           FROM agent_wake_queue
          WHERE wake_kind = 'subagent-terminal-publish'
          ORDER BY created_at`
      )
      .toArray();
  }

  migrateLegacyForTest(): void {
    this.setStateValue("linked:deliverySchema", "");
    this.setStateValue("linked:ackSeq", "8");
    this.setStateValue("linked:processedSeq", "7");
    (this as unknown as { migrateLegacyDeliveryState(): void }).migrateLegacyDeliveryState();
  }

  legacyCursorForTest(key: string): string | null {
    return this.getStateValue(key);
  }

  seedTerminalReceiptsForTest(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const seq = Number(
        this.sql
          .exec(
            `INSERT INTO linked_bridge_queue
           (dedupe_key, kind, channel_id, payload, created_at,
            terminal_outcome, terminal_at, terminal_turn_id)
         VALUES (?, 'message', 'ch-1', '{}', ?, 'completed', ?, ?)
         RETURNING seq`,
            `terminal:${index}`,
            index,
            index,
            `turn-${index}`
          )
          .toArray()[0]?.["seq"]
      );
      this.sql.exec(
        `INSERT INTO linked_delivery_batches
           (batch_id, bridge_session_id, turn_id, opened_at, opened_published_at,
            outcome, terminal_at, terminal_published_at, created_at)
         VALUES (?, 'receipt-session', ?, ?, ?, 'completed', ?, ?, ?)`,
        `receipt-batch-${index}`,
        `turn-${index}`,
        index,
        index,
        index,
        index,
        index
      );
      this.sql.exec(
        `INSERT INTO linked_delivery_attempts
           (delivery_id, seq, bridge_session_id, attachment_generation,
            offered_at, accepted_at, batch_id, superseded_at)
         VALUES (?, ?, 'receipt-session', 'receipt-generation', ?, ?, ?, NULL)`,
        `receipt-delivery-${index}`,
        seq,
        index,
        index,
        `receipt-batch-${index}`
      );
    }
    (this as unknown as { compactTerminalReceipts(): void }).compactTerminalReceipts();
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

  async processSubscriptionReplayEventForTest(
    channelId: string,
    event: ReturnType<typeof completedMessageEvent>
  ): Promise<void> {
    await (
      this as unknown as {
        processSubscriptionReplayEvent(channelId: string, event: unknown): Promise<void>;
      }
    ).processSubscriptionReplayEvent(channelId, event);
  }

  async deliverDurableChannelEventForTest(
    channelId: string,
    event: ReturnType<typeof completedMessageEvent>
  ): Promise<void> {
    this.ensureIdentity();
    try {
      await this.acceptChannelDelivery({
        deliveryId: `test:${event.messageId}`,
        channelId,
        channelRef: {
          source: "workers/pubsub-channel",
          className: "PubSubChannel",
          objectKey: channelId,
        },
        participantId: this.participantId(),
        subscriptionRevision: 1,
        eventSequence: event.id,
        envelope: { kind: "log", phase: "live", event } as never,
        agenticContext: {
          version: 1,
          relationships: [
            {
              participantId: this.participantId(),
              metadata: { name: "Linked", type: "agent" },
              applicationConfig: null,
            },
          ],
          channelConfig: {},
          conversation: {
            lastCompletedSender: null,
            lastCompletedMessageId: null,
            lastCompletedSeq: null,
            previousCompletedSender: null,
            previousCompletedMessageId: null,
            previousCompletedSeq: null,
            agentStreak: 0,
          },
          replyToSenderId: null,
        },
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "markWorkReady requires an active Durable Object request"
      ) {
        throw error;
      }
    }
  }

  appendedEvents(): Array<Record<string, unknown>> {
    return this.gadCalls
      .filter((call) => call.method === "appendLogEvent")
      .flatMap((call) => call.args["events"] as Array<Record<string, unknown>>);
  }
}

type BridgeAck = {
  ok: boolean;
  bridgeSessionId: string;
  attachmentGeneration: string;
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
  sessionInfo: Record<string, unknown> = {},
  bridgeSessionId = "bridge-session-1"
): Promise<TestBridge> {
  const response = await worker.openBridge({ bridgeSessionId, sessionInfo });
  const records = readChannelSubscriptionRecords<BridgeAck, Record<string, unknown>>(response);
  const first = await records.next();
  if (first.done || first.value.kind !== "subscribed") {
    throw new Error("linked bridge did not start with its subscription ACK");
  }
  return { ack: first.value.result, records };
}

async function acceptBridgePayload(
  worker: TestableLinkedAgentWorker,
  bridge: TestBridge,
  payload: Record<string, unknown>,
  batchId: string
): Promise<void> {
  await worker.acceptDelivery({
    bridgeSessionId: bridge.ack.bridgeSessionId,
    attachmentGeneration: bridge.ack.attachmentGeneration,
    deliveryId: String(payload["deliveryId"]),
    batchId,
  });
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
    externalControllerCallerId: "@workspace-extensions/claude-code",
    subagent: {
      runId: "run-9",
      task: "Audit the linked-agent supervision path.",
      parentRef: "do:parent-vessel",
      parentChannelId: "ch-parent",
      taskChannelId: "ch-1",
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
  contentClass?: "internal" | "external";
  externalKeys?: string[];
}) {
  return {
    id: opts.id,
    messageId: opts.messageId,
    type: AGENTIC_EVENT_PAYLOAD_KIND,
    senderId: opts.senderId,
    senderMetadata: opts.senderMetadata ?? { handle: "alice", type: "panel" },
    contentClass: opts.contentClass ?? "internal",
    externalKeys: opts.externalKeys ?? [],
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
    await expect(worker.openBridge({ bridgeSessionId: "foreign-1" })).rejects.toThrow(
      /does not own this vessel/
    );
    worker.testCallerKind = "panel";
    worker.testCallerId = "panel:x";
    await expect(worker.openBridge({ bridgeSessionId: "foreign-2" })).rejects.toThrow(
      /not a linked bridge/
    );
  });

  it("replaces the complete bridge generation without letting old cancellation detach the new one", async () => {
    const worker = await makeWorker();
    const first = await openTestBridge(worker, { bridge: "bridge-1" }, "same-process");
    const second = await openTestBridge(worker, { bridge: "bridge-2" }, "same-process");

    await first.records.return();
    expect(await worker.linkedStatus()).toMatchObject({
      attached: true,
      sessionInfo: { bridge: "bridge-2" },
    });
    await second.records.return();
    expect((await worker.linkedStatus()).attached).toBe(false);
  });

  it("replays surviving input and terminalizes only its exact accepted batch", async () => {
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
    expect(
      worker.appendedEvents().filter((event) => event["payloadKind"] === "turn.opened")
    ).toHaveLength(0);

    await acceptBridgePayload(worker, bridge, replayed, "batch-1");
    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 1,
      batchId: "batch-1",
      event: { hook: "Stop", finalText: "done", turnKey: "turn-1" },
    });
    expect(worker.queueRows()).toHaveLength(1);
    expect(worker.queueRows()[0]).toMatchObject({
      payload: "{}",
      terminal_outcome: "completed",
    });
    expect((await worker.linkedStatus()).pendingCount).toBe(0);
  });

  it("migrates legacy watermarks by replaying every surviving row", async () => {
    const worker = await makeWorker();
    worker.seedBridgeQueue(2, 8);
    worker.migrateLegacyForTest();
    expect(worker.legacyCursorForTest("linked:ackSeq")).toBe("");
    expect(worker.legacyCursorForTest("linked:processedSeq")).toBe("");

    const bridge = await openTestBridge(worker, {}, "post-migration-session");
    expect(bridge.ack.pendingCount).toBe(2);
    expect((await nextBridgePayload(bridge))["content"]).toBe("xxxxxxxx");
    expect((await nextBridgePayload(bridge))["content"]).toBe("xxxxxxxx");
  });

  it("binds transport acceptance to one attachment and replays only into a new process session", async () => {
    const worker = await makeWorker();
    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 11,
        messageId: "m-recovery",
        senderId: "panel:alice",
        text: "recover me",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );
    const first = await openTestBridge(worker, {}, "live-process-session");
    const payload = await nextBridgePayload(first);
    await acceptBridgePayload(worker, first, payload, "batch-recovery");
    await expect(
      worker.acceptDelivery({
        bridgeSessionId: first.ack.bridgeSessionId,
        attachmentGeneration: "stale-generation",
        deliveryId: String(payload["deliveryId"]),
        batchId: "batch-recovery",
      })
    ).rejects.toThrow(/stale bridge attachment/);

    const recovered = await openTestBridge(worker, {}, "live-process-session");
    expect(recovered.ack.pendingCount).toBe(0);
    const replacement = await openTestBridge(worker, {}, "new-process-session");
    expect(replacement.ack.pendingCount).toBe(1);
    const replayed = await nextBridgePayload(replacement);
    expect(replayed["deliveryId"]).not.toBe(payload["deliveryId"]);
  });

  it("caps superseded delivery attempts and ended hook-session receipts", async () => {
    const worker = await makeWorker();
    worker.seedBridgeQueue(1, 8);
    for (let index = 0; index < 7; index += 1) {
      const bridge = await openTestBridge(worker, {}, `attempt-session-${index}`);
      await nextBridgePayload(bridge);
    }
    expect(worker.attemptRows().length).toBeLessThanOrEqual(5);

    for (let index = 0; index < 10; index += 1) {
      const bridgeSessionId = `ended-hook-session-${index}`;
      await worker.ingestHookEvent({
        bridgeSessionId,
        seq: 1,
        event: { hook: "SessionStart" },
      });
      await worker.ingestHookEvent({
        bridgeSessionId,
        seq: 2,
        event: { hook: "SessionEnd" },
      });
    }
    expect(worker.bridgeSessionRows().filter((row) => row["ended_at"] != null)).toHaveLength(8);
    expect(
      new Set(worker.hookRows().map((row) => String(row["session_id"]))).size
    ).toBeLessThanOrEqual(8);
  });

  it("groups several accepted messages into one terminal turn without advancing a newer busy batch", async () => {
    const worker = await makeWorker();
    const bridge = await openTestBridge(worker, {}, "busy-session");
    for (const [id, messageId] of [
      [20, "m-busy-1"],
      [21, "m-busy-2"],
    ] as const) {
      await worker.processChannelEvent(
        "ch-1",
        completedMessageEvent({
          id,
          messageId,
          senderId: "panel:alice",
          text: messageId,
          to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
        }) as never
      );
    }
    const first = await nextBridgePayload(bridge);
    const second = await nextBridgePayload(bridge);
    await acceptBridgePayload(worker, bridge, first, "batch-busy-1");
    await acceptBridgePayload(worker, bridge, second, "batch-busy-1");
    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 1,
      batchId: "batch-busy-1",
      event: { hook: "PreToolUse", toolName: "Read", toolUseId: "busy-tool" },
    });

    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 22,
        messageId: "m-busy-next",
        senderId: "panel:alice",
        text: "next",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );
    const third = await nextBridgePayload(bridge);
    await acceptBridgePayload(worker, bridge, third, "batch-busy-2");
    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 2,
      batchId: "batch-busy-1",
      event: { hook: "Stop", turnKey: "busy-turn" },
    });

    const rows = worker.queueRows();
    expect(rows.filter((row) => row["terminal_outcome"] === "completed")).toHaveLength(2);
    expect(rows.filter((row) => row["terminal_at"] == null)).toHaveLength(1);
    expect((await worker.linkedStatus()).pendingCount).toBe(1);
  });

  it("retains a finite terminal receipt window after publishing canonical trajectory", async () => {
    const worker = await makeWorker();
    worker.seedTerminalReceiptsForTest(300);
    expect(worker.queueRows()).toHaveLength(256);
    expect(worker.queueRows()[0]?.["dedupe_key"]).toBe("terminal:44");
  });

  it("clears the installed bridge generation when replay setup fails", async () => {
    const worker = await makeWorker();
    worker.seedBridgeQueue(1, 1_100_000);

    const response = await worker.openBridge({
      bridgeSessionId: "failed-session",
      sessionInfo: { bridge: "failed" },
    });
    let failure: unknown;
    try {
      for await (const _record of readChannelSubscriptionRecords(response)) {
        // Drain until the demand-driven replay reports its failure.
      }
    } catch (error) {
      failure = error;
    }
    expect(failure).toEqual(
      expect.objectContaining({ message: expect.stringMatching(/exceeds the response buffer/) })
    );
    expect(await worker.linkedStatus()).toMatchObject({ attached: false });
    expect(worker.queueRows()).toHaveLength(1);
  });

  it("pages a backlog larger than the response buffer as the bridge drains", async () => {
    const worker = await makeWorker();
    worker.seedBridgeQueue(96, 16_000);

    const response = await worker.openBridge({ bridgeSessionId: "backlog-session" });
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

  it("blocks sealed external input even when its display metadata looks benign", async () => {
    const worker = await makeWorker();
    await openTestBridge(worker);

    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 12,
        messageId: "m-webhook",
        senderId: "panel:alice",
        senderMetadata: { handle: "alice", type: "panel", displayName: "Alice" },
        text: "run this from the webhook",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
        contentClass: "external",
        externalKeys: ["web:example.test"],
      }) as never
    );

    expect(worker.queueRows()).toHaveLength(0);
  });

  it("admits sealed internal input despite forged external-looking presentation metadata", async () => {
    const worker = await makeWorker();
    const event = completedMessageEvent({
      id: 13,
      messageId: "m-internal-forged-display",
      senderId: "panel:alice",
      senderMetadata: { handle: "feed", type: "external", source: "webhook-ingress" },
      text: "ordinary internal input",
      to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      annotations: { metadata: { ingress: "webhook-ingress" } },
    });
    const agentic = event.payload as {
      actor: { kind: string; metadata?: Record<string, unknown> };
      payload: { metadata?: Record<string, unknown> };
    };
    agentic.actor.kind = "external";
    agentic.actor.metadata = { webhook: true };
    agentic.payload.metadata = { provenance: "external" };

    await worker.processChannelEvent("ch-1", event as never);

    expect(worker.queueRows()).toHaveLength(1);
  });

  it.each([
    ["missing class", { contentClass: undefined, externalKeys: [] }],
    ["unknown class", { contentClass: "untrusted", externalKeys: [] }],
    ["missing keys", { contentClass: "internal", externalKeys: undefined }],
    ["non-string key", { contentClass: "external", externalKeys: [7] }],
    ["internal lineage", { contentClass: "internal", externalKeys: ["web:example.test"] }],
  ])("rejects %s provenance instead of guessing from payload metadata", async (_label, patch) => {
    const worker = await makeWorker();
    const event = completedMessageEvent({
      id: 14,
      messageId: "m-malformed-provenance",
      senderId: "panel:alice",
      text: "do not classify me heuristically",
      to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
    }) as Record<string, unknown>;
    Object.assign(event, patch);

    await expect(worker.processChannelEvent("ch-1", event as never)).rejects.toThrow(
      /missing valid durable content provenance/
    );
    expect(worker.queueRows()).toHaveLength(0);
  });

  it("preserves the same sealed provenance through live and subscription-replay admission", async () => {
    const liveWorker = await makeWorker();
    const replayWorker = await makeWorker();
    const event = completedMessageEvent({
      id: 15,
      messageId: "m-sealed-replay",
      senderId: "panel:alice",
      senderMetadata: { handle: "feed", source: "webhook-ingress" },
      text: "sealed internal message",
      to: [{ kind: "participant", participantId: liveWorker.selfParticipantId() }],
      contentClass: "internal",
      externalKeys: [],
    });
    await liveWorker.deliverDurableChannelEventForTest("ch-1", event);
    await replayWorker.processSubscriptionReplayEventForTest("ch-1", event);

    expect(liveWorker.queueRows()).toHaveLength(1);
    expect(replayWorker.queueRows()).toHaveLength(1);
    expect(replayWorker.queueRows()[0]?.["payload"]).toBe(liveWorker.queueRows()[0]?.["payload"]);
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

  it("opens a channel turn only after accepted input reaches hook activity", async () => {
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

    const pushed = await nextBridgePayload(bridge);
    expect(pushed["kind"]).toBe("message");
    expect(worker.appendedEvents()).toHaveLength(0);
    await acceptBridgePayload(worker, bridge, pushed, "batch-channel");

    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 1,
      batchId: "batch-channel",
      event: { hook: "PreToolUse", toolName: "Read", toolUseId: "tu-channel" },
    });

    const opened = worker
      .appendedEvents()
      .filter((event) => event["payloadKind"] === "turn.opened");
    expect(opened).toHaveLength(1);
    const openedCausality = opened[0]!["causality"] as Record<string, unknown>;
    const turnId = String(openedCausality["turnId"]);
    expect(openedCausality["messageId"]).toBe("m-channel-turn");

    const invocation = worker
      .appendedEvents()
      .find((event) => event["payloadKind"] === "invocation.started")!;
    expect((invocation["causality"] as Record<string, unknown>)["turnId"]).toBe(turnId);

    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 2,
      batchId: "batch-channel",
      event: { hook: "Stop", finalText: "done", turnKey: "claude-generated-key" },
    });

    const kinds = worker.appendedEvents().map((event) => event["payloadKind"]);
    expect(kinds.filter((kind) => kind === "turn.opened")).toHaveLength(1);
    const closed = worker.appendedEvents().find((event) => event["payloadKind"] === "turn.closed")!;
    expect((closed["causality"] as Record<string, unknown>)["turnId"]).toBe(turnId);
  });

  it("does not fabricate a terminal turn when its response is cancelled", async () => {
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
    const pushed = await nextBridgePayload(bridge);
    await acceptBridgePayload(worker, bridge, pushed, "batch-detach");
    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 1,
      batchId: "batch-detach",
      event: { hook: "PreToolUse", toolName: "Read", toolUseId: "tool-detach" },
    });
    worker.gadCalls.length = 0;

    await bridge.records.return();

    expect(worker.appendedEvents()).toHaveLength(0);
    expect((await worker.linkedStatus()).attached).toBe(false);
    expect((await worker.linkedStatus()).pendingCount).toBe(1);
  });

  it("authors idempotent trajectory events from hook reports", async () => {
    const worker = await makeWorker();
    await openTestBridge(worker);

    const prompt = {
      bridgeSessionId: "bridge-session-1",
      seq: 1,
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
    expect(turnOpenId).toMatch(/^turn:t:ch-1:hook:bridge-session-1:turn-9:/);

    // Redelivery of the same hook seq is a no-op.
    const duplicate = await worker.ingestHookEvent(prompt);
    expect(duplicate.duplicate).toBe(true);
    expect(worker.gadCalls.filter((call) => call.method === "appendLogEvent")).toHaveLength(1);

    // Tool lifecycle + Stop close the turn with the mirrored final message.
    await worker.ingestHookEvent({
      bridgeSessionId: "bridge-session-1",
      seq: 2,
      event: {
        hook: "PreToolUse",
        toolName: "Bash",
        toolUseId: "tu-1",
        request: { command: "ls", timeout: 1_000 },
      },
    });
    await worker.ingestHookEvent({
      bridgeSessionId: "bridge-session-1",
      seq: 3,
      event: { hook: "PostToolUse", toolUseId: "tu-1", outputSummary: "ok" },
    });
    await worker.ingestHookEvent({
      bridgeSessionId: "bridge-session-1",
      seq: 4,
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

  it("fails closed on hook gaps and same-sequence drift", async () => {
    const worker = await makeWorker();
    await worker.ingestHookEvent({
      bridgeSessionId: "hook-order-session",
      seq: 1,
      event: { hook: "SessionStart", model: "Opus" },
    });
    await expect(
      worker.ingestHookEvent({
        bridgeSessionId: "hook-order-session",
        seq: 3,
        event: { hook: "SessionEnd" },
      })
    ).rejects.toThrow(/expected sequence 2/);
    await expect(
      worker.ingestHookEvent({
        bridgeSessionId: "hook-order-session",
        seq: 1,
        event: { hook: "SessionStart", model: "Sonnet" },
      })
    ).rejects.toThrow(/payload drift/);
  });

  it("joins a concurrent exact hook replay while its durable application is pending", async () => {
    const worker = await makeWorker();
    let release!: () => void;
    worker.appendBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = {
      bridgeSessionId: "concurrent-hook-session",
      seq: 1,
      event: { hook: "SessionStart", model: "Opus" } as const,
    };
    const first = worker.ingestHookEvent(hook);
    await vi.waitFor(() => expect(worker.gadCalls).toHaveLength(1));
    const replay = worker.ingestHookEvent(hook);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(worker.gadCalls).toHaveLength(1);
    release();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(replay).resolves.toEqual({ ok: true, duplicate: true });
  });

  it("authors exact tool and turn failure receipts without terminalizing unrelated input", async () => {
    const worker = await makeWorker();
    const bridge = await openTestBridge(worker, {}, "failure-session");
    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 41,
        messageId: "m-failure",
        senderId: "panel:alice",
        text: "fail exactly",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );
    const payload = await nextBridgePayload(bridge);
    await acceptBridgePayload(worker, bridge, payload, "batch-failure");
    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 1,
      batchId: "batch-failure",
      event: { hook: "PreToolUse", toolName: "Bash", toolUseId: "tool-failure" },
    });
    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 2,
      batchId: "batch-failure",
      event: {
        hook: "PostToolUseFailure",
        toolName: "Bash",
        toolUseId: "tool-failure",
        error: "permission denied",
      },
    });
    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 3,
      batchId: "batch-failure",
      event: {
        hook: "StopFailure",
        error: "authentication_failed",
        errorDetails: "credential rejected",
        turnKey: "failure-turn",
      },
    });
    expect(worker.appendedEvents().map((event) => event["payloadKind"])).toContain(
      "invocation.failed"
    );
    expect(worker.queueRows()[0]).toMatchObject({ terminal_outcome: "failed", payload: "{}" });
  });

  it("redrives a persisted terminal transition before the next hook after publication fails", async () => {
    const worker = await makeWorker();
    const bridge = await openTestBridge(worker, {}, "terminal-replay-session");
    await worker.processChannelEvent(
      "ch-1",
      completedMessageEvent({
        id: 42,
        messageId: "m-terminal-replay",
        senderId: "panel:alice",
        text: "finish durably",
        to: [{ kind: "participant", participantId: worker.selfParticipantId() }],
      }) as never
    );
    const payload = await nextBridgePayload(bridge);
    await acceptBridgePayload(worker, bridge, payload, "batch-terminal-replay");
    await worker.ingestHookEvent({
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 1,
      batchId: "batch-terminal-replay",
      event: { hook: "PreToolUse", toolName: "Read", toolUseId: "tool-replay" },
    });
    worker.failLogAppend = true;
    const terminal = {
      bridgeSessionId: bridge.ack.bridgeSessionId,
      seq: 2,
      batchId: "batch-terminal-replay",
      event: { hook: "Stop", finalText: "done", turnKey: "terminal-replay" } as const,
    };
    await expect(worker.ingestHookEvent(terminal)).rejects.toThrow(/simulated replay/);
    expect(worker.queueRows()[0]).toMatchObject({ terminal_outcome: "completed" });
    expect(worker.queueRows()[0]?.["payload"]).not.toBe("{}");

    worker.failLogAppend = false;
    await expect(
      worker.ingestHookEvent({
        bridgeSessionId: bridge.ack.bridgeSessionId,
        seq: 3,
        event: { hook: "SessionEnd" },
      })
    ).resolves.toEqual({ ok: true });
    expect(worker.queueRows()[0]?.["payload"]).toBe("{}");
    const terminalIds = worker.gadCalls
      .filter((call) => call.method === "appendLogEvent")
      .flatMap((call) => call.args["events"] as Array<Record<string, unknown>>)
      .filter((event) => event["payloadKind"] === "turn.closed")
      .map((event) => event["envelopeId"]);
    expect(terminalIds).toHaveLength(2);
    expect(new Set(terminalIds).size).toBe(1);
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
    worker.testCallerId = "@workspace-extensions/claude-code";

    const result = await worker.reportExternalExit({ runId: "run-9", code: 1, signal: null });
    expect(result).toEqual({ ok: true, settled: true });
    expect(worker.terminalIntentRows()).toHaveLength(1);
    expect(JSON.parse(String(worker.terminalIntentRows()[0]!["payload_json"]))).toMatchObject({
      runId: "run-9",
      taskChannelId: "ch-1",
      parentRef: "do:parent-vessel",
      outcome: "failed",
      sourceEventId: "child-source-event",
    });
    expect(String(worker.terminalIntentRows()[0]!["payload_json"])).toContain("exit code 1");

    // A duplicate report no-ops.
    const again = await worker.reportExternalExit({ runId: "run-9", code: 1, signal: null });
    expect(again).toEqual({ ok: true, settled: false });
    expect(worker.terminalIntentRows()).toHaveLength(1);
  });

  it("settles a typed supervised result and rejects a foreign controller", async () => {
    const worker = await makeWorker(SUBAGENT_STATE_ARGS);
    worker.testCallerKind = "extension";
    worker.testCallerId = "@workspace-extensions/claude-code";

    expect(
      await worker.reportExternalResult({
        runId: "run-9",
        code: 0,
        outcome: "success",
        report: "audit complete",
      })
    ).toEqual({ ok: true, settled: true });
    expect(JSON.parse(String(worker.terminalIntentRows()[0]!["payload_json"]))).toMatchObject({
      runId: "run-9",
      outcome: "completed",
      report: "audit complete",
    });
    expect(
      await worker.reportExternalResult({
        runId: "run-9",
        code: 0,
        outcome: "success",
        report: "duplicate",
      })
    ).toEqual({ ok: true, settled: false });

    const foreign = await makeWorker(SUBAGENT_STATE_ARGS);
    foreign.testCallerKind = "extension";
    foreign.testCallerId = "@workspace-extensions/not-the-controller";
    await expect(
      foreign.reportExternalResult({ runId: "run-9", outcome: "success", report: "forged" })
    ).rejects.toThrow(/is not controller/);
    expect(foreign.terminalIntentRows()).toHaveLength(0);
  });

  it("ignores an exit report after a real complete or for a foreign run", async () => {
    const worker = await makeWorker(SUBAGENT_STATE_ARGS);
    // Real completion via the bridge first (agent caller).
    await worker.completeFromBridge({ report: "done", outcome: "success" });
    expect(worker.terminalIntentRows()).toHaveLength(1);

    worker.testCallerKind = "extension";
    worker.testCallerId = "@workspace-extensions/claude-code";
    const afterComplete = await worker.reportExternalExit({ runId: "run-9", code: 0 });
    expect(afterComplete).toEqual({ ok: true, settled: false });
    expect(worker.terminalIntentRows()).toHaveLength(1);

    // Foreign runId on a fresh duty-bearing vessel: refused.
    const other = await makeWorker(SUBAGENT_STATE_ARGS);
    other.testCallerKind = "extension";
    other.testCallerId = "@workspace-extensions/claude-code";
    expect(await other.reportExternalExit({ runId: "run-OTHER", code: 1 })).toEqual({
      ok: true,
      settled: false,
    });
    expect(other.terminalIntentRows()).toHaveLength(0);
  });
});
