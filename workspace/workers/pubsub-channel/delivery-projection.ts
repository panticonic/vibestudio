import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import type { SqlStorage } from "@workspace/runtime/worker";
import type { ChannelEvent } from "@workspace/harness";
import type { ChannelAgenticContext, ChannelConfig, RpcChannelMessage } from "@workspace/pubsub";
import type { AgenticEvent } from "@workspace/agentic-protocol";
import {
  conversationV1Policy,
  type ConversationStateV1,
  type PolicyEnvelopeView,
} from "@workspace/channel-policies";
import type { ChannelRelationshipPayload } from "./types.js";

export const CHANNEL_DELIVERY_PROJECTION_VERSION = 2;
export const CHANNEL_RELATIONSHIP_EVENT_TYPES = new Set([
  "channel.subscription.opened",
  "channel.subscription.revised",
  "channel.subscription.ended",
]);

type DeliveryInterest = "all" | "addressed" | "none";

interface RelationshipRow {
  participantId: string;
  revision: number;
  delivery: DeliveryInterest;
  endpointEntityId: string | null;
  endpointKind: "entity" | "session";
  active: boolean;
}

export class ChannelDeliveryProjection {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(callback: () => T) => T,
    private readonly channelId: string
  ) {}

  static createTables(sql: SqlStorage): void {
    sql.exec(`
      CREATE TABLE IF NOT EXISTS channel_relationships (
        participant_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL CHECK (revision > 0),
        delivery TEXT NOT NULL CHECK (delivery IN ('all', 'addressed', 'none')),
        endpoint_kind TEXT NOT NULL CHECK (endpoint_kind IN ('entity', 'session')),
        endpoint_entity_id TEXT,
        metadata_json TEXT NOT NULL,
        application_config_json TEXT,
        opened_sequence INTEGER NOT NULL,
        active INTEGER NOT NULL CHECK (active IN (0, 1)),
        CHECK (
          (endpoint_kind = 'entity' AND endpoint_entity_id IS NOT NULL) OR
          (endpoint_kind = 'session' AND endpoint_entity_id IS NULL)
        )
      );
      CREATE TABLE IF NOT EXISTS channel_delivery_mailbox (
        delivery_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL,
        participant_id TEXT NOT NULL,
        endpoint_entity_id TEXT NOT NULL,
        subscription_revision INTEGER NOT NULL,
        envelope_json TEXT,
        agentic_context_json TEXT,
        projection_version INTEGER NOT NULL,
        state TEXT NOT NULL DEFAULT 'ready'
          CHECK (state IN (
            'ready', 'leased', 'retrying',
            'terminal-completed', 'terminal-departed',
            'terminal-retired', 'terminal-integrity'
          )),
        claim_generation INTEGER NOT NULL DEFAULT 0,
        claimed_by TEXT,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_attempt_at INTEGER,
        terminal_outcome_json TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_delivery_event_recipient
        ON channel_delivery_mailbox(event_id, participant_id, subscription_revision);
      CREATE INDEX IF NOT EXISTS idx_channel_delivery_claim
        ON channel_delivery_mailbox(state, next_attempt_at, participant_id, event_sequence);
      CREATE INDEX IF NOT EXISTS idx_channel_delivery_lane
        ON channel_delivery_mailbox(participant_id, event_sequence, state, next_attempt_at);
      CREATE TABLE IF NOT EXISTS channel_delivery_projection_cursor (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        projection_version INTEGER NOT NULL,
        log_sequence INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO channel_delivery_projection_cursor
        (singleton, projection_version, log_sequence) VALUES (1, ${CHANNEL_DELIVERY_PROJECTION_VERSION}, 0);
      CREATE TABLE IF NOT EXISTS channel_delivery_context (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        projection_version INTEGER NOT NULL,
        initial_config_json TEXT NOT NULL,
        current_config_json TEXT NOT NULL,
        conversation_state_json TEXT NOT NULL
      );
      INSERT OR IGNORE INTO channel_delivery_context
        (singleton, projection_version, initial_config_json, current_config_json,
         conversation_state_json)
      VALUES (
        1,
        ${CHANNEL_DELIVERY_PROJECTION_VERSION},
        '{}',
        '{}',
        '${JSON.stringify(conversationV1Policy.init()).replaceAll("'", "''")}'
      );
      CREATE TABLE IF NOT EXISTS channel_delivery_message_senders (
        message_id TEXT PRIMARY KEY,
        sender_id TEXT NOT NULL,
        event_sequence INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS channel_receipts (
        message_id TEXT NOT NULL,
        participant_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('delivered', 'read', 'declined')),
        turn_id TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (message_id, participant_id)
      );
    `);
  }

  cursor(): number {
    this.ensureProjectionVersion();
    const row = this.sql
      .exec(`SELECT log_sequence FROM channel_delivery_projection_cursor WHERE singleton = 1`)
      .toArray()[0];
    return row ? Number(row["log_sequence"]) : 0;
  }

  /** Bind the immutable initial channel configuration before the first log
   * event. Later changes are ordinary `config-update` facts in the same fold. */
  initializeChannelConfig(config: object): void {
    this.ensureProjectionVersion();
    const cursor = this.cursor();
    const encoded = JSON.stringify(config);
    const row = this.sql
      .exec(`SELECT initial_config_json FROM channel_delivery_context WHERE singleton = 1`)
      .toArray()[0];
    const retained = String(row?.["initial_config_json"] ?? "{}");
    if (cursor > 0 && retained !== encoded) {
      throw new Error("Channel configuration must be initialized before the first log event");
    }
    this.sql.exec(
      `UPDATE channel_delivery_context
          SET initial_config_json = ?, current_config_json = ?
        WHERE singleton = 1`,
      encoded,
      encoded
    );
  }

  /** The plan's disposable-projection reset rule: a projection-version change
   *  never bricks a channel. On mismatch, drop the interval table, the whole
   *  mailbox, and the cursor, then let the ordinary derivation replay rebuild
   *  everything from the canonical log. In-flight leased rows are dropped with
   *  the rest: a stale settle for a vanished row is answered as stale, the
   *  rebuilt row re-delivers with the SAME deterministic delivery_id, and the
   *  recipient's admission journal returns its retained outcome — redelivery
   *  after a version bump is idempotent, merely wasteful, and version bumps
   *  are rare explicit events. */
  private ensureProjectionVersion(): void {
    const row = this.sql
      .exec(`SELECT projection_version FROM channel_delivery_projection_cursor WHERE singleton = 1`)
      .toArray()[0];
    if (row && Number(row["projection_version"]) === CHANNEL_DELIVERY_PROJECTION_VERSION) return;
    this.transaction(() => {
      this.sql.exec(`DELETE FROM channel_relationships`);
      this.sql.exec(`DELETE FROM channel_delivery_mailbox`);
      this.sql.exec(`DELETE FROM channel_receipts`);
      this.sql.exec(`DELETE FROM channel_delivery_message_senders`);
      this.sql.exec(
        `UPDATE channel_delivery_context
            SET projection_version = ?,
                current_config_json = initial_config_json,
                conversation_state_json = ?
          WHERE singleton = 1`,
        CHANNEL_DELIVERY_PROJECTION_VERSION,
        JSON.stringify(conversationV1Policy.init())
      );
      this.sql.exec(
        `INSERT OR REPLACE INTO channel_delivery_projection_cursor
           (singleton, projection_version, log_sequence)
         VALUES (1, ?, 0)`,
        CHANNEL_DELIVERY_PROJECTION_VERSION
      );
    });
  }

  relationship(participantId: string): RelationshipRow | null {
    const row = this.sql
      .exec(
        `SELECT participant_id, revision, delivery, endpoint_kind, endpoint_entity_id, active
           FROM channel_relationships WHERE participant_id = ?`,
        participantId
      )
      .toArray()[0];
    if (!row) return null;
    return {
      participantId: String(row["participant_id"]),
      revision: Number(row["revision"]),
      delivery: String(row["delivery"]) as DeliveryInterest,
      endpointEntityId:
        typeof row["endpoint_entity_id"] === "string" ? row["endpoint_entity_id"] : null,
      endpointKind: String(row["endpoint_kind"]) as "entity" | "session",
      active: Number(row["active"]) === 1,
    };
  }

  fold(event: ChannelEvent): { inserted: number; relationshipChanged: boolean } {
    const current = this.cursor();
    if (event.id <= current) return { inserted: 0, relationshipChanged: false };
    if (event.id !== current + 1) {
      throw new Error(
        `Channel delivery projection gap: expected ${current + 1}, received ${event.id}`
      );
    }
    return this.transaction(() => {
      let inserted = 0;
      let relationshipChanged = false;
      this.foldDecisionContext(event);
      if (CHANNEL_RELATIONSHIP_EVENT_TYPES.has(event.type)) {
        // A malformed or revision-inconsistent relationship event fails the
        // EVENT, never the channel: it is skipped and the cursor advances.
        // The skip decision is a pure function of the event bytes and the
        // prior folded state (itself a pure fold of prior events), so every
        // replay reaches the identical decision — determinism holds by
        // construction. Throwing here would brick every subsequent publish,
        // join, and leave behind one poison event.
        try {
          this.foldRelationship(event);
          relationshipChanged = true;
        } catch (error) {
          console.warn(
            `[channel-delivery-projection] skipping poison relationship event ${event.id} (${event.type}) on ${this.channelId}:`,
            error
          );
        }
      } else {
        inserted = this.deriveEvent(event);
      }
      this.sql.exec(
        `UPDATE channel_delivery_projection_cursor SET log_sequence = ? WHERE singleton = 1`,
        event.id
      );
      return { inserted, relationshipChanged };
    });
  }

  private foldRelationship(event: ChannelEvent): void {
    const payload = this.requireRelationshipPayload(event.payload);
    const current = this.relationship(payload.participantId);
    if (event.type === "channel.subscription.ended") {
      if (!current || !current.active || payload.revision !== current.revision + 1) {
        throw new Error(`Invalid ended relationship revision for ${payload.participantId}`);
      }
      this.sql.exec(
        `UPDATE channel_relationships SET revision = ?, active = 0 WHERE participant_id = ?`,
        payload.revision,
        payload.participantId
      );
      this.sql.exec(
        `UPDATE channel_delivery_mailbox
            SET state = 'terminal-departed', claimed_by = NULL
          WHERE participant_id = ? AND state IN ('ready', 'leased', 'retrying')`,
        payload.participantId
      );
      return;
    }
    if (!payload.delivery || !payload.endpoint || !payload.metadata) {
      throw new Error(`${event.type} is missing relationship fields`);
    }
    const expected = current ? current.revision + 1 : 1;
    if (payload.revision !== expected) {
      throw new Error(
        `Invalid relationship revision for ${payload.participantId}: expected ${expected}`
      );
    }
    const endpointEntityId = payload.endpoint.kind === "entity" ? payload.endpoint.entityId : null;
    // A fresh relationship revision is the recovery boundary for an
    // activation-local receiver. Replay in the join ACK reconstructs everything
    // through the current head; pending work addressed to the superseded
    // receiver incarnation must therefore stop blocking the participant lane.
    // This is also safe when an old claim is still in flight: its later
    // settlement observes a terminal row and cannot mutate the new revision.
    if (current) {
      this.sql.exec(
        `UPDATE channel_delivery_mailbox
            SET state = 'terminal-retired', claimed_by = NULL
          WHERE participant_id = ?
            AND subscription_revision < ?
            AND state IN ('ready', 'leased', 'retrying')`,
        payload.participantId,
        payload.revision
      );
    }
    this.sql.exec(
      `INSERT OR REPLACE INTO channel_relationships (
         participant_id, revision, delivery, endpoint_kind, endpoint_entity_id,
         metadata_json, application_config_json, opened_sequence, active
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      payload.participantId,
      payload.revision,
      payload.delivery,
      payload.endpoint.kind,
      endpointEntityId,
      JSON.stringify(payload.metadata),
      payload.applicationConfig === undefined ? null : JSON.stringify(payload.applicationConfig),
      event.id
    );
  }

  private deriveEvent(event: ChannelEvent): number {
    const envelope: RpcChannelMessage = { kind: "log", phase: "live", event };
    const envelopeJson = JSON.stringify(envelope);
    const now = Date.now();
    let inserted = 0;
    const relationships = this.sql
      .exec(
        `SELECT participant_id, revision, delivery, endpoint_kind, endpoint_entity_id
           FROM channel_relationships
          WHERE active = 1 AND delivery != 'none' AND endpoint_kind = 'entity'
          ORDER BY participant_id`
      )
      .toArray();
    const contextRow = this.sql
      .exec(
        `SELECT current_config_json, conversation_state_json
           FROM channel_delivery_context WHERE singleton = 1`
      )
      .toArray()[0]!;
    const replyTo = this.replyToMessageId(event);
    const replyToRow = replyTo
      ? this.sql
          .exec(
            `SELECT sender_id FROM channel_delivery_message_senders WHERE message_id = ?`,
            replyTo
          )
          .toArray()[0]
      : undefined;
    const agenticContext: ChannelAgenticContext = {
      version: 1,
      relationships: this.sql
        .exec(
          `SELECT participant_id, metadata_json, application_config_json
             FROM channel_relationships
            WHERE active = 1
            ORDER BY participant_id`
        )
        .toArray()
        .map((row) => ({
          participantId: String(row["participant_id"]),
          metadata: JSON.parse(String(row["metadata_json"])) as Record<string, unknown>,
          applicationConfig:
            row["application_config_json"] === null
              ? null
              : (JSON.parse(String(row["application_config_json"])) as {
                  version: number;
                  value: unknown;
                }),
        })),
      channelConfig: JSON.parse(String(contextRow["current_config_json"])) as ChannelConfig,
      conversation: JSON.parse(
        String(contextRow["conversation_state_json"])
      ) as ConversationStateV1,
      replyToSenderId:
        typeof replyToRow?.["sender_id"] === "string" ? String(replyToRow["sender_id"]) : null,
    };
    const agenticContextJson = JSON.stringify(agenticContext);
    for (const row of relationships) {
      const participantId = String(row["participant_id"]);
      const delivery = String(row["delivery"]) as DeliveryInterest;
      const addressed = this.addresses(event, participantId);
      // Ordinary self-publication is already locally known. Explicitly
      // addressed facts still create recipient work, including when the
      // publisher and recipient are the same durable participant.
      if (participantId === event.senderId && !addressed) continue;
      if (delivery === "addressed" && !addressed) continue;
      const revision = Number(row["revision"]);
      const endpointEntityId = String(row["endpoint_entity_id"]);
      const deliveryId = sha256HexSyncText(
        canonicalJson([this.channelId, event.messageId, participantId, revision])
      );
      const result = this.sql.exec(
        `INSERT OR IGNORE INTO channel_delivery_mailbox (
           delivery_id, channel_id, event_id, event_sequence, participant_id,
           endpoint_entity_id,
           subscription_revision, envelope_json, agentic_context_json,
           projection_version, state, claim_generation, attempts,
           next_attempt_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', 0, 0, ?, ?)
         RETURNING delivery_id`,
        deliveryId,
        this.channelId,
        event.messageId,
        event.id,
        participantId,
        endpointEntityId,
        revision,
        envelopeJson,
        agenticContextJson,
        CHANNEL_DELIVERY_PROJECTION_VERSION,
        now,
        now
      );
      const insertedRows = result.toArray().length;
      inserted += insertedRows;
      const sourceMessageId = this.sourceMessageId(event);
      if (insertedRows > 0 && sourceMessageId) {
        this.sql.exec(
          `INSERT INTO channel_receipts
             (message_id, participant_id, state, turn_id, updated_at)
           VALUES (?, ?, 'delivered', NULL, ?)
           ON CONFLICT(message_id, participant_id) DO NOTHING`,
          sourceMessageId,
          participantId,
          now
        );
      }
    }
    return inserted;
  }

  private foldDecisionContext(event: ChannelEvent): void {
    const row = this.sql
      .exec(
        `SELECT current_config_json, conversation_state_json
           FROM channel_delivery_context WHERE singleton = 1`
      )
      .toArray()[0]!;
    const currentConfig = JSON.parse(String(row["current_config_json"])) as ChannelConfig;
    const currentConversation = JSON.parse(
      String(row["conversation_state_json"])
    ) as ConversationStateV1;
    const nextConfig =
      event.type === "config-update" && event.payload && typeof event.payload === "object"
        ? (event.payload as ChannelConfig)
        : currentConfig;
    const actorKind = ((event.payload as { actor?: { kind?: string } } | null)?.actor?.kind ??
      "unknown") as string;
    const view: PolicyEnvelopeView = {
      envelopeId: event.messageId,
      seq: event.id,
      payloadKind: event.type,
      payload: event.payload,
      senderId: event.senderId,
      senderKind: actorKind,
      ...(event.annotations ? { annotations: event.annotations } : {}),
      appendedAt: new Date(event.ts).toISOString(),
    };
    const nextConversation = conversationV1Policy.reduce(currentConversation, view);
    this.sql.exec(
      `UPDATE channel_delivery_context
          SET current_config_json = ?, conversation_state_json = ?
        WHERE singleton = 1`,
      JSON.stringify(nextConfig),
      JSON.stringify(nextConversation)
    );
    const sourceMessageId = this.sourceMessageId(event);
    if (sourceMessageId) {
      this.sql.exec(
        `INSERT OR IGNORE INTO channel_delivery_message_senders
           (message_id, sender_id, event_sequence) VALUES (?, ?, ?)`,
        sourceMessageId,
        event.senderId,
        event.id
      );
    }
  }

  private replyToMessageId(event: ChannelEvent): string | null {
    if (event.type !== "agentic.trajectory.v1/event") return null;
    const payload = (event.payload as { payload?: { replyTo?: unknown } } | null)?.payload;
    return typeof payload?.replyTo === "string" ? payload.replyTo : null;
  }

  recordRead(messageId: string, participantId: string, turnId?: string): void {
    this.sql.exec(
      `INSERT INTO channel_receipts
         (message_id, participant_id, state, turn_id, updated_at)
       VALUES (?, ?, 'read', ?, ?)
       ON CONFLICT(message_id, participant_id) DO UPDATE SET
         state = 'read',
         turn_id = COALESCE(excluded.turn_id, channel_receipts.turn_id),
         updated_at = MAX(channel_receipts.updated_at, excluded.updated_at)`,
      messageId,
      participantId,
      turnId ?? null,
      Date.now()
    );
  }

  recordDeclined(deliveryId: string): void {
    const row = this.sql
      .exec(
        `SELECT participant_id, envelope_json
           FROM channel_delivery_mailbox
          WHERE delivery_id = ?`,
        deliveryId
      )
      .toArray()[0];
    if (!row || typeof row["envelope_json"] !== "string") return;
    const sourceMessageId = this.sourceMessageIdFromEnvelope(String(row["envelope_json"]));
    if (!sourceMessageId) return;
    this.sql.exec(
      `INSERT INTO channel_receipts
         (message_id, participant_id, state, turn_id, updated_at)
       VALUES (?, ?, 'declined', NULL, ?)
       ON CONFLICT(message_id, participant_id) DO UPDATE SET
         state = CASE WHEN channel_receipts.state = 'read' THEN 'read' ELSE 'declined' END,
         updated_at = MAX(channel_receipts.updated_at, excluded.updated_at)`,
      sourceMessageId,
      String(row["participant_id"]),
      Date.now()
    );
  }

  receiptRows(): Array<{
    messageId: string;
    participantId: string;
    state: "delivered" | "read" | "declined";
    turnId?: string;
    updatedAt: number;
  }> {
    return this.sql
      .exec(
        `SELECT message_id, participant_id, state, turn_id, updated_at
           FROM channel_receipts
          ORDER BY message_id, participant_id`
      )
      .toArray()
      .map((row) => ({
        messageId: String(row["message_id"]),
        participantId: String(row["participant_id"]),
        state: String(row["state"]) as "delivered" | "read" | "declined",
        ...(typeof row["turn_id"] === "string" ? { turnId: String(row["turn_id"]) } : {}),
        updatedAt: Number(row["updated_at"]),
      }));
  }

  diagnostics(headSequence: number): {
    projectionVersion: number;
    cursor: number;
    lag: number;
    memberships: Array<{
      active: boolean;
      endpointKind: "entity" | "session";
      delivery: DeliveryInterest;
      count: number;
    }>;
    mailbox: Array<{ state: string; count: number; oldestCreatedAt: number }>;
    receiptCount: number;
  } {
    const cursor = this.cursor();
    return {
      projectionVersion: CHANNEL_DELIVERY_PROJECTION_VERSION,
      cursor,
      lag: Math.max(0, headSequence - cursor),
      memberships: this.sql
        .exec(
          `SELECT active, endpoint_kind, delivery, COUNT(*) AS count
             FROM channel_relationships
            GROUP BY active, endpoint_kind, delivery
            ORDER BY active DESC, endpoint_kind, delivery`
        )
        .toArray()
        .map((row) => ({
          active: Number(row["active"]) === 1,
          endpointKind: String(row["endpoint_kind"]) as "entity" | "session",
          delivery: String(row["delivery"]) as DeliveryInterest,
          count: Number(row["count"]),
        })),
      mailbox: this.sql
        .exec(
          `SELECT state, COUNT(*) AS count, MIN(created_at) AS oldest_created_at
             FROM channel_delivery_mailbox
            GROUP BY state
            ORDER BY state`
        )
        .toArray()
        .map((row) => ({
          state: String(row["state"]),
          count: Number(row["count"]),
          oldestCreatedAt: Number(row["oldest_created_at"]),
        })),
      receiptCount: Number(
        this.sql.exec(`SELECT COUNT(*) AS count FROM channel_receipts`).toArray()[0]?.["count"] ?? 0
      ),
    };
  }

  private sourceMessageId(event: ChannelEvent): string | null {
    if (event.type !== "agentic.trajectory.v1/event") return null;
    const agentic = event.payload as { kind?: unknown; causality?: { messageId?: unknown } };
    return agentic.kind === "message.completed" && typeof agentic.causality?.messageId === "string"
      ? agentic.causality.messageId
      : null;
  }

  private sourceMessageIdFromEnvelope(envelopeJson: string): string | null {
    try {
      const envelope = JSON.parse(envelopeJson) as { event?: ChannelEvent };
      return envelope.event ? this.sourceMessageId(envelope.event) : null;
    } catch {
      return null;
    }
  }

  private addresses(event: ChannelEvent, participantId: string): boolean {
    if (
      event.type !== "agentic.trajectory.v1/event" ||
      !event.payload ||
      typeof event.payload !== "object"
    ) {
      return false;
    }
    const agentic = event.payload as AgenticEvent;
    const payload = (agentic as { payload?: { mentions?: unknown; to?: unknown } }).payload;
    if (Array.isArray(payload?.mentions) && payload.mentions.includes(participantId)) return true;
    if (!Array.isArray(payload?.to)) return false;
    return payload.to.some((target) => {
      if (!target || typeof target !== "object") return false;
      const value = target as { kind?: unknown; participantId?: unknown };
      return value.kind === "all" || value.participantId === participantId;
    });
  }

  private requireRelationshipPayload(value: unknown): ChannelRelationshipPayload {
    if (!value || typeof value !== "object")
      throw new Error("Invalid channel relationship payload");
    const payload = value as ChannelRelationshipPayload;
    if (!payload.participantId || !Number.isSafeInteger(payload.revision) || payload.revision < 1) {
      throw new Error("Invalid channel relationship identity");
    }
    return payload;
  }
}
