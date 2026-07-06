/**
 * LinkedAgentWorker — a full agent vessel whose reasoning loop lives OUTSIDE
 * the system (docs/claude-code-channels-plan.md §5).
 *
 * Where AiChatWorker runs the loop in-process, this vessel relays to an
 * attached external process (a Claude Code session, via the CLI bridge
 * `vibestudio claude channel-host`). Everything else — identity, subscriptions,
 * channel envelopes, addressing, presence, fork-cloning, subagent task duty —
 * is inherited unchanged from the vessel base. The bridge authenticates with
 * an entity-scoped `agent:` credential (caller kind "agent") and attaches over
 * `attach()`; while attached, addressing-approved conversation input is pushed
 * to it as `linked-agent:event` emits; while detached, input buffers durably
 * and presence shows the agent offline.
 */

import type { DurableObjectContext } from "@workspace/runtime/worker";
import { rpc } from "@workspace/runtime/worker";
import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ChannelEvent, ParticipantDescriptor } from "@workspace/harness";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  invocationCompletedPayload,
  invocationFailedPayload,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { ids } from "@workspace/agent-loop";
import type { AgentTool } from "@workspace/pi-core";

/** Push-event name the bridge listens on (transport: `rpc.emit` to the agent
 *  credential's callerId — every live connection of that caller receives it;
 *  one bridge per credential makes that per-connection in practice). */
export const LINKED_AGENT_EVENT = "linked-agent:event";

/** Bridge must heartbeat at least this often or the vessel detaches it. */
export const LINKED_HEARTBEAT_TIMEOUT_MS = 90_000;
/** A pending permission with no verdict auto-denies after this long. */
export const LINKED_PERMISSION_TIMEOUT_MS = 120_000;

const ATTACHMENT_KEY = "linked:attachment";
const COMPLETED_KEY = "linked:completed";
const PRIMARY_CHANNEL_KEY = "linked:primaryChannelId";
const ACK_SEQ_KEY = "linked:ackSeq";
const PROCESSED_SEQ_KEY = "linked:processedSeq";
const OPEN_TURN_KEY = "linked:openTurn";
const SESSION_KEY = "linked:session";
const ALARM_SOURCE = "linked-agent";

export interface LinkedAttachment {
  callerId: string;
  sessionInfo: Record<string, unknown>;
  attachedAt: number;
  lastHeartbeatAt: number;
}

/** Hook events reported by the bridge (plan §7.4). `seq` is a per-session
 *  monotonic counter minted by the bridge; redelivery is a no-op. */
export type LinkedHookEvent =
  | { hook: "SessionStart"; model?: string; cwd?: string }
  | { hook: "UserPromptSubmit"; promptText: string; turnKey: string }
  | { hook: "PreToolUse"; toolName: string; toolUseId: string; inputSummary?: string }
  | {
      hook: "PostToolUse";
      toolUseId: string;
      toolName?: string;
      ok: boolean;
      outputSummary?: string;
    }
  | { hook: "Stop"; finalText?: string; turnKey: string }
  | { hook: "SessionEnd" };

interface QueueRow {
  seq: number;
  kind: string;
  channelId: string;
  payload: Record<string, unknown>;
}

const TEXT_BOUND = 8_000;

