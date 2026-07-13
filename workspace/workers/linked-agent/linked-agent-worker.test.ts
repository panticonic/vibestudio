import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { AGENTIC_EVENT_PAYLOAD_KIND, AGENTIC_PROTOCOL_VERSION } from "@workspace/agentic-protocol";

import {
  LinkedAgentWorker,
  LINKED_HEARTBEAT_TIMEOUT_MS,
  LINKED_PERMISSION_TIMEOUT_MS,
} from "./linked-agent-worker.js";

const ENTITY = "session-entity-1";
const OBJECT_KEY = ENTITY; // vessel is keyed by the entity it serves

class TestableLinkedAgentWorker extends LinkedAgentWorker {
  static override schemaVersion = LinkedAgentWorker.schemaVersion;

  testCallerId: string | null = `agent:${ENTITY}`;
  testCallerKind: string | null = "agent";

  readonly emitted: Array<{ target: string; event: string; payload: Record<string, unknown> }> = [];
  readonly gadCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
  readonly published: Array<{ event: unknown }> = [];
  readonly signals: Array<{ event: unknown }> = [];
  /** Pending workspace-approval resolvers, keyed by requestId. */
  readonly approvalResolvers = new Map<string, (verdict: { behavior: string }) => void>();
  /** onSubagentComplete relays to the parent vessel. */
  readonly parentCompletions: Array<{ target: string; payload: Record<string, unknown> }> = [];

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
      emit: async (target: string, event: string, payload: Record<string, unknown>) => {
        this.emitted.push({ target, event, payload });
      },
    } as never;
  }

  protected override async callGad<T>(method: string, ...args: unknown[]): Promise<T> {
    this.gadCalls.push({ method, args: (args[0] ?? {}) as Record<string, unknown> });
    if (method === "appendLogEvent") {
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
      subscribe: async () => ({ ok: true }),
      unsubscribe: async () => undefined,
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
  it("attaches, heartbeats, and detaches on heartbeat timeout", async () => {
    const worker = await makeWorker();
    const result = await worker.attach({ sessionInfo: { host: "laptop" } });
    expect(result.ok).toBe(true);
    expect(result.primaryChannelId).toBe("ch-1");
    expect((await worker.linkedStatus()).attached).toBe(true);

    await worker.heartbeat();
    // Not yet expired: alarm before the deadline does nothing.
    await worker.fireLinkedAlarm(Date.now() + LINKED_HEARTBEAT_TIMEOUT_MS - 5_000);
    expect((await worker.linkedStatus()).attached).toBe(true);

    await worker.fireLinkedAlarm(Date.now() + LINKED_HEARTBEAT_TIMEOUT_MS + 5_000);
    expect((await worker.linkedStatus()).attached).toBe(false);
    // Detach notice pushed to the (now former) bridge.
    expect(worker.emitted.some((entry) => entry.payload["kind"] === "detach")).toBe(true);
  });

  it("rejects attach from a foreign agent credential", async () => {
    const worker = await makeWorker();
    worker.testCallerId = "agent:someone-else";
    await expect(worker.attach({})).rejects.toThrow(/does not own this vessel/);
    worker.testCallerKind = "panel";
    worker.testCallerId = "panel:x";
    await expect(worker.attach({})).rejects.toThrow(/not a linked bridge/);
  });

  it("rejects a second active bridge on the same credential", async () => {
    const worker = await makeWorker();
    await worker.attach({ sessionInfo: { bridge: "bridge-1" } });

    await expect(worker.attach({ sessionInfo: { bridge: "bridge-2" } })).rejects.toThrow(
      /already attached/
    );

    const refreshed = await worker.attach({ sessionInfo: { bridge: "bridge-1" } });
    expect(refreshed.ok).toBe(true);
  });

  it("buffers addressed input while detached and replays from the turn boundary on attach", async () => {
    const worker = await makeWorker();
    // Detached: addressed message (explicit `to` us) buffers, no emit.
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
    expect(worker.emitted.filter((entry) => entry.event === "linked-agent:event")).toHaveLength(0);

    // Attach replays the pending row to the bridge.
    await worker.attach({});
    const replayed = worker.emitted.filter(
      (entry) => entry.event === "linked-agent:event" && entry.payload["kind"] === "message"
    );
    expect(replayed).toHaveLength(1);
    expect(replayed[0]!.payload["content"]).toBe("hello agent");
    const meta = replayed[0]!.payload["meta"] as Record<string, unknown>;
    expect(meta["from_handle"]).toBe("alice");
    expect(meta["channel_id"]).toBe("ch-1");

    // Ack + turn boundary (Stop) prunes the queue.
    const seq = Number(replayed[0]!.payload["seq"]);
    await worker.ackDelivery({ seq });
    await worker.ingestHookEvent({
      sessionId: "s-1",
      seq: 1,
      event: { hook: "Stop", finalText: "done", turnKey: "turn-1" },
    });
    expect(worker.queueRows()).toHaveLength(0);
  });

  it("does not forward un-addressed input in a moderated conversation (addressing gate)", async () => {
    const worker = await makeWorker();
    worker.channelConfig = { conversationPolicy: "moderated" };
    await worker.attach({});
    worker.emitted.length = 0;

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
    expect(worker.emitted.filter((entry) => entry.event === "linked-agent:event")).toHaveLength(0);
  });

  it("does not forward the subagent task seed (delivered out-of-band as the -p prompt)", async () => {
    const worker = await makeWorker();
    await worker.attach({});
    worker.emitted.length = 0;

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
    expect(worker.emitted.filter((entry) => entry.event === "linked-agent:event")).toHaveLength(0);
  });

  it("does not forward externally-fed webhook input even when explicitly addressed", async () => {
    const worker = await makeWorker();
    await worker.attach({});
    worker.emitted.length = 0;

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
    expect(worker.emitted.filter((entry) => entry.event === "linked-agent:event")).toHaveLength(0);
  });

  it("opens a live turn for channel-driven input and groups tool events under it", async () => {
    const worker = await makeWorker();
    await worker.attach({ sessionInfo: { bridge: "bridge-1" } });
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

    const opened = worker.appendedEvents().filter((event) => event["payloadKind"] === "turn.opened");
    expect(opened).toHaveLength(1);
    const turnId = ((opened[0]!["causality"] as Record<string, unknown>)["turnId"] ?? "").toString();
    expect(turnId).toContain("channel:m-channel-turn");
    const pushed = worker.emitted.find((entry) => entry.payload["kind"] === "message");
    expect(pushed?.payload["bridge"]).toBe("bridge-1");

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
    const closed = worker
      .appendedEvents()
      .find((event) => event["payloadKind"] === "turn.closed")!;
    expect((closed["causality"] as Record<string, unknown>)["turnId"]).toBe(turnId);
  });

  it("closes an open turn when the bridge detaches", async () => {
    const worker = await makeWorker();
    await worker.attach({ sessionInfo: { bridge: "bridge-1" } });
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

    await worker.detachSelf();

    const closed = worker.appendedEvents().find((event) => event["payloadKind"] === "turn.closed");
    expect(closed).toBeTruthy();
    expect((await worker.linkedStatus()).attached).toBe(false);
  });

  it("authors idempotent trajectory events from hook reports", async () => {
    const worker = await makeWorker();
    await worker.attach({});

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
      "turn.opened",
      "message.completed",
    ]);
    const turnOpenId = String(events[0]!["envelopeId"]);
    expect(turnOpenId).toMatch(/^turn:t:ch-1:hook:s-1:turn-9:/);

    // Redelivery of the same hook seq is a no-op.
    const duplicate = await worker.ingestHookEvent(prompt);
    expect(duplicate.duplicate).toBe(true);
    expect(worker.gadCalls.filter((call) => call.method === "appendLogEvent")).toHaveLength(1);

    // Tool lifecycle + Stop close the turn with the mirrored final message.
    await worker.ingestHookEvent({
      sessionId: "s-1",
      seq: 3,
      event: { hook: "PreToolUse", toolName: "Bash", toolUseId: "tu-1", inputSummary: "ls" },
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
      "turn.opened",
      "message.completed",
      "invocation.started",
      "invocation.completed",
      "message.completed",
      "turn.closed",
    ]);
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
    await worker.attach({});
    worker.emitted.length = 0;

    await worker.requestPermission({
      requestId: "req-1",
      toolName: "Bash",
      description: "run npm install",
      inputPreview: "npm install",
    });
    expect(worker.permissionRows()[0]!["status"]).toBe("pending");
    // The conversation sees the pending relay as an ephemeral signal.
    expect(worker.signals).toHaveLength(1);

    // Shrink the deadline so the permission expires while the heartbeat is
    // still fresh (the real deadline outlives the heartbeat window, where a
    // dead bridge is detached — and denied — even earlier).
    const soon = Date.now() + 1_000;
    worker.shrinkPermissionDeadlines(soon);
    await worker.fireLinkedAlarm(soon + 500);
    expect(worker.permissionRows()[0]!["status"]).toBe("deny");
    const verdicts = worker.emitted.filter((entry) => entry.payload["kind"] === "permission");
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]!.payload["behavior"]).toBe("deny");

    // A late workspace verdict must not double-settle.
    worker.approvalResolvers.get("req-1")?.({ behavior: "allow" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.emitted.filter((entry) => entry.payload["kind"] === "permission")).toHaveLength(
      1
    );
  });

  it("labels approval requests with the bridge-provided permission capability", async () => {
    const worker = await makeWorker();
    await worker.attach({
      sessionInfo: { bridge: "bridge-1", agentKind: "codex", permissionCapability: "codex.tool" },
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
    await worker.attach({});

    await worker.requestPermission({ requestId: "req-dupe", toolName: "Bash" });
    const repeat = await worker.requestPermission({ requestId: "req-dupe", toolName: "Bash" });

    expect(repeat).toEqual({ ok: true, pending: true });
    expect(worker.permissionRows()).toHaveLength(1);
    expect(permissionPendingSignals(worker)).toHaveLength(1);
    expect(
      worker.rpcCall.mock.calls.filter((call) => call[1] === "userlandApproval.requestExternal")
    ).toHaveLength(1);

    worker.approvalResolvers.get("req-dupe")?.({ behavior: "allow" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    worker.emitted.length = 0;

    const afterSettle = await worker.requestPermission({ requestId: "req-dupe", toolName: "Bash" });
    expect(afterSettle).toEqual({ ok: true, pending: false });
    expect(permissionPendingSignals(worker)).toHaveLength(1);
    expect(worker.emitted.filter((entry) => entry.payload["kind"] === "permission")).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          requestId: "req-dupe",
          behavior: "allow",
          reason: "duplicate-settled",
        }),
      }),
    ]);
  });

  it("resolves a relayed permission as answered-at-terminal when the tool proceeds", async () => {
    const worker = await makeWorker();
    await worker.attach({});
    await worker.requestPermission({ requestId: "req-2", toolName: "Bash" });
    worker.emitted.length = 0;

    await worker.ingestHookEvent({
      sessionId: "s-1",
      seq: 10,
      event: { hook: "PreToolUse", toolName: "Bash", toolUseId: "tu-9" },
    });
    expect(worker.permissionRows()[0]!["status"]).toBe("terminal-answered");
    // No verdict push (the terminal already answered), approval withdrawn.
    expect(worker.emitted.filter((entry) => entry.payload["kind"] === "permission")).toHaveLength(
      0
    );
    expect(
      worker.rpcCall.mock.calls.some((call) => {
        const arg = (call[2] as unknown[] | undefined)?.[0] as { requestId?: string } | undefined;
        return call[1] === "userlandApproval.settleExternal" && arg?.requestId === "req-2";
      })
    ).toBe(true);
  });

  it("only withdraws the oldest pending permission for a matching terminal tool event", async () => {
    const worker = await makeWorker();
    await worker.attach({});
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

    await worker.attach({});
    worker.emitted.length = 0;
    const queued = await worker.onMethodCall("ch-1", "tc-2", "prompt", { text: "hi" });
    expect(queued.isError).toBeUndefined();
    expect(worker.emitted.filter((entry) => entry.payload["kind"] === "prompt")).toHaveLength(1);

    const status = await worker.onMethodCall("ch-1", "tc-3", "status", {});
    expect((status.result as { attached: boolean }).attached).toBe(true);

    // Pi-loop standard methods are pruned on the linked vessel.
    const unknown = await worker.onMethodCall("ch-1", "tc-4", "setModel", { model: "x:y" });
    expect(unknown.isError).toBe(true);
  });

  it("clears attachment and bridge state when forked", async () => {
    const worker = await makeWorker();
    await worker.attach({});
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
