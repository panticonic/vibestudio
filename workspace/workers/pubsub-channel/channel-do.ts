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

/// <reference path="./workerd.d.ts" />
import {
  createDurableObjectServiceClient,
  rpc,
  DurableObjectBase,
  type DurableObjectContext,
  type DurableObjectServiceClient,
  type UserlandApprovalChoice,
} from "@workspace/runtime/worker";
import type { ChannelEvent } from "@workspace/harness";
import {
  channelSubscriptionQueuingStrategy,
  encodeChannelSubscriptionRecord,
  enqueueChannelSubscriptionBytes,
} from "@workspace/pubsub";
import type {
  BootstrapSnapshot,
  ChannelInvite,
  ChannelReplayAfterRequest,
  ParticipantSnapshot,
} from "@workspace/pubsub";

const PUBSUB_CHANNEL_SCHEMA_BASELINE = 114;
import type {
  DeleteChannelInviteInput,
  DeleteChannelMembershipInput,
  PutChannelMembershipInput,
} from "@vibestudio/shared/channelInvites";
import type { DoAlarmSchedule } from "@vibestudio/shared/doDispatcher";
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
  queueDoEnvelope,
  type BroadcastDeps,
  cleanupDeliveryChain,
} from "./broadcast.js";
import { ChannelLog, type ChannelReplayContext, type MessageTypeDefinition } from "./log-store.js";
import { PolicyHost, policyViewFromLogEnvelope } from "./policy-host.js";
import { CallTransport, type PendingCallRow } from "./calls.js";
import type { PolicyEnvelopeView } from "@workspace/channel-policies";
import {
  AGENT_INSPECTION_METHODS,
  AGENT_INSPECTION_RPC_METHOD,
  isAgentInspectionMethod,
  type AgentInspectionMethod,
} from "@vibestudio/shared/agentInspection";

/** Subscribed humans move through these activity states without being removed
 * from the roster. Only domain activity resets these clocks. */
const PRESENCE_IDLE_MS = 5 * 60 * 1000;
const PRESENCE_AWAY_MS = 30 * 60 * 1000;
/** WP8 §3 — how long a departed user's `presence_last_seen` row is retained so
 *  offline members still render "last seen Xm ago". A bounded window (decision
 *  §8.3); older rows are swept alongside the participant sweep. Their account
 *  identity persists in the hub-owned identity DB regardless. */
const PRESENCE_LAST_SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Default channel-envelope replay window. */
const REPLAY_LIMIT = 50;
/** Dedup keys are a latency cache; the durable dedupe is the `ik:{key}`
 *  envelope id in the log lineage. */
const DEDUP_TTL_MS = 5 * 60 * 1000;
/** A pending call is eligible for at-least-once redelivery after its initial
 * delivery has had a short opportunity to settle. */
const PENDING_REDELIVERY_STALE_MS = 10_000;
const PENDING_REDELIVERY_INTERVAL_MS = 15_000;
const PENDING_REDELIVERY_SWEPT_AT_KEY = "pendingRedeliverySweptAt";
const INVITE_INDEX_RETRY_MS = 5_000;
const INVITE_INDEX_REVISION_KEY = "inviteIndexRevision";

const DEFAULT_POLICY_NAME = "agentic.conversation.v1";

/** Service protocol the channel DO resolves for sibling channels (fork parent,
 *  lineage forwarding). */
const CHANNEL_SERVICE_PROTOCOL = "vibestudio.channel.v1";
const GAD_WORKSPACE_SERVICE_PROTOCOL = "vibestudio.gad.workspace.v1";
/** Signal contentType for the ephemeral fork.head_changed lineage badge. */
const FORK_HEAD_CHANGED_SIGNAL = "fork.head_changed";
const FORK_OP_RECONCILE_MS = 5_000;

/** Ordered fork-op phases; a resume skips everything at or below the recorded
 * phase. `rollback-pending` remains retryable until owned context cleanup is
 * confirmed; `rolledback` is terminal. */
const FORK_PHASES = ["journaled", "cloned", "postcloned", "seeded", "announced", "done"] as const;
type ForkPhase = (typeof FORK_PHASES)[number] | "rollback-pending" | "rolledback";
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
  /** Stable identity allocated once by the caller and retained by transport
   * retries. It is also the saga identity and clone target key. */
  operationId: string;
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

/**
 * Stable principal-derived human participant id (WP6 §4): `user:<userId>`.
 * One roster identity per human, shared by every live panel/device.
 */
function isUserParticipantId(participantId: string): boolean {
  return participantId.startsWith("user:");
}

/** Build the stable channel participant id from the canonical bare account id. */
function toUserMemberId(userId: string): string {
  return `user:${userId}`;
}

/** The bare `userId` behind a `user:<id>` member id (idempotent on a bare id). */
function bareUserId(userIdOrRef: string): string {
  return userIdOrRef.startsWith("user:") ? userIdOrRef.slice("user:".length) : userIdOrRef;
}

function requireBareUserId(value: unknown, method: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.startsWith("user:")) {
    throw new Error(`${method}: userId must be a bare workspace account id`);
  }
  return value.trim();
}

/**
 * A human roster row stores ONLY the stable identity (`id: user:<userId>`,
 * `kind: "user"`) plus functional transport fields (methods, typing, …).
 * Mutable profile — handle/displayName/color/avatar — is NEVER frozen into
 * the row; renderers resolve it live from the host-projected identity read
 * (WP0 §3.7, WP6 §3). Client-asserted identity fields are dropped here: data
 * hygiene (one source of truth), not an inter-user security wall (plan §0.0).
 */
function scrubUserParticipantMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const scrubbed = { ...metadata };
  delete scrubbed["handle"];
  delete scrubbed["name"];
  delete scrubbed["displayName"];
  delete scrubbed["color"];
  delete scrubbed["avatar"];
  scrubbed["type"] = "user";
  scrubbed["kind"] = "user";
  return scrubbed;
}

const AGENT_INSPECTION_TIMEOUT_MS = 5_000;

function stableShortHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(36).padStart(7, "0")}${(h1 >>> 0).toString(36).padStart(7, "0")}`;
}

interface AgentInspectionResult {
  participantId: string;
  channelId: string;
  methodName: string;
  result: unknown;
  isError?: boolean;
  roster: {
    present: boolean;
    transport?: string;
    metadata?: Record<string, unknown>;
  };
}

/** A durable channel membership record (WP7 §3) — separate from the ephemeral
 *  `participants` roster row. Survives reconnects and offline stretches. */
interface ChannelMember {
  /** Bare `userId` (the `user:<id>` prefix stripped). */
  userId: string;
  /** Stable member id / `channel_members` PK (`user:<userId>`). */
  memberId: string;
  /** Invitee handle snapshot at add time (profiles still render LIVE, WP6 §3). */
  handle: string;
  /** Acting user's member id (or raw callerId for agent/worker adds). */
  addedBy: string;
  addedAt: number;
}

type ChannelPresenceStatus = "online" | "idle" | "away" | "offline";

interface ChannelPresenceEntry {
  participantId: string;
  userId: string;
  status: ChannelPresenceStatus;
  lastActiveAt: number | null;
  lastSeenAt: number | null;
  sessionCount: number;
}

export class PubSubChannel extends DurableObjectBase {
  static override schemaVersion = PUBSUB_CHANNEL_SCHEMA_BASELINE;
  private _channelLog: ChannelLog | null = null;
  private _inviteIndex: DurableObjectServiceClient | null = null;
  private _policyHost: PolicyHost | null = null;
  private _calls: CallTransport | null = null;
  private readonly publishDedupInFlight = new Map<string, Promise<ChannelEvent>>();
  private readonly subscriptionStreams = new Map<
    string,
    {
      participantId: string;
      deliveryId: string;
      token: symbol;
      controller: ReadableStreamDefaultController<Uint8Array>;
    }
  >();

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    // Eager init — the DO must be ready before any message arrives.
    this.ensureReady();
    try {
      this.sql.exec(`PRAGMA foreign_keys = ON`);
    } catch {
      /* workerd may ignore pragmas */
    }
    this.reapOrphanedSubscriptionProjection();
  }

  /**
   * `participants` is the durable projection of activation-local response
   * resources. A live response keeps this activation resident; therefore any
   * rows observed by a fresh activation have no possible owning stream and are
   * orphans. Rebuild them only from new subscription responses.
   */
  private reapOrphanedSubscriptionProjection(): void {
    const disconnectedAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO presence_last_seen (participant_id, last_seen)
         SELECT id, ? FROM participants WHERE id LIKE 'user:%'
         ON CONFLICT(participant_id) DO UPDATE SET last_seen = excluded.last_seen`,
        disconnectedAt
      );
      this.sql.exec(`DELETE FROM participants`);
    });
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        metadata TEXT NOT NULL,
        transport TEXT NOT NULL CHECK (transport IN ('rpc','do')),
        -- Freshest real client activity across a user's subscriptions.
        last_active_at INTEGER,
        presence_status TEXT CHECK (presence_status IN ('online','idle','away')),
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
    // Durable channel membership (WP7 §3). This is deliberately separate from
    // the ephemeral `participants` roster, which is rebuilt on reconnect. The
    // workspace-wide pending-invite index lives in GAD; membership carries no
    // duplicate acknowledgement state.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_members (
        user_id  TEXT PRIMARY KEY,   -- user:<userId>
        handle   TEXT NOT NULL,
        added_by TEXT NOT NULL,      -- user:<userId> (or raw callerId)
        added_at INTEGER NOT NULL
      )
    `);
    // Crash-safe membership → workspace-inbox projection. A row is replaced
    // atomically whenever the desired state changes, and removed only when the
    // matching op_id is confirmed by GAD, so an interleaved add/remove cannot
    // let an older response erase the newer intent.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS invite_index_ops (
        user_id    TEXT PRIMARY KEY,   -- user:<userId>
        op_id      TEXT NOT NULL UNIQUE,
        revision   INTEGER NOT NULL CHECK (revision > 0),
        action     TEXT NOT NULL CHECK (action IN ('put', 'delete')),
        handle     TEXT,
        added_by   TEXT,
        added_at   INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK (
          action = 'delete' OR
          (handle IS NOT NULL AND added_by IS NOT NULL AND added_at IS NOT NULL)
        )
      )
    `);
    this.sql.exec(
      `CREATE INDEX IF NOT EXISTS idx_invite_index_ops_updated ON invite_index_ops(updated_at)`
    );
    // WP8 §3 — retained last-seen for account presence. When a user's last
    // subscribed panel leaves, we stamp `last_seen`
    // here so an offline member still renders "last seen Xm ago". Deliberately
    // OUTLIVES the ephemeral `participants` row (which is deleted on leave); a
    // (re)join clears the row. Bounded by PRESENCE_LAST_SEEN_RETENTION_MS.
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS presence_last_seen (
        participant_id TEXT PRIMARY KEY,    -- user:<userId>
        last_seen      INTEGER NOT NULL
      )
    `);
  }

  protected override schemaProductionBaseline() {
    return {
      version: PUBSUB_CHANNEL_SCHEMA_BASELINE,
      name: "pubsub-channel-v114",
    } as const;
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  private get broadcastDeps(): BroadcastDeps {
    return {
      sql: this.sql,
      rpc: this.rpc,
      objectKey: this.objectKey,
      deliverParticipant: (participantId, payload) =>
        this.deliverParticipantPayload(participantId, payload),
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

  private get inviteIndex(): DurableObjectServiceClient {
    this._inviteIndex ??= createDurableObjectServiceClient(
      {
        call: <T = unknown>(targetId: string, method: string, args: unknown[]) =>
          this.rpc.call<T>(targetId, method, args),
      },
      GAD_WORKSPACE_SERVICE_PROTOCOL
    );
    return this._inviteIndex;
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
        void this.deliverParticipantPayload(participantId, {
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
    if (!caller?.callerId) return false;
    if (caller.callerId === participantId) return true;
    if (caller.callerPanelId === participantId) return true;
    // Principal-derived human identity (WP6 §3-4): any panel/device owned by
    // the host-verified user acts as the shared `user:<userId>` participant.
    if (caller.userId && participantId === `user:${caller.userId}`) return true;
    return false;
  }

  private participantSubscriptionCount(participantId: string): number {
    let count = 0;
    for (const stream of this.subscriptionStreams.values()) {
      if (stream.participantId === participantId) count += 1;
    }
    return count;
  }

  private subscriptionStreamKey(participantId: string, deliveryId: string): string {
    return `${participantId}\u0000${deliveryId}`;
  }

  private async deliverParticipantPayload(participantId: string, payload: unknown): Promise<void> {
    const bytes = encodeChannelSubscriptionRecord({ kind: "message", payload });
    const terminated: Array<{ key: string; token: symbol }> = [];
    for (const [key, stream] of this.subscriptionStreams) {
      if (stream.participantId !== participantId) continue;
      try {
        if (enqueueChannelSubscriptionBytes(stream.controller, bytes) !== "enqueued") {
          terminated.push({ key, token: stream.token });
        }
      } catch {
        terminated.push({ key, token: stream.token });
      }
    }
    for (const stream of terminated) {
      await this.terminateSubscriptionStream(stream.key, stream.token, "response-buffer-full");
    }
  }

  private async terminateSubscriptionStream(
    key: string,
    token: symbol,
    reason: string
  ): Promise<void> {
    const stream = this.subscriptionStreams.get(key);
    if (!stream || stream.token !== token) return;
    this.subscriptionStreams.delete(key);
    try {
      stream.controller.error(new Error(`Channel subscription terminated: ${reason}`));
    } catch {
      // Already terminal.
    }
    await this.unsubscribeParticipant(stream.participantId, "disconnect", stream.deliveryId);
  }

  private openSubscriptionResponse(
    participantId: string,
    deliveryId: string,
    replaceParticipant: boolean,
    result: SubscribeResult
  ): Response {
    const key = this.subscriptionStreamKey(participantId, deliveryId);
    const token = Symbol(key);
    for (const [streamKey, previous] of [...this.subscriptionStreams]) {
      if (streamKey !== key && (!replaceParticipant || previous.participantId !== participantId)) {
        continue;
      }
      this.subscriptionStreams.delete(streamKey);
      try {
        previous.controller.close();
      } catch {
        // Already terminal.
      }
    }
    const body = new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          this.subscriptionStreams.set(key, {
            participantId,
            deliveryId,
            token,
            controller,
          });
          const ack = encodeChannelSubscriptionRecord({ kind: "subscribed", result });
          if (enqueueChannelSubscriptionBytes(controller, ack) !== "enqueued") {
            void this.terminateSubscriptionStream(key, token, "subscription-ack-too-large");
          }
        },
        cancel: async () => {
          const current = this.subscriptionStreams.get(key);
          if (!current || current.token !== token) return;
          this.subscriptionStreams.delete(key);
          await this.unsubscribeParticipant(participantId, "disconnect", deliveryId);
        },
      },
      channelSubscriptionQueuingStrategy()
    );
    return new Response(body, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store",
      },
    });
  }

  private closeSubscriptionStream(participantId: string, deliveryId: string): void {
    const key = this.subscriptionStreamKey(participantId, deliveryId);
    const stream = this.subscriptionStreams.get(key);
    if (!stream) return;
    this.subscriptionStreams.delete(key);
    try {
      stream.controller.close();
    } catch {
      // Already terminal.
    }
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

  private broadcastChannelSignal(
    type: string,
    payload: Record<string, unknown>,
    senderId = "system"
  ): void {
    const event = buildChannelEvent(
      0,
      crypto.randomUUID(),
      type,
      JSON.stringify(payload),
      senderId,
      undefined,
      Date.now()
    );
    broadcast(this.broadcastDeps, event, { kind: "signal" }, senderId);
  }

  private presenceStatusAt(
    lastActiveAt: number,
    now = Date.now()
  ): Exclude<ChannelPresenceStatus, "offline"> {
    const age = Math.max(0, now - lastActiveAt);
    if (age < PRESENCE_IDLE_MS) return "online";
    if (age < PRESENCE_AWAY_MS) return "idle";
    return "away";
  }

  /** Record real user activity (message, typing, method interaction). */
  private markParticipantActive(participantId: string): void {
    if (!isUserParticipantId(participantId)) return;
    const now = Date.now();
    const row = this.sql
      .exec(`SELECT presence_status FROM participants WHERE id = ?`, participantId)
      .toArray()[0];
    if (!row) return;
    const was = row["presence_status"] as string | null;
    this.sql.exec(
      `UPDATE participants SET last_active_at = ?, presence_status = 'online' WHERE id = ?`,
      now,
      participantId
    );
    if (was !== "online") {
      this.broadcastPresenceSignal(participantId, "update", {
        kind: "user",
        presenceStatus: "online",
        lastActiveAt: now,
      });
    }
  }

  private recordOfflinePresence(participantId: string, lastSeen: number): void {
    this.sql.exec(
      `INSERT INTO presence_last_seen (participant_id, last_seen) VALUES (?, ?)
       ON CONFLICT(participant_id) DO UPDATE SET last_seen = excluded.last_seen`,
      participantId,
      lastSeen
    );
  }

  /** Durable per-channel human presence, including offline members who have no
   * roster row. Status is server-derived from real activity and session count. */
  @rpc({ principals: ["host", "user", "code", "entity"], sensitivity: "read" })
  async getChannelPresence(): Promise<{ entries: ChannelPresenceEntry[]; generatedAt: number }> {
    const generatedAt = Date.now();
    const entries = new Map<string, ChannelPresenceEntry>();
    for (const row of this.sql
      .exec(
        `SELECT id, last_active_at, presence_status
           FROM participants
          WHERE id LIKE 'user:%'`
      )
      .toArray()) {
      const participantId = row["id"] as string;
      const lastActiveAt = (row["last_active_at"] as number | null) ?? generatedAt;
      entries.set(participantId, {
        participantId,
        userId: bareUserId(participantId),
        status: this.presenceStatusAt(lastActiveAt, generatedAt),
        lastActiveAt,
        lastSeenAt: null,
        sessionCount: this.participantSubscriptionCount(participantId),
      });
    }
    for (const row of this.sql
      .exec(`SELECT participant_id, last_seen FROM presence_last_seen`)
      .toArray()) {
      const participantId = row["participant_id"] as string;
      if (entries.has(participantId)) continue;
      entries.set(participantId, {
        participantId,
        userId: bareUserId(participantId),
        status: "offline",
        lastActiveAt: null,
        lastSeenAt: row["last_seen"] as number,
        sessionCount: 0,
      });
    }
    for (const row of this.sql.exec(`SELECT user_id FROM channel_members`).toArray()) {
      const participantId = row["user_id"] as string;
      if (entries.has(participantId)) continue;
      entries.set(participantId, {
        participantId,
        userId: bareUserId(participantId),
        status: "offline",
        lastActiveAt: null,
        lastSeenAt: null,
        sessionCount: 0,
      });
    }
    return {
      entries: [...entries.values()].sort((a, b) => a.participantId.localeCompare(b.participantId)),
      generatedAt,
    };
  }

  // ── RPC-callable methods ──────────────────────────────────────────────

  /**
   * Subscribe a participant to this channel. Inserts the participant first,
   * then builds replay, so an initial roster snapshot includes the subscriber.
   */
  @rpc({ principals: ["user", "code", "entity"], sensitivity: "write" })
  async subscribe(participantId: string, metadata: Record<string, unknown>): Promise<Response> {
    const doRef = parseDOParticipantId(participantId);
    const transport = doRef ? "do" : "rpc";

    // ── Principal-derived human identity (WP6 §3-4) ──────────────────────
    // A human panel/shell joins as the STABLE account participant
    // `user:<userId>` (kind "user"), stamped from the host-verified caller
    // userId (WP4 §2.4) — any client-asserted id/handle for a human join is
    // IGNORED. This is data hygiene (one reliable identity per human, plan
    // §0.0), not an inter-user security wall. Mutable profile fields
    // (handle/displayName/color/avatar) are never frozen onto the roster
    // row; renderers resolve them live from the host-projected identity
    // read (WP0 §3.7). Agents/vessels keep supplying their own descriptor.
    const subscribeCaller = this.caller;
    const verifiedUserId =
      subscribeCaller?.userId &&
      (subscribeCaller.callerPanelId || this.authorization?.authorizingOrigin.kind === "user")
        ? subscribeCaller.userId
        : null;
    // Clean cut: every verified panel/shell is a human account. There is no
    // client marker, asserted kind, or pre-canonical participant-id convention.
    if (!doRef && verifiedUserId) {
      participantId = `user:${verifiedUserId}`;
    } else if (isUserParticipantId(participantId)) {
      throw new Error(
        `subscribe: participant id "${participantId}" is principal-derived; only a ` +
          `host-verified human caller (panel/shell carrying a userId) may claim it`
      );
    }
    const isUserParticipant = isUserParticipantId(participantId);

    if (!this.isAuthorizedParticipantCaller(participantId)) {
      const caller = this.caller;
      throw new Error(
        `Participant ${participantId} cannot be subscribed by caller ${caller?.callerId ?? "unknown"}`
      );
    }
    const deliveryId = subscribeCaller?.callerPanelId ?? subscribeCaller?.callerId;
    if (!deliveryId) throw new Error("subscribe: authenticated delivery identity is required");

    const parsedMetadata = participantMetadataSchema.safeParse(metadata);
    if (!parsedMetadata.success) {
      const issue = parsedMetadata.error.issues[0];
      throw new Error(
        `subscribe: invalid participant metadata at ${issue?.path.join(".") || "$"}: ${issue?.message ?? "invalid"}`
      );
    }

    const contextId = metadata["contextId"] as string | undefined;
    const channelConfigRaw = metadata["channelConfig"] as Record<string, unknown> | undefined;
    if (contextId) {
      this.initChannel(contextId, channelConfigRaw);
    }

    // Handle uniqueness: a friendly pre-check complements the partial unique
    // index that provides race-proof enforcement. Human
    // rows store NO handle (WP6 §3: the account handle renders live, is
    // unique server-wide, and never enters this per-channel column).
    const handle =
      !isUserParticipant && typeof metadata["handle"] === "string"
        ? (metadata["handle"] as string)
        : null;
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

    if (doRef) {
      // Subscription does not discover or activate a class. The participant
      // authenticated above is an exact runtime identity and must already be
      // active before the channel may retain or route to it. Using the active
      // entity registry keeps that liveness proof independent of the public
      // workspace-service/DO discovery surface (which intentionally does not
      // expose per-owner internal objects such as EvalDO).
      const active = (await this.rpc.call("main", "workspace-state.entity.resolveActive", [
        participantId,
      ])) as { id?: unknown; kind?: unknown } | null;
      if (!active || active.id !== participantId || active.kind !== "do") {
        throw new Error(`subscribe: Durable Object participant ${participantId} is not active`);
      }
    }

    // Active response resources are the one source of subscription lifetime.
    // Human identity is shared across independently authenticated delivery
    // endpoints; every other participant has one replaceable response.
    const existingSubscriptions = this.participantSubscriptionCount(participantId);

    // Extract replay options before cleaning metadata
    const wantsReplay = metadata["replay"] !== false;
    const sinceId = metadata["sinceId"] as number | undefined;
    const replayMessageLimit = metadata["replayMessageLimit"] as number | undefined;

    // Clean metadata for storage (remove transport/DO fields and subscribe-time hints)
    let storedMetadata = { ...metadata };
    delete storedMetadata["contextId"];
    delete storedMetadata["channelConfig"];
    delete storedMetadata["replay"];
    delete storedMetadata["sinceId"];
    delete storedMetadata["replayMessageLimit"];
    delete storedMetadata["transport"];
    if (isUserParticipant) storedMetadata = scrubUserParticipantMetadata(storedMetadata);

    try {
      if (isUserParticipant) {
        // The shared human identity and retained-presence reset form one
        // storage commit.
        // Joining IS activity (WP8 §3): seed `last_active_at` on first join and
        // bump it on every (re)join so a returning panel resets idle/away.
        const joinNow = Date.now();
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(
            `INSERT INTO participants (
               id, metadata, transport, last_active_at, presence_status, handle,
               do_source, do_class, do_object_key
             ) VALUES (?, ?, 'rpc', ?, 'online', NULL, NULL, NULL, NULL)
             ON CONFLICT(id) DO UPDATE SET
               metadata = excluded.metadata,
               transport = excluded.transport,
               last_active_at = MAX(COALESCE(participants.last_active_at, 0), excluded.last_active_at),
               presence_status = 'online'`,
            participantId,
            JSON.stringify(storedMetadata),
            joinNow
          );
          // Back online — drop retained last-seen in the same commit.
          this.sql.exec(`DELETE FROM presence_last_seen WHERE participant_id = ?`, participantId);
        });
      } else {
        this.sql.exec(
          `INSERT INTO participants (
             id, metadata, transport, last_active_at, presence_status, handle,
             do_source, do_class, do_object_key
           ) VALUES (?, ?, ?, NULL, NULL, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             metadata = excluded.metadata,
             transport = excluded.transport,
             handle = excluded.handle,
             do_source = excluded.do_source,
             do_class = excluded.do_class,
             do_object_key = excluded.do_object_key`,
          participantId,
          JSON.stringify(storedMetadata),
          transport === "do" ? "do" : "rpc",
          handle,
          doRef?.source ?? null,
          doRef?.className ?? null,
          doRef?.objectKey ?? null
        );
      }
    } catch (err) {
      if (handle && err instanceof Error && /unique/iu.test(err.message)) {
        throw new Error(
          `Participant handle "${handle}" is already in use by another participant ` +
            `(unknown) in this channel. Handles must be unique.`
        );
      }
      throw err;
    }

    // Publish join presence before building replay so the initial roster snapshot
    // includes self. Replacing a transport generation is an update to the same
    // semantic participant, not a synthetic leave/join pair.
    await this.publishPresenceEvent(
      participantId,
      existingSubscriptions > 0 ? "update" : "join",
      storedMetadata
    );

    const mode = wantsReplay && sinceId && sinceId > 0 ? "after" : "initial";
    const envelope =
      mode === "after"
        ? await this.channelLog.replayAfter({ after: sinceId! }, this.currentReplayContext())
        : await this.channelLog.replayInitial(
            wantsReplay ? (replayMessageLimit ?? REPLAY_LIMIT) : 0,
            this.currentReplayContext()
          );
    return this.openSubscriptionResponse(participantId, deliveryId, !isUserParticipant, {
      ok: true,
      participantId,
      channelConfig: this.getChannelConfig() ?? undefined,
      envelope,
    });
  }

  @rpc({ principals: ["host", "user"], sensitivity: "admin" })
  async adminUnsubscribeParticipant(participantId: string): Promise<void> {
    await this.unsubscribeParticipant(participantId, "graceful");
  }

  private async unsubscribeParticipant(
    participantId: string,
    leaveReason: "graceful" | "disconnect" | "replaced",
    deliveryId?: string
  ): Promise<void> {
    const metadata = this.getSenderMetadata(participantId) ?? {};
    const participantExists =
      this.sql.exec(`SELECT 1 FROM participants WHERE id = ?`, participantId).toArray().length > 0;
    if (deliveryId) {
      this.closeSubscriptionStream(participantId, deliveryId);
    } else {
      for (const stream of [...this.subscriptionStreams.values()]) {
        if (stream.participantId === participantId) {
          this.closeSubscriptionStream(participantId, stream.deliveryId);
        }
      }
    }
    if (this.participantSubscriptionCount(participantId) > 0) return;
    if (!participantExists) return;

    this.ctx.storage.transactionSync(() => {
      if (isUserParticipantId(participantId)) {
        this.recordOfflinePresence(participantId, Date.now());
      }
      this.sql.exec(`DELETE FROM participants WHERE id = ?`, participantId);
    });
    cleanupDeliveryChain(this.objectKey, participantId);
    await this.calls.failPendingCallsTargeting(participantId, leaveReason);
    await this.publishPresenceEvent(
      participantId,
      "leave",
      {
        ...metadata,
        ...(isUserParticipantId(participantId) ? { presenceStatus: "offline" } : {}),
      },
      leaveReason
    );
  }

  /** Abandoned terminals for every pending call targeting a leaver (or, on a
   *  fork that could not re-home the call, `aborted-by-fork` — C6). */
  async failPendingCallsTargeting(
    targetId: string,
    reason: "graceful" | "disconnect" | "replaced" | "aborted-by-fork"
  ): Promise<void> {
    await this.calls.failPendingCallsTargeting(targetId, reason);
  }

  /**
   * Publish a typed message. The transport is OPAQUE to payload semantics:
   * GAD validates agentic payloads at append-time inside the txn; policies
   * annotate (never mutate) the envelope.
   */
  @rpc({ principals: ["code"], sensitivity: "write" })
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
    this.markParticipantActive(participantId);
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

  /**
   * Publish a durable text message on behalf of a NON-participant host caller
   * (the `vibestudio channel send` CLI: a human `shell` device or an autonomous
   * `agent`). Unlike `publish`, the sender is NOT a roster participant and is NOT
   * taken from a client-supplied `participantId` — it is stamped from the VERIFIED
   * caller (`this.caller`), so a CLI can address a conversation without joining it
   * and cannot impersonate another participant. The message is a standard
   * `agentic.trajectory.v1` `message.completed` (role user for a shell device,
   * role assistant for an agent), carrying the same addressing fields
   * (`to`/`mentions`) a participant's message would.
   */
  @rpc({ principals: ["host", "user", "code", "entity"], sensitivity: "write" })
  async sendAsCaller(
    text: string,
    opts?: {
      handle?: string;
      to?: Array<{ kind: "all" | "role" | "participant"; role?: string; participantId?: string }>;
      mentions?: string[];
      idempotencyKey?: string;
    }
  ): Promise<{ id?: number; messageId: string }> {
    const caller = this.caller;
    const senderId = caller?.callerId ?? "cli";
    const isAgent = this.authorization?.authorizingOrigin.kind === "entity";
    const handle = isAgent ? senderId : (opts?.handle ?? senderId);
    const messageId = opts?.idempotencyKey ? `ik:${opts.idempotencyKey}` : crypto.randomUUID();
    const senderMetadata: Record<string, unknown> = {
      name: handle,
      handle,
      transport: "rpc",
      kind: isAgent ? "agent" : "user",
    };
    const event = {
      kind: "message.completed",
      actor: {
        kind: isAgent ? "agent" : "user",
        id: senderId,
        displayName: handle,
        metadata: senderMetadata,
      },
      causality: { messageId },
      payload: {
        protocol: "agentic.trajectory.v1",
        role: isAgent ? "assistant" : "user",
        blocks: [{ blockId: `${messageId}:block:0`, type: "text", content: text }],
        outcome: "completed",
        ...(opts?.mentions ? { mentions: opts.mentions } : {}),
        ...(opts?.to ? { to: opts.to } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const logged = await this.appendDurable({
      type: AGENTIC_EVENT_PAYLOAD_KIND,
      payload: event,
      senderId,
      senderMetadata,
      messageId,
      ...(opts?.idempotencyKey ? { idempotency: "idempotent-by-id" as const } : {}),
    });
    broadcast(this.broadcastDeps, logged, { kind: "log", phase: "live" }, senderId);
    return { id: logged.id, messageId };
  }

  /** Policy fold state (replaces getConversationState — WS2 §4.4). */
  @rpc({ principals: ["host", "code"], sensitivity: "read" })
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
  @rpc({ principals: ["host", "code"], sensitivity: "write" })
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
  @rpc({ principals: ["code"], sensitivity: "write" })
  async error(
    participantId: string,
    messageId: string,
    errorMessage: string,
    code?: string
  ): Promise<void> {
    this.assertParticipantCaller(participantId, "error");
    this.markParticipantActive(participantId);
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

  @rpc({ principals: ["host", "user", "code", "entity"], sensitivity: "read" })
  async getReplayAfter(request: ChannelReplayAfterRequest) {
    return this.channelLog.replayAfter(request, this.currentReplayContext());
  }

  /** Return one durable envelope by its stable envelope id, or null when that
   * id belongs to another log (for example a VCS commit id). This is a pure,
   * lineage-aware lookup used by panels, agents, and diagnostic evals. */
  @rpc({ principals: ["host", "user", "code", "entity"], sensitivity: "read" })
  async getEnvelope(envelopeId: string): Promise<ChannelEvent | null> {
    return this.channelLog.getEventByEnvelopeId(envelopeId);
  }

  /** Send a non-durable signal message. */
  @rpc({ principals: ["code"], sensitivity: "write" })
  async sendSignal(participantId: string, content: string, contentType?: string): Promise<void> {
    this.assertParticipantCaller(participantId, "sendSignal");
    this.markParticipantActive(participantId);
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
  @rpc({ principals: ["code"], sensitivity: "write" })
  async updateMetadata(participantId: string, metadata: Record<string, unknown>): Promise<void> {
    this.assertParticipantCaller(participantId, "updateMetadata");
    this.markParticipantActive(participantId);
    await this.updateParticipantMetadata(participantId, metadata);
  }

  @rpc({ principals: ["host", "user"], sensitivity: "admin" })
  async adminUpdateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    await this.updateParticipantMetadata(participantId, metadata);
  }

  private async updateParticipantMetadata(
    participantId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    // A human row keeps only its stable identity — re-asserted profile fields
    // are dropped (WP6 §3: profile renders live, never frozen into the roster).
    const stored = isUserParticipantId(participantId)
      ? scrubUserParticipantMetadata(metadata)
      : metadata;
    this.sql.exec(
      `UPDATE participants SET metadata = ? WHERE id = ?`,
      JSON.stringify(stored),
      participantId
    );
    await this.publishPresenceEvent(participantId, "update", stored);
  }

  @rpc({ principals: ["code"], sensitivity: "write" })
  async setTypingState(participantId: string, typing: boolean): Promise<void> {
    this.assertParticipantCaller(participantId, "setTypingState");
    if (typing) this.markParticipantActive(participantId);
    this.setParticipantTypingState(participantId, typing);
  }

  @rpc({ principals: ["host", "user"], sensitivity: "admin" })
  async adminSetParticipantTypingState(participantId: string, typing: boolean): Promise<void> {
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
  @rpc({ principals: ["host", "user", "code", "entity"], sensitivity: "read" })
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

  // ── Channel membership + workspace invite index (WP7 §3-4,7) ─────────────
  //
  // A durable, per-channel member list layered ON TOP OF — deliberately NOT
  // inside — the ephemeral `participants` roster (see `channel_members` in
  // createTables). Membership is notification / roster visibility, NOT a hard
  // ACL wall: inside a workspace users are mutually trusted (plan §0.0). The
  // ONE authorization gate is workspace membership of the ADDED user, answered
  // by the host — userland never opens the identity DB (INV-2).

  /**
   * Add a workspace member to this channel (WP7 §3). Records durable membership,
   * journals the workspace-inbox projection, and emits a best-effort live nudge.
   * Authorization (§4): the added user must be a member of THIS workspace
   * — checked via the host-projected `account.isMember` predicate (the child
   * resolves it against its OWN bound workspaceId over the shared identity DB
   * read-only; userland neither learns the workspaceId nor opens the DB). No
   * per-channel ACL. Attribution (`added_by`) is the acting caller's
   * host-verified `userId` (WP4). Idempotent: re-adding refreshes the handle
   * snapshot without a second invite.
   */
  @rpc({ principals: ["host", "user", "code", "entity"], sensitivity: "write" })
  async addMember(input: { userId: string }): Promise<ChannelMember & { alreadyMember: boolean }> {
    const targetUserId = requireBareUserId(input?.userId, "addMember");
    const memberId = toUserMemberId(targetUserId);

    const caller = this.caller;
    const addedBy = caller?.userId ? toUserMemberId(caller.userId) : (caller?.callerId ?? "system");

    // Authorization (WP7 §4): the only gate is workspace membership of the
    // ADDED user. Host seam — the child opens the shared identity DB RO and
    // answers `MembershipStore.has(userId, <its own workspaceId>)` (INV-2/§4).
    const isMember = await this.rpc.call<boolean>("main", "account.isMember", [targetUserId]);
    if (!isMember) {
      throw new Error(
        `addMember: ${memberId} is not a member of this workspace and cannot be added to the channel`
      );
    }

    // Denormalize the invitee's current handle for member-list / invite-chip
    // display. Profiles still render LIVE from the host projection (WP6 §3) —
    // this snapshot is a convenience, not the source of truth.
    const profiles = await this.rpc.call<Record<string, { handle?: string }>>(
      "main",
      "account.resolveProfiles",
      [[targetUserId]]
    );
    const handle = profiles[targetUserId]?.handle ?? memberId;

    const existing = this.sql
      .exec(`SELECT added_at, added_by FROM channel_members WHERE user_id = ?`, memberId)
      .toArray();
    const alreadyMember = existing.length > 0;
    if (alreadyMember) {
      const pendingPut =
        this.sql
          .exec(`SELECT 1 FROM invite_index_ops WHERE user_id = ? AND action = 'put'`, memberId)
          .toArray().length > 0;
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`UPDATE channel_members SET handle = ? WHERE user_id = ?`, handle, memberId);
        if (pendingPut) {
          this.journalInvitePut(
            memberId,
            handle,
            String(existing[0]!["added_by"]),
            Number(existing[0]!["added_at"])
          );
        }
      });
      if (pendingPut) {
        const synced = await this.flushInviteIndexOp(memberId);
        if (!synced) {
          throw new Error(
            `addMember: membership is saved, but invitation delivery is pending; retry to confirm`
          );
        }
      }
      return {
        userId: targetUserId,
        memberId,
        handle,
        addedBy: existing[0]!["added_by"] as string,
        addedAt: existing[0]!["added_at"] as number,
        alreadyMember: true,
      };
    }

    const addedAt = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO channel_members (user_id, handle, added_by, added_at)
           VALUES (?, ?, ?, ?)`,
        memberId,
        handle,
        addedBy,
        addedAt
      );
      this.journalInvitePut(memberId, handle, addedBy, addedAt);
    });
    const synced = await this.flushInviteIndexOp(memberId);
    // Live nudge is a membership signal, never a presence event: inviting an
    // offline person must not make them appear online.
    this.broadcastChannelSignal("channel.invite", {
      channelId: this.objectKey,
      memberId,
      userId: targetUserId,
      addedBy,
      addedAt,
    });
    if (!synced) {
      throw new Error(
        `addMember: membership is saved, but invitation delivery is pending; retry to confirm`
      );
    }
    return {
      userId: targetUserId,
      memberId,
      handle,
      addedBy,
      addedAt,
      alreadyMember: false,
    };
  }

  /** Remove a member from this channel (WP7 §3, §10.3 — a user may remove
   *  themselves; mutual trust means anyone may, no ACL). History stays visible. */
  @rpc({ principals: ["host", "user", "code", "entity"], sensitivity: "destructive" })
  async removeMember(input: { userId: string }): Promise<{ removed: boolean }> {
    const userId = requireBareUserId(input?.userId, "removeMember");
    const memberId = toUserMemberId(userId);
    const removed = this.deleteMembershipRow(memberId);
    const synced = await this.flushInviteIndexOp(memberId);
    if (!synced) {
      throw new Error(
        `removeMember: membership was removed, but invitation cleanup is pending; retry to confirm`
      );
    }
    return { removed };
  }

  /** Delete one durable membership row and journal inbox cleanup. */
  private deleteMembershipRow(memberId: string): boolean {
    const existed =
      this.sql.exec(`SELECT 1 FROM channel_members WHERE user_id = ?`, memberId).toArray().length >
      0;
    this.ctx.storage.transactionSync(() => {
      if (existed) this.sql.exec(`DELETE FROM channel_members WHERE user_id = ?`, memberId);
      this.journalInviteDelete(memberId);
    });
    return existed;
  }

  /** List this channel's durable members (WP7 §3). Ordered by add time. */
  @rpc({ principals: ["host", "user", "code", "entity"], sensitivity: "read" })
  async listMembers(): Promise<{ members: ChannelMember[] }> {
    const rows = this.sql
      .exec(
        `SELECT user_id, handle, added_by, added_at
           FROM channel_members ORDER BY added_at ASC`
      )
      .toArray();
    return {
      members: rows.map((row) => {
        const memberId = row["user_id"] as string;
        return {
          userId: bareUserId(memberId),
          memberId,
          handle: row["handle"] as string,
          addedBy: row["added_by"] as string,
          addedAt: row["added_at"] as number,
        };
      }),
    };
  }

  /**
   * Current-channel view of the canonical workspace inbox (WP7 §7). The caller
   * identity is host-verified and the indexed lookup is exact; no client-supplied
   * user id and no channel enumeration participate in discovery.
   */
  @rpc({ principals: ["user", "code"], sensitivity: "read" })
  async listInvitesForMe(): Promise<{ invites: ChannelInvite[] }> {
    const caller = this.caller;
    if (!caller?.userId) throw new Error("listInvitesForMe requires an authenticated user");
    const invite = await this.inviteIndex.call<ChannelInvite | null>("getChannelInvite", {
      userId: caller.userId,
      channelId: this.objectKey,
    } satisfies DeleteChannelInviteInput);
    return { invites: invite ? [invite] : [] };
  }

  /** Remove the calling user's invite from the canonical workspace inbox. */
  @rpc({ principals: ["user", "code"], sensitivity: "write" })
  async acknowledgeInvite(): Promise<{ acknowledged: boolean }> {
    const caller = this.caller;
    if (!caller?.userId) throw new Error("acknowledgeInvite requires an authenticated user");
    const result = await this.inviteIndex.call<{ deleted: boolean }>("deleteChannelInvite", {
      userId: caller.userId,
      channelId: this.objectKey,
    } satisfies DeleteChannelInviteInput);
    return { acknowledged: result.deleted };
  }

  private journalInvitePut(
    memberId: string,
    handle: string,
    addedBy: string,
    addedAt: number
  ): void {
    const revision = this.nextInviteIndexRevision();
    this.sql.exec(
      `INSERT OR REPLACE INTO invite_index_ops
         (user_id, op_id, revision, action, handle, added_by, added_at, updated_at)
       VALUES (?, ?, ?, 'put', ?, ?, ?, ?)`,
      memberId,
      crypto.randomUUID(),
      revision,
      handle,
      addedBy,
      addedAt,
      Date.now()
    );
  }

  private journalInviteDelete(memberId: string): void {
    const revision = this.nextInviteIndexRevision();
    this.sql.exec(
      `INSERT OR REPLACE INTO invite_index_ops
         (user_id, op_id, revision, action, handle, added_by, added_at, updated_at)
       VALUES (?, ?, ?, 'delete', NULL, NULL, NULL, ?)`,
      memberId,
      crypto.randomUUID(),
      revision,
      Date.now()
    );
  }

  /** Allocate the next channel-local projection revision inside the caller's
   * storage transaction. A single counter is sufficient because GAD compares
   * revisions within (channel,user), and gives every local intent a total order. */
  private nextInviteIndexRevision(): number {
    const current = Number(this.getStateValue(INVITE_INDEX_REVISION_KEY) ?? 0);
    const revision = current + 1;
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error("channel membership projection revision overflow");
    }
    this.setStateValue(INVITE_INDEX_REVISION_KEY, String(revision));
    return revision;
  }

  /** Drive one idempotent index mutation. Failures remain durably journaled. */
  private async flushInviteIndexOp(memberId: string): Promise<boolean> {
    const rows = this.sql
      .exec(
        `SELECT op_id, revision, action, handle, added_by, added_at
           FROM invite_index_ops WHERE user_id = ?`,
        memberId
      )
      .toArray();
    if (rows.length === 0) return true;
    const row = rows[0]!;
    const opId = String(row["op_id"]);
    const userId = bareUserId(memberId);
    try {
      if (row["action"] === "put") {
        // The local row and journal can outlive workspace membership while a
        // failed GAD write is waiting for its alarm retry. Re-authorize every
        // delayed put so revocation cannot resurrect the canonical invite.
        const isStillWorkspaceMember = await this.rpc.call<boolean>("main", "account.isMember", [
          userId,
        ]);
        if (!isStillWorkspaceMember) {
          this.ctx.storage.transactionSync(() => {
            this.sql.exec(`DELETE FROM channel_members WHERE user_id = ?`, memberId);
            this.journalInviteDelete(memberId);
          });
          // Flush the newly journaled, higher-revision delete now. If it fails,
          // the normal retry path retains it durably.
          return await this.flushInviteIndexOp(memberId);
        }
        await this.inviteIndex.call<void>("putChannelMembership", {
          channelId: this.objectKey,
          userId,
          memberId,
          handle: String(row["handle"]),
          addedBy: String(row["added_by"]),
          addedAt: Number(row["added_at"]),
          revision: Number(row["revision"]),
        } satisfies PutChannelMembershipInput);
      } else {
        await this.inviteIndex.call("deleteChannelMembership", {
          channelId: this.objectKey,
          userId,
          revision: Number(row["revision"]),
        } satisfies DeleteChannelMembershipInput);
      }
      this.sql.exec(`DELETE FROM invite_index_ops WHERE user_id = ? AND op_id = ?`, memberId, opId);
      return true;
    } catch (error) {
      // Retain the latest failed attempt for explicit action retry and diagnosis.
      this.sql.exec(
        `UPDATE invite_index_ops SET updated_at = ? WHERE user_id = ? AND op_id = ?`,
        Date.now(),
        memberId,
        opId
      );
      console.warn(`[Channel] invite index sync failed for ${memberId}:`, error);
      return false;
    }
  }

  private async flushInviteIndexOps(): Promise<void> {
    const memberIds = this.sql
      .exec(`SELECT user_id FROM invite_index_ops ORDER BY updated_at ASC`)
      .toArray()
      .map((row) => String(row["user_id"]));
    await Promise.all(memberIds.map((memberId) => this.flushInviteIndexOp(memberId)));
  }

  @rpc({ principals: ["host", "user", "code", "entity"], sensitivity: "read" })
  async getContextId(): Promise<string | null> {
    return this.getStateValue("contextId");
  }

  @rpc({ principals: ["host", "user", "code"], sensitivity: "read" })
  async getConfig(): Promise<ChannelConfig | null> {
    return this.getChannelConfig();
  }

  @rpc({ principals: ["host", "code"], sensitivity: "write" })
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

  @rpc({ principals: ["host", "code"], sensitivity: "read" })
  async getReplayBefore(beforeSeq: number, limit?: number) {
    return this.channelLog.replayBefore(beforeSeq, limit ?? 100, this.currentReplayContext());
  }

  // Registry reads: direct passthrough to GAD's channel_message_types
  // projection (hydrated — published `source` payloads are blob-spilled).

  @rpc({ principals: ["host", "code"], sensitivity: "read" })
  async getMessageTypes(): Promise<MessageTypeDefinition[]> {
    return this.channelLog.listMessageTypes();
  }

  @rpc({ principals: ["host", "code"], sensitivity: "read" })
  async getMessageType(typeId: string): Promise<MessageTypeDefinition | null> {
    return this.channelLog.getMessageType(typeId);
  }

  @rpc({ principals: ["host", "code"], sensitivity: "read" })
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

  @rpc({ principals: ["host", "user"], sensitivity: "read" })
  async adminInspectSchema() {
    const tableNames = [
      "participants",
      "pending_calls",
      "dedup_keys",
      "fork_ops",
      "lineage_subscribers",
      "channel_members",
      "invite_index_ops",
      "presence_last_seen",
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

  @rpc({ principals: ["host", "user"], sensitivity: "read" })
  async adminInspectLog(
    opts: {
      afterId?: number;
      beforeId?: number;
      limit?: number;
      includePresence?: boolean;
    } = {}
  ) {
    const rows = await this.channelLog.inspectRows(opts);
    const firstId = rows[0]?.["seq"] as number | undefined;
    const lastId = rows[rows.length - 1]?.["seq"] as number | undefined;
    const before =
      firstId != null
        ? await this.channelLog.replayBefore(firstId, 1, this.currentReplayContext())
        : null;
    const after =
      lastId != null
        ? await this.channelLog.replayAfter({ after: lastId }, this.currentReplayContext())
        : null;
    return {
      rows,
      hasMoreBefore: (before?.logEvents.length ?? 0) > 0,
      hasMoreAfter: (after?.logEvents.length ?? 0) > 0,
    };
  }

  @rpc({ principals: ["host", "user"], sensitivity: "read" })
  async adminInspectEnvelope(envelopeId: string) {
    return { rows: await this.channelLog.inspectEnvelope(envelopeId) };
  }

  @rpc({ principals: ["host", "user"], sensitivity: "admin" })
  async adminReconstructTranscript(opts: { rootLimit?: number; beforeSeq?: number } = {}) {
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

  @rpc({ principals: ["host", "user"], sensitivity: "read" })
  async adminInspectAgent(
    participantId: string,
    methodName = "getDebugState"
  ): Promise<AgentInspectionResult> {
    return this.inspectAgentReadOnly(participantId, methodName);
  }

  @rpc({ principals: ["host", "user", "code"], sensitivity: "read" })
  async inspectAgent(
    participantId: string,
    methodName = "getDebugState"
  ): Promise<AgentInspectionResult> {
    this.assertSupportedAgentInspectionMethod(methodName);
    await this.requireAgentInspectionApproval(participantId, methodName);
    return this.inspectAgentReadOnly(participantId, methodName);
  }

  private assertSupportedAgentInspectionMethod(
    methodName: string
  ): asserts methodName is AgentInspectionMethod {
    if (isAgentInspectionMethod(methodName)) return;
    throw new Error(
      `inspectAgent: unsupported method ${methodName}; expected one of ` +
        AGENT_INSPECTION_METHODS.join(", ")
    );
  }

  private async requireAgentInspectionApproval(
    participantId: string,
    methodName: string
  ): Promise<void> {
    const caller = this.caller;
    const callerId = caller?.callerId ?? "unknown";
    const callerKind = caller?.callerKind ?? "unknown";
    const subjectHash = stableShortHash(`${callerKind}:${callerId}:${participantId}:${methodName}`);
    const decision = await this.rpc.call<UserlandApprovalChoice>(
      "main",
      "userlandApproval.request",
      [
        {
          subject: {
            id: `channel.inspectAgent:${subjectHash}`,
            label: `Inspect ${methodName}`,
          },
          title: "Inspect agent debug data",
          summary:
            "Allow this runtime to read a standard read-only debug method from an agent, even when the agent is not joined to this channel's live roster.",
          warning:
            "Agent debug data may include settings, pending work, or internal execution state.",
          severity: "standard",
          defaultAction: "deny",
          details: [
            { label: "Caller", value: `${callerKind} ${callerId}` },
            { label: "Channel", value: this.objectKey },
            { label: "Agent", value: participantId },
            { label: "Method", value: methodName },
          ],
        },
      ]
    );
    if (decision.kind === "choice" && decision.choice === "allow") return;
    if (decision.kind === "choice" && decision.choice === "once") return;
    if (decision.kind === "choice" && decision.choice === "session") return;
    if (decision.kind === "choice" && decision.choice === "version") return;
    throw new Error(`inspectAgent approval denied for ${methodName} on ${participantId}`);
  }

  private async inspectAgentReadOnly(
    participantId: string,
    methodName: string
  ): Promise<AgentInspectionResult> {
    this.assertSupportedAgentInspectionMethod(methodName);
    if (!parseDOParticipantId(participantId)) {
      throw new Error(
        `inspectAgent: participant ${participantId} is not a Durable Object participant id`
      );
    }

    const rosterRows = this.sql
      .exec(`SELECT metadata, transport FROM participants WHERE id = ?`, participantId)
      .toArray();
    const roster: {
      present: boolean;
      transport?: string;
      metadata?: Record<string, unknown>;
    } = { present: rosterRows.length > 0 };
    if (rosterRows.length > 0) {
      roster.transport = String(rosterRows[0]!["transport"] ?? "");
      try {
        roster.metadata = JSON.parse(String(rosterRows[0]!["metadata"] ?? "{}")) as Record<
          string,
          unknown
        >;
      } catch {
        roster.metadata = {};
      }
    }

    const response = (await this.rpc.call(
      participantId,
      AGENT_INSPECTION_RPC_METHOD,
      [this.objectKey, methodName],
      { readOnly: true, timeoutMs: AGENT_INSPECTION_TIMEOUT_MS }
    )) as { result?: unknown; isError?: boolean } | unknown;
    const payload =
      response && typeof response === "object" && "result" in response
        ? (response as { result?: unknown; isError?: boolean })
        : { result: response };

    return {
      participantId,
      channelId: this.objectKey,
      methodName,
      result: payload.result,
      ...(payload.isError !== undefined ? { isError: payload.isError === true } : {}),
      roster,
    };
  }

  @rpc({ principals: ["host", "user"], sensitivity: "admin" })
  async adminValidateLog(opts: { rootLimit?: number } = {}) {
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

  @rpc({ principals: ["code"], sensitivity: "write" })
  async callMethod(
    callerPid: string,
    targetPid: string,
    callId: string,
    method: string,
    args: unknown,
    opts?: { invocationId?: string; transportCallId?: string; turnId?: string; timeoutMs?: number }
  ): Promise<void> {
    this.assertParticipantCaller(callerPid, "callMethod");
    this.markParticipantActive(callerPid);
    await this.calls.callMethod(callerPid, targetPid, callId, method, args, opts);
  }

  @rpc({ principals: ["code"], sensitivity: "write" })
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
    this.markParticipantActive(participantId);
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

  @rpc({ principals: ["code"], sensitivity: "write" })
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
    this.markParticipantActive(participantId);
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

  /** Cancel a method call owned by the authenticated participant.
   *
   * Cancellation is not an administrative operation: the participant that
   * initiated a call owns its lifetime. Authenticate the participant against
   * the transport principal, then have Calls verify the durable pending row's
   * caller before appending the terminal. Server-driven expiry remains the
   * separate `timeoutMethodCall` authority below.
   */
  @rpc({ principals: ["code"], sensitivity: "destructive" })
  async cancelMethodCall(participantId: string, callId: string): Promise<void> {
    this.assertParticipantCaller(participantId, "cancelMethodCall");
    await this.calls.cancelMethodCall(callId, "cancelled", participantId);
  }

  @rpc({ principals: ["host"], sensitivity: "write" })
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

  private nextPresenceTransitionAt(): number | null {
    const row = this.sql
      .exec(
        `SELECT MIN(
           CASE presence_status
             WHEN 'online' THEN last_active_at + ?
             WHEN 'idle' THEN last_active_at + ?
             ELSE NULL
           END
         ) AS next_at
         FROM participants
         WHERE id LIKE 'user:%' AND last_active_at IS NOT NULL`,
        PRESENCE_IDLE_MS,
        PRESENCE_AWAY_MS
      )
      .toArray()[0]?.["next_at"];
    return typeof row === "number" ? row : null;
  }

  private nextPresenceRetentionSweepAt(): number | null {
    const oldest = this.sql
      .exec(`SELECT MIN(last_seen) AS oldest FROM presence_last_seen`)
      .toArray()[0]?.["oldest"];
    return typeof oldest === "number" ? oldest + PRESENCE_LAST_SEEN_RETENTION_MS : null;
  }

  private nextInviteIndexSyncAt(): number | null {
    const oldest = this.sql
      .exec(`SELECT MIN(updated_at) AS oldest FROM invite_index_ops`)
      .toArray()[0]?.["oldest"];
    return typeof oldest === "number" ? oldest + INVITE_INDEX_RETRY_MS : null;
  }

  private nextPendingRedeliveryAt(): number | null {
    const oldest = this.sql
      .exec(`SELECT MIN(created_at) AS created_at FROM pending_calls`)
      .toArray()[0]?.["created_at"];
    if (typeof oldest !== "number") return null;
    const firstEligible = oldest + PENDING_REDELIVERY_STALE_MS;
    const lastSwept = Number(this.getStateValue(PENDING_REDELIVERY_SWEPT_AT_KEY) ?? 0);
    return Math.max(
      firstEligible,
      lastSwept > 0 ? lastSwept + PENDING_REDELIVERY_INTERVAL_MS : firstEligible
    );
  }

  private nextForkOpReconcileAt(): number | null {
    const oldest = this.sql
      .exec(
        `SELECT MIN(updated_at) AS oldest FROM fork_ops
          WHERE phase NOT IN ('done', 'rolledback')`
      )
      .toArray()[0]?.["oldest"];
    return typeof oldest === "number" ? oldest + FORK_OP_RECONCILE_MS : null;
  }

  private nextAlarmSchedule(): DoAlarmSchedule | null {
    const now = Date.now();
    const sources = [
      this.nextDedupSweepAt(),
      this.nextPresenceTransitionAt(),
      this.nextPresenceRetentionSweepAt(),
      this.nextInviteIndexSyncAt(),
      this.calls.nextCallDeadlineAt(),
      this.nextPendingRedeliveryAt(),
      this.nextForkOpReconcileAt(),
    ].filter((value): value is number => typeof value === "number");
    return sources.length === 0 ? null : { wakeAt: Math.max(Math.min(...sources), now + 100) };
  }

  protected override nextAlarmAfterRequest(): DoAlarmSchedule | null {
    return this.nextAlarmSchedule();
  }

  override async alarm(): Promise<DoAlarmSchedule | null> {
    await super.alarm();

    this.advancePresenceStatuses();
    this.sql.exec(
      `DELETE FROM presence_last_seen WHERE last_seen < ?`,
      Date.now() - PRESENCE_LAST_SEEN_RETENTION_MS
    );

    // Dedup TTL sweep — unconditional (no latch; a key inserted while no
    // publish succeeds is still swept).
    this.sql.exec(`DELETE FROM dedup_keys WHERE created_at < ?`, Date.now() - DEDUP_TTL_MS);

    await this.flushInviteIndexOps();
    await this.calls.timeoutExpiredPendingCalls(async (pending, message) => {
      await this.publishMethodCallFeedback(
        pending.targetId,
        pending.transportCallId,
        pending.method,
        message
      );
    });
    try {
      await this.calls.reconcilePendingCalls();
    } catch (error) {
      console.warn("[Channel] pending-call reconciliation failed:", error);
    }
    try {
      const count = Number(
        this.sql.exec(`SELECT COUNT(*) AS count FROM pending_calls`).toArray()[0]?.["count"] ?? 0
      );
      if (count > 0) {
        await this.redeliverStalePendingCalls();
        this.setStateValue(PENDING_REDELIVERY_SWEPT_AT_KEY, String(Date.now()));
      } else {
        this.setStateValue(PENDING_REDELIVERY_SWEPT_AT_KEY, "0");
      }
    } catch (error) {
      console.warn("[Channel] pending-call redelivery failed:", error);
    }
    await this.reconcileForkOps();

    return this.nextAlarmSchedule();
  }

  private async redeliverStalePendingCalls(): Promise<void> {
    const targets = this.sql
      .exec(
        `SELECT DISTINCT target_id FROM pending_calls WHERE created_at <= ?`,
        Date.now() - PENDING_REDELIVERY_STALE_MS
      )
      .toArray()
      .map((row) => String(row["target_id"]));
    for (const targetId of targets) {
      if (this.participantSubscriptionCount(targetId) > 0) {
        await this.calls.redeliverPendingCallsTo(targetId);
      }
    }
  }

  private advancePresenceStatuses(): void {
    const now = Date.now();
    const rows = this.sql
      .exec(
        `SELECT id, last_active_at, presence_status FROM participants
          WHERE id LIKE 'user:%' AND last_active_at IS NOT NULL`
      )
      .toArray();
    for (const row of rows) {
      const participantId = row["id"] as string;
      const lastActiveAt = row["last_active_at"] as number;
      const next = this.presenceStatusAt(lastActiveAt, now);
      if (row["presence_status"] === next) continue;
      this.sql.exec(
        `UPDATE participants SET presence_status = ? WHERE id = ?`,
        next,
        participantId
      );
      this.broadcastPresenceSignal(participantId, "update", {
        kind: "user",
        presenceStatus: next,
        lastActiveAt,
      });
    }
  }

  // ── Provenance ────────────────────────────────────────────────────────────

  /**
   * The channel's place in the fork/task tree, read from durable state (NOT the
   * old `getState()` dump peek). Fork provenance is written at `postClone`; task
   * provenance at task-channel creation (B1, WS-5) — until that lands a task
   * channel reads as `root`/`fork`.
   */
  @rpc({ principals: ["host", "user", "code"], sensitivity: "read" })
  async getProvenance(): Promise<ChannelProvenance> {
    return this.computeProvenance();
  }

  /**
   * Record task provenance for a subagent task channel (B1, WS-5). Written by
   * the spawning vessel right after the task channel is created/subscribed so
   * {@link getProvenance} reports `kind:"task"` instead of `root`. Durable state
   * keys, mirroring how fork provenance is stamped at `postClone`.
   */
  @rpc({ principals: ["host", "code"], sensitivity: "write" })
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
  // envelopeIds `fork-seed:{forkId}` / `fork-event:{forkId}`), so callers can
  // safely retry the operation.

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

  @rpc({ principals: ["host", "code"], sensitivity: "write" })
  async fork(opts: ForkOpts): Promise<ForkResult> {
    const forkId = opts.operationId;
    if (typeof forkId !== "string" || forkId.length < 8) {
      throw new Error("fork requires a stable operationId");
    }
    const existing = this.getForkOpRow(forkId);
    if (existing) {
      if (String(existing["opts"]) !== JSON.stringify(opts)) {
        throw new Error(`fork operation ${forkId} was reused with different input`);
      }
      if (existing["phase"] === "rollback-pending") {
        await this.rollbackForkOp(forkId);
        throw new Error(`fork operation ${forkId} failed and its cloned context was cleaned up`);
      }
      if (existing["phase"] === "rolledback") {
        throw new Error(`fork operation ${forkId} previously failed and was rolled back`);
      }
      return this.runForkOp(forkId);
    }
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
    console.info("[Channel] fork op starting", {
      forkId,
      phase,
      channelId: this.objectKey,
      sourceContextId,
      forkPointPubsubId: opts.forkPointPubsubId,
      keptAgentCount: keptAgents.length,
      keptAgents: keptAgents.map((agent) => ({
        participantId: agent.participantId,
        target: doTarget(agent.ref),
      })),
    });

    try {
      // Preflight canFork on the kept agents (WS-5 per-channel shape).
      for (const agent of keptAgents) {
        const r = await this.rpc.call<{ ok: boolean; reason?: string }>(
          doTarget(agent.ref),
          "canFork",
          [this.objectKey]
        );
        if (!r.ok) {
          throw new Error(
            `Cannot fork participant ${agent.participantId}: ${r.reason ?? "canFork=false"}`
          );
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
      console.info("[Channel] fork op cloned context", {
        forkId,
        sourceChannelId: this.objectKey,
        forkedChannelId,
        forkedContextId,
        clonedEntityCount: clone.entities.length,
        homeableTargets,
      });
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
        console.info("[Channel] fork op postClone complete", {
          forkId,
          forkedChannelId,
          forkedContextId,
          clonedParticipants,
        });
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
          await this.rpc.call(doTarget(forkedChannelRef), "appendSeed", [{ forkId }, opts.seed]);
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
      console.info("[Channel] fork op done", {
        forkId,
        sourceChannelId: this.objectKey,
        forkedChannelId,
        forkedContextId,
        seededMessageId,
        clonedParticipants,
      });
      return {
        forkId,
        forkedChannelId,
        forkedContextId,
        clonedParticipants,
        clonedAgents,
        ...(seededMessageId ? { seededMessageId } : {}),
      };
    } catch (err) {
      console.error("[Channel] fork op failed; rolling back", {
        forkId,
        channelId: this.objectKey,
        phase,
        error: err instanceof Error ? err.message : String(err),
      });
      await this.rollbackForkOp(forkId);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Fork failed: ${message}`);
    }
  }

  /** Tear down a failed fork. Cleanup failure is itself durable and retryable;
   * the operation becomes terminal only after context destruction succeeds. */
  private async rollbackForkOp(forkId: string): Promise<boolean> {
    const row = this.getForkOpRow(forkId);
    const forkedContextId = row?.["forked_context_id"] as string | null | undefined;
    if (forkedContextId) {
      try {
        await this.callMain("runtime.destroyContext", { contextId: forkedContextId });
      } catch (e) {
        console.error(`[Channel] fork rollback destroyContext failed for ${forkedContextId}:`, e);
        this.setForkOpPhase(forkId, "rollback-pending");
        return false;
      }
    }
    this.setForkOpPhase(forkId, "rolledback");
    return true;
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
  @rpc({ principals: ["host", "code"], sensitivity: "write" })
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
  @rpc({ principals: ["host", "code"], sensitivity: "destructive" })
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
  @rpc({ principals: ["host", "code"], sensitivity: "read" })
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

  /** Resume every stale, non-terminal fork saga from its durable phase. Each
   * step uses stable fork-derived identities, so alarm delivery is safe under
   * at-least-once execution. */
  private async reconcileForkOps(): Promise<void> {
    const rows = this.sql
      .exec(
        `SELECT fork_id FROM fork_ops
          WHERE phase NOT IN ('done', 'rolledback') AND updated_at <= ?`,
        Date.now() - FORK_OP_RECONCILE_MS
      )
      .toArray();
    for (const row of rows) {
      const forkId = String(row["fork_id"]);
      try {
        const op = this.getForkOpRow(forkId);
        if (op?.["phase"] === "rollback-pending") await this.rollbackForkOp(forkId);
        else await this.runForkOp(forkId);
      } catch (error) {
        console.warn(`[Channel] fork op ${forkId} reconciliation failed:`, error);
      }
    }
  }

  // ── appendSeed — fork opening message ──────────────────────────────────────

  /**
   * Append the fork's opening message on the CHILD channel. This is fork
   * plumbing: the pending fork marker only makes the operation one-shot and
   * crash-resumable for the matching fork id.
   */
  @rpc({ principals: ["host", "user", "code"], sensitivity: "write" })
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
      throw new Error(`appendSeed: no pending fork seed for fork ${forkId} on this channel`);
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
          ? {
              replaces: {
                messageId: envelope.replaces.messageId as never,
                seq: envelope.replaces.seq,
              },
            }
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
  @rpc({ principals: ["host", "code"], sensitivity: "write" })
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
        this.setStateValue("forkSeedMarker", JSON.stringify({ forkId: forkInit.forkId }));
      }
    }
    await this.channelLog.forkFrom(parentChannelId, forkPointId);
    // The child must NOT inherit the parent's fork journal or lineage roster.
    this.sql.exec(`DELETE FROM fork_ops`);
    this.sql.exec(`DELETE FROM lineage_subscribers`);
    // A cloned operation was authored for the parent's object key. Membership
    // may be inherited, but its in-flight projection must never be replayed as
    // a new pending invite for the child channel.
    this.sql.exec(`DELETE FROM invite_index_ops`);
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

  @rpc({ principals: ["code"], sensitivity: "write" })
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

  @rpc({ principals: ["code"], sensitivity: "write" })
  async unsubscribeLineage(participantId: string): Promise<void> {
    this.assertParticipantCaller(participantId, "unsubscribeLineage");
    this.sql.exec(`DELETE FROM lineage_subscribers WHERE id = ?`, participantId);
  }

  /** Relay point for a head advance reported up the chain from a descendant. */
  @rpc({ principals: ["host", "code"], sensitivity: "write" })
  async reportLineageHead(report: { channelId: string; headSeq: number }): Promise<void> {
    await this.relayLineageHead(report.channelId, report.headSeq);
  }

  /** Fan a local durable head advance out as an event-driven best-effort signal. */
  private noteLineageHeadAdvance(seq: number): void {
    const relay = this.relayLineageHead(this.objectKey, seq);
    if (this.ctx.waitUntil) this.ctx.waitUntil(relay);
    else void relay;
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
      void this.deliverParticipantPayload(pid, { channelId: this.objectKey, message: signal });
    }
  }

  // ── State introspection ─────────────────────────────────────────────────

  @rpc({ principals: ["host", "user", "code"], sensitivity: "read" })
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
