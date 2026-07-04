/**
 * PubSubChannel — Durable Object for pub/sub messaging.
 *
 * WS2: a GENERIC substrate — durable ordered log (delegated to GAD's unified
 * log), live fan-out, roster, and call transport. Every agentic decision
 * (agent-hop stamping, conversation fold, invocation payload vocabulary)
 * lives in `@workspace/channel-policies`, selected by name from channel
 * config and hosted by `policy-host.ts`.
 *
 * State taxonomy (P1): the channel log in GAD is the authority;
 * `pending_calls` (calls.ts), `policy_state:*` (policy-host.ts), and
 * `dedup_keys` are declared caches — deletable at any moment; `participants`
 * is operational transport state (live connections, observed into the log as
 * presence events).
 */

/// <reference path="../workerd.d.ts" />
import { rpc, DurableObjectBase, type DurableObjectContext } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@workspace/harness";
import type { BootstrapSnapshot, ParticipantSnapshot } from "@workspace/pubsub";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  createInitialChannelViewState,
  participantRefFromMetadata,
  publicParticipantMetadata,
  reduceChannelView,
  type AgenticEvent,
  type AppendIdempotency,
  type ChannelEnvelope,
  type ForkProjection,
  type InvocationOutcome,
  type LogEnvelope,
  type MessageBlockInput,
  type ParticipantRef,
} from "@workspace/agentic-protocol";
import { PARTICIPANT_SESSION_METADATA_KEY } from "@workspace/pubsub/internal-constants";
import {
  participantMetadataSchema,
  participantIsAgentVessel,
  type SubscribeResult,
  type ChannelConfig,
  type PresencePayload,
  type StoredAttachment,
} from "./types.js";
import {
  broadcast,
  buildChannelEvent,
  channelEventToRpcSignal,
  queueEmit,
  queueDoEnvelope,
  type BroadcastDeps,
  cleanupDeliveryChain,
} from "./broadcast.js";
import { ChannelLog, type ChannelReplayContext, type MessageTypeDefinition } from "./log-store.js";
import { PolicyHost, policyViewFromLogEnvelope } from "./policy-host.js";
import { CallTransport, type PendingCallRow } from "./calls.js";
import type { PolicyEnvelopeView } from "@workspace/channel-policies";

/** How long before an RPC participant is considered stale (no heartbeat). */
const PARTICIPANT_STALE_MS = 5 * 60 * 1000; // 5 minutes
/** Default channel-envelope replay window. */
const REPLAY_LIMIT = 50;
/** Dedup keys are a latency cache; the durable dedupe is the `ik:{key}`
 *  envelope id in the log lineage. */
const DEDUP_TTL_MS = 5 * 60 * 1000;
/** A pending call is eligible for lost-delivery redelivery once it is older
 *  than this (its original delivery already happened at creation). */
const PENDING_REDELIVERY_STALE_MS = 10_000;
/** Bounded redelivery cadence while calls are in flight. Anchored on a
 *  swept-at marker that advances each sweep — NOT on created_at (which never
 *  advances and would re-arm the alarm every 100ms for the call's lifetime,
 *  defeating hibernation). */
const PENDING_REDELIVERY_INTERVAL_MS = 15_000;
const PENDING_REDELIVERY_SWEPT_AT_KEY = "pendingRedeliverySweptAt";

const DEFAULT_POLICY_NAME = "agentic.conversation.v1";

/** Service protocol the channel DO resolves for sibling channels (fork parent,
 *  lineage forwarding). */
const CHANNEL_SERVICE_PROTOCOL = "vibez1.channel.v1";
/** Debounce window before a durable head advance fans out up the lineage. */
const LINEAGE_REPORT_DEBOUNCE_MS = 500;
/** Signal contentType for the ephemeral fork.head_changed lineage badge. */
const FORK_HEAD_CHANGED_SIGNAL = "fork.head_changed";
/** How long an interrupted fork op waits before the alarm reconciler resumes
 *  or rolls it back. */
const FORK_OP_RECONCILE_MS = 5_000;

/** Ordered fork-op phases; a resume skips everything at or below the recorded
 *  phase. `rolledback` is terminal (the op was torn down). */
const FORK_PHASES = [
  "journaled",
  "cloned",
  "postcloned",
  "seeded",
  "announced",
  "done",
] as const;
type ForkPhase = (typeof FORK_PHASES)[number] | "rolledback";
function forkPhaseReached(phase: string, target: ForkPhase): boolean {
  const a = FORK_PHASES.indexOf(phase as (typeof FORK_PHASES)[number]);
  const b = FORK_PHASES.indexOf(target as (typeof FORK_PHASES)[number]);
  return a >= 0 && b >= 0 && a >= b;
}

/** A resolvable durable-object reference. */
interface DORef {
  source: string;
  className: string;
  objectKey: string;
}

/** Build a DO RPC target id from a DORef: "do:{source}:{className}:{objectKey}". */
function doTarget(ref: DORef): string {
  return `do:${ref.source}:${ref.className}:${ref.objectKey}`;
}

/** The opening seed of an edit-/deep-dive fork. `blocks` are appended as a
 *  PRIMARY user message on the child channel by `appendSeed`. */
interface ForkSeed {
  author: ParticipantRef;
  blocks: MessageBlockInput[];
  replaces?: { messageId: string; seq: number };
}

/** Options for the durable `fork()` RPC. `include` scopes which forkable agents
 *  are cloned (root-context entity scope → cloneContext.include); omit to clone
 *  every agent vessel in the roster. `exclude`/`replace` are REMOVED (C7). */
interface ForkOpts {
  forkPointPubsubId: number;
  seed?: ForkSeed;
  label?: string;
  reason: string;
  include?: string[];
}

/** Result of a fork — the fresh channel + context and the cloned agents, so the
 *  caller can address them without re-resolving the new roster. */
interface ForkResult {
  forkId: string;
  forkedChannelId: string;
  forkedContextId: string;
  clonedParticipants: string[];
  clonedAgents: Array<{ participantId: string } & DORef>;
  seededMessageId?: string;
}

/** Provenance of a channel in the fork/task tree. */
type ChannelProvenance =
  | { kind: "root" }
  | {
      kind: "fork";
      forkedFrom: string;
      parentContextId: string;
      forkPointId: number;
      rootChannelId: string;
    }
  | { kind: "task"; parentChannelId: string; parentContextId: string; runId: string };

/** Pending fork seed marker consumed by `appendSeed` for idempotent fork recovery. */
interface ForkSeedMarker {
  forkId: string;
}

/** Subset of `runtime.cloneContext`'s result the fork op consumes. */
interface ClonedEntityView {
  sourceId: string;
  newId: string;
  kind: "do" | "worker";
  source: string;
  className?: string;
  sourceKey: string;
  newKey: string;
  targetId: string;
}
interface CloneContextResultView {
  contextId: string;
  entities: ClonedEntityView[];
}

function parseDOParticipantId(
  participantId: string
): { source: string; className: string; objectKey: string } | null {
  if (!participantId.startsWith("do:")) return null;
  const parts = participantId.slice(3).split(":");
  if (parts.length < 3) return null;
  const [source, className, ...objectKeyParts] = parts;
  const objectKey = objectKeyParts.join(":");
  if (!source || !className || !objectKey) return null;
  return { source, className, objectKey };
}

