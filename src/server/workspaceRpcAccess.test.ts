import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CentralDataManager } from "@vibestudio/shared/centralData";
import { IdentityDb } from "@vibestudio/identity/identityDb";
import { MembershipStore } from "@vibestudio/identity/membership";
import { UserStore } from "@vibestudio/identity/userStore";
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
    membership: { has: vi.fn((_userId: string, _workspaceId: string) => true) },
  };
}

describe("live cross-workspace RPC access", () => {
  it("applies live policy and membership changes across an existing child reader for two users", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-rpc-access-"));
    const databasePath = join(root, "identity.db");
    const central = new CentralDataManager({ databasePath });
    const writer = new IdentityDb({ path: databasePath, readOnly: false });
    const reader = new IdentityDb({ path: databasePath, readOnly: true });
    try {
      const users = new UserStore(writer);
      const alice = users.createRoot({ handle: "alice", displayName: "Alice" });
      const bob = users.inviteUser({
        handle: "bob",
        displayName: "Bob",
        role: "member",
        createdBy: alice.id,
      });
      const members = new MembershipStore(writer, users);
      const project = central.addWorkspace("Project");
      const pin = {
        url: "git+https://example.test/base.git",
        ref: "refs/tags/v1",
        commit: "1".repeat(40),
      };
      const personal = central.ensurePrivateWorkspaces(alice.id, {
        personal: pin,
        system: pin,
      }).personal;
      for (const user of [alice, bob]) members.add(user.id, project.workspaceId, alice.id);
      const closed = { incoming: [], outgoing: [] };
      const scope = {
        userId: alice.id,
        target: "main",
        operation: "notes.read",
        purpose: "call" as const,
      };
      const outgoing = {
        incoming: [],
        outgoing: [{ ...scope, workspaceId: personal.workspaceId }],
      };
      const incoming = { incoming: [{ ...scope, workspaceId: project.workspaceId }], outgoing: [] };
      writer.setWorkspaceRpcPolicy(project.workspaceId, outgoing, closed, alice.id);
      const input = {
        caller: {
          workspaceId: project.workspaceId,
          runtime: { kind: "panel" as const, id: "shared-panel" },
          subject: { userId: alice.id, handle: alice.handle },
        },
        destinationWorkspaceId: personal.workspaceId,
        target: scope.target,
        operation: scope.operation,
        purpose: scope.purpose,
        identity: reader,
        membership: new MembershipStore(reader, new UserStore(reader)),
      };
      expect(() => assertWorkspaceRpcAccess(input)).toThrow("Cross-workspace RPC is not permitted");
      writer.setWorkspaceRpcPolicy(personal.workspaceId, incoming, closed, alice.id);
      expect(() => assertWorkspaceRpcAccess(input)).not.toThrow();
      expect(() =>
        assertWorkspaceRpcAccess({
          ...input,
          caller: { ...input.caller, subject: { userId: bob.id, handle: bob.handle } },
        })
      ).toThrow("Cross-workspace RPC is not permitted");
      writer.setWorkspaceRpcPolicy(personal.workspaceId, closed, incoming, alice.id);
      expect(() => assertWorkspaceRpcAccess(input)).toThrow("Cross-workspace RPC is not permitted");
      writer.setWorkspaceRpcPolicy(personal.workspaceId, incoming, closed, alice.id);
      expect(() => assertWorkspaceRpcAccess(input)).not.toThrow();
      members.remove(alice.id, project.workspaceId);
      expect(() => assertWorkspaceRpcAccess(input)).toThrow("Cross-workspace RPC is not permitted");
    } finally {
      reader.close();
      writer.close();
      central.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

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

  it("does not carry host authority across an application boundary or consult policies for nonmembers", () => {
    const input = fixture();
    expect(() =>
      assertWorkspaceRpcAccess({ ...input, caller: { ...input.caller, hostOriginated: true } })
    ).toThrow("host authority cannot cross an application boundary");
    input.membership.has.mockReturnValue(false);
    expect(() => assertWorkspaceRpcAccess(input)).toThrow("not a member of the source workspace");
    expect(input.identity.getWorkspaceRpcPolicy).not.toHaveBeenCalled();
  });

  it.each(["outgoing-blocked", "incoming-blocked", "system-ingress"] as const)(
    "reports %s with the exact rejected operation while preserving the access gate",
    (reason) => {
      const input = fixture();
      if (reason === "system-ingress") {
        input.identity.getPrivateWorkspaceOwner.mockReturnValue({
          userId: "alice",
          role: "system",
        });
      } else {
        const original = input.identity.getWorkspaceRpcPolicy.getMockImplementation()!;
        input.identity.getWorkspaceRpcPolicy.mockImplementation((workspaceId) => {
          const policy = original(workspaceId);
          return reason === "outgoing-blocked" && workspaceId === "project"
            ? { ...policy, outgoing: [] }
            : reason === "incoming-blocked" && workspaceId === "personal"
              ? { ...policy, incoming: [] }
              : policy;
        });
      }
      let failure: unknown;
      try {
        assertWorkspaceRpcAccess(input);
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ code: "EACCES", errorKind: "access" });
      expect((failure as Error).message).toContain(reason);
      expect((failure as Error).message).toContain(`operation ${input.operation}`);
      expect((failure as Error).message).toContain(`destination ${input.destinationWorkspaceId}`);
    }
  );

  it("distinguishes missing destination membership from source membership", () => {
    const input = fixture();
    input.membership.has.mockImplementation(
      (_userId: string, workspaceId: string) => workspaceId !== "personal"
    );
    expect(() => assertWorkspaceRpcAccess(input)).toThrow(
      "not a member of the destination workspace"
    );
    expect(input.identity.getWorkspaceRpcPolicy).not.toHaveBeenCalled();
  });
});
