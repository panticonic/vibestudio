import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import type { AuthorityAcquisitionAdmission } from "./authorityAcquisitionStore.js";

const fixtures: Array<{ statePath: string; grants: CapabilityGrantStore; closed: boolean }> = [];
function fixture() {
  const statePath = mkdtempSync(join(tmpdir(), "authority-acquisition-store-"));
  const f = { statePath, grants: new CapabilityGrantStore({ statePath }), closed: false };
  fixtures.push(f);
  return f;
}
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    if (!f.closed) f.grants.close();
    rmSync(f.statePath, { recursive: true });
  }
});
function reopen(f: ReturnType<typeof fixture>) {
  f.grants.close();
  f.grants = new CapabilityGrantStore({ statePath: f.statePath });
}
const admission: AuthorityAcquisitionAdmission = {
  requestKey: "owner/session/request",
  ownerRuntimeId: "do:workers/agent:Agent:one",
  sessionId: "session-one",
  facts: {
    contextId: "context-one",
    sourceDigest: "source-one",
    capability: "model.use",
    resource: "credential-one",
  },
};
const grant = {
  effect: "allow" as const,
  subject: "session:session-one" as const,
  capability: "model.use",
  resource: { kind: "exact" as const, key: "credential-one" },
  issuedBy: "user:alice",
  provenance: "acquisition" as const,
};

