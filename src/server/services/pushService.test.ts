import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APPROVAL_CATEGORY_DECIDE } from "@vibestudio/shared/approvalContract";
import { createPushMetrics } from "./pushMetrics.js";
import { __private__, createPushService } from "./pushService.js";

const { buildFirebaseMessage } = __private__;
// Owning user stamped onto registrations at register time (WP4 §4.2). The
// register handler now reads the host-verified subject off ctx.caller, so tests
// must supply an attributed caller and route sends/cancels by this userId.
const PUSH_USER_ID = "user-1";
const PUSH_SUBJECT = { userId: PUSH_USER_ID, handle: "user1" };
const DECISION_ACTIONS_JSON = JSON.stringify([
  { id: "once", title: "Once" },
  { id: "deny", title: "Deny" },
]);

function tempDatabasePath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-push-")), "push.db");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("pushService", () => {
  it("builds Android data-only approval payloads", () => {
    const message = buildFirebaseMessage(
      {
        clientId: "android-1",
        platform: "android",
        token: "token-1",
        userId: PUSH_USER_ID,
        registeredAt: 1,
      },
      {
        title: "Approve request",
        body: "Worker wants access",
        category: APPROVAL_CATEGORY_DECIDE,
        data: {
          kind: "approval-prompt",
          approvalId: "approval-1",
          category: APPROVAL_CATEGORY_DECIDE,
          actionsJson: DECISION_ACTIONS_JSON,
        },
      }
    );

    expect(message).toMatchObject({
      token: "token-1",
      android: { priority: "high" },
      data: {
        kind: "approval-prompt",
        approvalId: "approval-1",
        title: "Approve request",
        body: "Worker wants access",
        category: APPROVAL_CATEGORY_DECIDE,
        actionsJson: DECISION_ACTIONS_JSON,
      },
    });
    expect(message).not.toHaveProperty("notification");
  });

  it("builds iOS notification payloads with APNs category", () => {
    const message = buildFirebaseMessage(
      {
        clientId: "ios-1",
        platform: "ios",
        token: "token-2",
        userId: PUSH_USER_ID,
        registeredAt: 1,
      },
      {
        title: "Approve request",
        body: "Panel wants access",
        category: APPROVAL_CATEGORY_DECIDE,
        data: {
          kind: "approval-prompt",
          approvalId: "approval-2",
          category: APPROVAL_CATEGORY_DECIDE,
        },
      }
    );

    expect(message).toMatchObject({
      token: "token-2",
      notification: {
        title: "Approve request",
        body: "Panel wants access",
      },
      apns: {
        headers: {
          "apns-push-type": "alert",
          "apns-priority": "10",
        },
        payload: {
          aps: {
            category: APPROVAL_CATEGORY_DECIDE,
            "thread-id": "approval-2",
          },
        },
      },
      data: {
        kind: "approval-prompt",
        approvalId: "approval-2",
      },
    });
  });

  it("removes invalid FCM registrations", async () => {
    const databasePath = tempDatabasePath();
    const send = vi.fn(async () => {
      throw { code: "messaging/registration-token-not-registered" };
    });
    const service = createPushService({
      databasePath,
      firebaseAdminLoader: async () => ({ send }),
      metrics: createPushMetrics(),
    });

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "mobile-1", platform: "android", token: "dead-token" }]
    );

    await expect(
      service.internal.send(PUSH_USER_ID, {
        clientId: "mobile-1",
        title: "Approve",
        category: APPROVAL_CATEGORY_DECIDE,
      })
    ).rejects.toMatchObject({ code: "messaging/registration-token-not-registered" });
    expect(service.internal.listRegistrations()).toEqual([]);
  });

  it("notifies internal listeners when registrations change", async () => {
    const databasePath = tempDatabasePath();
    const service = createPushService({
      databasePath,
      metrics: createPushMetrics(),
    });
    const listener = vi.fn();
    const unsubscribe = service.internal.onRegistrationsChanged(listener);

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "mobile-1", platform: "android", token: "token-1" }]
    );
    expect(listener).toHaveBeenCalledTimes(1);

    service.internal.unregister(PUSH_USER_ID, "mobile-1");
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "mobile-2", platform: "ios", token: "token-2" }]
    );
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("continues batch delivery after removing an invalid registration", async () => {
    const databasePath = tempDatabasePath();
    const messages: unknown[] = [];
    const send = vi.fn(async (message: { token?: string }) => {
      if (message.token === "dead-token") {
        throw { code: "messaging/registration-token-not-registered" };
      }
      messages.push(message);
      return "message-id";
    });
    const service = createPushService({
      databasePath,
      firebaseAdminLoader: async () => ({ send }),
      metrics: createPushMetrics(),
    });

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "mobile-dead", platform: "android", token: "dead-token" }]
    );
    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "mobile-good", platform: "ios", token: "good-token" }]
    );

    const results = await service.internal.sendToTargets(
      [
        { userId: PUSH_USER_ID, clientId: "mobile-dead" },
        { userId: PUSH_USER_ID, clientId: "mobile-good" },
      ],
      {
        title: "Approve",
        category: APPROVAL_CATEGORY_DECIDE,
        data: {
          kind: "approval-prompt",
          approvalId: "approval-1",
          category: APPROVAL_CATEGORY_DECIDE,
        },
      }
    );

    expect(send).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(1);
    expect(results).toMatchObject([
      { clientId: "mobile-dead", sent: false },
      { clientId: "mobile-good", sent: true },
    ]);
    expect(service.internal.listRegistrations()).toEqual([
      expect.objectContaining({ clientId: "mobile-good", token: "good-token" }),
    ]);
  });

  it("degrades to log-only delivery when Firebase is unavailable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const service = createPushService({
      databasePath: tempDatabasePath(),
      firebaseAdminLoader: async () => null,
      metrics: createPushMetrics(),
    });

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "mobile-1", platform: "ios", token: "token-1" }]
    );

    await expect(
      service.internal.send(PUSH_USER_ID, {
        clientId: "mobile-1",
        title: "Approve",
        category: APPROVAL_CATEGORY_DECIDE,
      })
    ).resolves.toMatchObject({ sent: true, logOnly: true, platform: "ios" });
  });

  it("sends approval-cancel data payloads", async () => {
    const messages: unknown[] = [];
    const service = createPushService({
      databasePath: tempDatabasePath(),
      firebaseAdminLoader: async () => ({
        send: async (message) => {
          messages.push(message);
          return "message-id";
        },
      }),
      metrics: createPushMetrics(),
    });

    await service.definition.handler(
      { caller: createVerifiedCaller("shell", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "mobile-1", platform: "android", token: "token-1" }]
    );

    await service.internal.cancel([{ userId: PUSH_USER_ID, clientId: "mobile-1" }], "approval-1");

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      data: {
        kind: "approval-cancel",
        approvalId: "approval-1",
        cancelKey: "approval-1",
      },
    });
  });

  it("isolates client ids by verified user and only unregisters the caller's row", async () => {
    const databasePath = tempDatabasePath();
    const service = createPushService({ databasePath, metrics: createPushMetrics() });
    const otherSubject = { userId: "user-2", handle: "user2" };

    await service.definition.handler(
      { caller: createVerifiedCaller("shell:one", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "mobile", platform: "ios", token: "token-one" }]
    );
    await service.definition.handler(
      { caller: createVerifiedCaller("shell:two", "shell", null, null, otherSubject) },
      "register",
      [{ clientId: "mobile", platform: "android", token: "token-two" }]
    );

    await service.definition.handler(
      { caller: createVerifiedCaller("shell:one", "shell", null, null, PUSH_SUBJECT) },
      "unregister",
      ["mobile"]
    );

    expect(service.internal.listRegistrations()).toEqual([
      expect.objectContaining({ userId: "user-2", clientId: "mobile", token: "token-two" }),
    ]);
  });

  it("durably removes every revoked-user registration and is idempotent across restart", async () => {
    const databasePath = tempDatabasePath();
    const service = createPushService({ databasePath, metrics: createPushMetrics() });
    await service.definition.handler(
      { caller: createVerifiedCaller("shell:one", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "phone", platform: "ios", token: "token-phone" }]
    );
    await service.definition.handler(
      { caller: createVerifiedCaller("shell:two", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "tablet", platform: "android", token: "token-tablet" }]
    );
    await service.definition.handler(
      {
        caller: createVerifiedCaller("shell:other", "shell", null, null, {
          userId: "user-2",
          handle: "user2",
        }),
      },
      "register",
      [{ clientId: "other", platform: "web", token: "token-other" }]
    );

    expect(service.internal.unregisterUser(PUSH_USER_ID)).toBe(2);
    expect(service.internal.unregisterUser(PUSH_USER_ID)).toBe(0);

    const restarted = createPushService({ databasePath, metrics: createPushMetrics() });
    expect(restarted.internal.listRegistrations()).toEqual([
      expect.objectContaining({ userId: "user-2", clientId: "other" }),
    ]);
  });

  it("preserves independent registrations written through concurrent SQLite handles", async () => {
    const databasePath = tempDatabasePath();
    const first = createPushService({ databasePath, metrics: createPushMetrics() });
    const second = createPushService({ databasePath, metrics: createPushMetrics() });

    await first.definition.handler(
      { caller: createVerifiedCaller("shell:one", "shell", null, null, PUSH_SUBJECT) },
      "register",
      [{ clientId: "one", platform: "ios", token: "token-one" }]
    );
    await second.definition.handler(
      {
        caller: createVerifiedCaller("shell:two", "shell", null, null, {
          userId: "user-2",
          handle: "user2",
        }),
      },
      "register",
      [{ clientId: "two", platform: "android", token: "token-two" }]
    );

    expect(first.internal.listRegistrations()).toHaveLength(2);
    expect(second.internal.listRegistrations()).toHaveLength(2);
  });

  it("rejects legacy push database structures instead of retaining them", () => {
    const databasePath = tempDatabasePath();
    const first = createPushService({ databasePath, metrics: createPushMetrics() });
    expect(first.internal.listRegistrations()).toEqual([]);
    const raw = new DatabaseSync(databasePath);
    raw.exec("CREATE TABLE push_batches (id TEXT PRIMARY KEY, payload TEXT NOT NULL)");
    raw.close();

    expect(() => createPushService({ databasePath, metrics: createPushMetrics() })).toThrow(
      /Unsupported push schema/
    );
  });

  it("does not upgrade or mutate a nonempty pre-cutover push database", () => {
    const databasePath = tempDatabasePath();
    const raw = new DatabaseSync(databasePath);
    raw.exec(`CREATE TABLE push_registrations (
      client_id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      platform TEXT NOT NULL,
      registered_at INTEGER NOT NULL
    )`);
    raw
      .prepare(
        "INSERT INTO push_registrations (client_id, token, platform, registered_at) VALUES (?, ?, ?, ?)"
      )
      .run("old-client", "keep-token", "android", 1);
    raw.close();
    const before = fs.readFileSync(databasePath);

    expect(() => createPushService({ databasePath, metrics: createPushMetrics() })).toThrow(
      /schema version 0 predates production baseline 1/
    );
    expect(fs.readFileSync(databasePath)).toEqual(before);
    const unchanged = new DatabaseSync(databasePath);
    expect(unchanged.prepare("SELECT * FROM push_registrations").all()).toEqual([
      {
        client_id: "old-client",
        token: "keep-token",
        platform: "android",
        registered_at: 1,
      },
    ]);
    unchanged.close();
  });

  it("rejects altered push constraints without rewriting the schema", () => {
    const databasePath = tempDatabasePath();
    const raw = new DatabaseSync(databasePath);
    raw.exec(`
      CREATE TABLE push_registrations (
        user_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        platform TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        PRIMARY KEY (user_id, client_id)
      );
      CREATE INDEX push_registrations_by_user ON push_registrations(user_id);
      PRAGMA user_version = 1;
    `);
    raw.close();
    const before = fs.readFileSync(databasePath);

    expect(() => createPushService({ databasePath, metrics: createPushMetrics() })).toThrow(
      /table:push_registrations definition is not canonical/
    );
    expect(fs.readFileSync(databasePath)).toEqual(before);
  });

  it("builds iOS cancel as a silent background push", () => {
    const message = buildFirebaseMessage(
      {
        clientId: "ios-1",
        platform: "ios",
        token: "token-2",
        userId: PUSH_USER_ID,
        registeredAt: 1,
      },
      {
        title: "",
        data: {
          kind: "approval-cancel",
          approvalId: "approval-1",
          cancelKey: "approval-1",
        },
      }
    );

    expect(message).toMatchObject({
      token: "token-2",
      data: {
        kind: "approval-cancel",
        approvalId: "approval-1",
        cancelKey: "approval-1",
      },
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
    });
    expect(message).not.toHaveProperty("notification");
  });
});
