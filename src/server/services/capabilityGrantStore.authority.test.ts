import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";

function store(label: string): CapabilityGrantStore {
  return new CapabilityGrantStore({
    statePath: mkdtempSync(join(tmpdir(), `authority-grants-${label}-`)),
  });
}

describe("CapabilityGrantStore agent authority", () => {
  it("round-trips the exact task constraint used by authorization", () => {
    const grants = store("task-scope");
    grants.issue({
      effect: "allow",
      capability: "workspace.gateway.access",
      resource: { kind: "origin", origin: "https://example.com" },
      subject: "session:session-one",
      issuedBy: "user:alice",
      provenance: "acquisition",
      constraints: {
        sessionId: "session-one",
        taskRef: "task:one",
        lineageAtConsent: ["none"],
      },
      scope: "task",
    });

    expect(
      grants.grantsForSubjects(["session:session-one"], "workspace.gateway.access")[0]?.constraints
        ?.taskRef
    ).toBe("task:one");
    grants.close();
  });

  it("counts only exact prior interactive approvals for standing-scope eligibility", () => {
    const grants = store("history");
    const base = {
      effect: "allow" as const,
      capability: "workspace.gateway.access",
      resource: { kind: "origin" as const, origin: "https://example.com" },
      subject: "session:task-one" as const,
      issuedBy: "user:alice",
      provenance: "acquisition" as const,
      constraints: {
        sessionId: "task-one",
        agentBindingId: "binding:news",
        lineageAtConsent: ["none"],
      },
    };
    grants.issue({
      ...base,
      scope: "once",
      constraints: { ...base.constraints, invocationDigest: "one" },
    });
    grants.issue({
      ...base,
      scope: "task",
      constraints: { ...base.constraints, taskRef: "task:one" },
    });
    grants.issue({
      ...base,
      resource: { kind: "origin", origin: "https://other.example" },
      scope: "once",
      constraints: { ...base.constraints, invocationDigest: "other" },
    });

    expect(
      grants.priorInteractiveApprovalCount({
        agentBindingId: "binding:news",
        capability: base.capability,
        resource: base.resource,
      })
    ).toBe(2);
    grants.close();
  });

  it("suspends idle standing grants, restores them explicitly, and reports withdrawal", () => {
    const grants = store("hygiene");
    const withdrawn: string[] = [];
    grants.onAgentGrantWithdrawal((grant) => withdrawn.push(grant.id!));
    const standing = grants.issue({
      effect: "allow",
      capability: "workspace.gateway.access",
      resource: { kind: "origin", origin: "https://example.com" },
      subject: "agent:binding:news",
      issuedBy: "user:alice",
      provenance: "acquisition",
      constraints: {
        agentBindingId: "binding:news",
        lineageAtConsent: ["none"],
      },
      scope: "agent",
      createdAt: 1,
      lastUsedAt: 1,
      decidedBy: "user:alice",
      decisionSurface: "card",
    });

    expect(grants.suspendIdleAgentGrants(101, 100)).toBe(1);
    expect(withdrawn).toEqual([standing.id]);
    expect(grants.grantsForSubjects(["agent:binding:news"], standing.capability, 101)).toEqual([]);
    expect(grants.restore(standing.id!)).toBe(true);
    expect(grants.grantsForSubjects(["agent:binding:news"], standing.capability, 101)).toHaveLength(
      1
    );
    grants.close();
  });

  it("lapses idle standing grants during ordinary authorization lookup", () => {
    const grants = store("lookup-hygiene");
    grants.issue({
      effect: "allow",
      capability: "workspace.gateway.access",
      resource: { kind: "origin", origin: "https://example.com" },
      subject: "agent:binding:news",
      issuedBy: "user:alice",
      provenance: "acquisition",
      constraints: {
        agentBindingId: "binding:news",
        lineageAtConsent: ["none"],
      },
      scope: "agent",
      createdAt: 1,
      lastUsedAt: 1,
    });

    expect(
      grants.grantsForSubjects(
        ["agent:binding:news"],
        "workspace.gateway.access",
        90 * 24 * 60 * 60 * 1_000 + 2
      )
    ).toEqual([]);
    grants.close();
  });

  it("applies a cell lock to capabilities added to that reviewed domain later", () => {
    const grants = store("cell-lock");
    const lock = grants.createLock({
      agentBindingId: "binding:news",
      level: "cell",
      domain: "sharing",
      verb: "act",
      decidedBy: "user:alice",
      surface: "profile",
      createdAt: 1,
    });

    const matched = grants.matchingLocks("binding:news", "push.send", "channel:briefings", 10);
    expect(matched).toEqual([
      expect.objectContaining({ id: lock.id, level: "cell", attemptCount: 1, lastAttemptAt: 10 }),
    ]);
    expect(grants.listLocks("binding:news")[0]).toMatchObject({
      id: lock.id,
      attemptCount: 1,
      lastAttemptAt: 10,
    });
    grants.close();
  });
});