describe("AuthorityAcquisitionStore in the grant owner", () => {
  it("retains exact operation withdrawal across reopen without retiring its session", () => {
    const f = fixture();
    const record = f.grants.acquisitions.admit(admission, 1);
    const sibling = f.grants.acquisitions.admit({ ...admission, requestKey: "sibling" }, 2);
    for (const owner of [
      { ...admission, ownerRuntimeId: "foreign" },
      { ...admission, sessionId: "foreign" },
    ])
      expect(() =>
        f.grants.acquisitions.withdraw(record.acquisitionId, owner, record.bindingDigest)
      ).toThrow("Acquisition is not owned by this task");
    expect(() =>
      f.grants.acquisitions.withdraw(record.acquisitionId, admission, "foreign")
    ).toThrow(/binding mismatch/);
    expect(f.grants.acquisitions.get(record.acquisitionId, admission)).toEqual(record);
    const closed = f.grants.acquisitions.withdraw(
      record.acquisitionId,
      admission,
      record.bindingDigest,
      3
    );
    expect(closed).toMatchObject({
      state: "closed",
      settledAt: 3,
      resolution: { state: "closed", value: { reason: "operation-ended" } },
    });
    reopen(f);
    expect(
      f.grants.acquisitions.withdraw(record.acquisitionId, admission, record.bindingDigest, 4)
    ).toEqual(closed);
    expect(f.grants.acquisitions.get(sibling.acquisitionId, admission)).toEqual(sibling);
    expect(f.grants.acquisitions.admit({ ...admission, requestKey: "later" }).state).toBe(
      "pending"
    );
  });

  it("preserves a decision which commits before exact withdrawal", () => {
    const f = fixture();
    const record = f.grants.acquisitions.admit(admission);
    const terminal = f.grants.acquisitions.resolve(
      record.acquisitionId,
      admission,
      record.bindingDigest,
      "once",
      () => ({ state: "decided", value: { decision: "once" } })
    );
    expect(
      f.grants.acquisitions.withdraw(record.acquisitionId, admission, record.bindingDigest)
    ).toEqual(terminal);
  });

  it("retains pending admission across close/reopen, with exact immutable facts", () => {
    const f = fixture();
    const input = structuredClone(admission);
    const accepted = f.grants.acquisitions.admit(input, 1);
    (input.facts as { contextId: string }).contextId = "mutated-caller-copy";
    reopen(f);
    expect(f.grants.acquisitions.get(accepted.acquisitionId, accepted.admission)).toEqual(accepted);
    expect(f.grants.acquisitions.admit(accepted.admission)).toEqual(accepted);
    expect(() => f.grants.acquisitions.admit(input)).toThrow(/immutable admission facts/);
    expect(f.grants.acquisitions.outstanding(accepted.admission)).toEqual([accepted]);
  });

  it("refuses stale binding and non-JSON admission before mutating authority", () => {
    const f = fixture();
    const accepted = f.grants.acquisitions.admit(admission);
    const write = vi.fn(() => ({ state: "decided" as const, value: "once" }));
    expect(() =>
      f.grants.acquisitions.resolve(
        accepted.acquisitionId,
        admission,
        "foreign-binding",
        "once",
        write
      )
    ).toThrow(/binding mismatch/);
    expect(write).not.toHaveBeenCalled();
    const nonJson = new Map([
      ["context", "foreign"],
    ]) as unknown as AuthorityAcquisitionAdmission["facts"];
    expect(() =>
      f.grants.acquisitions.admit({ ...admission, requestKey: "non-json", facts: nonJson })
    ).toThrow();
    expect(f.grants.acquisitions.current("non-json", admission)).toBeNull();
    expect(f.grants.acquisitions.outstanding(admission)).toEqual([accepted]);
  });

  it("keeps both the original failure and rollback failure when its owner is destroyed", () => {
    const f = fixture();
    const accepted = f.grants.acquisitions.admit(admission);
    const original = new Error("authority write failed during owner destruction");
    let failure: unknown;
    try {
      f.grants.acquisitions.resolve(
        accepted.acquisitionId,
        admission,
        accepted.bindingDigest,
        "once",
        () => {
          f.grants.close();
          f.closed = true;
          throw original;
        }
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(original);
    expect((failure as AggregateError).errors[0]).toBe(original);
    expect((failure as AggregateError).errors[1]).toBeInstanceOf(Error);
  });

  it("commits the grants and terminal decision once in the same database transaction", () => {
    const f = fixture();
    const accepted = f.grants.acquisitions.admit(admission);
    const write = vi.fn(() => {
      const issued = f.grants.issue(grant);
      return { state: "decided" as const, value: { decision: "once", grantId: issued.id! } };
    });
    const completed = f.grants.acquisitions.resolve(
      accepted.acquisitionId,
      admission,
      accepted.bindingDigest,
      { decision: "once" },
      write,
      10
    );
    reopen(f);
    expect(
      f.grants.acquisitions.resolve(
        accepted.acquisitionId,
        admission,
        accepted.bindingDigest,
        { decision: "once" },
        write,
        20
      )
    ).toEqual(completed);
    expect(write).toHaveBeenCalledOnce();
    expect(f.grants.listAuthorityGrants()).toHaveLength(1);
    expect(() =>
      f.grants.acquisitions.resolve(
        accepted.acquisitionId,
        admission,
        accepted.bindingDigest,
        { decision: "deny" },
        write
      )
    ).toThrow(/different decision/);
    expect(write).toHaveBeenCalledOnce();
  });

  it("rolls back all grants when a later facet or outcome persistence fails", () => {
    const f = fixture();
    const accepted = f.grants.acquisitions.admit(admission);
    const error = new Error("second authority facet retired");
    expect(() =>
      f.grants.acquisitions.resolve(
        accepted.acquisitionId,
        admission,
        accepted.bindingDigest,
        { decision: "once" },
        () => {
          f.grants.issue(grant);
          throw error;
        }
      )
    ).toThrow(error);
    expect(f.grants.listAuthorityGrants()).toEqual([]);
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql.exec(`CREATE TRIGGER reject_acquisition_result BEFORE UPDATE ON authority_acquisitions
        BEGIN SELECT RAISE(ABORT, 'injected outcome write failure'); END`);
      expect(() =>
        f.grants.acquisitions.resolve(
          accepted.acquisitionId,
          admission,
          accepted.bindingDigest,
          { decision: "once" },
          () => {
            f.grants.issue(grant);
            return { state: "decided", value: { decision: "once" } };
          }
        )
      ).toThrow(/injected outcome write failure/);
    } finally {
      sql.exec("DROP TRIGGER reject_acquisition_result");
      sql.close();
    }
    reopen(f);
    expect(f.grants.listAuthorityGrants()).toEqual([]);
    expect(f.grants.acquisitions.get(accepted.acquisitionId, admission)).toEqual(accepted);
  });

  it("retains lost acknowledgement indefinitely, and acknowledges only the exact owned receipt", () => {
    const f = fixture();
    const accepted = f.grants.acquisitions.admit(admission, 1);
    const completed = f.grants.acquisitions.resolve(
      accepted.acquisitionId,
      admission,
      accepted.bindingDigest,
      "deny",
      () => ({ state: "decided", value: "deny" }),
      2
    );
    reopen(f);
    expect(f.grants.acquisitions.outstanding(admission)).toEqual([completed]);
    for (const foreign of [
      { ...admission, sessionId: "other" },
      { ...admission, ownerRuntimeId: "other" },
    ]) {
      expect(() => f.grants.acquisitions.get(accepted.acquisitionId, foreign)).toThrow(/not owned/);
      expect(() =>
        f.grants.acquisitions.acknowledge(
          accepted.acquisitionId,
          foreign,
          completed.resolutionDigest!
        )
      ).toThrow(/not owned/);
    }
    expect(() =>
      f.grants.acquisitions.acknowledge(accepted.acquisitionId, admission, "wrong")
    ).toThrow(/terminal receipt/);
    f.grants.acquisitions.acknowledge(
      accepted.acquisitionId,
      admission,
      completed.resolutionDigest!,
      100
    );
    f.grants.acquisitions.acknowledge(
      accepted.acquisitionId,
      admission,
      completed.resolutionDigest!,
      200
    );
    reopen(f);
    expect(f.grants.acquisitions.outstanding(admission)).toEqual([]);
    expect(f.grants.acquisitions.get(accepted.acquisitionId, admission)).toEqual({
      ...completed,
      acknowledgedAt: 100,
    });
  });

  it("starts a new explicit acquisition cycle without reopening or forgetting the old identity", () => {
    const f = fixture();
    const first = f.grants.acquisitions.admit(admission, 1);
    expect(f.grants.acquisitions.supersede(admission.requestKey, admission)).toBe(false);
    expect(() =>
      f.grants.acquisitions.acknowledge(first.acquisitionId, admission, "pending")
    ).toThrow(/terminal receipt/);
    const completed = f.grants.acquisitions.resolve(
      first.acquisitionId,
      admission,
      first.bindingDigest,
      "once",
      () => ({ state: "decided", value: "once" }),
      2
    );
    expect(f.grants.acquisitions.supersede(admission.requestKey, admission, 3)).toBe(true);
    const second = f.grants.acquisitions.admit(admission, 4);
    expect(second.acquisitionId).not.toBe(first.acquisitionId);
    expect(second.bindingDigest).not.toBe(first.bindingDigest);
    expect(f.grants.acquisitions.current(admission.requestKey, admission)).toEqual(second);
    expect(f.grants.acquisitions.get(first.acquisitionId, admission)).toEqual({
      ...completed,
      supersededAt: 3,
    });
    expect(f.grants.acquisitions.outstanding(admission)).toHaveLength(2);
  });

  it("authoritative owner retirement closes pending asks and fences late and new admissions", () => {
    const f = fixture();
    const accepted = f.grants.acquisitions.admit(admission, 1);
    f.grants.acquisitions.retire(admission, 2);
    reopen(f);
    f.grants.acquisitions.retire(admission, 3);
    const closed = f.grants.acquisitions.get(accepted.acquisitionId, admission);
    expect(closed).toMatchObject({
      state: "closed",
      settledAt: 2,
      resolution: { state: "closed", value: { reason: "owner-retired" } },
    });
    expect(f.grants.acquisitions.outstanding(admission)).toEqual([]);
    expect(() => f.grants.acquisitions.admit(admission)).toThrow(/retired/);
    expect(() => f.grants.acquisitions.admit({ ...admission, requestKey: "new" })).toThrow(
      /retired/
    );
    const write = vi.fn(() => ({ state: "decided" as const, value: "once" }));
    expect(() =>
      f.grants.acquisitions.resolve(
        accepted.acquisitionId,
        admission,
        accepted.bindingDigest,
        "once",
        write
      )
    ).toThrow(/retired/);
    expect(write).not.toHaveBeenCalled();
    f.grants.acquisitions.acknowledge(accepted.acquisitionId, admission, closed!.resolutionDigest!);
  });

  it("verifies retained admission and terminal content before returning it", () => {
    const f = fixture();
    const accepted = f.grants.acquisitions.admit(admission);
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql
        .prepare("UPDATE authority_acquisitions SET binding_json = ? WHERE acquisition_id = ?")
        .run(
          JSON.stringify({ ...admission, facts: { contextId: "foreign" } }),
          accepted.acquisitionId
        );
      expect(() => f.grants.acquisitions.get(accepted.acquisitionId, admission)).toThrow(
        /content verification/
      );
      sql
        .prepare("UPDATE authority_acquisitions SET binding_json = ? WHERE acquisition_id = ?")
        .run(JSON.stringify(admission), accepted.acquisitionId);
      f.grants.acquisitions.resolve(
        accepted.acquisitionId,
        admission,
        accepted.bindingDigest,
        "deny",
        () => ({ state: "decided", value: "deny" })
      );
      sql
        .prepare("UPDATE authority_acquisitions SET resolution_json = ? WHERE acquisition_id = ?")
        .run(JSON.stringify({ state: "decided", value: "once" }), accepted.acquisitionId);
      expect(() => f.grants.acquisitions.get(accepted.acquisitionId, admission)).toThrow(
        /content verification/
      );
    } finally {
      sql.close();
    }
  });

  it("bounds outstanding scans with stable continuation and preserves acknowledged identities", () => {
    const f = fixture();
    for (let i = 0; i < 70; i++)
      f.grants.acquisitions.admit({ ...admission, requestKey: `request-${i}` }, 1);
    const first = f.grants.acquisitions.outstanding(admission);
    expect(first).toHaveLength(64);
    const last = first.at(-1)!;
    const second = f.grants.acquisitions.outstanding(admission, {
      after: { createdAt: last.createdAt, acquisitionId: last.acquisitionId },
    });
    expect(second).toHaveLength(6);
    expect(new Set([...first, ...second].map((r) => r.acquisitionId)).size).toBe(70);
    expect(() => f.grants.acquisitions.outstanding(admission, { limit: 0 })).toThrow(/page limit/);
    expect(() => f.grants.acquisitions.outstanding(admission, { limit: 10000 })).toThrow(
      /page limit/
    );
  });

  it("preserves grants, acquisition receipts and consent lineage through current-schema reopen", () => {
    const f = fixture();
    const issued = f.grants.issue(grant);
    const pending = f.grants.acquisitions.admit(admission);
    reopen(f);
    expect(f.grants.acquisitions.get(pending.acquisitionId, admission)).toEqual(pending);
    expect(f.grants.listAuthorityGrants()).toEqual([issued]);
    const lineage = [
      "none",
      "source:web:https://outside.example",
      "source:email:person@example.com",
    ];
    const consent = f.grants.issue({ ...grant, constraints: { lineageAtConsent: lineage } });
    reopen(f);
    expect(f.grants.listAuthorityGrants().find((value) => value.id === consent.id)).toEqual(
      consent
    );
    expect(() =>
      f.grants.issue({ ...grant, constraints: { lineageAtConsent: [1] as unknown as string[] } })
    ).toThrow(/array of source identities/);
    const corrupt = new DatabaseSync(f.grants.databasePath);
    try {
      corrupt
        .prepare("UPDATE authority_grants SET lineage_at_consent = ? WHERE id = ?")
        .run("[1]", consent.id!);
    } finally {
      corrupt.close();
    }
    expect(() => f.grants.listAuthorityGrants()).toThrow(/Stored consent lineage is invalid/);
  });

  it("round-trips every authority constraint through the canonical grant database", () => {
    const f = fixture();
    const subject = f.grants.ensureWebsiteSubject({
      userId: "user:alice",
      workspaceId: "workspace-one",
      origin: "https://example.com",
    });
    const constraints = {
      requestingCodePrincipal: `code:workers/test@${"a".repeat(64)}` as const,
      subjectGeneration: subject.generation,
      documentId: "document-one",
      sourceWorkspaceId: "workspace-one",
      sessionId: "session-one",
      invocationDigest: "b".repeat(64),
      providerExecutionDigest: "c".repeat(64),
      missionSubject: `mission:one@${"d".repeat(64)}` as const,
      lineageAtConsent: ["none", "source:web:https://outside.example"],
      taskRef: "chat-one",
      taskAuthority: "task:closure-one",
      agentBindingId: "agent-binding-one",
    } satisfies Required<import("@vibestudio/rpc").AuthorityGrantConstraints>;
    const issued = f.grants.issue({
      ...grant,
      subject: subject.subject,
      constraints,
      scope: "once",
    });
    reopen(f);
    expect(f.grants.listAuthorityGrants()).toEqual([issued]);
  });

  it("retires all known owners of a session atomically, retaining unrelated session work", () => {
    const f = fixture();
    const first = f.grants.acquisitions.admit(admission);
    const other = { ...admission, ownerRuntimeId: "owner-two", requestKey: "owner-two/request" };
    const second = f.grants.acquisitions.admit(other);
    const unrelated = {
      ...admission,
      sessionId: "another-session",
      requestKey: "another-session/request",
    };
    const third = f.grants.acquisitions.admit(unrelated);
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql.exec(
        "CREATE TRIGGER reject_second_retirement BEFORE UPDATE ON authority_acquisitions WHEN NEW.owner_runtime_id = 'owner-two' BEGIN SELECT RAISE(ABORT, 'second retirement failed'); END"
      );
      expect(() => f.grants.acquisitions.retireSession(admission.sessionId)).toThrow(
        /second retirement failed/
      );
      expect(f.grants.acquisitions.get(first.acquisitionId, admission)).toEqual(first);
      expect(f.grants.acquisitions.get(second.acquisitionId, other)).toEqual(second);
      expect(f.grants.acquisitions.admit(admission)).toEqual(first);
    } finally {
      sql.exec("DROP TRIGGER reject_second_retirement");
      sql.close();
    }
    f.grants.acquisitions.retireSession(admission.sessionId);
    reopen(f);
    expect(f.grants.acquisitions.get(first.acquisitionId, admission)?.state).toBe("closed");
    expect(f.grants.acquisitions.get(second.acquisitionId, other)?.state).toBe("closed");
    expect(() => f.grants.acquisitions.admit(admission)).toThrow(/absent or retired/);
    expect(() => f.grants.acquisitions.admit(other)).toThrow(/absent or retired/);
    expect(f.grants.acquisitions.admit(unrelated)).toEqual(third);
  });

  it("pages only terminal unacknowledged delivery across owners, including superseded receipts", () => {
    const f = fixture();
    const completed = [];
    for (let index = 0; index < 70; index++) {
      const owner = {
        ...admission,
        ownerRuntimeId: `owner-${index % 3}`,
        sessionId: `session-${index % 5}`,
        requestKey: `request-${index}`,
      };
      const pending = f.grants.acquisitions.admit(owner, 1);
      completed.push(
        f.grants.acquisitions.resolve(
          pending.acquisitionId,
          owner,
          pending.bindingDigest,
          "deny",
          () => ({ state: "decided", value: "deny" }),
          2
        )
      );
    }
    const old = completed[0]!;
    f.grants.acquisitions.supersede(old.admission.requestKey, old.admission);
    const pending = f.grants.acquisitions.admit({ ...admission, requestKey: "only-pending" });
    const acknowledged = completed[1]!;
    f.grants.acquisitions.acknowledge(
      acknowledged.acquisitionId,
      acknowledged.admission,
      acknowledged.resolutionDigest!
    );
    const retired = completed[2]!;
    f.grants.acquisitions.retire(retired.admission);
    reopen(f);
    const first = f.grants.acquisitions.scanOutstandingTerminal();
    expect(first).toHaveLength(64);
    const last = first.at(-1)!;
    const second = f.grants.acquisitions.scanOutstandingTerminal({
      ...last.admission,
      createdAt: last.createdAt,
      acquisitionId: last.acquisitionId,
    });
    const ids = [...first, ...second].map((record) => record.acquisitionId);
    const expected = completed.filter(
      (record) =>
        record.acquisitionId !== acknowledged.acquisitionId &&
        (record.admission.ownerRuntimeId !== retired.admission.ownerRuntimeId ||
          record.admission.sessionId !== retired.admission.sessionId)
    );
    expect(new Set(ids)).toEqual(new Set(expected.map((record) => record.acquisitionId)));
    expect(ids).not.toContain(pending.acquisitionId);
    expect(ids).toContain(old.acquisitionId);
    expect(ids).toHaveLength(new Set(ids).size);
    expect(() =>
      f.grants.acquisitions.scanOutstandingTerminal({
        ...admission,
        createdAt: NaN,
        acquisitionId: "foreign",
      })
    ).toThrow("delivery cursor");
  });

  it("retires indexed runtime sessions and bounded pending pages atomically without changing other runtimes", () => {
    const f = fixture();
    const records = [];
    for (let index = 0; index < 70; index++) {
      const owner = {
        ...admission,
        sessionId: `session-${String(index).padStart(3, "0")}`,
        requestKey: `request-${index}`,
      };
      records.push(f.grants.acquisitions.admit(owner));
    }
    const crowdedOwner = records[0]!.admission;
    for (let index = 0; index < 70; index++)
      records.push(
        f.grants.acquisitions.admit({ ...crowdedOwner, requestKey: `crowded-${index}` })
      );
    const other = f.grants.acquisitions.admit({
      ...admission,
      ownerRuntimeId: "unrelated-runtime",
      requestKey: "unrelated-request",
    });
    const sql = new DatabaseSync(f.grants.databasePath);
    try {
      sql.exec(
        "CREATE TRIGGER reject_runtime_retirement BEFORE UPDATE ON authority_acquisitions WHEN NEW.session_id = 'session-069' BEGIN SELECT RAISE(ABORT, 'last runtime session failed'); END"
      );
      expect(() => f.grants.acquisitions.retireRuntime(admission.ownerRuntimeId, 10)).toThrow(
        "last runtime session failed"
      );
      for (const record of records)
        expect(f.grants.acquisitions.get(record.acquisitionId, record.admission)).toEqual(record);
    } finally {
      sql.exec("DROP TRIGGER reject_runtime_retirement");
      sql.close();
    }
    f.grants.acquisitions.retireRuntime(admission.ownerRuntimeId, 11);
    reopen(f);
    f.grants.acquisitions.retireRuntime(admission.ownerRuntimeId, 12);
    for (const record of records) {
      expect(f.grants.acquisitions.get(record.acquisitionId, record.admission)).toMatchObject({
        state: "closed",
        settledAt: 11,
      });
      expect(() => f.grants.acquisitions.admit(record.admission)).toThrow("retired");
    }
    expect(f.grants.acquisitions.get(other.acquisitionId, other.admission)).toEqual(other);
  });
});
