import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GovernanceLog } from "./governanceLog.js";
import type { ApprovalProvenanceRecord, MembershipGovernanceRecord } from "./types.js";

function atLocalNoon(dayOffset = 0): number {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.getTime();
}

function approvalRecord(
  overrides: Partial<ApprovalProvenanceRecord> = {}
): ApprovalProvenanceRecord {
  return {
    approvalId: "approval-1",
    approvalKind: "capability",
    decision: "version",
    granted: true,
    workspaceId: "ws_1",
    resolvedAt: atLocalNoon(),
    resolvedBy: { userId: "usr_alice", handle: "alice" },
    resolvedVia: "shell",
    requestedBy: { callerId: "panel-1", callerKind: "panel", userId: "usr_bob" },
    ...overrides,
  };
}

function membershipRecord(
  overrides: Partial<MembershipGovernanceRecord> = {}
): MembershipGovernanceRecord {
  return {
    kind: "membership",
    op: "add-member",
    actor: { userId: "usr_root", handle: "root" },
    target: { userId: "usr_dave", handle: "dave" },
    workspaceId: "ws_1",
    at: atLocalNoon(),
    ...overrides,
  };
}

describe("GovernanceLog", () => {
  let dir: string;
  let databasePath: string;
  let log: GovernanceLog;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "governance-log-"));
    databasePath = path.join(dir, "governance.db");
    log = new GovernanceLog({ databasePath });
  });

  afterEach(async () => {
    await log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends and reads back approval + membership records as one stream", async () => {
    await log.append(approvalRecord());
    await log.append(membershipRecord());

    const records = await log.query();
    expect(records).toHaveLength(2);
    expect(records.map((r) => ("kind" in r ? r.kind : r.approvalKind))).toContain("membership");
    expect(records.map((r) => ("kind" in r ? r.kind : r.approvalKind))).toContain("capability");
  });

  it("returns records newest-first", async () => {
    await log.append(approvalRecord({ approvalId: "older", resolvedAt: atLocalNoon() - 2000 }));
    await log.append(approvalRecord({ approvalId: "newer", resolvedAt: atLocalNoon() - 1000 }));

    const records = await log.query();
    expect((records[0] as ApprovalProvenanceRecord).approvalId).toBe("newer");
    expect((records[1] as ApprovalProvenanceRecord).approvalId).toBe("older");
  });

  it("filters by record kind, acting user, approval kind, membership op, and grant outcome", async () => {
    await log.append(approvalRecord({ approvalId: "granted", granted: true }));
    await log.append(approvalRecord({ approvalId: "denied", granted: false, decision: "deny" }));
    await log.append(membershipRecord({ op: "revoke-user" }));

    expect(await log.query({ filter: { recordKind: "membership" } })).toHaveLength(1);
    expect(await log.query({ filter: { recordKind: "approval" } })).toHaveLength(2);
    expect(await log.query({ filter: { op: "revoke-user" } })).toHaveLength(1);
    expect(await log.query({ filter: { granted: false } })).toHaveLength(1);
    expect(await log.query({ filter: { userId: "usr_root" } })).toHaveLength(1); // membership actor
    expect(await log.query({ filter: { userId: "usr_alice" } })).toHaveLength(2); // approval resolver
    expect(await log.query({ filter: { approvalKind: "userland" } })).toHaveLength(0);
  });

  it("honors the after bound and limit", async () => {
    await log.append(approvalRecord({ approvalId: "a", resolvedAt: atLocalNoon() - 3000 }));
    await log.append(approvalRecord({ approvalId: "b", resolvedAt: atLocalNoon() - 1000 }));

    expect(await log.query({ after: atLocalNoon() - 2000 })).toHaveLength(1);
    expect(await log.query({ limit: 1 })).toHaveLength(1);
  });

  it("returns an empty list when nothing has been written", async () => {
    expect(await log.query()).toEqual([]);
  });

  it("deduplicates a lost-response approval retry and rejects conflicting replays", async () => {
    const first = approvalRecord({ approvalId: "stable", resolvedAt: atLocalNoon() });
    await log.append(first);
    await log.append({ ...first, resolvedAt: first.resolvedAt + 1 });
    expect(await log.query()).toHaveLength(1);

    await expect(
      log.append({ ...first, decision: "deny", granted: false, resolvedAt: first.resolvedAt + 2 })
    ).rejects.toThrow(/Conflicting governance replay/);
    expect(await log.query()).toEqual([first]);
  });

  it("rolls back the whole batch when one approval conflicts", async () => {
    await log.append(approvalRecord());
    await expect(
      log.appendMany([
        membershipRecord({ target: { userId: "usr_rollback" } }),
        approvalRecord({ decision: "deny", granted: false }),
      ])
    ).rejects.toThrow(/Conflicting governance replay/);
    expect(await log.query({ filter: { recordKind: "membership" } })).toEqual([]);
  });

  it("recovers a transaction interrupted before commit on restart", async () => {
    const first = approvalRecord();
    await log.append(first);
    await log.close();

    const interrupted = new DatabaseSync(databasePath);
    interrupted.exec("BEGIN IMMEDIATE");
    interrupted.exec("DELETE FROM governance_records");
    interrupted.close();

    log = new GovernanceLog({ databasePath });
    expect(await log.query()).toEqual([first]);
  });

  it("rejects a structurally corrupt stored payload", async () => {
    await log.append(approvalRecord());
    const raw = new DatabaseSync(databasePath);
    raw
      .prepare("UPDATE governance_records SET payload = ?")
      .run(JSON.stringify({ approvalId: "unsupported" }));
    raw.close();
    await expect(log.query()).rejects.toThrow(/Unsupported governance record/);
  });

  it("finds an old revocation without a bounded timeline scan", async () => {
    await log.append(membershipRecord({ op: "revoke-user", target: { userId: "usr_old" } }));
    for (let index = 0; index < 600; index++) {
      await log.append(
        membershipRecord({
          target: { userId: `usr_${index}` },
          at: atLocalNoon() + index + 1,
        })
      );
    }
    await expect(log.hasMembershipOperation("revoke-user", "usr_old")).resolves.toBe(true);
  });
});
