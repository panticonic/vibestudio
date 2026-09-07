import { describe, expect, it, vi } from "vitest";
import { assertWorkspaceRpcAccess } from "./workspaceRpcAccess.js";

function fixture() {
  const scope = {
    userId: "alice",
    target: "do:workers/calendar:Calendar:personal",
    operation: "slots",
    purpose: "call" as const,
  };
  return {
    caller: {
      workspaceId: "project",
      runtime: { kind: "panel" as const, id: "panel-one" },
      subject: { userId: "alice", handle: "alice" },
    },
    destinationWorkspaceId: "personal",
    target: scope.target,
    operation: scope.operation,
    purpose: scope.purpose,
    identity: {
      getPrivateWorkspaceOwner: vi.fn(
        () => null as { userId: string; role: "personal" | "system" } | null
      ),
      getWorkspaceRpcPolicy: vi.fn((workspaceId: string) =>
        workspaceId === "project"
          ? { outgoing: [{ ...scope, workspaceId: "personal" }], incoming: [] }
          : { incoming: [{ ...scope, workspaceId: "project" }], outgoing: [] }
      ),
    },
    membership: { has: vi.fn(() => true) },
  };
}

describe("live cross-workspace RPC access", () => {
  it("requires both exact policy scopes and rechecks membership on each use", () => {
    const input = fixture();
    expect(() => assertWorkspaceRpcAccess(input)).not.toThrow();
    input.membership.has.mockReturnValue(false);
    expect(() => assertWorkspaceRpcAccess(input)).toThrow("Cross-workspace RPC is not permitted");
    input.membership.has.mockReturnValue(true);
    expect(() => assertWorkspaceRpcAccess({ ...input, operation: "events" })).toThrow();
    expect(() =>
      assertWorkspaceRpcAccess({ ...input, target: "do:workers/calendar:Calendar:other" })
    ).toThrow();
    expect(() => assertWorkspaceRpcAccess({ ...input, purpose: "discover" })).toThrow();
  });

  it("refuses System ingress even with matching mutable policy", () => {
    const input = fixture();
    input.identity.getPrivateWorkspaceOwner.mockReturnValue({ userId: "alice", role: "system" });
    expect(() => assertWorkspaceRpcAccess(input)).toThrow();
  });

  it("does not carry host authority across an application boundary or reveal policies to nonmembers", () => {
    const input = fixture();
    expect(() =>
      assertWorkspaceRpcAccess({ ...input, caller: { ...input.caller, hostOriginated: true } })
    ).toThrow();
    input.membership.has.mockReturnValue(false);
    expect(() => assertWorkspaceRpcAccess(input)).toThrow();
    expect(input.identity.getWorkspaceRpcPolicy).not.toHaveBeenCalled();
  });
});