export class PubSubChannel extends DurableObjectBase {
  static override schemaVersion = 106;
  private _channelLog: ChannelLog | null = null;
  private _policyHost: PolicyHost | null = null;
  private _calls: CallTransport | null = null;
  private readonly publishDedupInFlight = new Map<string, Promise<ChannelEvent>>();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    // Eager init — the DO must be ready before any message arrives.
    this.ensureReady();
    try {
      this.sql.exec(`PRAGMA foreign_keys = ON`);
    } catch {
      /* workerd may ignore pragmas */
    }
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('rpc','do')),
        connected_at INTEGER NOT NULL,
        session_id TEXT,
        handle TEXT,
        do_source TEXT,
        do_class TEXT,
        do_object_key TEXT
      )
    `);
    this.sql.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_participants_handle
         ON participants(handle) WHERE handle IS NOT NULL`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pending_calls (
        transport_call_id TEXT PRIMARY KEY,
        invocation_id TEXT NOT NULL,
        turn_id TEXT,
        caller_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        method TEXT NOT NULL,
        args TEXT,
        created_at INTEGER NOT NULL,
        deadline_at INTEGER
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_calls_target ON pending_calls(target_id)`
    );
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_calls_deadline
         ON pending_calls(deadline_at) WHERE deadline_at IS NOT NULL`
    );
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS dedup_keys (
        key TEXT PRIMARY KEY,
        result_id INTEGER,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_dedup_keys_created ON dedup_keys(created_at)`);
    // Fork-operation journal (single-writer: this parent channel DO). The op's
    // durability lives HERE — the row is written BEFORE any host/DO call, and its
    // `phase` advances after each idempotent step so a crash resumes (or rolls
    // back) from the alarm reconciler. The `opts` blob carries the seed/label/
    // reason; `forked_*` are recorded once the clone exists (WS2 §fork).
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS fork_ops (
        fork_id TEXT PRIMARY KEY,
        fork_point_id INTEGER NOT NULL,
        opts TEXT NOT NULL,
        phase TEXT NOT NULL,
        forked_channel_id TEXT,
        forked_context_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_fork_ops_phase ON fork_ops(phase)`);
    // Lineage subscribers (held on the ROOT channel of a fork tree). A
    // signal-only roster — NO durable replay — that the head-advance hub fans
    // `fork.head_changed` out to. Distinct from `participants` so it never
    // pollutes the presence/roster projection.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS lineage_subscribers (
        id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  protected override migrate(_fromVersion: number, _toVersion: number): void {
    this.sql.exec(`DROP INDEX IF EXISTS idx_channel_envelopes_published_at`);
    this.sql.exec(`DROP INDEX IF EXISTS idx_messages_root`);
    this.sql.exec(`DROP INDEX IF EXISTS idx_messages_root_chat`);
    this.sql.exec(`DROP TABLE IF EXISTS channel_envelopes`);
    this.sql.exec(`DROP TABLE IF EXISTS messages`);
    this.sql.exec(`DROP TABLE IF EXISTS participants`);
    this.sql.exec(`DROP TABLE IF EXISTS pending_calls`);
    this.sql.exec(`DROP TABLE IF EXISTS dedup_keys`);
    this.sql.exec(`DROP TABLE IF EXISTS fork_ops`);
    this.sql.exec(`DROP TABLE IF EXISTS lineage_subscribers`);
    // Channel-side registry cache deleted for good — GAD's
    // channel_message_types projection is the only copy.
    this.sql.exec(`DROP TABLE IF EXISTS message_types`);
    this.createTables();
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  private get broadcastDeps(): BroadcastDeps {
    return {
      sql: this.sql,
      rpc: this.rpc,
      objectKey: this.objectKey,
    };
  }

  private get channelLog(): ChannelLog {
    this._channelLog ??= new ChannelLog(
      {
        call: <T = unknown>(targetId: string, method: string, args: unknown[]) =>
          this.rpc.call<T>(targetId, method, args),
      },
      this.objectKey
    );
    return this._channelLog;
  }

  private get policyHost(): PolicyHost {
    this._policyHost ??= new PolicyHost({
      getStateValue: (key) => this.getStateValue(key),
      setStateValue: (key, value) => this.setStateValue(key, value),
      deleteStateValue: (key) => this.deleteStateValue(key),
      log: this.channelLog,
      policyNames: () => this.getChannelConfig()?.policies,
    });
    return this._policyHost;
  }

  private get calls(): CallTransport {
    this._calls ??= new CallTransport({
      sql: this.sql,
      objectKey: this.objectKey,
      log: this.channelLog,
      builders: () => this.policyHost.callBuilders(),
      appendDurable: (input) => this.appendDurable(input),
      broadcastLive: (event, senderId, ref) =>
        broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref }, senderId),
      emitSignal: (participantId, event) => {
        void queueEmit(this.broadcastDeps, participantId, {
          channelId: this.objectKey,
          message: channelEventToRpcSignal(event),
        });
      },
      participantRef: (participantId) => this.participantRef(participantId),
      getSenderMetadata: (participantId) => this.getSenderMetadata(participantId),
      participantTransport: (participantId) => {
        const rows = this.sql
          .exec(`SELECT transport FROM participants WHERE id = ?`, participantId)
          .toArray();
        return rows.length > 0 ? (rows[0]!["transport"] as "rpc" | "do") : null;
      },
      rpcCall: (targetId, method, args) => this.rpc.call(targetId, method, args),
      waitUntil: (promise) => {
        if (this.ctx.waitUntil) this.ctx.waitUntil(promise);
        else void promise;
      },
      scheduleNextAlarm: () => this.scheduleNextAlarm(),
      getStateValue: (key) => this.getStateValue(key),
      setStateValue: (key, value) => this.setStateValue(key, value),
    });
    return this._calls;
  }

  /** Look up a participant's metadata from the participants table. */
  private getSenderMetadata(participantId: string): Record<string, unknown> | undefined {
    const row = this.sql
      .exec(`SELECT metadata FROM participants WHERE id = ?`, participantId)
      .toArray();
    if (row.length === 0) return undefined;
    try {
      return JSON.parse(row[0]!["metadata"] as string);
    } catch {
      return undefined;
    }
  }

  private participantRef(participantId: string): ParticipantRef {
    return participantRefFromMetadata(participantId, this.getSenderMetadata(participantId));
  }

  // ── The ONE append pipeline (WS2 §4.3) ───────────────────────────────────
  //
  //  1. policy state catch-up + pure annotate
  //  2. durable append (GAD validates + sanitizes + projects in the txn)
  //  3. fold the appended envelope into the policy caches
  //
  // A crash between 2 and 3 leaves the cache behind head; the next
  // getState() heals it (cache amnesia by construction).

  private async appendDurable(input: {
    type: string;
    payload: unknown;
    senderId: string;
    senderMetadata?: Record<string, unknown>;
    messageId?: string;
    /** "idempotent-by-id" is reserved for the client publish path. */
    idempotency?: AppendIdempotency;
    attachments?: StoredAttachment[];
  }): Promise<ChannelEvent> {
    const payloadRecord =
      input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)
        ? (input.payload as Record<string, unknown>)
        : null;
    const senderKind =
      ((payloadRecord?.["actor"] as { kind?: string } | undefined)?.kind as string | undefined) ??
      "unknown";
    const annotations = await this.policyHost.annotate({
      payloadKind: input.type,
      payload: input.payload,
      senderId: input.senderId,
      senderKind,
    });
    const event = await this.channelLog.append({
      type: input.type,
      payload: input.payload,
      senderId: input.senderId,
      senderMetadata: input.senderMetadata,
      messageId: input.messageId,
      ...(input.idempotency ? { idempotency: input.idempotency } : {}),
      ...(annotations ? { annotations } : {}),
      attachments: input.attachments,
    });
    this.policyHost.foldAppended(this.policyViewFromChannelEvent(event));
    // Report the head advance up the fork lineage (debounced) so live badges on
    // the root fan out. Cheap: records a pending seq + arms the alarm.
    this.noteLineageHeadAdvance(event.id);
    return event;
  }

  private policyViewFromChannelEvent(event: ChannelEvent): PolicyEnvelopeView {
    const actorKind = ((event.payload as { actor?: { kind?: string } } | null)?.actor?.kind ??
      "unknown") as string;
    return {
      envelopeId: event.messageId,
      seq: event.id,
      payloadKind: event.type,
      payload: event.payload,
      senderId: event.senderId,
      senderKind: actorKind,
      ...(event.annotations ? { annotations: event.annotations } : {}),
      appendedAt: new Date(event.ts).toISOString(),
    };
  }

  private currentReplayContext(): ChannelReplayContext {
    return {
      contextId: this.getStateValue("contextId") ?? undefined,
      channelConfig: this.getChannelConfig() ?? undefined,
      snapshots: [this.rosterSnapshot()],
    };
  }

  private rosterSnapshot(): BootstrapSnapshot {
    const participants: ParticipantSnapshot[] = [];
    for (const row of this.sql
      .exec(`SELECT id, metadata FROM participants ORDER BY id ASC`)
      .toArray()) {
      try {
        participants.push({
          id: row["id"] as string,
          metadata: JSON.parse(row["metadata"] as string),
        });
      } catch {
        /* ignore corrupt participant metadata */
      }
    }
    return { kind: "roster-snapshot", participants, ts: Date.now() };
  }

  // ── Channel initialization ──────────────────────────────────────────────

  private initChannel(contextId: string, channelConfig?: Record<string, unknown>): void {
    const existing = this.getStateValue("contextId");
    if (existing) {
      if (existing !== contextId) {
        throw new Error(`Context mismatch: channel bound to ${existing}, got ${contextId}`);
      }
      return;
    }
    this.setStateValue("contextId", contextId);
    this.setStateValue("createdAt", String(Date.now()));
    if (channelConfig) this.setStateValue("config", JSON.stringify(channelConfig));
    void this.refreshOwnTitle();
  }

  /** Push this channel's display title to the server-side registry. */
  private async refreshOwnTitle(): Promise<void> {
    const config = this.getChannelConfig();
    const configured =
      config && typeof config.title === "string" && config.title.trim().length > 0
        ? config.title.trim()
        : null;
    if (config?.titleExplicit === true) {
      await this.setOwnTitleExplicitly(configured ?? null);
    } else {
      await this.setOwnTitle(configured ?? "Channel");
    }
  }

  private getChannelConfig(): ChannelConfig | null {
    const raw = this.getStateValue("config");
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private assertParticipantCaller(participantId: string, method: string): void {
    if (!this.isAuthorizedParticipantCaller(participantId)) {
      const caller = this.caller;
      throw new Error(
        `${method}: participant ${participantId} cannot be used by caller ${caller?.callerId ?? "unknown"}`
      );
    }
  }

  private isAuthorizedParticipantCaller(participantId: string): boolean {
    const caller = this.caller;
    if (!caller?.callerId) return true;
    if (caller.callerId === participantId) return true;
    return caller.callerKind === "panel" && caller.callerPanelId === participantId;
  }

  private isPrivilegedRpcCaller(): boolean {
    const caller = this.caller;
    return (
      caller?.callerId === "main" ||
      caller?.callerKind === "server" ||
      caller?.callerKind === "shell"
    );
  }

  private assertAdminCaller(method: string): void {
    if (this.isPrivilegedRpcCaller()) return;
    const caller = this.caller;
    throw new Error(
      `${method}: privileged caller required (got ${caller?.callerKind ?? "unknown"} ${caller?.callerId ?? "unknown"})`
    );
  }

  // ── Presence events ─────────────────────────────────────────────────────

  private async publishPresenceEvent(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect" | "replaced",
    senderRef?: number
  ): Promise<void> {
    const publicMetadata = publicParticipantMetadata(metadata) ?? {};
    const payload: PresencePayload = {
      action,
      metadata: publicMetadata,
      ...(leaveReason ? { leaveReason } : {}),
    };

    const event = await this.appendDurable({
      type: "presence",
      payload,
      senderId,
      senderMetadata: publicMetadata,
    });
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref: senderRef }, senderId);
  }

  private broadcastPresenceSignal(
    senderId: string,
    action: "join" | "leave" | "update",
    metadata: Record<string, unknown>,
    leaveReason?: "graceful" | "disconnect" | "replaced"
  ): void {
    const payload: PresencePayload = {
      action,
      metadata,
      ...(leaveReason ? { leaveReason } : {}),
    };
    const event = buildChannelEvent(
      0,
      crypto.randomUUID(),
      "presence",
      JSON.stringify(payload),
      senderId,
      metadata,
      Date.now()
    );
    broadcast(this.broadcastDeps, event, { kind: "signal" }, senderId);
  }

  // ── RPC-callable methods ──────────────────────────────────────────────

  /**
   * Subscribe a participant to this channel. Inserts the participant first,
   * then builds replay, so an initial roster snapshot includes the subscriber.
   */
  @rpc({ callers: ["panel", "do"] })
  async subscribe(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<SubscribeResult> {
    const doRef = parseDOParticipantId(participantId);
    const transport = doRef ? "do" : "rpc";
    const callerId = this.rpcCallerId;
    if (!this.isAuthorizedParticipantCaller(participantId)) {
      const caller = this.caller;
      throw new Error(
        `Participant ${participantId} cannot be subscribed by caller ${caller?.callerId ?? "unknown"}`
      );
    }

    // Validate advertised method names FIRST with the exact legacy message
    // (agents depend on the text), then the zod schema for everything else.
    const advertisedMethods = metadata["methods"];
    if (Array.isArray(advertisedMethods)) {
      const VALID_METHOD_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;
      const RESERVED_METHOD_NAMES = new Set(["read", "edit", "write", "grep", "find", "ls"]);
      for (const m of advertisedMethods) {
        const name =
          m && typeof m === "object" && typeof (m as { name?: unknown }).name === "string"
            ? (m as { name: string }).name
            : null;
        if (name === null) continue; // unknown shape; let downstream handle it
        if (!VALID_METHOD_NAME.test(name) || RESERVED_METHOD_NAMES.has(name)) {
          throw new Error(
            `Invalid method name "${name}" advertised by participant "${participantId}". ` +
              `Method names must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/ and ` +
              `not collide with built-in tool names (read, edit, write, grep, find, ls).`
          );
        }
      }
    }
    const parsedMetadata = participantMetadataSchema.safeParse(metadata);
    if (!parsedMetadata.success) {
      const issue = parsedMetadata.error.issues[0];
      throw new Error(
        `subscribe: invalid participant metadata at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid"}`
      );
    }

    const participantSessionId =
      typeof metadata[PARTICIPANT_SESSION_METADATA_KEY] === "string"
        ? (metadata[PARTICIPANT_SESSION_METADATA_KEY] as string)
        : null;

    const contextId = metadata["contextId"] as string | undefined;
    const channelConfigRaw = metadata["channelConfig"] as Record<string, unknown> | undefined;
    if (contextId) {
      this.initChannel(contextId, channelConfigRaw);
    }

    // Handle uniqueness: friendly pre-check (exact legacy message); the
    // partial unique index is the race-proof enforcement underneath.
    const handle = typeof metadata["handle"] === "string" ? (metadata["handle"] as string) : null;
    if (handle) {
      const conflict = this.sql
        .exec(`SELECT id FROM participants WHERE handle = ? AND id != ?`, handle, participantId)
        .toArray();
      if (conflict.length > 0) {
        const otherId = conflict[0]!["id"] as string;
        throw new Error(
          `Participant handle "${handle}" is already in use by another participant ` +
            `(${otherId}) in this channel. Handles must be unique.`
        );
      }
    }

    if (doRef && callerId) {
      await this.rpc.call("main", "workers.resolveDurableObject", [
        doRef.source,
        doRef.className,
        doRef.objectKey,
      ]);
    }

    // Re-subscribe with the same participant ID: replace the roster entry, but
    // only redeliver in-flight calls if the underlying client session changed.
    const existing = this.sql
      .exec(`SELECT session_id FROM participants WHERE id = ?`, participantId)
      .toArray();
    let sessionReplaced = false;
    if (existing.length > 0) {
      const previousSessionId = existing[0]!["session_id"] as string | null;
      const oldMetadata = this.getSenderMetadata(participantId) ?? {};
      sessionReplaced =
        previousSessionId == null ||
        participantSessionId == null ||
        previousSessionId !== participantSessionId;
      await this.publishPresenceEvent(
        participantId,
        "leave",
        oldMetadata,
        sessionReplaced ? "replaced" : "graceful"
      );
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
      cleanupDeliveryChain(this.objectKey, participantId);
      if (sessionReplaced) {
        const pendingCountRow = this.sql
          .exec(`SELECT COUNT(*) as cnt FROM pending_calls WHERE target_id = ?`, participantId)
          .toArray();
        const pendingCount = (pendingCountRow[0]?.["cnt"] as number) ?? 0;
        console.log(
          `[Channel] Participant session replaced: target=${participantId} previousSession=${previousSessionId ?? "unknown"} newSession=${participantSessionId ?? "unknown"} pendingCalls=${pendingCount}`
        );
      }
    }

    // Extract replay options before cleaning metadata
    const wantsReplay = metadata["replay"] !== false;
    const sinceId = metadata["sinceId"] as number | undefined;
    const replayMessageLimit = metadata["replayMessageLimit"] as number | undefined;

    // Clean metadata for storage (remove transport/DO fields and subscribe-time hints)
    const storedMetadata = { ...metadata };
    delete storedMetadata["contextId"];
    delete storedMetadata["channelConfig"];
    delete storedMetadata["replay"];
    delete storedMetadata["sinceId"];
    delete storedMetadata["replayMessageLimit"];
    delete storedMetadata["transport"];
    delete storedMetadata[PARTICIPANT_SESSION_METADATA_KEY];

    try {
      this.sql.exec(
        `INSERT INTO participants (
           id, metadata, transport, connected_at, session_id, handle,
           do_source, do_class, do_object_key
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        participantId,
        JSON.stringify(storedMetadata),
        transport === "do" ? "do" : "rpc",
        Date.now(),
        participantSessionId,
        handle,
        doRef?.source ?? null,
        doRef?.className ?? null,
        doRef?.objectKey ?? null
      );
    } catch (err) {
      if (handle && err instanceof Error && /unique/iu.test(err.message)) {
        throw new Error(
          `Participant handle "${handle}" is already in use by another participant ` +
            `(unknown) in this channel. Handles must be unique.`
        );
      }
      throw err;
    }

    // Publish join presence before building replay so the initial roster snapshot includes self.
    await this.publishPresenceEvent(participantId, "join", storedMetadata);

    const mode = wantsReplay && sinceId && sinceId > 0 ? "after" : "initial";
    const envelope =
      mode === "after"
        ? await this.channelLog.replayAfter(sinceId!, this.currentReplayContext())
        : await this.channelLog.replayInitial(
            wantsReplay ? (replayMessageLimit ?? REPLAY_LIMIT) : 0,
            this.currentReplayContext()
          );
    // Deliver the structured `onChannelEnvelope` replay only to DO participants
    // that opted in (agent vessels). RPC-style DO clients (the eval's
    // connectViaRpc) receive replay via the `channel:message` emits + subscribe
    // ACK fallback, and have no onChannelEnvelope handler.
    this.queueReplayEnvelope(
      participantId,
      envelope,
      doRef != null && metadata["receivesChannelEnvelopes"] === true
    );

    // Redelivery + the reconnect/redelivery alarm are RPC-STYLE concerns: they serve participants that
    // settle method calls via the broadcast `started` + submitMethodResult — panels AND RPC-style
    // connectionless DO clients (the eval). Agent vessels get method calls via onMethodCall and don't
    // process the redelivered `started`, so they're excluded. Gate on the agent-vessel discriminator,
    // NOT `transport` (which would wrongly exclude the eval just because its id is a DO id).
    const isAgentVessel = participantIsAgentVessel(this.getSenderMetadata(participantId));
    if (sessionReplaced && !isAgentVessel) this.calls.redeliverPendingCallsTo(participantId);

    if (!isAgentVessel) {
      this.scheduleNextAlarm();
    }

    return {
      ok: true,
      channelConfig: this.getChannelConfig() ?? undefined,
      envelope,
    };
  }

  private queueReplayEnvelope(
    subscriberId: string,
    envelope: Awaited<ReturnType<ChannelLog["replayInitial"]>>,
    deliverToDo: boolean
  ): void {
    const onFatal = (err: { code?: string }) => {
      if (
        err?.code === "TARGET_NOT_REACHABLE" ||
        err?.code === "RECONNECT_GRACE_EXPIRED" ||
        err?.code === "DO_NOT_CREATED"
      ) {
        this.sql.exec(`DELETE FROM participants WHERE id = ?`, subscriberId);
        cleanupDeliveryChain(this.objectKey, subscriberId);
        return true;
      }
      return false;
    };
    for (const event of envelope.logEvents) {
      void queueEmit(
        this.broadcastDeps,
        subscriberId,
        {
          channelId: this.objectKey,
          message: { kind: "log", phase: "replay", event },
        },
        onFatal
      );
      if (deliverToDo) {
        void queueDoEnvelope(
          this.broadcastDeps,
          subscriberId,
          {
            kind: "log",
            phase: "replay",
            event,
          },
          onFatal
        );
      }
    }
    for (const snapshot of envelope.snapshots) {
      const message = {
        kind: "control" as const,
        type: "roster-snapshot" as const,
        participants: snapshot.participants,
        ts: snapshot.ts,
      };
      void queueEmit(
        this.broadcastDeps,
        subscriberId,
        { channelId: this.objectKey, message },
        onFatal
      );
      if (deliverToDo) {
        void queueDoEnvelope(this.broadcastDeps, subscriberId, message, onFatal);
      }
    }
    const readyMessage = {
      kind: "control" as const,
      type: "ready" as const,
      ready: envelope.ready,
    };
    void queueEmit(
      this.broadcastDeps,
      subscriberId,
      { channelId: this.objectKey, message: readyMessage },
      onFatal
    );
    if (deliverToDo) {
      void queueDoEnvelope(this.broadcastDeps, subscriberId, readyMessage, onFatal);
    }
  }

  @rpc({ callers: ["panel", "do"] })
  async unsubscribe(participantId: string): Promise<void> {
    this.assertParticipantCaller(participantId, "unsubscribe");
    await this.unsubscribeParticipant(participantId, "graceful");
  }

  @rpc({ callers: ["server", "shell"] })
  async adminUnsubscribeParticipant(participantId: string): Promise<void> {
    this.assertAdminCaller("adminUnsubscribeParticipant");
    await this.unsubscribeParticipant(participantId, "graceful");
  }

  private async unsubscribeParticipant(
    participantId: string,
    leaveReason: "graceful" | "disconnect" | "replaced"
  ): Promise<void> {
    const metadata = this.getSenderMetadata(participantId) ?? {};

    this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
    cleanupDeliveryChain(this.objectKey, participantId);
    await this.calls.failPendingCallsTargeting(participantId, leaveReason);
    await this.publishPresenceEvent(participantId, "leave", metadata, leaveReason);
    this.scheduleNextAlarm();
  }

  /** Abandoned terminals for every pending call targeting a leaver (or, on a
   *  fork that could not re-home the call, `aborted-by-fork` — C6). */
  async failPendingCallsTargeting(
    targetId: string,
    reason: "graceful" | "disconnect" | "replaced" | "aborted-by-fork"
  ): Promise<void> {
    await this.calls.failPendingCallsTargeting(targetId, reason);
  }

  /** Heartbeat from an RPC participant. */
  @rpc({ callers: ["panel", "do", "worker"] })
  async touch(participantId: string): Promise<void> {
    this.sql.exec(
      `UPDATE participants SET connected_at = ? WHERE id = ?`,
      Date.now(),
      participantId
    );
  }

  /**
   * Publish a typed message. The transport is OPAQUE to payload semantics:
   * GAD validates agentic payloads at append-time inside the txn; policies
   * annotate (never mutate) the envelope.
   */
  @rpc({ callers: ["panel", "do", "worker"] })
  async publish(
    participantId: string,
    type: string,
    payload: unknown,
    opts?: {
      ref?: number;
      senderMetadata?: Record<string, unknown>;
      attachments?: StoredAttachment[];
      idempotencyKey?: string;
    }
  ): Promise<{ id?: number }> {
    this.assertParticipantCaller(participantId, "publish");
    const ref = opts?.ref;
    const attachments = opts?.attachments;
    const idempotencyKey = opts?.idempotencyKey;
    if (idempotencyKey) {
      const existing = this.sql
        .exec(`SELECT result_id FROM dedup_keys WHERE key = ?`, idempotencyKey)
        .toArray();
      const existingId = existing[0]?.["result_id"] as number | null | undefined;
      if (existingId != null) return { id: existingId };
      const inFlight = this.publishDedupInFlight.get(idempotencyKey);
      if (inFlight) return { id: (await inFlight).id };
      if (existing.length > 0) {
        // A previous publish reserved the key but failed or the DO restarted
        // before storing a result. Let this request become the new owner.
        this.sql.exec(`DELETE FROM dedup_keys WHERE key = ? AND result_id IS NULL`, idempotencyKey);
      }
    }

    const senderMetadata = this.getSenderMetadata(participantId) ?? opts?.senderMetadata;
    const event = await this.runDedupedPublish(idempotencyKey, async () =>
      this.appendDurable({
        type,
        payload,
        senderId: participantId,
        senderMetadata,
        // Durable idempotency is the deterministic envelope id in the log
        // lineage; dedup_keys is only a latency cache (WS2 §3.2). Client
        // retries carry a stable key with volatile payload fields, so this
        // path — and ONLY this path — appends first-write-wins.
        messageId: idempotencyKey ? `ik:${idempotencyKey}` : undefined,
        ...(idempotencyKey ? { idempotency: "idempotent-by-id" as const } : {}),
        attachments,
      })
    );

    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live", ref }, participantId);
    return { id: event.id };
  }

  /** Policy fold state (replaces getConversationState — WS2 §4.4). */
  @rpc({ callers: ["panel", "do", "server"] })
  async getPolicyState(name?: string): Promise<{
    policy: string;
    version: number;
    foldedThroughSeq: number;
    state: unknown;
  }> {
    return this.policyHost.getState(name ?? DEFAULT_POLICY_NAME);
  }

  private async runDedupedPublish(
    idempotencyKey: string | undefined,
    append: () => Promise<ChannelEvent>
  ): Promise<ChannelEvent> {
    if (!idempotencyKey) return append();

    let promise!: Promise<ChannelEvent>;
    promise = (async () => {
      this.sql.exec(
        `INSERT OR IGNORE INTO dedup_keys (key, result_id, created_at) VALUES (?, NULL, ?)`,
        idempotencyKey,
        Date.now()
      );
      try {
        const event = await append();
        this.sql.exec(
          `UPDATE dedup_keys SET result_id = ?, created_at = ? WHERE key = ?`,
          event.id,
          Date.now(),
          idempotencyKey
        );
        this.scheduleNextAlarm();
        return event;
      } catch (err) {
        this.sql.exec(`DELETE FROM dedup_keys WHERE key = ? AND result_id IS NULL`, idempotencyKey);
        throw err;
      } finally {
        if (this.publishDedupInFlight.get(idempotencyKey) === promise) {
          this.publishDedupInFlight.delete(idempotencyKey);
        }
      }
    })();

    this.publishDedupInFlight.set(idempotencyKey, promise);
    return promise;
  }

  /**
   * Broadcast envelopes that were durably appended to GAD outside this DO
   * (trajectory publication fan-out). Folds each into the policy caches.
   */
  @rpc({ callers: ["server", "do"] })
  async broadcastStoredEnvelopes(envelopeIds: string[]): Promise<{ broadcasted: number }> {
    let broadcasted = 0;
    for (const envelopeId of envelopeIds) {
      if (typeof envelopeId !== "string" || envelopeId.length === 0) continue;
      const event = await this.channelLog.getEventByEnvelopeId(envelopeId);
      if (!event) continue;
      this.policyHost.foldAppended(this.policyViewFromChannelEvent(event));
      broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, event.senderId);
      broadcasted += 1;
    }
    return { broadcasted };
  }

  /** Mark a message as errored (durable `error` channel event). */
  @rpc({ callers: ["panel", "do", "worker"] })
  async error(
    participantId: string,
    messageId: string,
    errorMessage: string,
    code?: string
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "error");
    const senderMetadata = this.getSenderMetadata(participantId);
    const payload: Record<string, unknown> = { id: messageId, error: errorMessage };
    if (code) payload["code"] = code;
    const event = await this.appendDurable({
      type: "error",
      payload,
      senderId: participantId,
      senderMetadata,
    });
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, participantId);
  }

  @rpc({ callers: ["panel", "do", "server"] })
  async getReplayAfter(sinceId: number) {
    return this.channelLog.replayAfter(sinceId, this.currentReplayContext());
  }

  /** Send a non-durable signal message. */
  @rpc({ callers: ["panel", "do", "worker"] })
  async sendSignal(participantId: string, content: string, contentType?: string): Promise<void> {
    this.assertParticipantCaller(participantId, "sendSignal");
    const ts = Date.now();
    const senderMetadata = this.getSenderMetadata(participantId);

    const payload: Record<string, unknown> = { content };
    if (contentType) payload["contentType"] = contentType;
    const payloadJson = JSON.stringify(payload);

    const event = buildChannelEvent(
      0,
      `sig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      "signal",
      payloadJson,
      participantId,
      senderMetadata,
      ts
    );
    broadcast(this.broadcastDeps, event, { kind: "signal" }, participantId);
  }

  /** Replace a participant's metadata entirely. */
  @rpc({ callers: ["panel", "do", "worker"] })
  async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
    this.assertParticipantCaller(participantId, "updateMetadata");
    await this.updateParticipantMetadata(participantId, metadata);
  }

  @rpc({ callers: ["server", "shell"] })
  async adminUpdateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    this.assertAdminCaller("adminUpdateParticipantMetadata");
    await this.updateParticipantMetadata(participantId, metadata);
  }

  private async updateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(metadata),
      participantId
    );
    await this.publishPresenceEvent(participantId, "update", metadata);
  }

  @rpc({ callers: ["panel", "do", "worker"] })
  async setTypingState(participantId: string, typing: boolean): Promise<void> {
    this.assertParticipantCaller(participantId, "setTypingState");
    this.setParticipantTypingState(participantId, typing);
  }

  @rpc({ callers: ["server", "shell"] })
  async adminSetParticipantTypingState(participantId: string, typing: boolean): Promise<void> {
    this.assertAdminCaller("adminSetParticipantTypingState");
    this.setParticipantTypingState(participantId, typing);
  }

  private setParticipantTypingState(participantId: string, typing: boolean): void {
    const rows = this.sql
      .exec(`SELECT metadata FROM participants WHERE id = ?`, participantId)
      .toArray();
    if (rows.length === 0) return;
    const final = { ...JSON.parse(rows[0]!["metadata"] as string), typing };
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(final),
      participantId
    );
    this.broadcastPresenceSignal(participantId, "update", final);
  }

  /** Get all participants with DO identity when available. */
  @rpc({ callers: ["panel", "do", "server", "shell"] })
  async getParticipants(): Promise<
    Array<{
      participantId: string;
      metadata: Record<string, unknown>;
      transport: string;
      doRef?: { source: string; className: string; objectKey: string };
    }>
  > {
    const rows = this.sql
      .exec(`SELECT id, metadata, transport, do_source, do_class, do_object_key FROM participants`)
      .toArray();
    return rows.map((row) => {
      const participantId = row["id"] as string;
      const entry: {
        participantId: string;
        metadata: Record<string, unknown>;
        transport: string;
        doRef?: { source: string; className: string; objectKey: string };
      } = {
        participantId,
        metadata: JSON.parse(row["metadata"] as string),
        transport: row["transport"] as string,
      };
      if (row["do_source"] && row["do_class"] && row["do_object_key"]) {
        entry.doRef = {
          source: row["do_source"] as string,
          className: row["do_class"] as string,
          objectKey: row["do_object_key"] as string,
        };
      }
      return entry;
    });
  }

  @rpc({ callers: ["panel", "do", "server", "shell"] })
  async getContextId(): Promise<string | null> {
    return this.getStateValue("contextId");
  }

  @rpc({ callers: ["panel", "do", "server", "shell"] })
  async getConfig(): Promise<ChannelConfig | null> {
    return this.getChannelConfig();
  }

  @rpc({ callers: ["panel", "server"] })
  async updateConfig(config: Partial<ChannelConfig>): Promise<ChannelConfig> {
    const newConfig = { ...this.getChannelConfig(), ...config };
    this.setStateValue("config", JSON.stringify(newConfig));
    this.policyHost.invalidatePolicySelection();
    const event = await this.appendDurable({
      type: "config-update",
      payload: newConfig,
      senderId: "system",
    });
    broadcast(this.broadcastDeps, event, { kind: "log", phase: "live" }, "system");
    void this.refreshOwnTitle();
    return newConfig;
  }

  @rpc({ callers: ["panel", "do", "server"] })
  async getReplayBefore(beforeSeq: number, limit?: number) {
    return this.channelLog.replayBefore(beforeSeq, limit ?? 100, this.currentReplayContext());
  }

  // Registry reads: direct passthrough to GAD's channel_message_types
  // projection (hydrated — published `source` payloads are blob-spilled).

  @rpc({ callers: ["panel", "do", "server"] })
  async getMessageTypes(): Promise<MessageTypeDefinition[]> {
    return this.channelLog.listMessageTypes();
  }

  @rpc({ callers: ["panel", "do", "server"] })
  async getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    return this.channelLog.getMessageType(typeId);
  }

  @rpc({ callers: ["panel", "do", "server"] })
  async getMessageSender(participantId: string, messageId: string): Promise<string | null> {
    this.assertParticipantCaller(participantId, "getMessageSender");
    const replay = await this.channelLog.replayInitial(500, this.currentReplayContext());
    for (const event of [...replay.logEvents].reverse()) {
      if (event.type !== AGENTIC_EVENT_PAYLOAD_KIND) continue;
      const payload = event.payload as {
        kind?: string;
        causality?: Record<string, unknown>;
      } | null;
      if (!payload || typeof payload !== "object") continue;
      if (payload.kind !== "message.completed") continue;
      if (payload.causality?.["messageId"] === messageId) return event.senderId;
    }
    return null;
  }

  @rpc({ callers: ["server", "shell"] })
  async adminInspectSchema() {
    this.assertAdminCaller("adminInspectSchema");
    const tableNames = [
      "participants",
      "pending_calls",
      "dedup_keys",
      "fork_ops",
      "lineage_subscribers",
    ];
    const tables = tableNames.map((table) => ({
      table,
      columns: this.sql.exec(`PRAGMA table_info(${table})`).toArray(),
    }));
    const indexes = tableNames.flatMap((table) => {
      const list = this.sql.exec(`PRAGMA index_list(${table})`).toArray();
      return list.map((idx) => ({
        table,
        ...idx,
        columns: this.sql.exec(`PRAGMA index_info(${idx["name"] as string})`).toArray(),
      }));
    });
    const localEnvelopeTables = this.sql
      .exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'channel_envelopes'`)
      .toArray();
    return {
      tables,
      indexes,
      invariants: [
        {
          name: "durable-log-delegated-to-gad",
          ok: localEnvelopeTables.length === 0,
        },
      ],
    };
  }

  @rpc({ callers: ["server", "shell"] })
  async adminInspectLog(
    opts: {
      afterId?: number;
      beforeId?: number;
      limit?: number;
      includePresence?: boolean;
    } = {}
  ) {
    this.assertAdminCaller("adminInspectLog");
    const rows = await this.channelLog.inspectRows(opts);
    const firstId = rows[0]?.["seq"] as number | undefined;
    const lastId = rows[rows.length - 1]?.["seq"] as number | undefined;
    const before =
      firstId != null
        ? await this.channelLog.replayBefore(firstId, 1, this.currentReplayContext())
        : null;
    const after =
      lastId != null
        ? await this.channelLog.replayAfter(lastId, this.currentReplayContext())
        : null;
    return {
      rows,
      hasMoreBefore: (before?.logEvents.length ?? 0) > 0,
      hasMoreAfter: (after?.logEvents.length ?? 0) > 0,
    };
  }

  @rpc({ callers: ["server", "shell"] })
  async adminInspectEnvelope(envelopeId: string) {
    this.assertAdminCaller("adminInspectMessageChain");
    return { rows: await this.channelLog.inspectEnvelope(envelopeId) };
  }

  @rpc({ callers: ["server", "shell"] })
  async adminReconstructTranscript(opts: { rootLimit?: number; beforeSeq?: number } = {}) {
    this.assertAdminCaller("adminReconstructTranscript");
    const envelope =
      opts.beforeSeq != null
        ? await this.getReplayBefore(opts.beforeSeq, opts.rootLimit)
        : await this.channelLog.replayInitial(
            opts.rootLimit ?? REPLAY_LIMIT,
            this.currentReplayContext()
          );
    return {
      logEvents: envelope.logEvents,
      ready: envelope.ready,
    };
  }

  @rpc({ callers: ["server", "shell"] })
  async adminValidateLog(opts: { rootLimit?: number } = {}) {
    this.assertAdminCaller("adminValidateLog");
    const issues: Array<{ code: string; message: string; rowId?: number }> = [];
    const schema = await this.adminInspectSchema();
    for (const invariant of schema.invariants) {
      if (!invariant.ok)
        issues.push({ code: "schema", message: `schema invariant failed: ${invariant.name}` });
    }
    const rows = await this.channelLog.inspectRows({
      limit: Math.min(Math.max(opts.rootLimit ?? 10000, 1), 100000),
    });
    for (const row of rows) {
      const rowId = row["seq"] as number;
      try {
        const parsed = JSON.parse(row["payload"] as string);
        if (row["payload_kind"] === AGENTIC_EVENT_PAYLOAD_KIND) {
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            issues.push({
              code: "agentic-envelope",
              message: "agentic envelope payload is invalid",
              rowId,
            });
          }
        }
      } catch {
        issues.push({ code: "payload-json", message: "payload is not valid JSON", rowId });
      }
    }
    return {
      ok: issues.length === 0,
      issues,
      stats: {
        rowCount: rows.length,
      },
    };
  }

  // ── Method calls (calls.ts — pending_calls is a declared cache) ──────────

  @rpc({ callers: ["panel", "do", "worker"] })
  async callMethod(
    callerPid: string,
    targetPid: string,
    callId: string,
    method: string,
    args: unknown,
    opts?: { invocationId?: string; transportCallId?: string; turnId?: string; timeoutMs?: number }
  ): Promise<void> {
    this.assertParticipantCaller(callerPid, "callMethod");
    await this.calls.callMethod(callerPid, targetPid, callId, method, args, opts);
  }

  @rpc({ callers: ["panel", "do", "worker"] })
  async submitMethodResult(
    participantId: string,
    transportCallId: string,
    content: unknown,
    isError: boolean,
    opts?: {
      invocationId?: string;
      turnId?: string;
      terminalOutcome?: InvocationOutcome;
      terminalReasonCode?: string;
      attachments?: StoredAttachment[];
    }
  ): Promise<{ id?: number; dropped?: boolean; reason?: string; recovered?: boolean }> {
    this.assertParticipantCaller(participantId, "submitMethodResult");
    const resolution = await this.calls.resolveSubmitterForCall(
      participantId,
      transportCallId,
      "submitMethodResult"
    );
    if (resolution.kind === "terminal") {
      return { id: resolution.eventId };
    }
    if (resolution.kind === "missing") {
      // No live pending row AND no durable `started`/terminal even after
      // reconcile: a cache-cold / lost record. Dropping the result here strands
      // the caller forever — its parked invocation only settles on a terminal
      // carrying the same invocationId/transportCallId, so with NO terminal the
      // turn never closes and waitForIdle hangs. Recover by rooting the method
      // (sanctioned synthetic `started`, satisfying the fold) and appending +
      // broadcasting a real terminal keyed on the caller's invocationId.
      const id = await this.calls.settleMissingCall(
        participantId,
        transportCallId,
        content,
        isError,
        {
          ...(opts?.invocationId ? { invocationId: opts.invocationId } : {}),
          ...(opts?.turnId ? { turnId: opts.turnId } : {}),
          ...(opts?.terminalOutcome ? { terminalOutcome: opts.terminalOutcome } : {}),
          ...(opts?.terminalReasonCode ? { terminalReasonCode: opts.terminalReasonCode } : {}),
          ...(opts?.attachments ? { attachments: opts.attachments } : {}),
        }
      );
      console.warn(
        `[Channel] submitMethodResult recovered a lost call (no pending row): rooted method + ` +
          `appended terminal so the caller settles: channel=${this.objectKey} ` +
          `transportCallId=${transportCallId} isError=${isError} terminalSeq=${id}`
      );
      return { id, dropped: false, recovered: true };
    }
    const id = await this.calls.settleCall(
      transportCallId,
      content,
      isError,
      opts?.terminalOutcome,
      opts?.terminalReasonCode,
      { attachments: opts?.attachments }
    );
    return { id };
  }

  @rpc({ callers: ["panel", "do", "worker"] })
  async submitMethodProgress(
    participantId: string,
    transportCallId: string,
    content: unknown,
    opts?: {
      invocationId?: string;
      turnId?: string;
      attachments?: StoredAttachment[];
    }
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "submitMethodProgress");
    const resolution = await this.calls.resolveSubmitterForCall(
      participantId,
      transportCallId,
      "submitMethodProgress"
    );
    if (resolution.kind !== "pending") {
      return;
    }
    await this.calls.submitMethodProgress(transportCallId, content, {
      attachments: opts?.attachments,
    });
  }

  /** Terminal result entry point (kept for DO delivery + external callers). */
  async handleMethodResult(
    transportCallId: string,
    content: unknown,
    isError: boolean,
    terminalOutcome?: InvocationOutcome,
    terminalReasonCode?: string,
    transportOpts?: {
      attachments?: StoredAttachment[];
    }
  ): Promise<number | undefined> {
    return this.calls.settleCall(
      transportCallId,
      content,
      isError,
      terminalOutcome,
      terminalReasonCode,
      { attachments: transportOpts?.attachments }
    );
  }

  @rpc({ callers: ["server"] })
  async cancelMethodCall(callId: string): Promise<void> {
    await this.calls.cancelMethodCall(callId, "cancelled");
  }

  @rpc({ callers: ["server"] })
  async timeoutMethodCall(callId: string, reason?: string): Promise<void> {
    const pending = await this.calls.cancelMethodCall(callId, reason ?? "timed out");
    if (!pending) return;
    // Tell the target agent its call rotted — the caller already got a
    // terminal, but the agent otherwise never learns it failed to respond.
    await this.publishMethodCallFeedback(
      pending.targetId,
      pending.transportCallId,
      pending.method,
      reason ?? "method call deadline expired"
    );
  }

  /** Publish a ui.feedback event targeted at a participant (best effort). */
  private async publishMethodCallFeedback(
    targetId: string,
    transportCallId: string,
    method: string,
    message: string
  ): Promise<void> {
    try {
      const event: AgenticEvent<"ui.feedback"> = {
        kind: "ui.feedback",
        actor: { kind: "system", id: "channel" },
        payload: {
          protocol: AGENTIC_PROTOCOL_VERSION,
          target: this.participantRef(targetId),
          category: "method_call_failed",
          refs: { callId: transportCallId },
          error: { message: `${method}: ${message}` },
          occurrenceKey: `method_call_failed:${transportCallId}`,
        },
        createdAt: new Date().toISOString(),
      };
      const logged = await this.appendDurable({
        type: AGENTIC_EVENT_PAYLOAD_KIND,
        payload: event,
        senderId: "system",
      });
      broadcast(this.broadcastDeps, logged, { kind: "log", phase: "live" }, "system");
    } catch (err) {
      console.warn(`[Channel] failed to publish method-call feedback for ${transportCallId}:`, err);
    }
  }

  /** Convergence sweep for the pending_calls cache (P3 — also an ops hook). */
  async reconcilePendingCalls(force = false): Promise<{ inserted: number; deleted: number }> {
    return this.calls.reconcilePendingCalls(force);
  }

  // ── Alarm — single scheduler over pure next-time sources (WS2 §8.2) ──────

  private nextDedupSweepAt(): number | null {
    const oldest = this.sql.exec(`SELECT MIN(created_at) AS oldest FROM dedup_keys`).toArray()[0]?.[
      "oldest"
    ];
    return typeof oldest === "number" ? oldest + DEDUP_TTL_MS : null;
  }

  private nextParticipantSweepAt(now: number): number | null {
    void now;
    const earliest = this.sql
      .exec(`SELECT MIN(connected_at) AS connectedAt FROM participants WHERE transport = 'rpc'`)
      .toArray()[0]?.["connectedAt"];
    return typeof earliest === "number" ? earliest + PARTICIPANT_STALE_MS : null;
  }

  private scheduleNextAlarm(): void {
    const now = Date.now();
    const sources = [
      this.nextDedupSweepAt(),
      this.nextParticipantSweepAt(now),
      this.calls.nextCallDeadlineAt(),
      // While method calls are in flight, wake soon enough for the
      // lost-delivery redelivery sweep (at-least-once within seconds, not
      // only at the 5-minute expiry).
      this.nextPendingRedeliveryAt(now),
      // Fork-op crash-recovery reconcile + debounced lineage head fan-out.
      this.nextForkOpReconcileAt(now),
      this.nextLineageReportAt(),
    ].filter((value): value is number => typeof value === "number");
    if (sources.length === 0) {
      this.deleteAlarm();
      return;
    }
    this.setAlarm(Math.max(Math.min(...sources) - now, 100));
  }

  private nextPendingRedeliveryAt(now: number): number | null {
    void now;
    const oldest = this.sql
      .exec(`SELECT MIN(created_at) AS createdAt FROM pending_calls`)
      .toArray()[0]?.["createdAt"];
    if (typeof oldest !== "number") return null;
    // First redelivery one stale-window after the call was created; every
    // subsequent one is `interval` after the LAST sweep (the marker advances
    // in alarm()), so the alarm never busy-loops while a long call runs.
    const firstEligible = oldest + PENDING_REDELIVERY_STALE_MS;
    const lastSwept = Number(this.getStateValue(PENDING_REDELIVERY_SWEPT_AT_KEY) ?? 0);
    const nextRecurring =
      lastSwept > 0 ? lastSwept + PENDING_REDELIVERY_INTERVAL_MS : firstEligible;
    return Math.max(firstEligible, nextRecurring);
  }

  override async alarm(): Promise<void> {
    await super.alarm();

    await this.evictStaleParticipants();

    // Dedup TTL sweep — unconditional (no latch; a key inserted while no
    // publish succeeds is still swept).
    this.sql.exec(`DELETE FROM dedup_keys WHERE created_at < ?`, Date.now() - DEDUP_TTL_MS);

    await this.calls.timeoutExpiredPendingCalls(async (pending, message) => {
      await this.publishMethodCallFeedback(
        pending.targetId,
        pending.transportCallId,
        pending.method,
        message
      );
    });

    // Convergence sweep for the pending_calls cache (cheap: skipped when the
    // observed head hasn't moved).
    try {
      await this.calls.reconcilePendingCalls();
    } catch (err) {
      console.warn(`[Channel] reconcilePendingCalls failed:`, err);
    }

    // At-least-once for in-flight method calls: a delivery lost to a session
    // replacement race otherwise strands the call until expiry. Re-emitting
    // is idempotent client-side (executing/submitted call-id sets). The
    // swept-at marker advances the next redelivery deadline by one interval
    // so the alarm can't busy-loop on a long-running call.
    try {
      const pendingCount = this.sql
        .exec(`SELECT COUNT(*) AS cnt FROM pending_calls`)
        .toArray()[0]?.["cnt"];
      if (typeof pendingCount === "number" && pendingCount > 0) {
        this.redeliverStalePendingCalls();
        this.setStateValue(PENDING_REDELIVERY_SWEPT_AT_KEY, String(Date.now()));
      } else {
        // No pending calls — clear the marker so the next call's first
        // redelivery is anchored to its own creation, not a stale sweep.
        this.setStateValue(PENDING_REDELIVERY_SWEPT_AT_KEY, "0");
      }
    } catch (err) {
      console.warn(`[Channel] pending-call redelivery sweep failed:`, err);
    }

    // Debounced lineage head fan-out (root → lineage subscribers) and
    // fork-op crash reconcile (resume or roll back an interrupted fork).
    try {
      await this.flushLineageHeadReport();
    } catch (err) {
      console.warn(`[Channel] lineage head report failed:`, err);
    }
    try {
      await this.reconcileForkOps();
    } catch (err) {
      console.warn(`[Channel] fork-op reconcile failed:`, err);
    }

    this.scheduleNextAlarm();
  }

  /** Re-emit pending calls older than one alarm tick whose target is a
   *  connected rpc participant (lost-delivery healing). */
  private redeliverStalePendingCalls(): void {
    const cutoff = Date.now() - 10_000;
    const targets = new Set<string>();
    for (const row of this.sql
      .exec(`SELECT DISTINCT target_id FROM pending_calls WHERE created_at < ?`, cutoff)
      .toArray()) {
      targets.add(String((row as Record<string, unknown>)["target_id"]));
    }
    for (const targetId of targets) {
      const connected = this.sql
        .exec(`SELECT 1 FROM participants WHERE id = ? AND transport = 'rpc'`, targetId)
        .toArray();
      if (connected.length > 0) this.calls.redeliverPendingCallsTo(targetId);
    }
  }

  private async evictStaleParticipants(): Promise<void> {
    const cutoff = Date.now() - PARTICIPANT_STALE_MS;
    const stale = this.sql
      .exec(
        `SELECT id, metadata FROM participants WHERE transport = 'rpc' AND connected_at < ?`,
        cutoff
      )
      .toArray();

    for (const row of stale) {
      const pid = row["id"] as string;
      let metadata: Record<string, unknown> = {};
      try {
        metadata = JSON.parse(row["metadata"] as string);
      } catch {
        /* corrupted metadata, use empty default */
      }
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, pid);
      cleanupDeliveryChain(this.objectKey, pid);
      await this.calls.failPendingCallsTargeting(pid, "disconnect");
      await this.publishPresenceEvent(pid, "leave", metadata, "disconnect");
    }

    if (stale.length > 0) {
      console.log(`[Channel] Evicted ${stale.length} stale RPC participant(s)`);
      this.scheduleNextAlarm();
    }
  }

  // ── Provenance ────────────────────────────────────────────────────────────

  /**
   * The channel's place in the fork/task tree, read from durable state (NOT the
   * old `getState()` dump peek). Fork provenance is written at `postClone`; task
   * provenance at task-channel creation (B1, WS-5) — until that lands a task
   * channel reads as `root`/`fork`.
   */
  @rpc({ callers: ["panel", "do", "server", "shell"] })
  async getProvenance(): Promise<ChannelProvenance> {
    return this.computeProvenance();
  }

  /**
   * Record task provenance for a subagent task channel (B1, WS-5). Written by
   * the spawning vessel right after the task channel is created/subscribed so
   * {@link getProvenance} reports `kind:"task"` instead of `root`. Durable state
   * keys, mirroring how fork provenance is stamped at `postClone`.
   */
  @rpc({ callers: ["worker", "server", "do"] })
  async recordTaskProvenance(args: {
    parentChannelId: string;
    parentContextId: string;
    runId: string;
  }): Promise<void> {
    this.setStateValue("taskParentChannelId", args.parentChannelId);
    this.setStateValue("taskParentContextId", args.parentContextId);
    this.setStateValue("taskRunId", args.runId);
  }

  private computeProvenance(): ChannelProvenance {
    const taskParent = this.getStateValue("taskParentChannelId");
    if (taskParent) {
      return {
        kind: "task",
        parentChannelId: taskParent,
        parentContextId: this.getStateValue("taskParentContextId") ?? "",
        runId: this.getStateValue("taskRunId") ?? "",
      };
    }
    const forkedFrom = this.getStateValue("forkedFrom");
    if (forkedFrom) {
      return {
        kind: "fork",
        forkedFrom,
        parentContextId: this.getStateValue("forkedFromContextId") ?? "",
        forkPointId: Number(this.getStateValue("forkPointId") ?? 0),
        rootChannelId: this.getStateValue("rootChannelId") ?? forkedFrom,
      };
    }
    return { kind: "root" };
  }

  // ── Fork operation (durable, journaled, owned by THIS parent channel) ──────
  //
  // The op's durability lives in `fork_ops`: the row is journaled BEFORE any
  // host/DO call and its `phase` advances after each idempotent step. Order:
  //   journal → clone (targetKey=`fork:{forkId}`) → postClones → appendSeed →
  //   channel.forked → done.
  // Every phase is idempotent (deterministic clone targetKey + deterministic
  // envelopeIds `fork-seed:{forkId}` / `fork-event:{forkId}`), so a crash resumes
  // from `reconcileForkOps()` (or rolls back via destroyContext).

  /** Thin host-call wrapper (the DO drives runtime.cloneContext/destroyContext).
   *  Host runtime services take exactly ONE opts object, positional. */
  private callMain<T>(method: string, arg: unknown): Promise<T> {
    return this.rpc.call<T>("main", method, [arg]);
  }

  /** Resolve a sibling channel's DO ref (fork parent / lineage forwarding). */
  private async resolveChannelRef(channelId: string): Promise<DORef> {
    const svc = await this.rpc.call<DORef>("main", "workers.resolveService", [
      CHANNEL_SERVICE_PROTOCOL,
      channelId,
    ]);
    return { source: svc.source, className: svc.className, objectKey: svc.objectKey };
  }

  @rpc({ callers: ["panel", "do", "worker", "server"] })
  async fork(opts: ForkOpts): Promise<ForkResult> {
    const forkId = crypto.randomUUID();
    const now = Date.now();
    // Journal FIRST — before any host/DO call — so a crash is always recoverable.
    this.sql.exec(
      `INSERT INTO fork_ops (fork_id, fork_point_id, opts, phase, created_at, updated_at)
         VALUES (?, ?, ?, 'journaled', ?, ?)`,
      forkId,
      opts.forkPointPubsubId,
      JSON.stringify(opts),
      now,
      now
    );
    // Arm the reconcile alarm now (durable) so a hard crash mid-saga still gets
    // resumed/rolled back even if no other RPC re-arms the DO.
    this.scheduleNextAlarm();
    return this.runForkOp(forkId);
  }

  private getForkOpRow(forkId: string): Record<string, unknown> | null {
    const rows = this.sql.exec(`SELECT * FROM fork_ops WHERE fork_id = ?`, forkId).toArray();
    return rows.length > 0 ? (rows[0] as Record<string, unknown>) : null;
  }

  private setForkOpPhase(
    forkId: string,
    phase: ForkPhase,
    fields?: { forkedChannelId?: string; forkedContextId?: string }
  ): void {
    this.sql.exec(
      `UPDATE fork_ops SET phase = ?,
         forked_channel_id = COALESCE(?, forked_channel_id),
         forked_context_id = COALESCE(?, forked_context_id),
         updated_at = ?
       WHERE fork_id = ?`,
      phase,
      fields?.forkedChannelId ?? null,
      fields?.forkedContextId ?? null,
      Date.now(),
      forkId
    );
  }

  /** Drive an interrupted/fresh fork op from its recorded phase to `done`,
   *  rolling back on unrecoverable failure. Idempotent under retry. */
  private async runForkOp(forkId: string): Promise<ForkResult> {
    const row = this.getForkOpRow(forkId);
    if (!row) throw new Error(`fork op ${forkId} not found`);
    const phase = row["phase"] as string;
    const opts = JSON.parse(row["opts"] as string) as ForkOpts;

    const sourceContextId = this.getStateValue("contextId");
    if (!sourceContextId) throw new Error(`Channel ${this.objectKey} has no contextId`);

    // Classify the (stable) parent roster: forkable = agent vessels with a doRef,
    // scoped by opts.include when given (C7 entity scope).
    const includeScope = opts.include ? new Set(opts.include) : null;
    const selfRef = await this.resolveChannelRef(this.objectKey);
    const keptAgents: Array<{ participantId: string; ref: DORef }> = [];
    for (const p of await this.getParticipants()) {
      if (p.metadata?.["receivesChannelEnvelopes"] !== true || !p.doRef) continue;
      if (includeScope && !includeScope.has(doTarget(p.doRef))) continue;
      keptAgents.push({ participantId: p.participantId, ref: p.doRef });
    }

    try {
      // Preflight canFork on the kept agents (WS-5 per-channel shape).
      for (const agent of keptAgents) {
        const r = await this.rpc.call<{ ok: boolean; reason?: string }>(
          doTarget(agent.ref),
          "canFork",
          [this.objectKey]
        );
        if (!r.ok) {
          throw new Error(`Cannot fork participant ${agent.participantId}: ${r.reason ?? "canFork=false"}`);
        }
      }

      // 1. CLONE — idempotent via targetKey; a resumed op gets the SAME child.
      //    Recursive so a live-subagent context clones its lifecycle subtree in
      //    full (include scopes the ROOT context only); lineage edges are never
      //    followed.
      const include = [doTarget(selfRef), ...keptAgents.map((a) => doTarget(a.ref))];
      const clone = await this.callMain<CloneContextResultView>("runtime.cloneContext", {
        sourceContextId,
        include,
        recursive: true,
        targetKey: `fork:${forkId}`,
      });
      const findClone = (ref: DORef): ClonedEntityView => {
        const id = doTarget(ref);
        const entity = clone.entities.find((e) => e.sourceId === id);
        if (!entity) throw new Error(`cloneContext did not clone ${id}`);
        return entity;
      };
      const channelClone = findClone(selfRef);
      const forkedChannelId = channelClone.newKey;
      const forkedContextId = clone.contextId;
      const forkedChannelRef: DORef = {
        source: channelClone.source,
        className: channelClone.className!,
        objectKey: forkedChannelId,
      };
      const homeableTargets = clone.entities.map((e) => e.sourceId);
      if (!forkPhaseReached(phase, "cloned")) {
        this.setForkOpPhase(forkId, "cloned", { forkedChannelId, forkedContextId });
      }

      const clonedAgents: Array<{ participantId: string } & DORef> = [];
      const clonedParticipants: string[] = [];

      // 2. POSTCLONES — re-root the cloned channel's log at the fork point, hand
      //    it its provenance + pending seed marker, then re-home each
      //    cloned agent. Skipped on a resume that already passed this phase.
      const parentProvenance = this.computeProvenance();
      const rootChannelId =
        parentProvenance.kind === "fork" ? parentProvenance.rootChannelId : this.objectKey;
      if (!forkPhaseReached(phase, "postcloned")) {
        await this.rpc.call(doTarget(forkedChannelRef), "postClone", [
          this.objectKey,
          opts.forkPointPubsubId,
          forkedContextId,
          {
            forkId,
            rootChannelId,
            ...(opts.seed ? { seed: opts.seed } : {}),
            homeableTargets,
          },
        ]);
        for (const agent of keptAgents) {
          const ce = findClone(agent.ref);
          const clonedRef: DORef = {
            source: ce.source,
            className: ce.className!,
            objectKey: ce.newKey,
          };
          await this.rpc.call(doTarget(clonedRef), "postClone", [
            agent.ref.objectKey,
            forkedChannelId,
            this.objectKey,
            opts.forkPointPubsubId,
            forkedContextId,
          ]);
          clonedParticipants.push(agent.participantId);
          clonedAgents.push({ participantId: agent.participantId, ...clonedRef });
        }
        this.setForkOpPhase(forkId, "postcloned");
      } else {
        for (const agent of keptAgents) {
          const ce = findClone(agent.ref);
          clonedParticipants.push(agent.participantId);
          clonedAgents.push({
            participantId: agent.participantId,
            source: ce.source,
            className: ce.className!,
            objectKey: ce.newKey,
          });
        }
      }

      // 3. SEED — append the fork opening message on the child.
      let seededMessageId: string | undefined;
      if (opts.seed) {
        seededMessageId = `fork-seed:${forkId}`;
        if (!forkPhaseReached(phase, "seeded")) {
          await this.rpc.call(doTarget(forkedChannelRef), "appendSeed", [
            { forkId },
            opts.seed,
          ]);
        }
      }
      if (!forkPhaseReached(phase, "seeded")) this.setForkOpPhase(forkId, "seeded");

      // 4. ANNOUNCE — channel.forked on THIS (parent) log; the parent's `forks`
      //    projection enumerates its direct children.
      if (!forkPhaseReached(phase, "announced")) {
        await this.appendForkEvent(forkId, opts, {
          forkedChannelId,
          forkedContextId,
          rootChannelId,
          seededMessageId,
        });
        this.setForkOpPhase(forkId, "announced");
      }

      this.setForkOpPhase(forkId, "done");
      return {
        forkId,
        forkedChannelId,
        forkedContextId,
        clonedParticipants,
        clonedAgents,
        ...(seededMessageId ? { seededMessageId } : {}),
      };
    } catch (err) {
      await this.rollbackForkOp(forkId);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Fork failed: ${message}`);
    }
  }

  /** Tear down a failed fork: destroy the cloned context (we own it) and mark
   *  the journal `rolledback` so the reconciler leaves it alone. */
  private async rollbackForkOp(forkId: string): Promise<void> {
    const row = this.getForkOpRow(forkId);
    const forkedContextId = row?.["forked_context_id"] as string | null | undefined;
    if (forkedContextId) {
      try {
        await this.callMain("runtime.destroyContext", { contextId: forkedContextId });
      } catch (e) {
        console.error(`[Channel] fork rollback destroyContext failed for ${forkedContextId}:`, e);
      }
    }
    this.setForkOpPhase(forkId, "rolledback");
  }

  /** Append the durable `channel.forked` event to the parent log (this channel).
   *  Deterministic envelopeId makes a reconcile re-append a no-op. */
  private async appendForkEvent(
    forkId: string,
    opts: ForkOpts,
    fork: {
      forkedChannelId: string;
      forkedContextId: string;
      rootChannelId: string;
      seededMessageId?: string;
    }
  ): Promise<void> {
    void fork.rootChannelId;
    const actor = opts.seed?.author ?? this.participantRef(this.rpcCallerId ?? "system");
    const event: AgenticEvent<"channel.forked"> = {
      kind: "channel.forked",
      actor,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        forkId,
        forkedChannelId: fork.forkedChannelId,
        forkedContextId: fork.forkedContextId,
        forkPointId: opts.forkPointPubsubId,
        label: opts.label ?? opts.reason,
        reason: opts.reason,
        actor,
        ...(fork.seededMessageId ? { seededMessageId: fork.seededMessageId } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event,
      senderId: "system",
      messageId: `fork-event:${forkId}`,
      idempotency: "idempotent-by-id",
    });
    broadcast(this.broadcastDeps, logged, { kind: "log", phase: "live" }, "system");
  }

  /** Rename a direct child fork (durable `channel.fork_renamed` on this log). */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  async renameFork(forkId: string, label: string): Promise<void> {
    const event: AgenticEvent<"channel.fork_renamed"> = {
      kind: "channel.fork_renamed",
      actor: this.participantRef(this.rpcCallerId ?? "system"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, forkId, label },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event,
      senderId: "system",
    });
    broadcast(this.broadcastDeps, logged, { kind: "log", phase: "live" }, "system");
  }

  /** Archive a direct child fork (durable `channel.fork_archived` latch). */
  @rpc({ callers: ["panel", "do", "worker", "server"] })
  async archiveFork(forkId: string): Promise<void> {
    const event: AgenticEvent<"channel.fork_archived"> = {
      kind: "channel.fork_archived",
      actor: this.participantRef(this.rpcCallerId ?? "system"),
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, forkId },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event,
      senderId: "system",
    });
    broadcast(this.broadcastDeps, logged, { kind: "log", phase: "live" }, "system");
  }

  /**
   * List the DIRECT-CHILD forks rooted off THIS channel — folded from this
   * channel's OWN durable log (`channel.forked` / `channel.fork_renamed` /
   * `channel.fork_archived` envelopes) through the SAME reducer fold the client
   * uses, so the projection can never drift from the UI's. Archived forks are
   * returned too (the UI filters). A pure read — no writes. The fork switcher
   * shows SIBLING forks by reading the PARENT channel's `listForks` (WS-8
   * deferred this for lack of a cheap getForks RPC).
   */
  @rpc({ callers: ["panel", "worker", "server", "do"] })
  async listForks(): Promise<{ forks: ForkProjection[] }> {
    const PAGE = 500;
    let view = createInitialChannelViewState();
    let afterSeq = 0;
    for (;;) {
      const envelopes = await this.channelLog.read({
        afterSeq,
        limit: PAGE,
        payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      });
      if (envelopes.length === 0) break;
      for (const envelope of envelopes) {
        afterSeq = envelope.seq;
        const kind = (envelope.payload as AgenticEvent | null)?.kind;
        if (
          kind === "channel.forked" ||
          kind === "channel.fork_renamed" ||
          kind === "channel.fork_archived"
        ) {
          view = reduceChannelView(view, this.forkFoldEnvelope(envelope));
        }
      }
      if (envelopes.length < PAGE) break;
    }
    return { forks: view.forks };
  }

  /** Map a durable log envelope onto the `ChannelEnvelope` shape the reducer
   *  fold consumes (fork payloads carry no blob-spilled fields, so the
   *  non-hydrated `read()` payload is fed directly). */
  private forkFoldEnvelope(envelope: LogEnvelope): ChannelEnvelope {
    return {
      envelopeId: String(envelope.envelopeId) as ChannelEnvelope["envelopeId"],
      channelId: this.objectKey as ChannelEnvelope["channelId"],
      seq: envelope.seq,
      from: envelope.actor,
      payload: envelope.payload,
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      publishedAt: envelope.appendedAt,
    };
  }

  /** Resume or roll back any interrupted fork op (multiplexed onto alarm()). */
  private async reconcileForkOps(): Promise<void> {
    const stale = Date.now() - FORK_OP_RECONCILE_MS;
    const rows = this.sql
      .exec(
        `SELECT fork_id FROM fork_ops
           WHERE phase NOT IN ('done', 'rolledback') AND updated_at < ?`,
        stale
      )
      .toArray();
    for (const row of rows) {
      const forkId = row["fork_id"] as string;
      try {
        await this.runForkOp(forkId);
      } catch (err) {
        console.warn(`[Channel] fork op ${forkId} reconcile failed:`, err);
      }
    }
  }

  private nextForkOpReconcileAt(now: number): number | null {
    const oldest = this.sql
      .exec(
        `SELECT MIN(updated_at) AS oldest FROM fork_ops WHERE phase NOT IN ('done', 'rolledback')`
      )
      .toArray()[0]?.["oldest"];
    void now;
    return typeof oldest === "number" ? oldest + FORK_OP_RECONCILE_MS : null;
  }

  // ── appendSeed — fork opening message ──────────────────────────────────────

  /**
   * Append the fork's opening message on the CHILD channel. This is fork
   * plumbing: the pending fork marker only makes the operation one-shot and
   * crash-resumable for the matching fork id.
   */
  @rpc({ callers: ["panel", "worker", "server", "do", "shell"] })
  async appendSeed(
    forkOpRef: { forkId: string },
    envelope: ForkSeed
  ): Promise<{ messageId: string; seq: number }> {
    const forkId = forkOpRef.forkId;
    const messageId = `fork-seed:${forkId}`;
    // Idempotent: a re-drive after the message is durable returns it — even once
    // the pending seed marker has been consumed.
    const existing = await this.channelLog.getEventByEnvelopeId(messageId);
    if (existing) return { messageId, seq: existing.id };

    const marker = this.readForkSeedMarker();
    if (!marker || marker.forkId !== forkId) {
      throw new Error(
        `appendSeed: no pending fork seed for fork ${forkId} on this channel`
      );
    }

    const author = envelope.author;
    const seedEvent: AgenticEvent<"message.completed"> = {
      kind: "message.completed",
      actor: author,
      causality: { messageId: messageId as never },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        role: "user",
        blocks: envelope.blocks,
        outcome: "completed",
        tier: "primary",
        ...(envelope.replaces
          ? { replaces: { messageId: envelope.replaces.messageId as never, seq: envelope.replaces.seq } }
          : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: seedEvent,
      senderId: author.participantId ?? author.id,
      senderMetadata: author.metadata,
      messageId,
      idempotency: "idempotent-by-id",
    });
    broadcast(this.broadcastDeps, logged, { kind: "log", phase: "live" }, logged.senderId);
    this.clearForkSeedMarker();
    return { messageId, seq: logged.id };
  }

  private readForkSeedMarker(): ForkSeedMarker | null {
    const raw = this.getStateValue("forkSeedMarker");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ForkSeedMarker;
    } catch {
      return null;
    }
  }

  private clearForkSeedMarker(): void {
    this.deleteStateValue("forkSeedMarker");
  }

  // ── Fork support ────────────────────────────────────────────────────────

  /**
   * Called after cloneDO() copies the parent's SQLite. Forks the durable
   * channel log (no-copy), clears operational state, and REBUILDS the policy
   * caches by replaying the forked lineage — conversation state survives the
   * fork (WS2 §4.5). Also lands the clone's fork provenance + pending seed
   * marker from the parent fork op (`forkInit`).
   */
  @rpc({ callers: ["worker", "server", "do"] })
  async postClone(
    parentChannelId: string,
    forkPointId: number,
    // The clone's new context. A true context fork (`runtime.cloneContext`) lands
    // the clone in a fresh, isolated context; thread it so the channel's stored
    // contextId re-homes (matching the clone's entity record).
    newContextId: string,
    // Provenance + seed marker from the parent fork op. `rootChannelId`
    // roots the lineage tree; `seed` records that one `appendSeed` is pending;
    // `homeableTargets` are the cloned entity ids — a pending call whose target is
    // NOT among them could not follow the fork and is settled `aborted-by-fork` (C6).
    forkInit?: {
      forkId: string;
      rootChannelId: string;
      seed?: ForkSeed;
      homeableTargets?: string[];
    }
  ): Promise<void> {
    if (!newContextId) throw new Error("postClone requires newContextId");
    // Fix identity: cloneDO copies parent's __objectKey; overwrite with our actual key
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES ('__objectKey', ?)`,
      this.objectKey
    );
    const parentContextId = this.getStateValue("contextId");
    if (parentContextId) this.setStateValue("forkedFromContextId", parentContextId);
    // Re-home the context (bypasses initChannel's mismatch guard by writing the
    // state row directly because clone provisioning owns the new context).
    this.setStateValue("contextId", newContextId);
    this.setStateValue("forkedFrom", parentChannelId);
    this.setStateValue("forkPointId", String(forkPointId));
    if (forkInit) {
      this.setStateValue("rootChannelId", forkInit.rootChannelId);
      this.setStateValue("forkId", forkInit.forkId);
      if (forkInit.seed) {
        this.setStateValue(
          "forkSeedMarker",
          JSON.stringify({ forkId: forkInit.forkId })
        );
      }
    }
    await this.channelLog.forkFrom(parentChannelId, forkPointId);
    // The child must NOT inherit the parent's fork journal or lineage roster —
    // it runs neither the parent's reconciler nor its head fan-out.
    this.sql.exec(`DELETE FROM fork_ops`);
    this.sql.exec(`DELETE FROM lineage_subscribers`);
    this.deleteStateValue("lineageDirtyAt");
    // Clear operational state + caches
    this.sql.exec(`DELETE FROM participants`);
    this.sql.exec(`DELETE FROM pending_calls`);
    this.sql.exec(`DELETE FROM dedup_keys`);
    await this.policyHost.rebuildAfterFork();
    // Rebuild pending_calls for any started-without-terminal in the inherited
    // prefix (they will be abandoned/redelivered by normal roster flow).
    await this.calls.reconcilePendingCalls(true);
    // Settle calls that could not follow the fork (target not cloned) —
    // aborted-by-fork rather than left hanging until deadline (C6).
    if (forkInit?.homeableTargets) {
      await this.settleUnhomeablePendingCalls(new Set(forkInit.homeableTargets));
    }
  }

  private async settleUnhomeablePendingCalls(homeable: Set<string>): Promise<void> {
    const targets = new Set<string>();
    for (const row of this.sql.exec(`SELECT DISTINCT target_id FROM pending_calls`).toArray()) {
      targets.add(String((row as Record<string, unknown>)["target_id"]));
    }
    for (const targetId of targets) {
      if (homeable.has(targetId)) continue;
      await this.calls.failPendingCallsTargeting(targetId, "aborted-by-fork");
    }
  }

  // ── Lineage subscriptions + fork.head_changed hub ─────────────────────────
  //
  // A NEW signal-only subscription MODE: unlike `subscribe` (always durable
  // replay), `subscribeLineage` registers a lightweight roster that the root of
  // a fork tree fans ephemeral `fork.head_changed` signals to. Each channel, on
  // a durable head advance, reports up its `forkedFrom` chain (debounced) to the
  // root; the root fans out to its lineage subscribers. Badges reconcile from
  // durable state on open (§H) — a missed signal is not durable.

  @rpc({ callers: ["panel", "do"] })
  async subscribeLineage(
    participantId: string,
    metadata: Record<string, unknown> = {}
  ): Promise<{ ok: true }> {
    if (!this.isAuthorizedParticipantCaller(participantId)) {
      const caller = this.caller;
      throw new Error(
        `Participant ${participantId} cannot subscribe to lineage by caller ${caller?.callerId ?? "unknown"}`
      );
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO lineage_subscribers (id, metadata, created_at) VALUES (?, ?, ?)`,
      participantId,
      JSON.stringify(metadata),
      Date.now()
    );
    return { ok: true };
  }

  @rpc({ callers: ["panel", "do"] })
  async unsubscribeLineage(participantId: string): Promise<void> {
    this.assertParticipantCaller(participantId, "unsubscribeLineage");
    this.sql.exec(`DELETE FROM lineage_subscribers WHERE id = ?`, participantId);
  }

  /** Relay point for a head advance reported up the chain from a descendant. */
  @rpc({ callers: ["do", "worker", "server"] })
  async reportLineageHead(report: { channelId: string; headSeq: number }): Promise<void> {
    await this.relayLineageHead(report.channelId, report.headSeq);
  }

  /** Record a local durable head advance for the debounced fan-out. */
  private noteLineageHeadAdvance(seq: number): void {
    const pending = Number(this.getStateValue("lineagePendingHead") ?? 0);
    if (seq <= pending) return;
    this.setStateValue("lineagePendingHead", String(seq));
    if (!this.getStateValue("lineageDirtyAt")) {
      this.setStateValue("lineageDirtyAt", String(Date.now()));
      this.scheduleNextAlarm();
    }
  }

  private nextLineageReportAt(): number | null {
    const dirtyAt = this.getStateValue("lineageDirtyAt");
    return dirtyAt ? Number(dirtyAt) + LINEAGE_REPORT_DEBOUNCE_MS : null;
  }

  private async flushLineageHeadReport(): Promise<void> {
    if (!this.getStateValue("lineageDirtyAt")) return;
    const head = Number(this.getStateValue("lineagePendingHead") ?? 0);
    this.deleteStateValue("lineageDirtyAt");
    await this.relayLineageHead(this.objectKey, head);
  }

  /** Root → fan out to lineage subscribers; otherwise forward up to the parent. */
  private async relayLineageHead(originChannelId: string, headSeq: number): Promise<void> {
    const provenance = this.computeProvenance();
    if (provenance.kind === "fork") {
      try {
        const parentRef = await this.resolveChannelRef(provenance.forkedFrom);
        await this.rpc.call(doTarget(parentRef), "reportLineageHead", [
          { channelId: originChannelId, headSeq },
        ]);
      } catch (err) {
        console.warn(`[Channel] lineage head forward to ${provenance.forkedFrom} failed:`, err);
      }
      return;
    }
    this.fanoutLineageHead(originChannelId, headSeq);
  }

  private fanoutLineageHead(originChannelId: string, headSeq: number): void {
    const subs = this.sql.exec(`SELECT id FROM lineage_subscribers`).toArray();
    if (subs.length === 0) return;
    const event = buildChannelEvent(
      0,
      `linsig_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      "signal",
      JSON.stringify({
        content: JSON.stringify({ channelId: originChannelId, headSeq }),
        contentType: FORK_HEAD_CHANGED_SIGNAL,
      }),
      "system",
      undefined,
      Date.now()
    );
    const signal = channelEventToRpcSignal(event);
    for (const row of subs) {
      const pid = (row as Record<string, unknown>)["id"] as string;
      void queueEmit(
        this.broadcastDeps,
        pid,
        { channelId: this.objectKey, message: signal },
        (err) => {
          if (
            err?.code === "TARGET_NOT_REACHABLE" ||
            err?.code === "RECONNECT_GRACE_EXPIRED" ||
            err?.code === "DO_NOT_CREATED"
          ) {
            this.sql.exec(`DELETE FROM lineage_subscribers WHERE id = ?`, pid);
            return true;
          }
          return false;
        }
      );
    }
  }

  // ── State introspection ─────────────────────────────────────────────────

  @rpc({ callers: ["panel", "server", "shell"] })
  override async getState(): Promise<Record<string, unknown>> {
    const replay = await this.channelLog.replayInitial(1, this.currentReplayContext());
    const participants = this.sql.exec(`SELECT * FROM participants`).toArray();
    const pendingCalls = this.sql.exec(`SELECT * FROM pending_calls`).toArray();
    const state = this.sql.exec(`SELECT * FROM state`).toArray();
    return {
      envelopeCount: replay.ready.envelopeCount,
      participants,
      pendingCalls,
      state,
    };
  }
}

export type { PendingCallRow };
