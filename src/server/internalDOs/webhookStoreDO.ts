import {
  DurableObjectBase,
  rpc,
  type DurableObjectContext,
  type DurableObjectSchemaMigration,
} from "@vibestudio/durable";
import type { AuthenticatedCaller } from "@vibestudio/rpc";
import type { WebhookIngressSubscription } from "../../../packages/shared/src/webhooks/ingress.js";

interface WebhookIngressSubscriptionRow {
  subscription_id: string;
  label: string | null;
  owner_caller_id: string;
  owner_caller_kind: WebhookIngressSubscription["ownerCallerKind"];
  target_json: string;
  delivery_json: string;
  payload_json: string;
  verifier_json: string;
  replay_json: string | null;
  response_json: string;
  public_url: string;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}

export class WebhookStoreDO extends DurableObjectBase {
  static override schemaVersion = 2;

  protected override schemaProductionBaseline() {
    return { version: 1, name: "webhook-store-v1" } as const;
  }

  constructor(ctx: DurableObjectContext, env: unknown) {
    super(ctx, env);
    this.ensureReady();
  }

  /** Keep verifier secrets and dispatch targets behind the server service. */
  protected override assertInboundAllowed(
    caller: AuthenticatedCaller | null,
    kind: "call" | "event"
  ): void {
    if (kind === "event") return;
    if (caller?.callerKind !== "server") {
      throw new Error(
        `webhook-ingress: WebhookStoreDO is server-only; refusing caller kind ${caller?.callerKind ?? "unknown"}`
      );
    }
  }

