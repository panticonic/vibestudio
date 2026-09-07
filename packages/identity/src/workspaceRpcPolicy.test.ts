import { describe, expect, it } from "vitest";
import {
  closedWorkspaceRpcPolicy,
  evaluateWorkspaceRpcBoundary,
  WorkspaceRpcPolicySchema,
} from "./workspaceRpcPolicy.js";

describe("hard cross-workspace RPC policy", () => {
  const base = {
    sourceWorkspaceId: "project",
    destinationWorkspaceId: "personal",
    initiatingUserId: "alice",
    target: "main",
    operation: "calendar.list",
    purpose: "call" as const,
    exported: true,
    sourcePolicy: {
      incoming: [],
      outgoing: [
        {
          workspaceId: "personal",
          userId: "alice",
          target: "main",
    operation: "calendar.list",
          purpose: "call" as const,
        },
      ],
    },
    destinationPolicy: {
      incoming: [
        {
          workspaceId: "project",
          userId: "alice",
          target: "main",
    operation: "calendar.list",
          purpose: "call" as const,
        },
      ],
      outgoing: [],
    },
  };

  it("requires both exact scopes and deliberate export", () => {
    expect(evaluateWorkspaceRpcBoundary(base)).toEqual({ allowed: true });
    expect(
      evaluateWorkspaceRpcBoundary({ ...base, sourcePolicy: closedWorkspaceRpcPolicy() })
    ).toEqual({ allowed: false, reason: "outgoing-blocked" });
    expect(
      evaluateWorkspaceRpcBoundary({ ...base, destinationPolicy: closedWorkspaceRpcPolicy() })
    ).toEqual({ allowed: false, reason: "incoming-blocked" });
    expect(evaluateWorkspaceRpcBoundary({ ...base, exported: false })).toEqual({
      allowed: false,
      reason: "not-exported",
    });
  });

  it("cannot use an open boundary for another account, operation, workspace or discovery", () => {
    for (const change of [
      { initiatingUserId: "bob" },
      { operation: "calendar.delete" },
      { target: "do:workers/calendar:Calendar:other" },
      { destinationWorkspaceId: "other" },
      { sourceWorkspaceId: "other" },
      { purpose: "discover" as const },
    ])
      expect(evaluateWorkspaceRpcBoundary({ ...base, ...change }).allowed).toBe(false);
  });

  it("keeps System ingress closed even with matching mutable policy", () => {
    expect(evaluateWorkspaceRpcBoundary({ ...base, destinationRole: "system" })).toEqual({
      allowed: false,
      reason: "system-ingress",
    });
  });

  it("leaves local RPC to its existing authority checks", () => {
    expect(
      evaluateWorkspaceRpcBoundary({
        ...base,
        destinationWorkspaceId: "project",
        destinationRole: "system",
        exported: false,
      })
    ).toEqual({ allowed: true });
  });

  it("rejects wildcards, malformed scopes and ambiguous duplicate policy", () => {
    expect(() =>
      WorkspaceRpcPolicySchema.parse({
        ...base.sourcePolicy,
        outgoing: [...base.sourcePolicy.outgoing, ...base.sourcePolicy.outgoing],
      })
    ).toThrow(/Duplicate/);
    for (const value of ["*", "alice\n", " alice", ""]) {
      expect(() =>
        WorkspaceRpcPolicySchema.parse({
          incoming: [],
          outgoing: [{ ...base.sourcePolicy.outgoing[0], userId: value }],
        })
      ).toThrow();
    }
    expect(WorkspaceRpcPolicySchema.parse(closedWorkspaceRpcPolicy())).toEqual({
      incoming: [],
      outgoing: [],
    });
  });

  it("canonicalizes scope order for compare-and-set replacement", () => {
    const first = base.sourcePolicy.outgoing[0]!;
    const second = { ...first, operation: "calendar.delete" };
    expect(
      WorkspaceRpcPolicySchema.parse({ incoming: [], outgoing: [first, second] }).outgoing
    ).toEqual([second, first]);
    expect(
      WorkspaceRpcPolicySchema.parse({ incoming: [], outgoing: [second, first] }).outgoing
    ).toEqual([second, first]);
  });
});
