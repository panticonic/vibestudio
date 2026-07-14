/**
 * Push Notification Service — manages push notification registrations
 * for mobile/remote shell clients and delivers approval pushes through FCM.
 *
 * Registrations are persisted as independently addressable SQLite rows so
 * multiple workspace processes cannot overwrite one another. Delivery
 * gracefully degrades to log-only when Firebase is unavailable.
 */

import * as fs from "fs";
import * as path from "path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { getCentralDataPath } from "@vibestudio/env-paths";
import type { PushApprovalDataPayload } from "@vibestudio/shared/approvalContract";
import { pushMethods } from "@vibestudio/service-schemas/push";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  assertCanonicalSqliteSchema,
  initializeCanonicalSqliteSchema,
  isTrulyEmptySqliteDatabase,
  type CanonicalSqliteSchema,
} from "@vibestudio/sqlite";
import { pushMetrics, type PushMetrics } from "./pushMetrics.js";

export interface PushRegistration {
  token: string;
  platform: "ios" | "android" | "web";
  clientId: string;
  /**
   * Owning user (WP4 §4.2), stamped from the host-verified `ctx.caller.subject`
   * at `register` time (INV-3) — NEVER from the client's `register` args (which
   * carry only token/platform/clientId). The device asserts its FCM token; the
   * host asserts whose it is. Target selection uses this field so a workspace's
   * approval reaches only member devices, never every device on the machine.
   */
  userId: string;
  registeredAt: number;
}

export interface PushSendOptions {
  clientId: string;
  title: string;
  body?: string;
  category?: string;
  data?: PushApprovalDataPayload | Record<string, unknown>;
}

export interface PushBroadcastOptions {
  title: string;
  body?: string;
  category?: string;
  data?: PushApprovalDataPayload | Record<string, unknown>;
}

export interface PushSendResult {
  userId: string;
  clientId: string;
  platform: PushRegistration["platform"];
  sent: boolean;
  logOnly: boolean;
  error?: string;
}

export interface PushDeliveryTarget {
  userId: string;
  clientId: string;
}

export interface PushServiceInternal {
  send(userId: string, opts: PushSendOptions): Promise<PushSendResult>;
  /**
   * Deliver to the exact user/client registrations selected by the caller.
   * Missing or concurrently removed registrations are skipped.
   */
  sendToTargets(
    targets: readonly PushDeliveryTarget[],
    opts: PushBroadcastOptions
  ): Promise<PushSendResult[]>;
  /**
   * Cancel an approval on the exact user/client targets that successfully
   * received it. The caller snapshots these identities at delivery time.
   */
  cancel(
    targets: readonly PushDeliveryTarget[],
    approvalId: string,
    cancelKey?: string
  ): Promise<PushSendResult[]>;
  listRegistrations(): PushRegistration[];
  onRegistrationsChanged(listener: () => void): () => void;
  unregister(userId: string, clientId: string): boolean;
  /** Idempotent revocation cascade: remove every persisted device for a user. */
  unregisterUser(userId: string): number;
}

export interface PushServiceResult {
  definition: ServiceDefinition;
  internal: PushServiceInternal;
}

interface FirebaseMessagingClient {
  send(message: unknown): Promise<string>;
}

type FirebaseAdminLoader = () => Promise<FirebaseMessagingClient | null>;

interface PushServiceDeps {
  databasePath?: string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  firebaseAdminLoader?: FirebaseAdminLoader;
  metrics?: PushMetrics;
}

const PUSH_DATABASE_SCHEMA: CanonicalSqliteSchema = {
  version: 1,
  objects: [
    {
      type: "table",
      name: "push_registrations",
      sql: `CREATE TABLE push_registrations (
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL CHECK(platform IN ('ios', 'android', 'web')),
        registered_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, client_id)
      )`,
    },
    {
      type: "index",
      name: "push_registrations_by_user",
      sql: "CREATE INDEX push_registrations_by_user ON push_registrations(user_id)",
    },
  ],
};