  protected createTables(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS webhook_ingress_subscriptions (
        subscription_id TEXT PRIMARY KEY,
        label TEXT,
        owner_caller_id TEXT NOT NULL,
        owner_caller_kind TEXT NOT NULL,
        target_json TEXT NOT NULL,
        delivery_json TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        verifier_json TEXT NOT NULL,
        replay_json TEXT,
        response_json TEXT NOT NULL,
        public_url TEXT NOT NULL,
        revoked_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE INDEX IF NOT EXISTS webhook_ingress_subscriptions_owner_idx
      ON webhook_ingress_subscriptions(owner_caller_id)
    `);
  }

  protected override schemaMigrations(): readonly DurableObjectSchemaMigration[] {
    return [
      {
        version: 2,
        name: "generalize-webhook-delivery-contract",
        validateSource: assertExactV1WebhookSource,
        migrate: (sql) => {
          const replayUpdates: Array<{ subscriptionId: string; replayJson: string | null }> = [];
          for (const row of sql.exec(`SELECT * FROM webhook_ingress_subscriptions`).toArray()) {
            validateV1WebhookRow(row);
            replayUpdates.push({
              subscriptionId: String(row["subscription_id"]),
              replayJson: migrateV1ReplayJson(row["replay_json"], String(row["subscription_id"])),
            });
          }

          sql.exec(`ALTER TABLE webhook_ingress_subscriptions ADD COLUMN delivery_json TEXT`);
          sql.exec(`ALTER TABLE webhook_ingress_subscriptions ADD COLUMN payload_json TEXT`);
          sql.exec(`ALTER TABLE webhook_ingress_subscriptions ADD COLUMN response_json TEXT`);
          sql.exec(
            `UPDATE webhook_ingress_subscriptions
                SET delivery_json = ?, payload_json = ?, response_json = ?`,
            JSON.stringify({ mode: "relay" }),
            JSON.stringify({ type: "json" }),
            JSON.stringify({
              successStatus: 202,
              malformedPayload: "ack",
              dispatchError: "retry",
            })
          );

          for (const update of replayUpdates) {
            sql.exec(
              `UPDATE webhook_ingress_subscriptions SET replay_json = ? WHERE subscription_id = ?`,
              update.replayJson,
              update.subscriptionId
            );
          }

          sql.exec(`DROP INDEX IF EXISTS webhook_ingress_subscriptions_owner_idx`);
          sql.exec(`
            CREATE TABLE webhook_ingress_subscriptions_v2 (
              subscription_id TEXT PRIMARY KEY,
              label TEXT,
              owner_caller_id TEXT NOT NULL,
              owner_caller_kind TEXT NOT NULL,
              target_json TEXT NOT NULL,
              delivery_json TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              verifier_json TEXT NOT NULL,
              replay_json TEXT,
              response_json TEXT NOT NULL,
              public_url TEXT NOT NULL,
              revoked_at INTEGER,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
          `);
          sql.exec(`
            INSERT INTO webhook_ingress_subscriptions_v2 (
              subscription_id, label, owner_caller_id, owner_caller_kind,
              target_json, delivery_json, payload_json, verifier_json, replay_json,
              response_json, public_url, revoked_at, created_at, updated_at
            )
            SELECT subscription_id, label, owner_caller_id, owner_caller_kind,
                   target_json, delivery_json, payload_json, verifier_json, replay_json,
                   response_json, public_url, revoked_at, created_at, updated_at
              FROM webhook_ingress_subscriptions
          `);
          sql.exec(`DROP TABLE webhook_ingress_subscriptions`);
          sql.exec(
            `ALTER TABLE webhook_ingress_subscriptions_v2 RENAME TO webhook_ingress_subscriptions`
          );
          sql.exec(`
            CREATE INDEX webhook_ingress_subscriptions_owner_idx
            ON webhook_ingress_subscriptions(owner_caller_id)
          `);
        },
      },
    ];
  }

  protected override requiredTables(): readonly string[] {
    return ["webhook_ingress_subscriptions"];
  }

  protected override validateSchema(): void {
    super.validateSchema();
    const columns = new Set(
      this.sql
        .exec(`PRAGMA table_info(webhook_ingress_subscriptions)`)
        .toArray()
        .map((column) => String(column["name"]))
    );
    for (const column of ["delivery_json", "payload_json", "response_json"]) {
      if (!columns.has(column)) {
        throw new Error(
          `${this.constructor.name} schema validation failed: webhook_ingress_subscriptions.${column} is missing`
        );
      }
    }
  }

  @rpc({ principals: ["host"], sensitivity: "write" })
  create(
    input: Omit<WebhookIngressSubscription, "subscriptionId" | "createdAt" | "updatedAt">
  ): WebhookIngressSubscription {
    const now = Date.now();
    const subscription: WebhookIngressSubscription = {
      ...input,
      subscriptionId: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    this.replace(subscription);
    return subscription;
  }

  @rpc({ principals: ["host"], sensitivity: "read" })
  get(subscriptionId: string): WebhookIngressSubscription | null {
    const row = this.sql
      .exec(this.selectSql("WHERE subscription_id = ?"), subscriptionId)
      .toArray()[0] as unknown as WebhookIngressSubscriptionRow | undefined;
    return row ? this.fromRow(row) : null;
  }

  @rpc({ principals: ["host"], sensitivity: "read" })
  list(ownerCallerId?: string): WebhookIngressSubscription[] {
    const rows = ownerCallerId
      ? this.sql.exec(this.selectSql("WHERE owner_caller_id = ?"), ownerCallerId).toArray()
      : this.sql.exec(this.selectSql("")).toArray();
    return (rows as unknown as WebhookIngressSubscriptionRow[]).map((row) => this.fromRow(row));
  }

  @rpc({ principals: ["host"], sensitivity: "write" })
  replace(subscription: WebhookIngressSubscription): void {
    this.sql.exec(
      `
        INSERT INTO webhook_ingress_subscriptions (
          subscription_id, label, owner_caller_id, owner_caller_kind,
          target_json, delivery_json, payload_json, verifier_json, replay_json,
          response_json, public_url, revoked_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(subscription_id) DO UPDATE SET
          label = excluded.label,
          owner_caller_id = excluded.owner_caller_id,
          owner_caller_kind = excluded.owner_caller_kind,
          target_json = excluded.target_json,
          delivery_json = excluded.delivery_json,
          payload_json = excluded.payload_json,
          verifier_json = excluded.verifier_json,
          replay_json = excluded.replay_json,
          response_json = excluded.response_json,
          public_url = excluded.public_url,
          revoked_at = excluded.revoked_at,
          updated_at = excluded.updated_at
      `,
      subscription.subscriptionId,
      subscription.label ?? null,
      subscription.ownerCallerId,
      subscription.ownerCallerKind,
      JSON.stringify(subscription.target),
      JSON.stringify(subscription.delivery),
      JSON.stringify(subscription.payload),
      JSON.stringify(subscription.verifier),
      subscription.replay ? JSON.stringify(subscription.replay) : null,
      JSON.stringify(subscription.response),
      subscription.publicUrl,
      subscription.revokedAt ?? null,
      subscription.createdAt,
      subscription.updatedAt
    );
  }

  private selectSql(where: string): string {
    return `
      SELECT
        subscription_id,
        label,
        owner_caller_id,
        owner_caller_kind,
        target_json,
        delivery_json,
        payload_json,
        verifier_json,
        replay_json,
        response_json,
        public_url,
        revoked_at,
        created_at,
        updated_at
      FROM webhook_ingress_subscriptions
      ${where}
      ORDER BY created_at ASC
    `;
  }

  private fromRow(row: WebhookIngressSubscriptionRow): WebhookIngressSubscription {
    return {
      subscriptionId: row.subscription_id,
      label: row.label ?? undefined,
      ownerCallerId: row.owner_caller_id,
      ownerCallerKind: row.owner_caller_kind,
      target: JSON.parse(row.target_json) as WebhookIngressSubscription["target"],
      delivery: JSON.parse(row.delivery_json) as WebhookIngressSubscription["delivery"],
      payload: JSON.parse(row.payload_json) as WebhookIngressSubscription["payload"],
      verifier: JSON.parse(row.verifier_json) as WebhookIngressSubscription["verifier"],
      replay: row.replay_json
        ? (JSON.parse(row.replay_json) as WebhookIngressSubscription["replay"])
        : undefined,
      response: JSON.parse(row.response_json) as WebhookIngressSubscription["response"],
      publicUrl: row.public_url,
      revokedAt: row.revoked_at ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

type MigrationSql = Parameters<DurableObjectSchemaMigration["migrate"]>[0];

const V1_WEBHOOK_COLUMNS = [
  "subscription_id",
  "label",
  "owner_caller_id",
  "owner_caller_kind",
  "target_json",
  "verifier_json",
  "replay_json",
  "public_url",
  "revoked_at",
  "created_at",
  "updated_at",
] as const;

function assertExactV1WebhookSource(sql: MigrationSql): void {
  const columns = sql
    .exec(`PRAGMA table_info(webhook_ingress_subscriptions)`)
    .toArray()
    .map((column) => String(column["name"]));
  if (
    columns.length !== V1_WEBHOOK_COLUMNS.length ||
    !V1_WEBHOOK_COLUMNS.every((column, index) => columns[index] === column)
  ) {
    throw new Error("WebhookStoreDO migration source does not match the exact v1 table shape");
  }
  for (const row of sql.exec(`SELECT * FROM webhook_ingress_subscriptions`).toArray()) {
    validateV1WebhookRow(row);
    migrateV1ReplayJson(row["replay_json"], String(row["subscription_id"]));
  }
}

function validateV1WebhookRow(row: Record<string, unknown>): void {
  const id = row["subscription_id"];
  if (
    typeof id !== "string" ||
    !id ||
    (row["label"] !== null && typeof row["label"] !== "string") ||
    typeof row["owner_caller_id"] !== "string" ||
    typeof row["owner_caller_kind"] !== "string" ||
    typeof row["public_url"] !== "string" ||
    (row["revoked_at"] !== null && !isStoredTimestamp(row["revoked_at"])) ||
    !isStoredTimestamp(row["created_at"]) ||
    !isStoredTimestamp(row["updated_at"])
  ) {
    throw new Error(`WebhookStoreDO migration found invalid scalar fields for ${String(id)}`);
  }
  const target = parseMigrationJson(row["target_json"], "target_json", id);
  if (
    !isExactRecord(target, ["source", "className", "objectKey", "method"]) ||
    !["source", "className", "objectKey", "method"].every(
      (key) => typeof target[key] === "string" && Boolean(target[key])
    )
  ) {
    throw new Error(`WebhookStoreDO migration found invalid target_json for ${id}`);
  }
  const verifier = parseMigrationJson(row["verifier_json"], "verifier_json", id);
  if (!isRecognizedV1Verifier(verifier)) {
    throw new Error(`WebhookStoreDO migration found invalid verifier_json for ${id}`);
  }
}

function migrateV1ReplayJson(value: unknown, subscriptionId: string): string | null {
  if (value === null) return null;
  const parsed = parseMigrationJson(value, "replay_json", subscriptionId);
  if (!isExactRecord(parsed, ["deliveryIdHeader", "ttlMs"], true)) {
    throw new Error(`WebhookStoreDO migration found invalid replay_json for ${subscriptionId}`);
  }
  if (
    parsed["deliveryIdHeader"] !== undefined &&
    (typeof parsed["deliveryIdHeader"] !== "string" || !parsed["deliveryIdHeader"].trim())
  ) {
    throw new Error(
      `WebhookStoreDO migration found invalid replay_json.deliveryIdHeader for ${subscriptionId}`
    );
  }
  if (
    parsed["ttlMs"] !== undefined &&
    (typeof parsed["ttlMs"] !== "number" ||
      !Number.isSafeInteger(parsed["ttlMs"]) ||
      parsed["ttlMs"] <= 0)
  ) {
    throw new Error(
      `WebhookStoreDO migration found invalid replay_json.ttlMs for ${subscriptionId}`
    );
  }
  const key =
    typeof parsed["deliveryIdHeader"] === "string"
      ? { type: "header" as const, name: parsed["deliveryIdHeader"] }
      : { type: "body-sha256" as const };
  return JSON.stringify({ key, ttlMs: parsed["ttlMs"] ?? 24 * 60 * 60 * 1000 });
}

function parseMigrationJson(value: unknown, field: string, id: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error(`WebhookStoreDO migration found non-text ${field} for ${String(id)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`WebhookStoreDO migration found malformed ${field} for ${String(id)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`WebhookStoreDO migration found non-object ${field} for ${String(id)}`);
  }
  return parsed as Record<string, unknown>;
}

function isStoredTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isExactRecord(
  value: unknown,
  keys: readonly string[],
  optional = false
): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return (
    actual.every((key) => keys.includes(key)) && (optional || keys.every((key) => key in value))
  );
}

function isRecognizedV1Verifier(value: Record<string, unknown>): boolean {
  const string = (key: string) => typeof value[key] === "string" && Boolean(value[key]);
  switch (value["type"]) {
    case "hmac-sha256":
      return (
        isExactRecord(value, ["type", "headerName", "secret", "prefix", "encoding"], true) &&
        string("headerName") &&
        string("secret") &&
        (value["prefix"] === undefined || typeof value["prefix"] === "string") &&
        (value["encoding"] === undefined ||
          value["encoding"] === "hex" ||
          value["encoding"] === "base64")
      );
    case "timestamped-hmac-sha256":
      return (
        isExactRecord(
          value,
          [
            "type",
            "signatureHeaderName",
            "timestampHeaderName",
            "secret",
            "prefix",
            "encoding",
            "toleranceMs",
            "signedPayload",
          ],
          true
        ) &&
        string("signatureHeaderName") &&
        string("timestampHeaderName") &&
        string("secret") &&
        (value["prefix"] === undefined || typeof value["prefix"] === "string") &&
        (value["encoding"] === undefined ||
          value["encoding"] === "hex" ||
          value["encoding"] === "base64") &&
        (value["toleranceMs"] === undefined ||
          (typeof value["toleranceMs"] === "number" && value["toleranceMs"] > 0)) &&
        (value["signedPayload"] === "slack-v0" || value["signedPayload"] === "timestamp-dot-body")
      );
    case "bearer":
      return (
        isExactRecord(value, ["type", "headerName", "token", "scheme"], true) &&
        string("headerName") &&
        string("token") &&
        (value["scheme"] === undefined || typeof value["scheme"] === "string")
      );
    case "query-token":
      return (
        isExactRecord(value, ["type", "paramName", "token"], true) &&
        string("paramName") &&
        string("token")
      );
    case "oidc-jwt":
      return (
        isExactRecord(
          value,
          ["type", "issuer", "audience", "jwksUrl", "headerName", "serviceAccountEmail"],
          true
        ) &&
        string("issuer") &&
        string("audience") &&
        string("jwksUrl") &&
        (value["headerName"] === undefined || typeof value["headerName"] === "string") &&
        (value["serviceAccountEmail"] === undefined ||
          typeof value["serviceAccountEmail"] === "string")
      );
    default:
      return false;
  }
}