function bounded(text: unknown, max = TEXT_BOUND): string {
  const value = typeof text === "string" ? text : text == null ? "" : String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function lowerString(value: unknown): string | null {
  return typeof value === "string" ? value.toLowerCase() : null;
}

function metadataMarksExternalIngress(metadata: unknown): boolean {
  const record = recordValue(metadata);
  if (!record) return false;
  if (record["webhook"] === true || record["webhookIngress"] === true) return true;
  for (const key of ["type", "kind", "source", "origin", "transport", "ingress", "provenance"]) {
    const value = lowerString(record[key]);
    if (!value) continue;
    if (value === "external" || value === "webhook" || value === "webhook-ingress") return true;
    if (value.includes("webhook-ingress")) return true;
  }
  return false;
}

function isExternallyFedInput(event: ChannelEvent): boolean {
  const agentic = recordValue(event.payload);
  const actor = recordValue(agentic?.["actor"]);
  const payload = recordValue(agentic?.["payload"]);
  const annotations = recordValue((event as { annotations?: unknown }).annotations);
  return (
    lowerString(actor?.["kind"]) === "external" ||
    metadataMarksExternalIngress(event.senderMetadata) ||
    metadataMarksExternalIngress(actor?.["metadata"]) ||
    metadataMarksExternalIngress(payload?.["metadata"]) ||
    metadataMarksExternalIngress(annotations?.["metadata"])
  );
}

function sessionBridgeId(sessionInfo: Record<string, unknown> | undefined): string | null {
  const bridge = sessionInfo?.["bridge"];
  return typeof bridge === "string" && bridge.length > 0 ? bridge : null;
}

function permissionCapabilityFromSession(sessionInfo: Record<string, unknown> | undefined): string {
  const explicit = sessionInfo?.["permissionCapability"];
  if (typeof explicit === "string" && explicit.trim().length > 0) return explicit;
  const agentKind = sessionInfo?.["agentKind"];
  if (typeof agentKind === "string" && agentKind.trim().length > 0) return `${agentKind}.tool`;
  return "linked-agent.tool";
}

export class LinkedAgentWorker extends AgentWorkerBase {
  static override schemaVersion = AgentWorkerBase.schemaVersion;

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS linked_bridge_queue (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT UNIQUE,
        kind TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS linked_permissions (
        request_id TEXT PRIMARY KEY,
        tool_name TEXT NOT NULL,
        description TEXT,
        preview TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        deadline_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS linked_hook_seqs (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      )
    `);
    this.registerAgentAlarmSource({
      id: ALARM_SOURCE,
      nextWakeAt: () => this.linkedNextWakeAt(),
      fire: async (now) => this.linkedAlarm(now),
    });
  }

  // ── Identity & participant surface ─────────────────────────────────────────

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown
  ): ParticipantDescriptor {
    const cfg = (config && typeof config === "object" ? config : {}) as Record<string, unknown>;
    const attachment = this.attachment();
    return {
      handle: typeof cfg["handle"] === "string" && cfg["handle"] ? cfg["handle"] : "claude-code",
      name: typeof cfg["name"] === "string" && cfg["name"] ? cfg["name"] : "Claude Code",
      type: "agent",
      metadata: {
        linkedAgent: true,
        agentKind: typeof cfg["agentKind"] === "string" ? cfg["agentKind"] : "claude-code",
        linkedAttachment: attachment ? "attached" : "detached",
      },
      methods: [
        {
          name: "prompt",
          description: "Send a prompt to the linked session (queued to its next turn boundary)",
          parameters: {
            type: "object",
            properties: { text: { type: "string", description: "Prompt text" } },
            required: ["text"],
          },
        },
        { name: "interrupt", description: "Interrupt the linked session's current turn" },
        { name: "status", description: "Attachment and session status of the linked agent" },
      ],
    };
  }

  /** No in-process model loop: prompt/tool artifacts are never composed. */
  protected override async ensurePromptArtifacts(_channelId: string): Promise<void> {}

  protected override getLoopTools(_channelId: string): AgentTool[] {
    return [];
  }

  protected override async shouldRespond(channelId: string, event: ChannelEvent): Promise<boolean> {
    if (!(await super.shouldRespond(channelId, event))) return false;
    if (isExternallyFedInput(event)) return false;
    return true;
  }

  // ── Attachment state machine (plan §5.1) ───────────────────────────────────

  protected attachment(): LinkedAttachment | null {
    const raw = this.getStateValue(ATTACHMENT_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as LinkedAttachment;
    } catch {
      return null;
    }
  }

  /** The entity this vessel serves. The launch orchestrator creates the vessel
   *  with `STATE_ARGS.linkedEntityId` (falling back to the DO objectKey), and
   *  the agent credential is minted for the same entity — the redeemer-stamped
   *  callerId `agent:<entityId>` is therefore the authorization. */
  protected expectedEntityId(): string {
    const stateArgs = this.env["STATE_ARGS"];
    const raw =
      stateArgs && typeof stateArgs === "object"
        ? (stateArgs as Record<string, unknown>)["linkedEntityId"]
        : undefined;
    if (typeof raw === "string" && raw.length > 0) return raw;
    return this.objectKey;
  }

  private requireBridgeCaller(method: string): string {
    const kind = this.rpcCallerKind;
    const callerId = this.rpcCallerId ?? "";
    // Host/ops path (tests, server-driven teardown) is trusted as-is.
    if (kind === "server") return callerId;
    if (kind !== "agent") {
      throw new Error(`${method}: caller kind "${kind ?? "unattributed"}" is not a linked bridge`);
    }
    const entityId = callerId.startsWith("agent:") ? callerId.slice("agent:".length) : "";
    if (!entityId || entityId !== this.expectedEntityId()) {
      throw new Error(
        `${method}: agent credential for "${entityId || callerId}" does not own this vessel`
      );
    }
    return callerId;
  }

  @rpc({ callers: ["agent", "server"] })
  async attach(opts?: { sessionInfo?: Record<string, unknown> }): Promise<{
    ok: boolean;
    cursor: number;
    replayFromSeq: number;
    pendingCount: number;
    primaryChannelId: string | null;
    contextId: string | null;
    channelIds: string[];
  }> {
    const callerId = this.requireBridgeCaller("attach");
    const now = Date.now();
    const existing = this.attachment();
    if (existing && now < existing.lastHeartbeatAt + LINKED_HEARTBEAT_TIMEOUT_MS) {
      const existingBridge = sessionBridgeId(existing.sessionInfo);
      const incomingBridge = sessionBridgeId(opts?.sessionInfo);
      if (!existingBridge || !incomingBridge || existingBridge !== incomingBridge) {
        throw new Error("attach: linked bridge already attached");
      }
    }
    const attachment: LinkedAttachment = {
      callerId,
      sessionInfo: opts?.sessionInfo ?? {},
      attachedAt: now,
      lastHeartbeatAt: now,
    };
    this.setStateValue(ATTACHMENT_KEY, JSON.stringify(attachment));
    this.scheduleAgentAlarm(ALARM_SOURCE, now + LINKED_HEARTBEAT_TIMEOUT_MS);
    await this.refreshPresence();
    const primaryChannelId = this.primaryChannelId();
    let contextId: string | null = null;
    if (primaryChannelId) {
      try {
        contextId = this.subscriptions.getContextId(primaryChannelId);
      } catch {
        contextId = null;
      }
    }
    const replayFromSeq = this.processedSeq();
    const pending = this.queueRowsAfter(replayFromSeq);
    // Replay from the last turn boundary (§7.5): acked-but-unprocessed input is
    // re-delivered into the fresh session; duplicates are context, not commands.
    for (const row of pending) {
      await this.openBridgeQueueTurn(row);
      this.emitToBridge(this.queueEventPayload(row));
    }
    return {
      ok: true,
      cursor: this.ackSeq(),
      replayFromSeq,
      pendingCount: pending.length,
      primaryChannelId,
      contextId,
      channelIds: this.subscriptions.listChannelIds(),
    };
  }

  @rpc({ callers: ["agent", "server"] })
  async heartbeat(): Promise<{ ok: boolean; attached: boolean }> {
    this.requireBridgeCaller("heartbeat");
    const attachment = this.attachment();
    if (!attachment) return { ok: true, attached: false };
    attachment.lastHeartbeatAt = Date.now();
    this.setStateValue(ATTACHMENT_KEY, JSON.stringify(attachment));
    this.scheduleAgentAlarm(ALARM_SOURCE, attachment.lastHeartbeatAt + LINKED_HEARTBEAT_TIMEOUT_MS);
    return { ok: true, attached: true };
  }

  @rpc({ callers: ["agent", "server"] })
  async detachSelf(): Promise<{ ok: boolean }> {
    this.requireBridgeCaller("detachSelf");
    await this.detach("bridge-detached");
    return { ok: true };
  }

  @rpc({ callers: ["agent", "server"] })
  async ackDelivery(opts: { seq: number }): Promise<{ ok: boolean; ackSeq: number }> {
    this.requireBridgeCaller("ackDelivery");
    const seq = Number(opts?.seq);
    if (!Number.isFinite(seq)) throw new Error("ackDelivery requires a numeric seq");
    const next = Math.max(this.ackSeq(), Math.round(seq));
    this.setStateValue(ACK_SEQ_KEY, String(next));
    return { ok: true, ackSeq: next };
  }

  protected async detach(reason: string): Promise<void> {
    const attachment = this.attachment();
    if (!attachment) return;
    this.emitToBridge({ kind: "detach", reason });
    await this.closeOpenTurn(`bridge detached (${reason})`, false);
    this.setStateValue(ATTACHMENT_KEY, "");
    this.clearAgentAlarm(ALARM_SOURCE);
    // No consumer for verdicts anymore — pending permissions fail closed.
    await this.denyPendingPermissions(`bridge detached (${reason})`);
    await this.refreshPresence();
  }

  /** Re-advertise participant metadata (attachment state) on every channel. */
  protected async refreshPresence(): Promise<void> {
    for (const channelId of this.subscriptions.listChannelIds()) {
      try {
        const config = this.subscriptions.getConfig(channelId);
        await this.subscriptions.subscribe({
          channelId,
          contextId: this.subscriptions.getContextId(channelId),
          config: config ?? undefined,
          descriptor: this.getEffectiveParticipantInfo(channelId, config ?? undefined),
          replay: false,
        });
      } catch (err) {
        console.warn(
          `[LinkedAgent] presence refresh failed for ${channelId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  private linkedNextWakeAt(): number | null {
    const deadlines: number[] = [];
    const attachment = this.attachment();
    if (attachment) deadlines.push(attachment.lastHeartbeatAt + LINKED_HEARTBEAT_TIMEOUT_MS);
    const row = this.sql
      .exec(`SELECT MIN(deadline_at) AS due FROM linked_permissions WHERE status = 'pending'`)
      .toArray()[0];
    const due = row?.["due"];
    if (typeof due === "number") deadlines.push(due);
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  private async linkedAlarm(now: number): Promise<void> {
    const attachment = this.attachment();
    if (attachment && now >= attachment.lastHeartbeatAt + LINKED_HEARTBEAT_TIMEOUT_MS) {
      await this.detach("heartbeat-timeout");
    }
    const expired = this.sql
      .exec(
        `SELECT request_id FROM linked_permissions WHERE status = 'pending' AND deadline_at <= ?`,
        now
      )
      .toArray()
      .map((row) => String(row["request_id"]));
    for (const requestId of expired) {
      await this.settlePermission(requestId, "deny", "timeout");
    }
  }

  // ── Bridge delivery (queue + push) ─────────────────────────────────────────

  protected primaryChannelId(): string | null {
    const stored = this.getStateValue(PRIMARY_CHANNEL_KEY);
    if (stored) return stored;
    const first = this.subscriptions.listChannelIds()[0] ?? null;
    if (first) this.setStateValue(PRIMARY_CHANNEL_KEY, first);
    return first;
  }

  private ackSeq(): number {
    return Number(this.getStateValue(ACK_SEQ_KEY) ?? 0) || 0;
  }

  private processedSeq(): number {
    return Number(this.getStateValue(PROCESSED_SEQ_KEY) ?? 0) || 0;
  }

  private queueRowsAfter(seq: number): QueueRow[] {
    return this.sql
      .exec(
        `SELECT seq, kind, channel_id, payload FROM linked_bridge_queue WHERE seq > ? ORDER BY seq`,
        seq
      )
      .toArray()
      .map((row) => ({
        seq: Number(row["seq"]),
        kind: String(row["kind"]),
        channelId: String(row["channel_id"]),
        payload: JSON.parse(String(row["payload"])) as Record<string, unknown>,
      }));
  }

  private enqueueForBridge(
    kind: "message" | "prompt",
    channelId: string,
    dedupeKey: string,
    payload: Record<string, unknown>
  ): number | null {
    this.sql.exec(
      `INSERT OR IGNORE INTO linked_bridge_queue (dedupe_key, kind, channel_id, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      dedupeKey,
      kind,
      channelId,
      JSON.stringify(payload),
      Date.now()
    );
    const row = this.sql
      .exec(`SELECT seq FROM linked_bridge_queue WHERE dedupe_key = ?`, dedupeKey)
      .toArray()[0];
    return row ? Number(row["seq"]) : null;
  }

  private queueEventPayload(row: QueueRow): Record<string, unknown> {
    return { kind: row.kind, seq: row.seq, channelId: row.channelId, ...row.payload };
  }

  /** Fire-and-forget push to the attached bridge (no-op while detached; the
   *  durable queue is the source of truth, pushes are the live tail). */
  protected emitToBridge(payload: Record<string, unknown>): void {
    const attachment = this.attachment();
    if (!attachment) return;
    const rpc = this.rpc as unknown as {
      emit: (target: string, event: string, payload: unknown) => Promise<void>;
    };
    const bridge = sessionBridgeId(attachment.sessionInfo);
    const framed = bridge ? { ...payload, bridge } : payload;
    void rpc.emit(attachment.callerId, LINKED_AGENT_EVENT, framed).catch((err: unknown) => {
      console.warn("[LinkedAgent] bridge emit failed:", err instanceof Error ? err.message : err);
    });
  }

  /** The vessel-base seam: addressing-approved conversation input is queued for
   *  the external session instead of driving the in-process loop. */
  protected override async dispatchApprovedInput(
    channelId: string,
    event: ChannelEvent,
    _sourceMessageId: string | undefined
  ): Promise<void> {
    // The subagent task seed is delivered out-of-band as the headless launch
    // prompt (`claude -p <task>`); relaying it here would hand the session its
    // task twice (live push + attach replay). It stays on the channel for
    // trajectory visibility and `channel history`, just not in the bridge queue.
    if (event.messageId.startsWith("subagent-seed:")) return;
    const agentic = event.payload as AgenticEvent | null;
    const senderMetadata = (event as { senderMetadata?: Record<string, unknown> }).senderMetadata;
    const payload = (agentic?.payload ?? {}) as { mentions?: string[] };
    const content = bounded(this.turnContent(channelId, event));
    const meta: Record<string, unknown> = {
      channel_id: channelId,
      seq: event.id,
      from: event.senderId,
      from_handle:
        typeof senderMetadata?.["handle"] === "string" ? senderMetadata["handle"] : undefined,
      kind: "message.completed",
      turn_id: (agentic as { turnId?: string } | null)?.turnId,
      ...(Array.isArray(payload.mentions) ? { mentions: payload.mentions } : {}),
    };
    const seq = this.enqueueForBridge("message", channelId, `msg:${channelId}:${event.messageId}`, {
      content,
      meta,
    });
    if (seq !== null) {
      if (this.attachment()) {
        await this.openChannelTurn(channelId, event, content);
      }
      this.emitToBridge({ kind: "message", seq, channelId, content, meta });
    }
  }

  // ── Outbound: say / complete (plan §7.2) ───────────────────────────────────

  @rpc({ callers: ["agent", "server"] })
  async say(opts: {
    text: string;
    to?: Array<{ kind: "all" | "role" | "participant"; role?: string; participantId?: string }>;
    mentions?: string[];
    replyTo?: string;
    idempotencyKey?: string;
  }): Promise<{ ok: boolean; messageId: string; channelId: string }> {
    this.requireBridgeCaller("say");
    const channelId = this.primaryChannelId();
    if (!channelId) throw new Error("say: linked agent has no channel subscription");
    if (typeof opts?.text !== "string" || opts.text.trim().length === 0) {
      throw new Error("say requires non-empty text");
    }
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) throw new Error("say: not subscribed to the primary channel");
    const descriptor = this.getEffectiveParticipantInfo(
      channelId,
      this.subscriptions.getConfig(channelId)
    );
    const messageId = `say:${opts.idempotencyKey ?? `linked:${Date.now()}`}`;
    await this.createChannelClient(channelId).send(participantId, messageId, opts.text, {
      saliency: "say",
      senderMetadata: {
        ...descriptor.metadata,
        name: descriptor.name,
        type: descriptor.type,
        handle: descriptor.handle,
      },
      ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
      ...(opts.mentions ? { mentions: opts.mentions } : {}),
      ...(opts.to ? { to: opts.to } : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: `say:${opts.idempotencyKey}` } : {}),
    });
    return { ok: true, messageId, channelId };
  }

  @rpc({ callers: ["agent", "server"] })
  async completeFromBridge(opts: {
    report: string;
    outcome?: "success" | "failed";
  }): Promise<{ ok: boolean }> {
    this.requireBridgeCaller("completeFromBridge");
    await this.completeAsSubagent(
      typeof opts?.report === "string" ? opts.report : "",
      opts?.outcome === "failed" ? "failed" : "success"
    );
    // Remembered so a process-exit report after a real complete is a no-op
    // (belt on top of the parent-side post-terminal idempotency).
    this.setStateValue(COMPLETED_KEY, "1");
    return { ok: true };
  }

  /**
   * Launcher-extension report that the external headless process exited (§8.2
   * failure path). If this vessel carries subagent duty and the session never
   * called `complete`, settle the parent's run as failed instead of leaving it
   * dangling as "running". Idempotent: a post-complete exit (the normal case —
   * every headless process eventually exits) and a duplicate report both no-op;
   * the parent's `onSubagentComplete` is additionally post-terminal-idempotent.
   * Caller gating is coarse (any extension may call); the worst a forged report
   * can do is settle-as-failed, which is the cancel path's power.
   */
  @rpc({ callers: ["extension", "server"] })
  async reportExternalExit(opts: {
    runId?: string;
    code?: number | null;
    signal?: string | null;
  }): Promise<{ ok: boolean; settled: boolean }> {
    const sub = this.subagentIdentity();
    if (!sub) return { ok: true, settled: false };
    if (opts?.runId && opts.runId !== sub.runId) return { ok: true, settled: false };
    if (this.getStateValue(COMPLETED_KEY)) return { ok: true, settled: false };
    this.setStateValue(COMPLETED_KEY, "1");
    // The bridge died with the process; fail-close its pending permissions now
    // rather than waiting out the heartbeat timeout.
    await this.detach("process-exit");
    const exitDesc =
      typeof opts?.signal === "string" && opts.signal
        ? `signal ${opts.signal}`
        : `exit code ${opts?.code ?? "unknown"}`;
    await this.completeAsSubagent(
      `Claude Code session exited (${exitDesc}) without calling complete. ` +
        "Settled as failed; inspect the task channel transcript and the child " +
        "context for partial work.",
      "failed"
    );
    return { ok: true, settled: true };
  }

  @rpc({ callers: ["agent", "server"] })
  async linkedStatus(): Promise<{
    attached: boolean;
    sessionInfo: Record<string, unknown> | null;
    pendingCount: number;
    ackSeq: number;
    processedSeq: number;
    primaryChannelId: string | null;
    channelIds: string[];
  }> {
    this.requireBridgeCaller("linkedStatus");
    return this.linkedStatusResult();
  }

  private linkedStatusResult() {
    const attachment = this.attachment();
    return {
      attached: attachment !== null,
      sessionInfo: attachment?.sessionInfo ?? null,
      pendingCount: this.queueRowsAfter(this.processedSeq()).length,
      ackSeq: this.ackSeq(),
      processedSeq: this.processedSeq(),
      primaryChannelId: this.primaryChannelId(),
      channelIds: this.subscriptions.listChannelIds(),
    };
  }

  // ── Method provision (plan §5.2) ───────────────────────────────────────────

  protected override async handleStandardAgentMethodCall(
    channelId: string,
    methodName: string,
    args: unknown
  ): Promise<{ result: unknown; isError?: boolean } | null> {
    switch (methodName) {
      case "prompt": {
        const text = (args as { text?: unknown } | null)?.text;
        if (typeof text !== "string" || text.trim().length === 0) {
          return { result: { error: "prompt requires text" }, isError: true };
        }
        if (!this.attachment()) {
          return { result: { error: "agent offline: no attached session" }, isError: true };
        }
        const seq = this.enqueueForBridge(
          "prompt",
          channelId,
          `prompt:${channelId}:${this.rpcRequestId ?? `${Date.now()}`}`,
          { content: bounded(text), meta: { from: this.rpcCallerId ?? "channel" } }
        );
        if (seq !== null) {
          await this.openCommandTurn(channelId, String(seq), bounded(text));
          this.emitToBridge({
            kind: "prompt",
            seq,
            channelId,
            content: bounded(text),
            meta: { from: this.rpcCallerId ?? "channel" },
          });
        }
        return { result: { queued: true, seq } };
      }
      case "interrupt": {
        if (!this.attachment()) {
          return { result: { error: "agent offline: no attached session" }, isError: true };
        }
        this.emitToBridge({ kind: "interrupt" });
        return { result: { interrupted: true } };
      }
      case "status":
        return { result: this.linkedStatusResult() };
      default:
        // The Pi-loop standard methods (pause/setModel/…) do not apply to an
        // externally-driven session; unknown methods error in the base caller.
        return null;
    }
  }

  // ── Trajectory authorship from hook events (plan §7.4) ─────────────────────

  @rpc({ callers: ["agent", "server"] })
  async ingestHookEvent(opts: {
    sessionId: string;
    seq: number;
    event: LinkedHookEvent;
  }): Promise<{ ok: boolean; duplicate?: boolean }> {
    this.requireBridgeCaller("ingestHookEvent");
    const sessionId = String(opts?.sessionId ?? "");
    const seq = Number(opts?.seq);
    if (!sessionId || !Number.isFinite(seq)) {
      throw new Error("ingestHookEvent requires sessionId and a numeric seq");
    }
    const inserted = this.sql
      .exec(
        `INSERT OR IGNORE INTO linked_hook_seqs (session_id, seq) VALUES (?, ?) RETURNING seq`,
        sessionId,
        Math.round(seq)
      )
      .toArray();
    if (inserted.length === 0) return { ok: true, duplicate: true };

    const channelId = this.primaryChannelId();
    if (!channelId) return { ok: true }; // nothing to author against yet

    const event = opts.event;
    switch (event.hook) {
      case "SessionStart": {
        this.setStateValue(
          SESSION_KEY,
          JSON.stringify({ sessionId, model: event.model, cwd: event.cwd })
        );
        await this.appendTrajectory(channelId, [
          {
            envelopeId: ids.systemEvent(`linked:${sessionId}`, "session-start", Math.round(seq)),
            payloadKind: "system.event",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "linked-agent.session_started",
              summary: `Claude Code session started${event.model ? ` (${event.model})` : ""}`,
              details: { sessionId, model: event.model, cwd: event.cwd },
            },
          },
        ]);
        await this.refreshPresence();
        break;
      }
      case "UserPromptSubmit": {
        const turnId = this.turnIdFor(channelId, sessionId, event.turnKey);
        const existing = this.openTurn();
        if (existing?.turnKey === event.turnKey) break;
        if (existing && existing.turnKey !== event.turnKey) {
          await this.closeOpenTurn("new terminal prompt submitted", true);
        }
        this.setStateValue(OPEN_TURN_KEY, JSON.stringify({ turnId, turnKey: event.turnKey }));
        const messageId = `lm:${turnId}:user`;
        await this.appendTrajectory(channelId, [
          {
            envelopeId: ids.turnOpened(turnId),
            payloadKind: "turn.opened",
            payload: { protocol: AGENTIC_PROTOCOL_VERSION },
            causality: { turnId },
            publish: true,
          },
          {
            envelopeId: ids.messageTerminal(messageId),
            payloadKind: "message.completed",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "user",
              blocks: [
                {
                  blockId: `${messageId}:block:0`,
                  type: "text",
                  content: bounded(event.promptText),
                },
              ],
              outcome: "completed",
              tier: "primary",
              metadata: { source: "terminal" },
            },
            causality: { turnId, messageId },
            publish: true,
          },
        ]);
        break;
      }
      case "PreToolUse": {
        const invocationId = `linv:${sessionId}:${event.toolUseId}`;
        // Terminal answered a relayed permission prompt for this tool: the tool
        // proceeded, so the workspace approval resolves as answered-at-terminal.
        await this.resolvePermissionAnsweredAtTerminal(event.toolName);
        await this.appendTrajectory(channelId, [
          {
            envelopeId: ids.invocationStart(invocationId),
            payloadKind: "invocation.started",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: event.toolName,
              invocationType: "tool",
              userVisible: true,
              ...(event.inputSummary ? { summary: bounded(event.inputSummary, 2_000) } : {}),
            },
            causality: { invocationId, ...this.openTurnCausality() },
            publish: true,
          },
        ]);
        break;
      }
      case "PostToolUse": {
        const invocationId = `linv:${sessionId}:${event.toolUseId}`;
        await this.appendTrajectory(channelId, [
          {
            envelopeId: ids.invocationTerminal(invocationId),
            payloadKind: event.ok ? "invocation.completed" : "invocation.failed",
            payload: event.ok
              ? invocationCompletedPayload({
                  ...(event.outputSummary ? { summary: bounded(event.outputSummary, 2_000) } : {}),
                })
              : invocationFailedPayload(
                  "tool_error",
                  bounded(event.outputSummary ?? "tool failed", 2_000)
                ),
            causality: { invocationId, ...this.openTurnCausality() },
            publish: true,
          },
        ]);
        break;
      }
      case "Stop": {
        const open = this.openTurn();
        const turnId = open?.turnId ?? this.turnIdFor(channelId, sessionId, event.turnKey);
        const messageId = `lm:${turnId}:final`;
        const items: TrajectoryItem[] = [];
        if (!open) {
          // Channel-driven turns have no UserPromptSubmit: open retroactively so
          // the pair is well-formed (idempotent by envelopeId on redelivery).
          items.push({
            envelopeId: ids.turnOpened(turnId),
            payloadKind: "turn.opened",
            payload: { protocol: AGENTIC_PROTOCOL_VERSION },
            causality: { turnId },
            publish: true,
          });
        }
        if (typeof event.finalText === "string" && event.finalText.trim().length > 0) {
          // Mirrored final assistant message (plan §7.5): visible in trajectory
          // and cards, tier "secondary" and no say-saliency — not spoken INTO the
          // conversation; respond policies keep it from waking other agents.
          items.push({
            envelopeId: ids.messageTerminal(messageId),
            payloadKind: "message.completed",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              role: "assistant",
              blocks: [
                {
                  blockId: `${messageId}:block:0`,
                  type: "text",
                  content: bounded(event.finalText),
                },
              ],
              outcome: "completed",
              tier: "secondary",
              metadata: { source: "linked-terminal-mirror" },
            },
            causality: { turnId, messageId },
            publish: true,
          });
        }
        items.push({
          envelopeId: ids.turnClosed(turnId),
          payloadKind: "turn.closed",
          payload: { protocol: AGENTIC_PROTOCOL_VERSION },
          causality: { turnId },
          publish: true,
        });
        await this.appendTrajectory(channelId, items);
        this.setStateValue(OPEN_TURN_KEY, "");
        // §7.5 cursor semantics: turn.closed is the processed marker — input
        // acked before this boundary is never replayed to a fresh session.
        const processed = this.ackSeq();
        this.setStateValue(PROCESSED_SEQ_KEY, String(processed));
        this.sql.exec(`DELETE FROM linked_bridge_queue WHERE seq <= ?`, processed);
        // A turn closed with relayed permission verdicts unconsumed: the local
        // human answered at the terminal — no dangling approval cards.
        await this.resolvePermissionAnsweredAtTerminal(null);
        break;
      }
      case "SessionEnd": {
        await this.appendTrajectory(channelId, [
          {
            envelopeId: ids.systemEvent(`linked:${sessionId}`, "session-end", Math.round(seq)),
            payloadKind: "system.event",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              kind: "linked-agent.session_ended",
              summary: "Claude Code session ended",
              details: { sessionId },
            },
          },
        ]);
        await this.detach("session-end");
        break;
      }
    }
    return { ok: true };
  }

  private turnIdFor(channelId: string, sessionId: string, turnKey: string): string {
    return ids.turnId(channelId, `hook:${sessionId}:${turnKey}`, this.participantId());
  }

  private openTurn(): { turnId: string; turnKey: string } | null {
    const raw = this.getStateValue(OPEN_TURN_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as { turnId: string; turnKey: string };
    } catch {
      return null;
    }
  }

  private openTurnCausality(): { turnId?: string } {
    const open = this.openTurn();
    return open ? { turnId: open.turnId } : {};
  }

  private async openChannelTurn(
    channelId: string,
    event: ChannelEvent,
    content: string
  ): Promise<void> {
    if (this.openTurn()) return;
    const turnKey = `channel:${event.messageId}`;
    const turnId = ids.turnId(channelId, turnKey, this.participantId());
    this.setStateValue(OPEN_TURN_KEY, JSON.stringify({ turnId, turnKey }));
    const messageId = `lm:${turnId}:channel-input`;
    await this.appendTrajectory(channelId, [
      {
        envelopeId: ids.turnOpened(turnId),
        payloadKind: "turn.opened",
        payload: { protocol: AGENTIC_PROTOCOL_VERSION },
        causality: { turnId },
        publish: true,
      },
      {
        envelopeId: ids.messageTerminal(messageId),
        payloadKind: "message.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "user",
          blocks: [{ blockId: `${messageId}:block:0`, type: "text", content }],
          outcome: "completed",
          tier: "primary",
          metadata: { source: "channel" },
        },
        causality: { turnId, messageId },
        publish: true,
      },
    ]);
  }

  private async openCommandTurn(channelId: string, seq: string, content: string): Promise<void> {
    if (this.openTurn()) return;
    const turnKey = `prompt:${seq}`;
    const turnId = ids.turnId(channelId, turnKey, this.participantId());
    this.setStateValue(OPEN_TURN_KEY, JSON.stringify({ turnId, turnKey }));
    const messageId = `lm:${turnId}:channel-command`;
    await this.appendTrajectory(channelId, [
      {
        envelopeId: ids.turnOpened(turnId),
        payloadKind: "turn.opened",
        payload: { protocol: AGENTIC_PROTOCOL_VERSION },
        causality: { turnId },
        publish: true,
      },
      {
        envelopeId: ids.messageTerminal(messageId),
        payloadKind: "message.completed",
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          role: "user",
          blocks: [{ blockId: `${messageId}:block:0`, type: "text", content }],
          outcome: "completed",
          tier: "primary",
          metadata: { source: "channel-command" },
        },
        causality: { turnId, messageId },
        publish: true,
      },
    ]);
  }

  private async openBridgeQueueTurn(row: QueueRow): Promise<void> {
    if (this.openTurn()) return;
    const content = bounded(row.payload["content"]);
    if (row.kind === "message") {
      const turnKey = `queue:${row.seq}`;
      const turnId = ids.turnId(row.channelId, turnKey, this.participantId());
      this.setStateValue(OPEN_TURN_KEY, JSON.stringify({ turnId, turnKey }));
      const messageId = `lm:${turnId}:queued-input`;
      await this.appendTrajectory(row.channelId, [
        {
          envelopeId: ids.turnOpened(turnId),
          payloadKind: "turn.opened",
          payload: { protocol: AGENTIC_PROTOCOL_VERSION },
          causality: { turnId },
          publish: true,
        },
        {
          envelopeId: ids.messageTerminal(messageId),
          payloadKind: "message.completed",
          payload: {
            protocol: AGENTIC_PROTOCOL_VERSION,
            role: "user",
            blocks: [{ blockId: `${messageId}:block:0`, type: "text", content }],
            outcome: "completed",
            tier: "primary",
            metadata: { source: "queued-channel" },
          },
          causality: { turnId, messageId },
          publish: true,
        },
      ]);
      return;
    }
    if (row.kind === "prompt") {
      await this.openCommandTurn(row.channelId, String(row.seq), content);
    }
  }

  private async closeOpenTurn(
    reason: string,
    resolvePendingPermissionsAtTerminal: boolean
  ): Promise<void> {
    const open = this.openTurn();
    if (!open) return;
    const channelId = this.primaryChannelId();
    this.setStateValue(OPEN_TURN_KEY, "");
    if (!channelId) return;
    await this.appendTrajectory(channelId, [
      {
        envelopeId: ids.turnClosed(open.turnId),
        payloadKind: "turn.closed",
        payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: bounded(reason, 512) },
        causality: { turnId: open.turnId },
        publish: true,
      },
    ]);
    if (resolvePendingPermissionsAtTerminal) {
      await this.resolvePermissionAnsweredAtTerminal(null);
    }
  }

  private async appendTrajectory(channelId: string, items: TrajectoryItem[]): Promise<void> {
    if (items.length === 0) return;
    const logId = ids.logIdForChannel(channelId);
    const selfRef = this.selfRef(channelId);
    const result = await this.callGad<{
      envelopes: Array<{ envelopeId: string }>;
      published?: Array<{ originEnvelopeId: string; channelId: string; envelopeId: string }>;
    }>("appendLogEvent", {
      logId,
      head: logId,
      logKind: "trajectory",
      owner: { kind: "agent", id: selfRef.id },
      idempotency: "idempotent-by-id",
      events: items.map((item) => ({
        envelopeId: item.envelopeId,
        actor: selfRef,
        payloadKind: item.payloadKind,
        payload: item.payload,
        ...(item.causality ? { causality: item.causality } : {}),
        ...(item.publish ? { publish: { channels: [{ channelId }] } } : {}),
      })),
    });
    const published = result.published ?? [];
    const envelopeIds = published
      .filter((entry) => entry.channelId === channelId)
      .map((entry) => entry.envelopeId);
    if (envelopeIds.length > 0) {
      await this.createChannelClient(channelId)
        .broadcastStoredEnvelopes(envelopeIds)
        .catch((err) => {
          console.warn(
            "[LinkedAgent] broadcast of published trajectory events failed:",
            err instanceof Error ? err.message : err
          );
        });
    }
  }

  // ── Permission relay (plan §7.3) ───────────────────────────────────────────

  @rpc({ callers: ["agent", "server"] })
  async requestPermission(opts: {
    requestId: string;
    toolName: string;
    description?: string;
    inputPreview?: string;
  }): Promise<{ ok: boolean; pending: boolean }> {
    this.requireBridgeCaller("requestPermission");
    const requestId = String(opts?.requestId ?? "");
    const toolName = String(opts?.toolName ?? "");
    if (!requestId || !toolName) {
      throw new Error("requestPermission requires requestId and toolName");
    }
    const now = Date.now();
    const resolveToken = crypto.randomUUID();
    const inserted = this.sql
      .exec(
        `INSERT OR IGNORE INTO linked_permissions
           (request_id, tool_name, description, preview, status, created_at, deadline_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)
         RETURNING request_id`,
        requestId,
        toolName,
        opts.description ?? null,
        opts.inputPreview ?? null,
        now,
        now + LINKED_PERMISSION_TIMEOUT_MS
      )
      .toArray();
    if (inserted.length === 0) {
      const existing = this.sql
        .exec(`SELECT status FROM linked_permissions WHERE request_id = ?`, requestId)
        .toArray()[0] as { status?: string } | undefined;
      const status = existing?.status;
      if (status === "allow" || status === "deny") {
        this.emitToBridge({
          kind: "permission",
          requestId,
          behavior: status,
          reason: "duplicate-settled",
        });
      }
      return { ok: true, pending: status === "pending" };
    }
    this.scheduleAgentAlarm(ALARM_SOURCE, now + LINKED_PERMISSION_TIMEOUT_MS);
    this.publishPermissionSignal(
      requestId,
      resolveToken,
      toolName,
      opts.description,
      opts.inputPreview
    );
    const resolve = this.resolvePermissionViaApprovals(
      requestId,
      resolveToken,
      toolName,
      opts.description,
      opts.inputPreview
    ).catch(() => {});
    this.ctx.waitUntil?.(resolve);
    return { ok: true, pending: true };
  }

  /** Conversation-side surfacing of the pending relay: an ephemeral signal the
   *  chat UI renders as "Claude Code wants to run X" (W6 owns the card). */
  private publishPermissionSignal(
    requestId: string,
    resolveToken: string,
    toolName: string,
    description?: string,
    preview?: string
  ): void {
    const channelId = this.primaryChannelId();
    if (!channelId) return;
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const event = {
      kind: "system.event",
      actor: this.selfRef(channelId),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        kind: "linked-agent.permission_pending",
        summary: `Claude Code wants to run ${toolName}`,
        // `channelId` lets the chat card call
        // `shellApproval.resolveExternalAgentByRequest({ channelId, requestId, resolveToken }, …)`
        // without knowing the internal approvalId (W6 §7.3).
        details: { channelId, requestId, resolveToken, toolName, description, preview },
      },
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    void this.createChannelClient(channelId)
      .sendSignalEvent(participantId, AGENTIC_EVENT_PAYLOAD_KIND, event)
      .catch(() => {});
  }

  /** Companion to {@link publishPermissionSignal}: an ephemeral signal telling
   *  the chat UI to clear the pending permission card, published at EVERY settle
   *  site (verdict push, terminal-answered, auto-deny, detach-deny) so a card
   *  resolved on any surface clears everywhere. Signals are ephemeral, so a panel
   *  reload naturally drops stale pending cards (W6 §7.3). */
  private publishPermissionSettledSignal(
    requestId: string,
    behavior: "allow" | "deny" | undefined,
    settledBy: string
  ): void {
    const channelId = this.primaryChannelId();
    if (!channelId) return;
    const participantId = this.subscriptions.getParticipantId(channelId);
    if (!participantId) return;
    const event = {
      kind: "system.event",
      actor: this.selfRef(channelId),
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        kind: "linked-agent.permission_settled",
        summary: "Claude Code permission settled",
        details: {
          channelId,
          requestId,
          ...(behavior ? { behavior } : {}),
          settledBy,
        },
      },
      createdAt: new Date().toISOString(),
    } as unknown as AgenticEvent;
    void this.createChannelClient(channelId)
      .sendSignalEvent(participantId, AGENTIC_EVENT_PAYLOAD_KIND, event)
      .catch(() => {});
  }

  private async resolvePermissionViaApprovals(
    requestId: string,
    resolveToken: string,
    toolName: string,
    description?: string,
    preview?: string
  ): Promise<void> {
    let behavior: "allow" | "deny" = "deny";
    let reason = "approval-request-failed";
    const channelId = this.primaryChannelId();
    if (!channelId) {
      await this.settlePermission(requestId, behavior, "no-channel");
      return;
    }
    try {
      // Pinned W6 contract (plan §7.3): a first-class workspace approval filed
      // by the vessel; resolves to { behavior: "allow" | "deny" }.
      const verdict = await this.rpc.call<{ behavior?: string }>(
        "main",
        "userlandApproval.requestExternal",
        [
          {
            channelId,
            capability: permissionCapabilityFromSession(this.attachment()?.sessionInfo),
            operation: toolName,
            description: description ?? `Claude Code wants to run ${toolName}`,
            ...(preview !== undefined ? { preview } : {}),
            requestId,
            resolveToken,
          },
        ]
      );
      behavior = verdict?.behavior === "allow" ? "allow" : "deny";
      reason = "workspace-approval";
    } catch (err) {
      console.warn(
        `[LinkedAgent] workspace approval for ${requestId} failed (deny):`,
        err instanceof Error ? err.message : err
      );
    }
    await this.settlePermission(requestId, behavior, reason);
  }

  /** First verdict wins; later verdicts (timeout racing the approval, terminal
   *  answer racing the workspace card) are no-ops. */
  private async settlePermission(
    requestId: string,
    behavior: "allow" | "deny",
    reason: string
  ): Promise<void> {
    const updated = this.sql
      .exec(
        `UPDATE linked_permissions SET status = ? WHERE request_id = ? AND status = 'pending'
         RETURNING request_id`,
        behavior,
        requestId
      )
      .toArray();
    if (updated.length === 0) return;
    this.emitToBridge({ kind: "permission", requestId, behavior, reason });
    this.publishPermissionSettledSignal(requestId, behavior, reason);
  }

  /** §7.5 race cleanup: the terminal human answered (tool proceeded, or the
   *  turn closed with the relay verdict unconsumed) — resolve the workspace
   *  approval card instead of leaving it dangling. A tool event consumes only
   *  the oldest pending request for that tool; `toolName === null` sweeps every
   *  pending request at the turn boundary. */
  private async resolvePermissionAnsweredAtTerminal(toolName: string | null): Promise<void> {
    const rows = this.sql
      .exec(
        toolName === null
          ? `UPDATE linked_permissions SET status = 'terminal-answered'
             WHERE status = 'pending' RETURNING request_id`
          : `UPDATE linked_permissions SET status = 'terminal-answered'
             WHERE request_id = (
               SELECT request_id FROM linked_permissions
               WHERE status = 'pending' AND tool_name = ?
               ORDER BY created_at, request_id
               LIMIT 1
             )
             RETURNING request_id`,
        ...(toolName === null ? [] : [toolName])
      )
      .toArray();
    for (const row of rows) {
      const requestId = String(row["request_id"]);
      await this.withdrawWorkspaceApproval(requestId);
      this.publishPermissionSettledSignal(requestId, undefined, "terminal-answered");
    }
  }

  /** Withdraw the workspace approval card for a relayed permission whose verdict
   *  was settled elsewhere — answered at the terminal, or the bridge detached.
   *  Quiet: the card disappears without recording a deny (plan §7.5). This is the
   *  single integration point for the W6 `settleExternal` approvals contract. */
  private async withdrawWorkspaceApproval(requestId: string): Promise<void> {
    const channelId = this.primaryChannelId();
    if (!channelId) return;
    await this.rpc
      .call("main", "userlandApproval.settleExternal", [{ channelId, requestId }])
      .catch(() => {});
  }

  private async denyPendingPermissions(reason: string): Promise<void> {
    const rows = this.sql
      .exec(
        `UPDATE linked_permissions SET status = 'deny' WHERE status = 'pending' RETURNING request_id`
      )
      .toArray();
    for (const row of rows) {
      const requestId = String(row["request_id"]);
      await this.withdrawWorkspaceApproval(requestId);
      this.publishPermissionSettledSignal(requestId, "deny", "detached");
    }
    void reason;
  }

  // ── Fork hygiene ───────────────────────────────────────────────────────────

  /** A cloned linked vessel starts detached: bridge connections, delivery
   *  cursors, permission relays, and hook idempotency are per-live-session
   *  state that must not ghost into the fork. */
  protected override async onChannelForked(ctx: {
    oldChannelId: string;
    newChannelId: string;
    forkPointPubsubId: number;
  }): Promise<void> {
    this.setStateValue(ATTACHMENT_KEY, "");
    this.setStateValue(COMPLETED_KEY, "");
    this.setStateValue(ACK_SEQ_KEY, "");
    this.setStateValue(PROCESSED_SEQ_KEY, "");
    this.setStateValue(OPEN_TURN_KEY, "");
    this.setStateValue(SESSION_KEY, "");
    this.setStateValue(PRIMARY_CHANNEL_KEY, ctx.newChannelId);
    this.sql.exec(`DELETE FROM linked_bridge_queue`);
    this.sql.exec(`DELETE FROM linked_permissions`);
    this.sql.exec(`DELETE FROM linked_hook_seqs`);
    this.clearAgentAlarm(ALARM_SOURCE);
  }
}

interface TrajectoryItem {
  envelopeId: string;
  payloadKind: string;
  payload: Record<string, unknown>;
  causality?: Record<string, unknown>;
  publish?: boolean;
}
