import { describe, expect, it } from "vitest";
import { IdentityDb, type ClientPrincipalRow } from "./identityDb.js";

const DEVICE_KEY = "a".repeat(64);

function setup() {
  let clock = 100;
  const db = new IdentityDb({ path: ":memory:", readOnly: false, now: () => clock++ });
  db.insertUser({ id: "usr_a", handle: "a", displayName: "A", role: "member", createdAt: 1 });
  db.upsertDevice({
    deviceId: "dev_1",
    refreshTokenHash: "h",
    transport: { kind: "iroh", deviceKey: DEVICE_KEY },
    userId: "usr_a",
    label: "one",
    createdAt: 2,
  });
  const row = (over: Partial<ClientPrincipalRow> = {}): Omit<ClientPrincipalRow, "revokedAt"> => ({
    principalId: "client:app:desktop:dev_1",
    userId: "usr_a",
    deviceId: "dev_1",
    clientId: "app",
    runtime: "desktop",
    source: "clients/app",
    buildKey: "bk1",
    effectiveVersion: "v1",
    executionDigest: "d".repeat(64),
    authority: { services: [] },
    capabilities: ["x.y"],
    attesterWorkspaceId: "ws_sys",
    attestedAt: 5,
    ...over,
  });
  return { db, row };
}

describe("client principals", () => {
  it("round-trips an attested principal and upserts in place", () => {
    const { db, row } = setup();
    db.upsertClientPrincipal(row());
    expect(db.getClientPrincipal("client:app:desktop:dev_1")).toEqual(row());
    db.revokeClientPrincipals({ principalId: "client:app:desktop:dev_1" }, "t");
    db.upsertClientPrincipal(row({ buildKey: "bk2", capabilities: [] }));
    const got = db.getClientPrincipal("client:app:desktop:dev_1")!;
    expect(got.buildKey).toBe("bk2");
    expect(got.revokedAt).toBeUndefined();
  });

  it("mints and validates credentials, binding the device key", () => {
    const { db, row } = setup();
    db.upsertClientPrincipal(row());
    const { credentialId, token } = db.mintClientCredential({
      principalId: "client:app:desktop:dev_1",
      deviceKey: DEVICE_KEY,
    });
    expect(token.startsWith(`clientcred:${credentialId}:`)).toBe(true);
    expect(db.validateClientCredential(token, DEVICE_KEY)?.credentialId).toBe(credentialId);
    expect(db.validateClientCredential(token)).toBeNull();
    expect(db.validateClientCredential(token, "b".repeat(64))).toBeNull();
    expect(db.validateClientCredential(`${token}x`, DEVICE_KEY)).toBeNull();
    const loopback = db.mintClientCredential({ principalId: "client:app:desktop:dev_1" });
    expect(db.validateClientCredential(loopback.token)).not.toBeNull();
    expect(db.validateClientCredential(loopback.token, DEVICE_KEY)).toBeNull();
  });

  it("lists live principals per attester", () => {
    const { db, row } = setup();
    db.upsertClientPrincipal(row());
    db.upsertClientPrincipal(
      row({ principalId: "client:o:desktop:dev_1", attesterWorkspaceId: "ws_o" })
    );
    expect(db.listClientPrincipals("ws_sys").map((p) => p.principalId)).toEqual([
      "client:app:desktop:dev_1",
    ]);
    db.revokeClientPrincipals({ principalId: "client:app:desktop:dev_1" }, "t");
    expect(db.listClientPrincipals("ws_sys")).toEqual([]);
  });

  it("rejects a mint for an unattested principal", () => {
    const { db } = setup();
    expect(() => db.mintClientCredential({ principalId: "client:nope:desktop:dev_1" })).toThrow();
  });

  it("invalidates credentials when the execution digest changes, and restores nothing on same digest", () => {
    const { db, row } = setup();
    db.upsertClientPrincipal(row());
    const { token } = db.mintClientCredential({ principalId: "client:app:desktop:dev_1" });
    db.upsertClientPrincipal(row({ buildKey: "bk2" }));
    expect(db.validateClientCredential(token)).not.toBeNull();
    db.upsertClientPrincipal(row({ executionDigest: "e".repeat(64) }));
    expect(db.validateClientCredential(token)).toBeNull();
  });

  it("keeps the newest 16 credentials per principal", () => {
    const { db, row } = setup();
    db.upsertClientPrincipal(row());
    const tokens = Array.from(
      { length: 18 },
      () => db.mintClientCredential({ principalId: "client:app:desktop:dev_1" }).token
    );
    expect(db.validateClientCredential(tokens[0]!)).toBeNull();
    expect(db.validateClientCredential(tokens[1]!)).toBeNull();
    expect(db.validateClientCredential(tokens[2]!)).not.toBeNull();
    expect(db.validateClientCredential(tokens[17]!)).not.toBeNull();
  });

  it("revokes by filter and invalidates credentials, returning only newly revoked ids", () => {
    const { db, row } = setup();
    db.upsertClientPrincipal(row());
    db.upsertClientPrincipal(row({ principalId: "client:other:desktop:dev_1", clientId: "other" }));
    const { token } = db.mintClientCredential({ principalId: "client:app:desktop:dev_1" });
    expect(db.revokeClientPrincipals({ clientId: "app", runtime: "desktop" }, "t")).toEqual([
      "client:app:desktop:dev_1",
    ]);
    expect(db.validateClientCredential(token)).toBeNull();
    expect(db.revokeClientPrincipals({ deviceId: "dev_1" }, "t")).toEqual([
      "client:other:desktop:dev_1",
    ]);
    expect(db.revokeClientPrincipals({ attesterWorkspaceId: "ws_sys" }, "t")).toEqual([]);
  });

  it("rejects credentials once the device or user is revoked", () => {
    const { db, row } = setup();
    db.upsertClientPrincipal(row());
    const { token } = db.mintClientCredential({ principalId: "client:app:desktop:dev_1" });
    db.revokeUser("usr_a");
    expect(db.validateClientCredential(token)).toBeNull();
  });

  it("refuses writes from a read-only child", () => {
    const { db, row } = setup();
    expect(db.readOnly).toBe(false);
    expect(() =>
      new IdentityDb({ path: ":memory:", readOnly: true }).upsertClientPrincipal(row())
    ).toThrow();
  });
});