function getPushDatabasePath(): string {
  return path.join(getCentralDataPath(), "server-auth", "push.db");
}

function rowToRegistration(row: Record<string, SQLOutputValue>): PushRegistration {
  return {
    userId: row["user_id"] as string,
    clientId: row["client_id"] as string,
    token: row["token"] as string,
    platform: row["platform"] as PushRegistration["platform"],
    registeredAt: row["registered_at"] as number,
  };
}

class PushRegistrationStore {
  private readonly db: DatabaseSync;

  constructor(databasePath: string) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA busy_timeout = 5000");
    try {
      if (isTrulyEmptySqliteDatabase(this.db)) {
        initializeCanonicalSqliteSchema(this.db, PUSH_DATABASE_SCHEMA);
      } else {
        assertCanonicalSqliteSchema(
          this.db,
          PUSH_DATABASE_SCHEMA,
          `push schema in ${databasePath}`
        );
      }
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  list(): PushRegistration[] {
    return this.db
      .prepare("SELECT * FROM push_registrations ORDER BY registered_at, user_id, client_id")
      .all()
      .map(rowToRegistration);
  }

  get(userId: string, clientId: string): PushRegistration | null {
    const row = this.db
      .prepare("SELECT * FROM push_registrations WHERE user_id = ? AND client_id = ?")
      .get(userId, clientId);
    return row ? rowToRegistration(row) : null;
  }

  upsert(registration: PushRegistration): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // An FCM token identifies one physical installation. Moving it between
      // accounts must remove the old owner atomically.
      this.db.prepare("DELETE FROM push_registrations WHERE token = ?").run(registration.token);
      this.db
        .prepare(
          `INSERT INTO push_registrations
             (user_id, client_id, token, platform, registered_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id, client_id) DO UPDATE SET
             token = excluded.token,
             platform = excluded.platform,
             registered_at = excluded.registered_at`
        )
        .run(
          registration.userId,
          registration.clientId,
          registration.token,
          registration.platform,
          registration.registeredAt
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  delete(userId: string, clientId: string): boolean {
    return (
      this.db
        .prepare("DELETE FROM push_registrations WHERE user_id = ? AND client_id = ?")
        .run(userId, clientId).changes > 0
    );
  }

  deleteUser(userId: string): number {
    return Number(
      this.db.prepare("DELETE FROM push_registrations WHERE user_id = ?").run(userId).changes
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readServiceAccount(env: NodeJS.ProcessEnv): Record<string, unknown> | null {
  const inlineJson =
    env["VIBESTUDIO_FIREBASE_SERVICE_ACCOUNT_JSON"] ?? env["FIREBASE_SERVICE_ACCOUNT_JSON"];
  if (inlineJson) {
    return JSON.parse(inlineJson) as Record<string, unknown>;
  }

  const candidatePaths = [
    env["VIBESTUDIO_FIREBASE_SERVICE_ACCOUNT_PATH"],
    env["GOOGLE_APPLICATION_CREDENTIALS"],
    path.join(process.cwd(), "firebase-service-account.json"),
  ].filter((value): value is string => !!value);

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return JSON.parse(fs.readFileSync(candidate, "utf-8")) as Record<string, unknown>;
    }
  }

  return null;
}

function createDefaultFirebaseLoader(env: NodeJS.ProcessEnv): FirebaseAdminLoader {
  let initialized: Promise<FirebaseMessagingClient | null> | null = null;
  return async () => {
    initialized ??= (async () => {
      const serviceAccount = readServiceAccount(env);
      if (!serviceAccount) {
        console.warn(
          "[PushService] Firebase service account missing; using log-only push delivery"
        );
        return null;
      }

      try {
        const appModule = await import("firebase-admin/app");
        const messagingModule = await import("firebase-admin/messaging");
        const app =
          appModule.getApps()[0] ??
          appModule.initializeApp({
            credential: appModule.cert(serviceAccount),
          });
        const messaging = messagingModule.getMessaging(app);
        return { send: (message) => messaging.send(message as never) };
      } catch (error) {
        console.warn(
          "[PushService] Failed to initialize firebase-admin; using log-only push delivery:",
          error
        );
        return null;
      }
    })();
    return initialized;
  };
}

function stringifyData(data: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === undefined) continue;
    out[key] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

function buildFirebaseMessage(
  registration: PushRegistration,
  opts: PushBroadcastOptions
): Record<string, unknown> {
  const category = opts.category ?? String(opts.data?.["category"] ?? "");
  const kind = String(opts.data?.["kind"] ?? "");
  const cancelKey = String(opts.data?.["cancelKey"] ?? opts.data?.["approvalId"] ?? "");
  const body = opts.body && opts.body.length > 140 ? `${opts.body.slice(0, 137)}...` : opts.body;
  const data = stringifyData({
    title: opts.title,
    body,
    category,
    ...opts.data,
  });

  if (registration.platform === "ios") {
    if (kind === "approval-cancel") {
      return {
        token: registration.token,
        data,
        apns: {
          headers: {
            "apns-push-type": "background",
            "apns-priority": "5",
          },
          payload: {
            aps: {
              "content-available": 1,
            },
          },
        },
      };
    }

    const message: Record<string, unknown> = {
      token: registration.token,
      data,
      apns: {
        headers: {
          "apns-push-type": "alert",
          "apns-priority": "10",
        },
        payload: {
          aps: {
            ...(category ? { category } : {}),
            ...(cancelKey ? { "thread-id": cancelKey } : {}),
          },
        },
      },
    };
    if (opts.title || body) {
      message["notification"] = {
        title: opts.title,
        body: body ?? "",
      };
    }
    return message;
  }

  return {
    token: registration.token,
    data,
    android: {
      priority: "high",
    },
  };
}

function isInvalidTokenError(error: unknown): boolean {
  const code =
    typeof error === "object" && error
      ? String(
          (error as { code?: unknown; errorInfo?: { code?: unknown } }).code ??
            (error as { errorInfo?: { code?: unknown } }).errorInfo?.code ??
            ""
        )
      : "";
  return (
    code === "messaging/registration-token-not-registered" ||
    code === "messaging/invalid-registration-token"
  );
}

export function createPushService(deps: PushServiceDeps = {}): PushServiceResult {
  const store = new PushRegistrationStore(deps.databasePath ?? getPushDatabasePath());
  const now = deps.now ?? (() => Date.now());
  const metrics = deps.metrics ?? pushMetrics;
  const loadFirebase =
    deps.firebaseAdminLoader ?? createDefaultFirebaseLoader(deps.env ?? process.env);
  const registrationListeners = new Set<() => void>();

  function emitRegistrationsChanged(): void {
    for (const listener of registrationListeners) {
      try {
        listener();
      } catch (error) {
        console.warn("[PushService] Registration listener failed:", error);
      }
    }
  }

  const initialRegistrationCount = store.list().length;
  if (initialRegistrationCount > 0) {
    console.log(`[PushService] Loaded ${initialRegistrationCount} persisted registration(s)`);
  }

  async function sendToRegistration(
    registration: PushRegistration,
    opts: PushBroadcastOptions
  ): Promise<PushSendResult> {
    const category = opts.category ?? String(opts.data?.["category"] ?? "unknown");
    try {
      const client = await loadFirebase();
      if (!client) {
        console.log(`[PushService] Log-only push for ${registration.clientId}: ${opts.title}`);
        metrics.recordPushSend({ platform: registration.platform, category, outcome: "log-only" });
        return {
          userId: registration.userId,
          clientId: registration.clientId,
          platform: registration.platform,
          sent: true,
          logOnly: true,
        };
      }

      await client.send(buildFirebaseMessage(registration, opts));
      metrics.recordPushSend({ platform: registration.platform, category, outcome: "sent" });
      return {
        userId: registration.userId,
        clientId: registration.clientId,
        platform: registration.platform,
        sent: true,
        logOnly: false,
      };
    } catch (error) {
      if (isInvalidTokenError(error)) {
        store.delete(registration.userId, registration.clientId);
        emitRegistrationsChanged();
      }
      metrics.recordPushSend({ platform: registration.platform, category, outcome: "failed" });
      throw error;
    }
  }

  const internal: PushServiceInternal = {
    async send(userId, opts) {
      const registration = store.get(userId, opts.clientId);
      if (!registration) {
        metrics.recordPushSend({
          platform: "unknown",
          category: opts.category ?? String(opts.data?.["category"] ?? "unknown"),
          outcome: "no-registration",
        });
        throw new Error(`No push registration found for client ${opts.clientId}`);
      }
      return sendToRegistration(registration, opts);
    },

    async sendToTargets(deliveryTargets, opts) {
      const results: PushSendResult[] = [];
      const targets = new Map(
        deliveryTargets.map((target) => [`${target.userId}\0${target.clientId}`, target])
      );
      for (const target of targets.values()) {
        const registration = store.get(target.userId, target.clientId);
        if (!registration) continue;
        try {
          results.push(await sendToRegistration(registration, opts));
        } catch (error) {
          console.warn(`[PushService] Push send failed for ${registration.clientId}:`, error);
          results.push({
            userId: registration.userId,
            clientId: registration.clientId,
            platform: registration.platform,
            sent: false,
            logOnly: false,
            error: errorMessage(error),
          });
        }
      }
      return results;
    },

    async cancel(targets, approvalId, cancelKey) {
      metrics.recordPushCancel();
      return internal.sendToTargets(targets, {
        title: "",
        data: {
          kind: "approval-cancel",
          approvalId,
          cancelKey: cancelKey ?? approvalId,
        } satisfies PushApprovalDataPayload,
      });
    },

    listRegistrations() {
      return store.list();
    },

    onRegistrationsChanged(listener) {
      registrationListeners.add(listener);
      return () => registrationListeners.delete(listener);
    },

    unregister(userId, clientId) {
      const existed = store.delete(userId, clientId);
      if (existed) {
        console.log(`[PushService] Unregistered device for client ${clientId}`);
        emitRegistrationsChanged();
      }
      return existed;
    },

    unregisterUser(userId) {
      const removed = store.deleteUser(userId);
      if (removed > 0) emitRegistrationsChanged();
      return removed;
    },
  };

  const definition: ServiceDefinition = {
    name: "push",
    description: "Push notification device registration and delivery",
    authority: { principals: ["user", "code", "host"] },
    methods: pushMethods,
    handler: defineServiceHandler("push", pushMethods, {
      register: (ctx, [opts]) => {
        // Single source of truth for routing (WP4 §4.2 / INV-3): the owning
        // user is the HOST-VERIFIED subject on the caller context, never the
        // client's strict `register` args. Retired client-owned `userId`
        // fields are rejected at the service-schema boundary.
        const userId = ctx.caller.subject?.userId;
        if (!userId) {
          throw new Error("push.register requires an attributed caller (no subject on ctx.caller)");
        }
        const registration: PushRegistration = {
          token: opts.token,
          platform: opts.platform,
          clientId: opts.clientId,
          userId,
          registeredAt: now(),
        };
        store.upsert(registration);
        console.log(
          `[PushService] Registered device for client ${opts.clientId} (${opts.platform}) → user ${userId}`
        );
        emitRegistrationsChanged();
        return { registered: true };
      },
      unregister: (ctx, [clientId]) => {
        const userId = ctx.caller.subject?.userId;
        if (!userId) {
          throw new Error(
            "push.unregister requires an attributed caller (no subject on ctx.caller)"
          );
        }
        return { unregistered: internal.unregister(userId, clientId) };
      },
      send: (ctx, [opts]) => {
        const userId = ctx.caller.subject?.userId;
        if (!userId) {
          throw new Error("push.send requires an attributed caller (no subject on ctx.caller)");
        }
        return internal.send(userId, opts);
      },
      listRegistrations: () => internal.listRegistrations(),
    }),
  };

  return { definition, internal };
}

export const __private__ = {
  buildFirebaseMessage,
};
