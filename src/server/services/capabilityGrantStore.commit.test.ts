import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CapabilityGrantStore, type IssueAuthorityGrantInput } from "./capabilityGrantStore.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function fixture() {
  const statePath = mkdtempSync(join(tmpdir(), "authority-commit-effects-"));
  const grants = new CapabilityGrantStore({ statePath });
  const sql = new DatabaseSync(grants.databasePath);
  cleanups.push(() => {
    sql.close();
    grants.close();
    rmSync(statePath, { recursive: true, force: true });
  });
  const input: IssueAuthorityGrantInput = {
    effect: "allow",
    subject: "agent:one",
    capability: "workspace.gateway.access",
    resource: { kind: "origin", origin: "https://example.com" },
    scope: "agent",
    issuedBy: "user:alice",
    provenance: "acquisition",
    createdAt: 1,
    lastUsedAt: 1,
  };
  return { grants, sql, input };
}

describe("authority commit and live effects", () => {
  it.each(["revoke", "subject", "suspend", "reset"] as const)(
    "%s notifies only after the outer commit and drops effects on rollback",
    (operation) => {
      const { grants, sql, input } = fixture();
      const issued = grants.issue(input);
      const observed: unknown[] = [];
      grants.onGrantWithdrawal(() => {
        observed.push(
          sql
            .prepare("SELECT revoked_at, suspended_at FROM authority_grants WHERE id = ?")
            .get(issued.id!)
        );
      });
      const withdraw = () => {
        switch (operation) {
          case "revoke":
            return grants.revoke(issued.id!, 101);
          case "subject":
            return grants.revokeSubject(input.subject, 101);
          case "suspend":
            return grants.suspendIdleAgentGrants(101, 100);
          case "reset":
            return grants.resetAgentAuthority("one", { keepLocks: true }, 101);
        }
      };
      const failure = new Error("decision failed");
      expect(() =>
        grants.transaction(() => {
          withdraw();
          expect(observed).toEqual([]);
          throw failure;
        })
      ).toThrow(failure);
      expect(grants.listAuthorityGrants()).toEqual([issued]);
      expect(observed).toEqual([]);
      grants.transaction(() => {
        withdraw();
        expect(observed).toEqual([]);
      });
      expect(observed).toEqual([
        {
          revoked_at: operation === "suspend" ? null : 101,
          suspended_at: operation === "suspend" ? 101 : null,
        },
      ]);
    }
  );

  it("discards a caught nested rollback while preserving the outer work and its effects", () => {
    const { grants, input } = fixture();
    const first = grants.issue(input);
    const second = grants.issue(input);
    const withdrawn: string[] = [];
    grants.onGrantWithdrawal((grant) => withdrawn.push(grant.id!));
    grants.transaction(() => {
      grants.revoke(first.id!, 10);
      expect(() =>
        grants.transaction(() => {
          grants.revoke(second.id!, 11);
          throw new Error("nested decision refused");
        })
      ).toThrow("nested decision refused");
      expect(withdrawn).toEqual([]);
      expect(grants.listActiveAuthorityGrants(12).map((grant) => grant.id)).toEqual([second.id]);
    });
    expect(withdrawn).toEqual([first.id]);
  });

  it("does not abort subject executions for a rolled-back identity invalidation", () => {
    const { grants, sql, input } = fixture();
    const subject = grants.ensureWebsiteSubject({
      userId: "user:alice",
      workspaceId: "ws",
      origin: "https://example.com",
    });
    const binding = { subject: subject.subject, generation: subject.generation, documentId: "doc" };
    const unregister = grants.registerSubjectExecution(binding);
    const signal = grants.subjectExecutionSignal(binding);
    const issued = grants.issue({
      ...input,
      subject: subject.subject,
      constraints: {
        subjectGeneration: subject.generation,
        documentId: "doc",
        sourceWorkspaceId: "ws",
      },
    });
    const generations: unknown[] = [];
    signal.addEventListener("abort", () =>
      generations.push(
        sql
          .prepare("SELECT generation FROM authority_subjects WHERE subject = ?")
          .get(subject.subject)?.["generation"]
      )
    );
    expect(() =>
      grants.transaction(() => {
        grants.invalidateAuthoritySubject(subject.subject, 10);
        expect(signal.aborted).toBe(false);
        throw new Error("receipt refused");
      })
    ).toThrow("receipt refused");
    expect(signal.aborted).toBe(false);
    expect(grants.isSubjectExecutionCurrent(binding)).toBe(true);
    expect(grants.listAuthorityGrants()).toEqual([issued]);
    grants.transaction(() => {
      grants.invalidateAuthoritySubject(subject.subject, 11);
      expect(signal.aborted).toBe(false);
    });
    expect(generations).toEqual([1]);
    expect(signal.aborted).toBe(true);
    unregister();
  });

  it("drops live effects when SQLite rejects COMMIT itself", () => {
    const { grants, sql, input } = fixture();
    const issued = grants.issue(input);
    sql.exec(`CREATE TABLE commit_dependency (
      grant_id TEXT REFERENCES authority_grants(id) DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER reject_commit AFTER UPDATE OF revoked_at ON authority_grants
    BEGIN INSERT INTO commit_dependency VALUES ('absent'); END;`);
    const withdrawn: string[] = [];
    grants.onGrantWithdrawal((grant) => withdrawn.push(grant.id!));
    expect(() => grants.revoke(issued.id!, 10)).toThrow(/FOREIGN KEY/);
    expect(grants.listAuthorityGrants()).toEqual([issued]);
    expect(withdrawn).toEqual([]);
    expect(sql.prepare("SELECT * FROM commit_dependency").all()).toEqual([]);
    sql.exec("DROP TRIGGER reject_commit");
    expect(grants.revoke(issued.id!, 11)).toBe(true);
    expect(withdrawn).toEqual([issued.id]);
  });

  it("runs every committed effect and propagates listener failures without attempting SQL rollback", () => {
    const { grants, input } = fixture();
    const first = grants.issue(input);
    const second = grants.issue(input);
    const failure = new Error("live retirement failed");
    const observed: string[] = [];
    grants.onGrantWithdrawal(() => {
      throw failure;
    });
    grants.onGrantWithdrawal((grant) => observed.push(grant.id!));
    let thrown: AggregateError | undefined;
    try {
      grants.transaction(() => {
        grants.revoke(first.id!, 10);
        grants.revoke(second.id!, 10);
      });
    } catch (error) {
      thrown = error as AggregateError;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect(thrown!.message).toBe("Authority changes committed, but live effects failed");
    expect(thrown!.errors).toHaveLength(2);
    expect(thrown!.errors[0].cause).toBe(failure);
    expect(observed).toEqual([first.id, second.id]);
    expect(grants.listAuthorityGrants().every((grant) => grant.revokedAt === 10)).toBe(true);
    expect(grants.transaction(() => grants.issue(input)).revokedAt).toBeUndefined();
  });

  it("notifies install rollback after withdrawing new consent and restoring outgoing consent together", () => {
    const { grants, sql, input } = fixture();
    const outgoing = grants.issue(input);
    grants.revoke(outgoing.id!, 10);
    const incoming = grants.issue(input);
    const observed: string[] = [];
    grants.onGrantWithdrawal((grant) => {
      observed.push(grant.id!);
      expect(
        sql.prepare("SELECT revoked_at FROM authority_grants WHERE id = ?").get(outgoing.id!)?.[
          "revoked_at"
        ]
      ).toBeNull();
    });
    grants.rollbackInstallClearance({
      issuedGrantIds: [incoming.id!],
      restoreRevokedGrantIds: [outgoing.id!],
      retiredAt: 10,
      now: 11,
    });
    expect(observed).toEqual([incoming.id]);
    expect(grants.listActiveAuthorityGrants(12).map((grant) => grant.id)).toEqual([outgoing.id]);
  });
});
