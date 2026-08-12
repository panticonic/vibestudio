/**
 * LinkedAgentWorker — a full agent vessel whose reasoning loop lives OUTSIDE
 * the system (docs/claude-code-channels-plan.md §5).
 *
 * Where AiChatWorker runs the loop in-process, this vessel relays to an
 * attached external process (a Claude Code session, via the CLI bridge
 * `vibestudio claude channel-host`). Everything else — identity, subscriptions,
 * channel envelopes, addressing, presence, fork-cloning, subagent task duty —
 * is inherited unchanged from the vessel base. The bridge authenticates with
 * an entity-scoped `agent:` credential (caller kind "agent") and owns one
 * `openBridge()` response stream. While that response is alive,
 * addressing-approved conversation input flows through it; cancelling or losing
 * the response detaches the exact generation. While detached, input buffers
 * durably and presence shows the agent offline.
 */

import type { DurableObjectContext } from "@workspace/runtime/worker";
import { rpc } from "@workspace/runtime/worker";
import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ChannelEvent, ParticipantDescriptor } from "@workspace/harness";
import {
  AGENTIC_PROTOCOL_VERSION,
  agentToolFailureFromUnknown,
  invocationCompletedPayload,
  invocationFailedPayload,
  type AgenticEvent,
} from "@workspace/agentic-protocol";
import { ids } from "@workspace/agent-loop";
import type { ClaudeHookEvent } from "@vibestudio/shared/claudeLaunchProfile";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import type { AgentTool } from "@workspace/pi-core";
import {
  CHANNEL_SUBSCRIPTION_BUFFER_BYTES,
  channelSubscriptionQueuingStrategy,
  encodeChannelSubscriptionRecord,
  enqueueChannelSubscriptionBytes,
} from "@workspace/pubsub";

const COMPLETED_KEY = "linked:completed";
const PRIMARY_CHANNEL_KEY = "linked:primaryChannelId";
const LEGACY_ACK_SEQ_KEY = "linked:ackSeq";
const LEGACY_PROCESSED_SEQ_KEY = "linked:processedSeq";
const OPEN_TURN_KEY = "linked:openTurn";
const SESSION_KEY = "linked:session";
const DELIVERY_SCHEMA_KEY = "linked:deliverySchema";
const BRIDGE_REPLAY_PAGE_SIZE = 64;
const TERMINAL_RECEIPT_LIMIT = 256;
const SUPERSEDED_ATTEMPT_LIMIT = 4;
const HOOK_RECEIPT_LIMIT = 256;
const ENDED_HOOK_SESSION_LIMIT = 8;

export interface LinkedAttachment {
  callerId: string;
  bridgeSessionId: string;
  attachmentGeneration: string;
  sessionInfo: Record<string, unknown>;
  attachedAt: number;
}

interface LinkedBridgeStream extends LinkedAttachment {
  token: symbol;
  controller: ReadableStreamDefaultController<Uint8Array>;
  replayCursor: number;
  replayPending: boolean;
  replayPump: Promise<void> | null;
}

/** Hook events reported by the bridge (plan §7.4). `seq` is a per-session
 *  monotonic counter minted by the bridge; redelivery is a no-op. */
export type LinkedHookEvent = ClaudeHookEvent;

interface QueueRow {
  seq: number;
  kind: string;
  channelId: string;
  payload: Record<string, unknown>;
}

interface DeliveryAttempt {
  deliveryId: string;
  seq: number;
  bridgeSessionId: string;
  attachmentGeneration: string;
}

type DeliveryOutcome = "completed" | "failed" | "interrupted";

interface OpenLinkedTurn {
  turnId: string;
  turnKey: string;
  source: "local" | "channel";
  bridgeSessionId?: string;
  batchId?: string;
}

interface HookIngestOptions {
  bridgeSessionId: string;
  seq: number;
  batchId?: string;
  interruptedBatchId?: string;
  event: LinkedHookEvent;
}

const TEXT_BOUND = 8_000;

function bounded(text: unknown, max = TEXT_BOUND): string {
  const value = typeof text === "string" ? text : text == null ? "" : String(text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function sealedContentClass(event: ChannelEvent): "internal" | "external" {
  const { contentClass, externalKeys } = event;
  if (
    (contentClass !== "internal" && contentClass !== "external") ||
    !Array.isArray(externalKeys) ||
    !externalKeys.every((key) => typeof key === "string") ||
    (contentClass === "internal" && externalKeys.length > 0)
  ) {
    throw new Error("linked-agent input is missing valid durable content provenance");
  }
  return contentClass;
}

export class LinkedAgentWorker extends AgentWorkerBase {
  static override schemaVersion = AgentWorkerBase.schemaVersion;
  private bridgeStream: LinkedBridgeStream | null = null;
  private readonly hookApplications = new Map<
    string,
    { eventJson: string; promise: Promise<{ ok: boolean; duplicate?: boolean }> }
  >();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS linked_bridge_queue (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        dedupe_key TEXT UNIQUE,
        kind TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        terminal_outcome TEXT,
        terminal_at INTEGER,
        terminal_turn_id TEXT
      )
    `);
    this.ensureQueueColumn("terminal_outcome", "TEXT");
    this.ensureQueueColumn("terminal_at", "INTEGER");
    this.ensureQueueColumn("terminal_turn_id", "TEXT");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS linked_delivery_attempts (
        delivery_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        bridge_session_id TEXT NOT NULL,
        attachment_generation TEXT NOT NULL,
        offered_at INTEGER NOT NULL,
        accepted_at INTEGER,
        batch_id TEXT,
        superseded_at INTEGER,
        UNIQUE (seq, bridge_session_id, attachment_generation)
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS linked_delivery_batches (
        batch_id TEXT PRIMARY KEY,
        bridge_session_id TEXT NOT NULL,
        turn_id TEXT,
        opened_at INTEGER,
        opened_published_at INTEGER,
        outcome TEXT,
        terminal_at INTEGER,
        terminal_published_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    this.ensureBatchColumn("opened_at", "INTEGER");
    this.ensureBatchColumn("opened_published_at", "INTEGER");
    this.ensureBatchColumn("terminal_published_at", "INTEGER");
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS linked_bridge_sessions (
        session_id TEXT PRIMARY KEY,
        last_hook_seq INTEGER NOT NULL DEFAULT 0,
        ended_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS linked_hook_seqs (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_json TEXT,
        created_at INTEGER NOT NULL DEFAULT 0,
        applied_at INTEGER,
        PRIMARY KEY (session_id, seq)
      )
    `);
    this.ensureHookColumn("event_json", "TEXT");
    this.ensureHookColumn("created_at", "INTEGER NOT NULL DEFAULT 0");
    this.ensureHookColumn("applied_at", "INTEGER");
    this.migrateLegacyDeliveryState();
  }

  private ensureQueueColumn(name: string, declaration: string): void {
    const present = this.sql
      .exec(`PRAGMA table_info(linked_bridge_queue)`)
      .toArray()
      .some((row) => String(row["name"]) === name);
    if (!present)
      this.sql.exec(`ALTER TABLE linked_bridge_queue ADD COLUMN ${name} ${declaration}`);
  }

  private ensureHookColumn(name: string, declaration: string): void {
    const present = this.sql
      .exec(`PRAGMA table_info(linked_hook_seqs)`)
      .toArray()
      .some((row) => String(row["name"]) === name);
    if (!present) this.sql.exec(`ALTER TABLE linked_hook_seqs ADD COLUMN ${name} ${declaration}`);
  }

  private ensureBatchColumn(name: string, declaration: string): void {
    const present = this.sql
      .exec(`PRAGMA table_info(linked_delivery_batches)`)
      .toArray()
      .some((row) => String(row["name"]) === name);
    if (!present) {
      this.sql.exec(`ALTER TABLE linked_delivery_batches ADD COLUMN ${name} ${declaration}`);
    }
  }

  /**
   * Legacy cursors cannot prove which individual rows reached Claude or a turn
   * boundary. Deleted rows are irrecoverable; every row that still exists is
   * therefore intentionally replayable after this one-way migration.
   */
  private migrateLegacyDeliveryState(): void {
    if (this.getStateValue(DELIVERY_SCHEMA_KEY) === "2") return;
    this.setStateValue(LEGACY_ACK_SEQ_KEY, "");
    this.setStateValue(LEGACY_PROCESSED_SEQ_KEY, "");
    this.setStateValue(OPEN_TURN_KEY, "");
    this.sql.exec(
      `UPDATE linked_bridge_queue
       SET terminal_outcome = NULL, terminal_at = NULL, terminal_turn_id = NULL`
    );
    this.sql.exec(`DELETE FROM linked_hook_seqs`);
    this.setStateValue(DELIVERY_SCHEMA_KEY, "2");
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

  protected override async getLoopTools(_channelId: string): Promise<AgentTool[]> {
    return [];
  }

  protected override async shouldRespond(channelId: string, event: ChannelEvent): Promise<boolean> {
    if (sealedContentClass(event) === "external") return false;
    return super.shouldRespond(channelId, event);
  }

  // ── Response-owned bridge lifetime (plan §5.1) ─────────────────────────────

  protected attachment(): LinkedAttachment | null {
    const stream = this.bridgeStream;
    return stream
      ? {
          callerId: stream.callerId,
          bridgeSessionId: stream.bridgeSessionId,
          attachmentGeneration: stream.attachmentGeneration,
          sessionInfo: stream.sessionInfo,
          attachedAt: stream.attachedAt,
        }
      : null;
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

  private requireExternalControllerCaller(method: string): string {
    const kind = this.rpcCallerKind;
    const callerId = this.rpcCallerId ?? "";
    if (kind === "server") return callerId;
    const stateArgs = this.env["STATE_ARGS"];
    const expected =
      stateArgs && typeof stateArgs === "object"
        ? (stateArgs as Record<string, unknown>)["externalControllerCallerId"]
        : undefined;
    if (typeof expected !== "string" || !expected) {
      throw new Error(`${method}: this vessel has no external controller`);
    }
    if (callerId !== expected) {
      throw new Error(
        `${method}: caller "${callerId || "unattributed"}" is not controller "${expected}"`
      );
    }
    return callerId;
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async openBridge(opts: {
    bridgeSessionId: string;
    sessionInfo?: Record<string, unknown>;
  }): Promise<Response> {
    const callerId = this.requireBridgeCaller("openBridge");
    const bridgeSessionId = String(opts?.bridgeSessionId ?? "");
    if (!bridgeSessionId || bridgeSessionId.length > 128) {
      throw new Error("openBridge requires a bounded bridgeSessionId");
    }
    await this.recoverPendingHookApplications();
    const existingSession = this.sql
      .exec(`SELECT ended_at FROM linked_bridge_sessions WHERE session_id = ?`, bridgeSessionId)
      .toArray()[0];
    if (existingSession?.["ended_at"] != null) {
      throw new Error("openBridge cannot resume an ended bridge session");
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO linked_bridge_sessions
         (session_id, last_hook_seq, ended_at, created_at)
       VALUES (?, 0, NULL, ?)`,
      bridgeSessionId,
      now
    );
    await this.supersedeForeignSession(bridgeSessionId, now);
    this.sql.exec(
      `UPDATE linked_delivery_attempts
       SET superseded_at = ?
       WHERE bridge_session_id = ? AND accepted_at IS NULL AND superseded_at IS NULL`,
      now,
      bridgeSessionId
    );
    const attachmentGeneration = crypto.randomUUID();
    const primaryChannelId = this.primaryChannelId();
    let contextId: string | null = null;
    if (primaryChannelId) {
      try {
        contextId = this.subscriptions.getContextId(primaryChannelId);
      } catch {
        contextId = null;
      }
    }
    const result = {
      ok: true,
      bridgeSessionId,
      attachmentGeneration,
      pendingCount: this.queuePendingCountForSession(bridgeSessionId),
      primaryChannelId,
      contextId,
      channelIds: this.subscriptions.listChannelIds(),
    };

    // Replacing a response is atomic desired-state replacement. Fence the old
    // response by token before closing it so its eventual cancel callback can
    // never detach the new stream.
    const previous = this.bridgeStream;
    if (previous) {
      this.bridgeStream = null;
      try {
        previous.controller.close();
      } catch {
        // Already terminal.
      }
    }
    const token = Symbol("linked-bridge");
    let stream!: LinkedBridgeStream;
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          stream = {
            token,
            controller,
            callerId,
            bridgeSessionId,
            attachmentGeneration,
            sessionInfo: opts?.sessionInfo ?? {},
            attachedAt: Date.now(),
            replayCursor: 0,
            replayPending: true,
            replayPump: null,
          };
          this.bridgeStream = stream;
          const ack = encodeChannelSubscriptionRecord({ kind: "subscribed", result });
          if (enqueueChannelSubscriptionBytes(controller, ack) !== "enqueued") {
            void this.closeBridgeStream(token);
          }
        },
        pull: async () => this.pumpBridgeReplay(token),
        cancel: async () => this.closeBridgeStream(token),
      },
      channelSubscriptionQueuingStrategy()
    );

    try {
      await this.refreshPresence();
    } catch (error) {
      try {
        await this.closeBridgeStream(token);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "linked bridge setup and attachment cleanup failed"
        );
      }
      throw error;
    }
    return new Response(body, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    });
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async acceptDelivery(opts: {
    bridgeSessionId: string;
    attachmentGeneration: string;
    deliveryId: string;
    batchId: string;
  }): Promise<{
    ok: true;
    deliveryId: string;
    batchId: string;
    state: "transport-accepted";
  }> {
    this.requireBridgeCaller("acceptDelivery");
    const stream = this.bridgeStream;
    const bridgeSessionId = String(opts?.bridgeSessionId ?? "");
    const attachmentGeneration = String(opts?.attachmentGeneration ?? "");
    const deliveryId = String(opts?.deliveryId ?? "");
    const batchId = String(opts?.batchId ?? "");
    if (
      !stream ||
      stream.bridgeSessionId !== bridgeSessionId ||
      stream.attachmentGeneration !== attachmentGeneration
    ) {
      throw new Error("acceptDelivery rejected a stale bridge attachment");
    }
    if (!deliveryId || !batchId || deliveryId.length > 128 || batchId.length > 128) {
      throw new Error("acceptDelivery requires bounded deliveryId and batchId");
    }
    const now = Date.now();
    const attempt = this.sql
      .exec(
        `SELECT a.seq, a.bridge_session_id, a.attachment_generation,
                a.accepted_at, a.batch_id, a.superseded_at, q.terminal_at
         FROM linked_delivery_attempts a
         JOIN linked_bridge_queue q ON q.seq = a.seq
         WHERE a.delivery_id = ?`,
        deliveryId
      )
      .toArray()[0];
    if (
      !attempt ||
      String(attempt["bridge_session_id"]) !== bridgeSessionId ||
      String(attempt["attachment_generation"]) !== attachmentGeneration ||
      attempt["superseded_at"] != null ||
      attempt["terminal_at"] != null
    ) {
      throw new Error("acceptDelivery rejected an unknown or terminal delivery attempt");
    }
    if (attempt["accepted_at"] != null) {
      if (String(attempt["batch_id"]) !== batchId) {
        throw new Error("acceptDelivery cannot move an accepted delivery to another batch");
      }
      return { ok: true, deliveryId, batchId, state: "transport-accepted" };
    }
    this.sql.exec(
      `INSERT OR IGNORE INTO linked_delivery_batches
         (batch_id, bridge_session_id, turn_id, opened_at, opened_published_at,
          outcome, terminal_at, terminal_published_at, created_at)
       VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?)`,
      batchId,
      bridgeSessionId,
      now
    );
    const batch = this.sql
      .exec(
        `SELECT bridge_session_id, terminal_at FROM linked_delivery_batches WHERE batch_id = ?`,
        batchId
      )
      .toArray()[0];
    if (
      !batch ||
      String(batch["bridge_session_id"]) !== bridgeSessionId ||
      batch["terminal_at"] != null
    ) {
      throw new Error("acceptDelivery rejected a foreign or terminal batch");
    }
    this.sql.exec(
      `UPDATE linked_delivery_attempts
       SET accepted_at = ?, batch_id = ?
       WHERE delivery_id = ? AND accepted_at IS NULL AND superseded_at IS NULL`,
      now,
      batchId,
      deliveryId
    );
    return { ok: true, deliveryId, batchId, state: "transport-accepted" };
  }

  private async closeBridgeStream(token: symbol, failure?: unknown): Promise<void> {
    const stream = this.bridgeStream;
    if (!stream || stream.token !== token) return;
    this.bridgeStream = null;
    try {
      if (failure === undefined) stream.controller.close();
      else stream.controller.error(failure);
    } catch {
      // Already terminal.
    }
    await this.refreshPresence();
  }

  private async closeCurrentBridge(): Promise<void> {
    const stream = this.bridgeStream;
    if (stream) await this.closeBridgeStream(stream.token);
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

  // ── Bridge delivery (durable queue + response stream) ──────────────────────

  protected primaryChannelId(): string | null {
    const stored = this.getStateValue(PRIMARY_CHANNEL_KEY);
    if (stored) return stored;
    const first = this.subscriptions.listChannelIds()[0] ?? null;
    if (first) this.setStateValue(PRIMARY_CHANNEL_KEY, first);
    return first;
  }

  private queueRowsForSessionAfter(bridgeSessionId: string, seq: number): QueueRow[] {
    return this.sql
      .exec(
        `SELECT q.seq, q.kind, q.channel_id, q.payload
         FROM linked_bridge_queue q
         WHERE q.seq > ?
           AND q.terminal_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM linked_delivery_attempts a
             WHERE a.seq = q.seq
               AND a.bridge_session_id = ?
               AND a.accepted_at IS NOT NULL
               AND a.superseded_at IS NULL
           )
         ORDER BY q.seq
         LIMIT ?`,
        seq,
        bridgeSessionId,
        BRIDGE_REPLAY_PAGE_SIZE
      )
      .toArray()
      .map((row) => ({
        seq: Number(row["seq"]),
        kind: String(row["kind"]),
        channelId: String(row["channel_id"]),
        payload: JSON.parse(String(row["payload"])) as Record<string, unknown>,
      }));
  }

  private queuePendingCount(): number {
    const row = this.sql
      .exec(`SELECT COUNT(*) AS count FROM linked_bridge_queue WHERE terminal_at IS NULL`)
      .toArray()[0];
    return Number(row?.["count"] ?? 0);
  }

  private queuePendingCountForSession(bridgeSessionId: string): number {
    const row = this.sql
      .exec(
        `SELECT COUNT(*) AS count
         FROM linked_bridge_queue q
         WHERE q.terminal_at IS NULL
           AND NOT EXISTS (
             SELECT 1
             FROM linked_delivery_attempts a
             WHERE a.seq = q.seq
               AND a.bridge_session_id = ?
               AND a.accepted_at IS NOT NULL
               AND a.superseded_at IS NULL
           )`,
        bridgeSessionId
      )
      .toArray()[0];
    return Number(row?.["count"] ?? 0);
  }

  private queueRow(seq: number): QueueRow | null {
    const row = this.sql
      .exec(
        `SELECT seq, kind, channel_id, payload
         FROM linked_bridge_queue
         WHERE seq = ? AND terminal_at IS NULL`,
        seq
      )
      .toArray()[0];
    return row
      ? {
          seq: Number(row["seq"]),
          kind: String(row["kind"]),
          channelId: String(row["channel_id"]),
          payload: JSON.parse(String(row["payload"])) as Record<string, unknown>,
        }
      : null;
  }

  private ensureDeliveryAttempt(row: QueueRow, stream: LinkedBridgeStream): DeliveryAttempt {
    const existing = this.sql
      .exec(
        `SELECT delivery_id, seq, bridge_session_id, attachment_generation
         FROM linked_delivery_attempts
         WHERE seq = ? AND bridge_session_id = ? AND attachment_generation = ?`,
        row.seq,
        stream.bridgeSessionId,
        stream.attachmentGeneration
      )
      .toArray()[0];
    if (existing) {
      return {
        deliveryId: String(existing["delivery_id"]),
        seq: Number(existing["seq"]),
        bridgeSessionId: String(existing["bridge_session_id"]),
        attachmentGeneration: String(existing["attachment_generation"]),
      };
    }
    const delivery: DeliveryAttempt = {
      deliveryId: crypto.randomUUID(),
      seq: row.seq,
      bridgeSessionId: stream.bridgeSessionId,
      attachmentGeneration: stream.attachmentGeneration,
    };
    this.sql.exec(
      `INSERT INTO linked_delivery_attempts
         (delivery_id, seq, bridge_session_id, attachment_generation,
          offered_at, accepted_at, batch_id, superseded_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      delivery.deliveryId,
      delivery.seq,
      delivery.bridgeSessionId,
      delivery.attachmentGeneration,
      Date.now()
    );
    this.compactSupersededAttempts(row.seq);
    return delivery;
  }

  private compactSupersededAttempts(seq: number): void {
    this.sql.exec(
      `DELETE FROM linked_delivery_attempts
       WHERE delivery_id IN (
         SELECT delivery_id
         FROM linked_delivery_attempts
         WHERE seq = ? AND superseded_at IS NOT NULL
         ORDER BY superseded_at DESC, offered_at DESC
         LIMIT -1 OFFSET ?
       )`,
      seq,
      SUPERSEDED_ATTEMPT_LIMIT
    );
    this.sql.exec(
      `DELETE FROM linked_delivery_batches
       WHERE outcome = 'abandoned'
         AND batch_id NOT IN (
           SELECT batch_id FROM linked_delivery_attempts WHERE batch_id IS NOT NULL
         )`
    );
  }

  private async supersedeForeignSession(bridgeSessionId: string, now: number): Promise<void> {
    this.sql.exec(
      `UPDATE linked_bridge_sessions
       SET ended_at = COALESCE(ended_at, ?)
       WHERE session_id <> ?`,
      now,
      bridgeSessionId
    );
    const foreignBatches = this.sql
      .exec(
        `SELECT DISTINCT batch_id
         FROM linked_delivery_attempts
         WHERE bridge_session_id <> ?
           AND batch_id IS NOT NULL
           AND superseded_at IS NULL`,
        bridgeSessionId
      )
      .toArray()
      .map((row) => String(row["batch_id"]));
    this.sql.exec(
      `UPDATE linked_delivery_attempts
       SET superseded_at = ?
       WHERE bridge_session_id <> ? AND superseded_at IS NULL`,
      now,
      bridgeSessionId
    );
    for (const batchId of foreignBatches) {
      this.sql.exec(
        `UPDATE linked_delivery_batches
         SET outcome = COALESCE(outcome, 'abandoned'),
             terminal_at = COALESCE(terminal_at, ?)
         WHERE batch_id = ?`,
        now,
        batchId
      );
    }
    for (const row of this.sql
      .exec(`SELECT DISTINCT seq FROM linked_delivery_attempts WHERE superseded_at IS NOT NULL`)
      .toArray()) {
      this.compactSupersededAttempts(Number(row["seq"]));
    }
    this.compactHookReceipts(bridgeSessionId);
    const open = this.openTurn();
    if (
      open?.source === "channel" &&
      open.bridgeSessionId &&
      open.bridgeSessionId !== bridgeSessionId
    ) {
      await this.closeOpenTurn("linked session replaced before a terminal hook");
    }
  }

  private async pumpBridgeReplay(token: symbol): Promise<void> {
    const stream = this.bridgeStream;
    if (!stream || stream.token !== token || !stream.replayPending) return;
    if (stream.replayPump) return stream.replayPump;

    const pump = this.runBridgeReplay(stream);
    stream.replayPump = pump;
    try {
      await pump;
    } catch (error) {
      try {
        await this.closeBridgeStream(token, error);
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "linked bridge replay and cleanup failed");
      }
      throw error;
    } finally {
      if (stream.replayPump === pump) stream.replayPump = null;
    }
  }

  /** Fill only currently available response capacity, reading durable rows one page at a time. */
  private async runBridgeReplay(stream: LinkedBridgeStream): Promise<void> {
    while (this.bridgeStream === stream && stream.replayPending) {
      const rows = this.queueRowsForSessionAfter(stream.bridgeSessionId, stream.replayCursor);
      if (rows.length === 0) {
        stream.replayPending = false;
        return;
      }
      for (const row of rows) {
        if (this.bridgeStream !== stream) return;
        const delivery = this.ensureDeliveryAttempt(row, stream);
        const bytes = encodeChannelSubscriptionRecord({
          kind: "message",
          payload: this.queueEventPayload(row, delivery),
        });
        if (bytes.byteLength > CHANNEL_SUBSCRIPTION_BUFFER_BYTES) {
          throw new Error("Linked bridge replay record exceeds the response buffer limit");
        }
        const capacity = stream.controller.desiredSize;
        if (capacity === null) return;
        if (bytes.byteLength > capacity) return;

        const outcome = enqueueChannelSubscriptionBytes(stream.controller, bytes);
        if (outcome === "backpressured") return;
        if (outcome !== "enqueued") {
          throw new Error(`Linked bridge replay record cannot be delivered: ${outcome}`);
        }
        stream.replayCursor = row.seq;
      }
    }
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

  private queueEventPayload(row: QueueRow, delivery: DeliveryAttempt): Record<string, unknown> {
    return {
      kind: row.kind,
      seq: row.seq,
      channelId: row.channelId,
      deliveryId: delivery.deliveryId,
      bridgeSessionId: delivery.bridgeSessionId,
      attachmentGeneration: delivery.attachmentGeneration,
      ...row.payload,
    };
  }

  /** Enqueue onto the response-owned bridge tail. The durable queue remains
   *  authoritative; a failed response write terminates that exact attachment. */
  protected emitToBridge(payload: Record<string, unknown>): void {
    const stream = this.bridgeStream;
    if (!stream) return;
    const seq = payload["seq"];
    if (stream.replayPending && typeof seq === "number" && seq > stream.replayCursor) return;
    try {
      let exactPayload = payload;
      if (typeof seq === "number") {
        const row = this.queueRow(seq);
        if (!row) return;
        exactPayload = this.queueEventPayload(row, this.ensureDeliveryAttempt(row, stream));
      }
      const bytes = encodeChannelSubscriptionRecord({ kind: "message", payload: exactPayload });
      if (enqueueChannelSubscriptionBytes(stream.controller, bytes) !== "enqueued") {
        void this.closeBridgeStream(stream.token);
      }
    } catch {
      void this.closeBridgeStream(stream.token);
    }
  }

  /** The vessel-base seam: addressing-approved conversation input is queued for
   *  the external session instead of driving the in-process loop. */
  protected override async dispatchApprovedInput(
    channelId: string,
    event: ChannelEvent,
    sourceMessageId: string | undefined
  ): Promise<void> {
    // The subagent task seed is delivered out-of-band as the headless launch
    // prompt (`claude -p <task>`); relaying it here would hand the session its
    // task twice (live push + attach replay). It stays on the channel for
    // trajectory visibility and `channel history`, just not in the bridge queue.
    if (event.messageId.startsWith("subagent-seed:")) return;
    if (!sourceMessageId) {
      throw new Error(
        `linked input ${event.messageId} has no canonical source message identity; refusing an unwalkable turn`
      );
    }
    const agentic = event.payload as AgenticEvent | null;
    const senderMetadata = (event as { senderMetadata?: Record<string, unknown> }).senderMetadata;
    const payload = (agentic?.payload ?? {}) as { mentions?: string[] };
    const content = this.turnContent(channelId, event);
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
      triggerMessageId: sourceMessageId,
      meta,
    });
    if (seq !== null) {
      this.emitToBridge({ kind: "message", seq, channelId, content, meta });
    }
  }

  // ── Outbound: say / complete (plan §7.2) ───────────────────────────────────

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
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
    const subagent = this.subagentIdentity();
    const parentParticipantId = subagent?.parentParticipantId;
    if (!opts.to && subagent && !parentParticipantId) {
      throw new Error("say: subagent supervisor participant is unavailable");
    }
    let mentions = opts.mentions;
    if (mentions?.length) {
      const participants = await this.createChannelClient(channelId).getParticipants();
      const byHandle = new Map(
        participants.flatMap((participant) => {
          const handle = participant.metadata["handle"];
          return typeof handle === "string" && handle
            ? [[handle, participant.participantId] as const]
            : [];
        })
      );
      mentions = mentions.map((handle) => {
        const participantIdForHandle = byHandle.get(handle);
        if (!participantIdForHandle) {
          throw new Error(`say: unknown participant handle ${handle}`);
        }
        return participantIdForHandle;
      });
    }
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
      ...(mentions ? { mentions } : {}),
      ...(opts.to
        ? { to: opts.to }
        : parentParticipantId
          ? { to: [{ kind: "participant" as const, participantId: parentParticipantId }] }
          : {}),
      ...(opts.idempotencyKey ? { idempotencyKey: `say:${opts.idempotencyKey}` } : {}),
    });
    return { ok: true, messageId, channelId };
  }

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
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
   * Authoritative terminal result from the extension supervising a headless
   * external engine. The exact controller identity is stamped into STATE_ARGS
   * when the vessel is created; no unrelated extension may settle the run.
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async reportExternalResult(opts: {
    runId?: string;
    report?: string;
    outcome?: "success" | "failed";
    code?: number | null;
  }): Promise<{ ok: boolean; settled: boolean }> {
    this.requireExternalControllerCaller("reportExternalResult");
    const sub = this.subagentIdentity();
    if (!sub) return { ok: true, settled: false };
    if (!opts?.runId || opts.runId !== sub.runId) return { ok: true, settled: false };
    if (this.getStateValue(COMPLETED_KEY)) return { ok: true, settled: false };
    this.setStateValue(COMPLETED_KEY, "1");
    await this.closeCurrentBridge();
    const report =
      typeof opts.report === "string" && opts.report.trim()
        ? opts.report.trim()
        : `External agent completed with exit code ${opts.code ?? "unknown"} and no report.`;
    await this.completeAsSubagent(report, opts.outcome === "failed" ? "failed" : "success");
    return { ok: true, settled: true };
  }

  /**
   * Launcher-extension report that the external headless process exited (§8.2
   * failure path). If this vessel carries subagent duty and the session never
   * called `complete`, settle the parent's run as failed instead of leaving it
   * dangling as "running". Idempotent: a post-complete exit (the normal case —
   * every headless process eventually exits) and a duplicate report both no-op.
   * The durable task event and recipient transition are independently idempotent.
   * The controller identity stamped into STATE_ARGS is the authorization; an
   * unrelated extension cannot forge a terminal exit.
   */
  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async reportExternalExit(opts: {
    runId?: string;
    code?: number | null;
    signal?: string | null;
  }): Promise<{ ok: boolean; settled: boolean }> {
    this.requireExternalControllerCaller("reportExternalExit");
    const sub = this.subagentIdentity();
    if (!sub) return { ok: true, settled: false };
    if (opts?.runId && opts.runId !== sub.runId) return { ok: true, settled: false };
    if (this.getStateValue(COMPLETED_KEY)) return { ok: true, settled: false };
    this.setStateValue(COMPLETED_KEY, "1");
    await this.closeCurrentBridge();
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

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async linkedStatus(): Promise<{
    attached: boolean;
    sessionInfo: Record<string, unknown> | null;
    pendingCount: number;
    queuedCount: number;
    acceptedCount: number;
    terminalPendingPublicationCount: number;
    terminalReceiptCount: number;
    activeBatchId: string | null;
    primaryChannelId: string | null;
    channelIds: string[];
  }> {
    this.requireBridgeCaller("linkedStatus");
    return this.linkedStatusResult();
  }

  private linkedStatusResult() {
    const attachment = this.attachment();
    const counts = this.sql
      .exec(
        `SELECT
           SUM(CASE WHEN q.terminal_at IS NULL AND NOT EXISTS (
             SELECT 1 FROM linked_delivery_attempts a
             WHERE a.seq = q.seq AND a.accepted_at IS NOT NULL AND a.superseded_at IS NULL
           ) THEN 1 ELSE 0 END) AS queued_count,
           SUM(CASE WHEN q.terminal_at IS NULL AND EXISTS (
             SELECT 1 FROM linked_delivery_attempts a
             WHERE a.seq = q.seq AND a.accepted_at IS NOT NULL AND a.superseded_at IS NULL
           ) THEN 1 ELSE 0 END) AS accepted_count,
           SUM(CASE WHEN q.terminal_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM linked_delivery_attempts a
             JOIN linked_delivery_batches b ON b.batch_id = a.batch_id
             WHERE a.seq = q.seq AND b.terminal_published_at IS NULL
           ) THEN 1 ELSE 0 END) AS terminal_pending_count,
           SUM(CASE WHEN q.terminal_at IS NOT NULL AND EXISTS (
             SELECT 1 FROM linked_delivery_attempts a
             JOIN linked_delivery_batches b ON b.batch_id = a.batch_id
             WHERE a.seq = q.seq AND b.terminal_published_at IS NOT NULL
           ) THEN 1 ELSE 0 END) AS terminal_count
         FROM linked_bridge_queue q`
      )
      .toArray()[0];
    const open = this.openTurn();
    return {
      attached: attachment !== null,
      sessionInfo: attachment?.sessionInfo ?? null,
      pendingCount: this.queuePendingCount(),
      queuedCount: Number(counts?.["queued_count"] ?? 0),
      acceptedCount: Number(counts?.["accepted_count"] ?? 0),
      terminalPendingPublicationCount: Number(counts?.["terminal_pending_count"] ?? 0),
      terminalReceiptCount: Number(counts?.["terminal_count"] ?? 0),
      activeBatchId: open?.source === "channel" ? (open.batchId ?? null) : null,
      primaryChannelId: this.primaryChannelId(),
      channelIds: this.subscriptions.listChannelIds(),
    };
  }

  @rpc({
    principals: ["host", "code"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "read",
  })
  async deliveryReceipt(opts: { dedupeKey: string }): Promise<{
    found: boolean;
    state?:
      | "queued"
      | "offered"
      | "transport-accepted"
      | "terminal-pending-publication"
      | "terminal";
    batchId?: string | null;
    turnId?: string | null;
    outcome?: DeliveryOutcome | null;
    terminalAt?: number | null;
  }> {
    this.requireExternalControllerCaller("deliveryReceipt");
    const dedupeKey = String(opts?.dedupeKey ?? "");
    if (!dedupeKey || dedupeKey.length > 512) {
      throw new Error("deliveryReceipt requires a bounded dedupeKey");
    }
    const row = this.sql
      .exec(
        `SELECT seq, terminal_outcome, terminal_at, terminal_turn_id
         FROM linked_bridge_queue WHERE dedupe_key = ?`,
        dedupeKey
      )
      .toArray()[0];
    if (!row) return { found: false };
    if (row["terminal_at"] != null) {
      const publication = this.sql
        .exec(
          `SELECT b.terminal_published_at
           FROM linked_delivery_attempts a
           JOIN linked_delivery_batches b ON b.batch_id = a.batch_id
           WHERE a.seq = ? AND b.terminal_at IS NOT NULL
           ORDER BY b.terminal_at DESC LIMIT 1`,
          Number(row["seq"])
        )
        .toArray()[0];
      return {
        found: true,
        state:
          publication?.["terminal_published_at"] == null
            ? "terminal-pending-publication"
            : "terminal",
        turnId: row["terminal_turn_id"] == null ? null : String(row["terminal_turn_id"]),
        outcome: String(row["terminal_outcome"]) as DeliveryOutcome,
        terminalAt: Number(row["terminal_at"]),
      };
    }
    const attempt = this.sql
      .exec(
        `SELECT accepted_at, batch_id
         FROM linked_delivery_attempts
         WHERE seq = ? AND superseded_at IS NULL
         ORDER BY offered_at DESC LIMIT 1`,
        Number(row["seq"])
      )
      .toArray()[0];
    if (!attempt) return { found: true, state: "queued", batchId: null };
    return {
      found: true,
      state: attempt["accepted_at"] == null ? "offered" : "transport-accepted",
      batchId: attempt["batch_id"] == null ? null : String(attempt["batch_id"]),
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
          { content: text, meta: { from: this.rpcCallerId ?? "channel" } }
        );
        if (seq !== null) {
          this.emitToBridge({
            kind: "prompt",
            seq,
            channelId,
            content: text,
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

  // ── Observable trajectory and causal recording from hooks (plan §7.4) ─────

  @rpc({
    principals: ["host"],
    effect: { kind: "open" },
    tier: "open",
    sensitivity: "write",
  })
  async ingestHookEvent(opts: HookIngestOptions): Promise<{ ok: boolean; duplicate?: boolean }> {
    this.requireBridgeCaller("ingestHookEvent");
    const sessionId = String(opts?.bridgeSessionId ?? "");
    const seq = Number(opts?.seq);
    if (!sessionId || sessionId.length > 128 || !Number.isInteger(seq) || seq < 1) {
      throw new Error(
        "ingestHookEvent requires a bounded bridgeSessionId and positive integer seq"
      );
    }
    const batchId = opts?.batchId == null ? null : String(opts.batchId);
    const interruptedBatchId =
      opts?.interruptedBatchId == null ? null : String(opts.interruptedBatchId);
    if ((batchId?.length ?? 0) > 128 || (interruptedBatchId?.length ?? 0) > 128) {
      throw new Error("ingestHookEvent batch identities must be bounded");
    }
    const eventJson = JSON.stringify({ batchId, interruptedBatchId, event: opts.event });
    await this.recoverPendingHookApplications(sessionId, seq);
    const applicationKey = `${sessionId}:${seq}`;
    const active = this.hookApplications.get(applicationKey);
    if (active) {
      if (active.eventJson !== eventJson) {
        throw new Error("ingestHookEvent rejected concurrent same-sequence payload drift");
      }
      await active.promise;
      return { ok: true, duplicate: true };
    }
    const promise = this.ingestHookEventOwned(opts, eventJson);
    this.hookApplications.set(applicationKey, { eventJson, promise });
    try {
      return await promise;
    } finally {
      if (this.hookApplications.get(applicationKey)?.promise === promise) {
        this.hookApplications.delete(applicationKey);
      }
    }
  }

  private async ingestHookEventOwned(
    opts: HookIngestOptions,
    eventJson: string
  ): Promise<{ ok: boolean; duplicate?: boolean }> {
    const sessionId = String(opts.bridgeSessionId);
    const seq = Number(opts.seq);
    const batchId = opts.batchId == null ? null : String(opts.batchId);
    const interruptedBatchId =
      opts.interruptedBatchId == null ? null : String(opts.interruptedBatchId);
    const existing = this.sql
      .exec(
        `SELECT event_json, applied_at FROM linked_hook_seqs WHERE session_id = ? AND seq = ?`,
        sessionId,
        seq
      )
      .toArray()[0];
    if (existing) {
      if (String(existing["event_json"] ?? "") !== eventJson) {
        throw new Error("ingestHookEvent rejected same-sequence payload drift");
      }
      if (existing["applied_at"] != null) return { ok: true, duplicate: true };
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT OR IGNORE INTO linked_bridge_sessions
         (session_id, last_hook_seq, ended_at, created_at)
       VALUES (?, 0, NULL, ?)`,
      sessionId,
      now
    );
    const session = this.sql
      .exec(
        `SELECT last_hook_seq, ended_at FROM linked_bridge_sessions WHERE session_id = ?`,
        sessionId
      )
      .toArray()[0];
    if (!session || session["ended_at"] != null) {
      throw new Error("ingestHookEvent rejected an ended bridge session");
    }
    const lastSeq = Number(session["last_hook_seq"] ?? 0);
    if (!existing && seq !== lastSeq + 1) {
      throw new Error(`ingestHookEvent expected sequence ${lastSeq + 1}, received ${seq}`);
    }
    if (!existing) {
      this.sql.exec(
        `INSERT INTO linked_hook_seqs (session_id, seq, event_json, created_at, applied_at)
         VALUES (?, ?, ?, ?, NULL)`,
        sessionId,
        seq,
        eventJson,
        now
      );
    }

    const channelId = this.primaryChannelId();
    if (channelId) {
      await this.applyHookEvent({
        channelId,
        bridgeSessionId: sessionId,
        seq,
        batchId,
        interruptedBatchId,
        event: opts.event,
      });
    }
    const appliedAt = Date.now();
    this.sql.exec(
      `UPDATE linked_hook_seqs SET applied_at = ? WHERE session_id = ? AND seq = ?`,
      appliedAt,
      sessionId,
      seq
    );
    this.sql.exec(
      `UPDATE linked_bridge_sessions SET last_hook_seq = ? WHERE session_id = ?`,
      seq,
      sessionId
    );
    if (opts.event.hook === "SessionEnd") {
      this.sql.exec(
        `UPDATE linked_bridge_sessions SET ended_at = ? WHERE session_id = ?`,
        appliedAt,
        sessionId
      );
    }
    this.compactHookReceipts(sessionId);
    return { ok: true };
  }

  /**
   * An unapplied hook row is a durable continuation, not a failed watermark.
   * A live concurrent application is joined through `hookApplications`; after
   * eviction there can be no surviving external call, so the next semantic
   * ingress replays the deterministic trajectory envelopes and advances the
   * same durable row.
   */
  private async recoverPendingHookApplications(
    onlySessionId?: string,
    beforeSeq?: number
  ): Promise<void> {
    for (;;) {
      const conditions = ["applied_at IS NULL"];
      const bindings: unknown[] = [];
      if (onlySessionId) {
        conditions.push("session_id = ?");
        bindings.push(onlySessionId);
      }
      if (beforeSeq !== undefined) {
        conditions.push("seq < ?");
        bindings.push(beforeSeq);
      }
      const row = this.sql
        .exec(
          `SELECT session_id, seq, event_json
           FROM linked_hook_seqs
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at, session_id, seq
           LIMIT 1`,
          ...bindings
        )
        .toArray()[0];
      if (!row) return;
      const bridgeSessionId = String(row["session_id"]);
      const seq = Number(row["seq"]);
      const eventJson = String(row["event_json"] ?? "");
      const applicationKey = `${bridgeSessionId}:${seq}`;
      const active = this.hookApplications.get(applicationKey);
      if (active) {
        if (active.eventJson !== eventJson) {
          throw new Error("durable hook continuation drifted from its live application");
        }
        await active.promise;
        continue;
      }
      const parsed = JSON.parse(eventJson) as {
        batchId: string | null;
        interruptedBatchId: string | null;
        event: LinkedHookEvent;
      };
      const opts: HookIngestOptions = {
        bridgeSessionId,
        seq,
        ...(parsed.batchId ? { batchId: parsed.batchId } : {}),
        ...(parsed.interruptedBatchId ? { interruptedBatchId: parsed.interruptedBatchId } : {}),
        event: parsed.event,
      };
      const promise = this.ingestHookEventOwned(opts, eventJson);
      this.hookApplications.set(applicationKey, { eventJson, promise });
      try {
        await promise;
      } finally {
        if (this.hookApplications.get(applicationKey)?.promise === promise) {
          this.hookApplications.delete(applicationKey);
        }
      }
    }
  }

  private async applyHookEvent(input: {
    channelId: string;
    bridgeSessionId: string;
    seq: number;
    batchId: string | null;
    interruptedBatchId: string | null;
    event: LinkedHookEvent;
  }): Promise<void> {
    const {
      channelId,
      bridgeSessionId: sessionId,
      seq,
      batchId,
      interruptedBatchId,
      event,
    } = input;

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
        if (interruptedBatchId) {
          await this.terminalizeBatch(channelId, sessionId, interruptedBatchId, "interrupted");
        }
        const turnId = this.turnIdFor(channelId, sessionId, event.turnKey);
        const existing = this.openTurn();
        if (existing?.turnKey === event.turnKey) break;
        if (existing && existing.turnKey !== event.turnKey) {
          await this.closeOpenTurn("new terminal prompt submitted");
        }
        this.setStateValue(
          OPEN_TURN_KEY,
          JSON.stringify({
            turnId,
            turnKey: event.turnKey,
            source: "local",
          } satisfies OpenLinkedTurn)
        );
        const messageId = `lm:${turnId}:user`;
        await this.appendTrajectory(channelId, [
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
                  content: event.promptText,
                },
              ],
              outcome: "completed",
              tier: "primary",
              metadata: { source: "terminal" },
            },
            causality: { turnId, messageId },
            publish: true,
          },
          this.triggeredTurnOpenedItem(turnId, messageId),
        ]);
        break;
      }
      case "PreToolUse": {
        if (batchId) await this.activateBatch(channelId, sessionId, batchId, batchId);
        const invocationId = `linv:${sessionId}:${event.toolUseId}`;
        await this.appendTrajectory(channelId, [
          {
            envelopeId: ids.invocationStart(invocationId),
            payloadKind: "invocation.started",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              name: event.toolName,
              invocationType: "tool",
              userVisible: true,
              ...(event.request !== undefined ? { request: event.request } : {}),
            },
            causality: { invocationId, ...this.openTurnCausality() },
            publish: true,
          },
        ]);
        break;
      }
      case "PostToolUse": {
        if (batchId) await this.activateBatch(channelId, sessionId, batchId, batchId);
        const invocationId = `linv:${sessionId}:${event.toolUseId}`;
        await this.appendTrajectory(channelId, [
          {
            envelopeId: ids.invocationTerminal(invocationId),
            payloadKind: "invocation.completed",
            payload: invocationCompletedPayload({
              ...(event.outputSummary ? { summary: bounded(event.outputSummary, 2_000) } : {}),
            }),
            causality: { invocationId, ...this.openTurnCausality() },
            publish: true,
          },
        ]);
        break;
      }
      case "PostToolUseFailure": {
        if (batchId) await this.activateBatch(channelId, sessionId, batchId, batchId);
        const invocationId = `linv:${sessionId}:${event.toolUseId}`;
        await this.appendTrajectory(channelId, [
          {
            envelopeId: ids.invocationTerminal(invocationId),
            payloadKind: "invocation.failed",
            payload: invocationFailedPayload("tool_error", bounded(event.error, 2_000), {
              failure: agentToolFailureFromUnknown(
                { message: event.error },
                {
                  operation: event.toolName ?? "external-tool",
                  stage: "external-tool",
                  causal: { invocationId },
                }
              ),
            }),
            causality: { invocationId, ...this.openTurnCausality() },
            publish: true,
          },
        ]);
        break;
      }
      case "Stop": {
        const open = batchId
          ? (this.terminalTurnForBatch(batchId, sessionId) ??
            (await this.activateBatch(channelId, sessionId, batchId, event.turnKey)))
          : this.openTurn();
        if (!open) {
          throw new Error(
            `linked Stop ${event.turnKey} has no captured prompt or received message; refusing to invent turn causality`
          );
        }
        const turnId = open.turnId;
        const messageId = `lm:${turnId}:final`;
        const items: TrajectoryItem[] = [];
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
                  content: event.finalText,
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
        if (batchId) this.prepareBatchTerminal(batchId, sessionId, turnId, "completed");
        this.setStateValue(OPEN_TURN_KEY, "");
        await this.appendTrajectory(channelId, items);
        if (batchId) this.finishBatchTerminalPublication(batchId, sessionId);
        break;
      }
      case "StopFailure": {
        const open = batchId
          ? (this.terminalTurnForBatch(batchId, sessionId) ??
            (await this.activateBatch(channelId, sessionId, batchId, event.turnKey)))
          : this.openTurn();
        if (!open) throw new Error("linked StopFailure has no active turn");
        if (batchId) this.prepareBatchTerminal(batchId, sessionId, open.turnId, "failed");
        this.setStateValue(OPEN_TURN_KEY, "");
        await this.appendTrajectory(channelId, [
          {
            envelopeId: ids.turnClosed(open.turnId),
            payloadKind: "turn.closed",
            payload: {
              protocol: AGENTIC_PROTOCOL_VERSION,
              reason: bounded(`Claude API failure: ${event.errorDetails ?? event.error}`, 512),
            },
            causality: { turnId: open.turnId },
            publish: true,
          },
        ]);
        if (batchId) this.finishBatchTerminalPublication(batchId, sessionId);
        break;
      }
      case "SessionEnd": {
        const open = this.openTurn();
        if (open?.bridgeSessionId === sessionId && open.batchId) {
          this.abandonBatch(open.batchId, sessionId, Date.now());
        }
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
        if (open?.bridgeSessionId === sessionId) {
          await this.closeOpenTurn("linked session ended before a terminal hook");
        }
        break;
      }
    }
  }

  private turnIdFor(channelId: string, sessionId: string, turnKey: string): string {
    return ids.turnId(channelId, `hook:${sessionId}:${turnKey}`, this.participantId());
  }

  private async activateBatch(
    channelId: string,
    bridgeSessionId: string,
    batchId: string,
    turnKey: string
  ): Promise<OpenLinkedTurn> {
    const open = this.openTurn();
    if (open) {
      if (
        !(
          open.source === "channel" &&
          open.bridgeSessionId === bridgeSessionId &&
          open.batchId === batchId
        )
      )
        throw new Error("linked channel batch cannot replace another active turn");
    }
    const batch = this.sql
      .exec(
        `SELECT bridge_session_id, turn_id, opened_published_at, terminal_at
         FROM linked_delivery_batches WHERE batch_id = ?`,
        batchId
      )
      .toArray()[0];
    if (
      !batch ||
      String(batch["bridge_session_id"]) !== bridgeSessionId ||
      batch["terminal_at"] != null
    ) {
      throw new Error("linked hook references a foreign or terminal delivery batch");
    }
    const first = this.sql
      .exec(
        `SELECT q.seq, q.kind, q.channel_id, q.payload
         FROM linked_delivery_attempts a
         JOIN linked_bridge_queue q ON q.seq = a.seq
         WHERE a.batch_id = ?
           AND a.bridge_session_id = ?
           AND a.accepted_at IS NOT NULL
           AND a.superseded_at IS NULL
           AND q.terminal_at IS NULL
         ORDER BY q.seq
         LIMIT 1`,
        batchId,
        bridgeSessionId
      )
      .toArray()[0];
    if (!first) throw new Error("linked hook batch has no accepted delivery members");
    const row: QueueRow = {
      seq: Number(first["seq"]),
      kind: String(first["kind"]),
      channelId: String(first["channel_id"]),
      payload: JSON.parse(String(first["payload"])) as Record<string, unknown>,
    };
    if (row.channelId !== channelId) {
      throw new Error("linked hook batch channel drifted from the vessel primary channel");
    }
    const turnId =
      open?.turnId ??
      (batch["turn_id"] == null
        ? ids.turnId(
            channelId,
            `bridge:${bridgeSessionId}:${batchId}:${turnKey}`,
            this.participantId()
          )
        : String(batch["turn_id"]));
    const items: TrajectoryItem[] = [];
    if (row.kind === "message") {
      const triggerMessageId = row.payload["triggerMessageId"];
      if (typeof triggerMessageId !== "string" || !triggerMessageId) {
        throw new Error(`linked queue row ${row.seq} has no canonical trigger message identity`);
      }
      items.push(this.triggeredTurnOpenedItem(turnId, triggerMessageId));
    } else {
      const content = bounded(row.payload["content"]);
      const messageId = `lm:${turnId}:channel-command`;
      items.push(
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
        this.triggeredTurnOpenedItem(turnId, messageId)
      );
    }
    this.sql.exec(
      `UPDATE linked_delivery_batches
       SET turn_id = ?, opened_at = COALESCE(opened_at, ?)
       WHERE batch_id = ? AND bridge_session_id = ? AND terminal_at IS NULL`,
      turnId,
      Date.now(),
      batchId,
      bridgeSessionId
    );
    const active: OpenLinkedTurn = {
      turnId,
      turnKey,
      source: "channel",
      bridgeSessionId,
      batchId,
    };
    this.setStateValue(OPEN_TURN_KEY, JSON.stringify(active));
    if (batch["opened_published_at"] != null) return active;
    await this.appendTrajectory(channelId, items);
    this.sql.exec(
      `UPDATE linked_delivery_batches
       SET opened_published_at = COALESCE(opened_published_at, ?)
       WHERE batch_id = ? AND bridge_session_id = ?`,
      Date.now(),
      batchId,
      bridgeSessionId
    );
    return active;
  }

  private async terminalizeBatch(
    channelId: string,
    bridgeSessionId: string,
    batchId: string,
    outcome: DeliveryOutcome
  ): Promise<void> {
    const open = this.terminalTurnForBatch(batchId, bridgeSessionId) ?? this.openTurn();
    if (
      !open ||
      open.source !== "channel" ||
      open.bridgeSessionId !== bridgeSessionId ||
      open.batchId !== batchId
    ) {
      throw new Error("linked terminal receipt does not own the active delivery batch");
    }
    this.prepareBatchTerminal(batchId, bridgeSessionId, open.turnId, outcome);
    this.setStateValue(OPEN_TURN_KEY, "");
    await this.appendTrajectory(channelId, [
      {
        envelopeId: ids.turnClosed(open.turnId),
        payloadKind: "turn.closed",
        payload: { protocol: AGENTIC_PROTOCOL_VERSION, reason: outcome },
        causality: { turnId: open.turnId },
        publish: true,
      },
    ]);
    this.finishBatchTerminalPublication(batchId, bridgeSessionId);
  }

  private prepareBatchTerminal(
    batchId: string,
    bridgeSessionId: string,
    turnId: string,
    outcome: DeliveryOutcome
  ): void {
    const now = Date.now();
    const batch = this.sql
      .exec(
        `SELECT bridge_session_id, turn_id, outcome, terminal_at
         FROM linked_delivery_batches WHERE batch_id = ?`,
        batchId
      )
      .toArray()[0];
    if (!batch || String(batch["bridge_session_id"]) !== bridgeSessionId) {
      throw new Error("linked terminal receipt references a foreign delivery batch");
    }
    if (batch["terminal_at"] != null) {
      if (String(batch["outcome"]) !== outcome || String(batch["turn_id"]) !== turnId) {
        throw new Error("linked terminal receipt drifted after persistence");
      }
      return;
    }
    this.sql.exec(
      `UPDATE linked_delivery_batches
       SET turn_id = ?, outcome = ?, terminal_at = ?
       WHERE batch_id = ? AND terminal_at IS NULL`,
      turnId,
      outcome,
      now,
      batchId
    );
    this.sql.exec(
      `UPDATE linked_bridge_queue
       SET terminal_outcome = ?, terminal_at = ?, terminal_turn_id = ?
       WHERE terminal_at IS NULL AND seq IN (
         SELECT seq FROM linked_delivery_attempts
         WHERE batch_id = ?
           AND bridge_session_id = ?
           AND accepted_at IS NOT NULL
           AND superseded_at IS NULL
       )`,
      outcome,
      now,
      turnId,
      batchId,
      bridgeSessionId
    );
  }

  private finishBatchTerminalPublication(batchId: string, bridgeSessionId: string): void {
    const publishedAt = Date.now();
    this.sql.exec(
      `UPDATE linked_delivery_batches
       SET terminal_published_at = COALESCE(terminal_published_at, ?)
       WHERE batch_id = ? AND bridge_session_id = ? AND terminal_at IS NOT NULL`,
      publishedAt,
      batchId,
      bridgeSessionId
    );
    this.sql.exec(
      `UPDATE linked_bridge_queue SET payload = '{}'
       WHERE terminal_at IS NOT NULL AND seq IN (
         SELECT seq FROM linked_delivery_attempts
         WHERE batch_id = ? AND bridge_session_id = ?
       )`,
      batchId,
      bridgeSessionId
    );
    this.compactTerminalReceipts();
  }

  private terminalTurnForBatch(batchId: string, bridgeSessionId: string): OpenLinkedTurn | null {
    const batch = this.sql
      .exec(
        `SELECT turn_id, terminal_at FROM linked_delivery_batches
         WHERE batch_id = ? AND bridge_session_id = ?`,
        batchId,
        bridgeSessionId
      )
      .toArray()[0];
    if (!batch || batch["terminal_at"] == null || batch["turn_id"] == null) return null;
    return {
      turnId: String(batch["turn_id"]),
      turnKey: batchId,
      source: "channel",
      bridgeSessionId,
      batchId,
    };
  }

  private abandonBatch(batchId: string, bridgeSessionId: string, at: number): void {
    this.sql.exec(
      `UPDATE linked_delivery_attempts
       SET superseded_at = COALESCE(superseded_at, ?)
       WHERE batch_id = ? AND bridge_session_id = ?`,
      at,
      batchId,
      bridgeSessionId
    );
    this.sql.exec(
      `UPDATE linked_delivery_batches
       SET outcome = COALESCE(outcome, 'abandoned'), terminal_at = COALESCE(terminal_at, ?)
       WHERE batch_id = ? AND bridge_session_id = ?`,
      at,
      batchId,
      bridgeSessionId
    );
  }

  /** The trajectory is canonical long-term history. SQL receipts retain only a
   * finite recent diagnostic window and a small replay-attempt tail. */
  private compactTerminalReceipts(): void {
    const expired = this.sql
      .exec(
        `SELECT seq FROM linked_bridge_queue
         WHERE terminal_at IS NOT NULL
           AND EXISTS (
             SELECT 1
             FROM linked_delivery_attempts a
             JOIN linked_delivery_batches b ON b.batch_id = a.batch_id
             WHERE a.seq = linked_bridge_queue.seq
               AND b.terminal_published_at IS NOT NULL
           )
         ORDER BY terminal_at DESC, seq DESC
         LIMIT -1 OFFSET ?`,
        TERMINAL_RECEIPT_LIMIT
      )
      .toArray()
      .map((row) => Number(row["seq"]));
    for (const seq of expired) {
      this.sql.exec(`DELETE FROM linked_delivery_attempts WHERE seq = ?`, seq);
      this.sql.exec(`DELETE FROM linked_bridge_queue WHERE seq = ?`, seq);
    }
    this.sql.exec(
      `DELETE FROM linked_delivery_batches
       WHERE terminal_published_at IS NOT NULL
         AND batch_id NOT IN (
           SELECT batch_id FROM linked_delivery_attempts WHERE batch_id IS NOT NULL
         )`
    );
  }

  private compactHookReceipts(sessionId: string): void {
    this.sql.exec(
      `DELETE FROM linked_hook_seqs
       WHERE session_id = ? AND seq IN (
         SELECT seq FROM linked_hook_seqs
         WHERE session_id = ? AND applied_at IS NOT NULL
         ORDER BY seq DESC
         LIMIT -1 OFFSET ?
       )`,
      sessionId,
      sessionId,
      HOOK_RECEIPT_LIMIT
    );
    const expiredSessions = this.sql
      .exec(
        `SELECT session_id FROM linked_bridge_sessions
         WHERE ended_at IS NOT NULL
         ORDER BY ended_at DESC
         LIMIT -1 OFFSET ?`,
        ENDED_HOOK_SESSION_LIMIT
      )
      .toArray()
      .map((row) => String(row["session_id"]));
    for (const expired of expiredSessions) {
      this.sql.exec(`DELETE FROM linked_hook_seqs WHERE session_id = ?`, expired);
      this.sql.exec(`DELETE FROM linked_bridge_sessions WHERE session_id = ?`, expired);
    }
  }

  private openTurn(): OpenLinkedTurn | null {
    const raw = this.getStateValue(OPEN_TURN_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as OpenLinkedTurn;
    } catch {
      return null;
    }
  }

  private openTurnCausality(): { turnId?: string } {
    const open = this.openTurn();
    return open ? { turnId: open.turnId } : {};
  }

  private triggeredTurnOpenedItem(turnId: string, triggerMessageId: string): TrajectoryItem {
    return {
      envelopeId: ids.turnOpened(turnId),
      payloadKind: "turn.opened",
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      causality: { turnId, messageId: triggerMessageId },
      publish: true,
    };
  }

  private async closeOpenTurn(reason: string): Promise<void> {
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
  }

  private async appendTrajectory(channelId: string, items: TrajectoryItem[]): Promise<void> {
    if (items.length === 0) return;
    const { logId, head } = channelTrajectoryFor(channelId);
    const selfRef = this.selfRef(channelId);
    await this.callGad("appendLogEvent", {
      logId,
      head,
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
  }

  // ── Fork hygiene ───────────────────────────────────────────────────────────

  /** A cloned linked vessel starts detached and with no delivery receipts. */
  protected override async onChannelForked(ctx: {
    oldChannelId: string;
    newChannelId: string;
    forkPointPubsubId: number;
  }): Promise<void> {
    await this.closeCurrentBridge();
    this.setStateValue(COMPLETED_KEY, "");
    this.setStateValue(OPEN_TURN_KEY, "");
    this.setStateValue(SESSION_KEY, "");
    this.setStateValue(PRIMARY_CHANNEL_KEY, ctx.newChannelId);
    this.sql.exec(`DELETE FROM linked_delivery_attempts`);
    this.sql.exec(`DELETE FROM linked_delivery_batches`);
    this.sql.exec(`DELETE FROM linked_bridge_sessions`);
    this.sql.exec(`DELETE FROM linked_bridge_queue`);
    this.sql.exec(`DELETE FROM linked_hook_seqs`);
  }
}

interface TrajectoryItem {
  envelopeId: string;
  payloadKind: string;
  payload: Record<string, unknown>;
  causality?: Record<string, unknown>;
  publish?: boolean;
}
