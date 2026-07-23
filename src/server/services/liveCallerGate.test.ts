import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createLiveCallerGate } from "./liveCallerGate.js";

describe("createLiveCallerGate", () => {
  const executionDigest = "a".repeat(64);
  const authority = { requests: [], evalCeilings: [] } as const;
  const codeIdentity = (
    callerId: string,
    callerKind: "panel" | "app" | "worker" | "do",
    repoPath: string
  ) => ({
    callerId,
    callerKind,
    repoPath,
    effectiveVersion: "ev-1",
    executionDigest,
    requested: authority.requests,
    evalCeilings: authority.evalCeilings,
  });

  function fixture() {
    let userRevoked = false;
    let member = true;
    let deviceLive = true;
    let agentLive = true;
    let extensionLive = true;
    let currentExecutionDigest = executionDigest;
    const gate = createLiveCallerGate({
      workspaceId: "ws_alpha",
      userStore: {
        getUser: (userId: string) =>
          userId === "usr_alice"
            ? ({
                id: userId,
                handle: "alice",
                displayName: "Alice",
                role: "member",
                createdAt: 1,
                ...(userRevoked ? { revokedAt: 2 } : {}),
              } as const)
            : null,
      },
      membershipStore: { has: () => member },
      deviceAuthStore: {
        userFor: () => (deviceLive ? "usr_alice" : null),
        getAgentCredential: () =>
          agentLive
            ? ({
                agentId: "agt_1",
                entityId: "session:one",
                tokenHash: "hash",
                createdAt: 1,
              } as const)
            : null,
      },
      entityCache: {
        resolveActive: (entityId) =>
          entityId === "session:one"
            ? ({
                id: entityId,
                kind: "session",
                source: { repoPath: "agent-cli", effectiveVersion: "" },
                contextId: "ctx_1",
                key: "one",
                agentBinding: {
                  entityId,
                  contextId: "ctx_1",
                  channelId: "channel_1",
                },
                ownerUserId: "usr_alice",
                createdAt: 1,
                status: "active",
                cleanupComplete: true,
              } as never)
            : entityId.startsWith("do:")
              ? ({
                  id: entityId,
                  kind: "do",
                  source: { repoPath: "vibestudio/internal", effectiveVersion: "ev-1" },
                  activeExecutionDigest: currentExecutionDigest,
                  activeAuthority: authority,
                  ownerUserId: "system",
                } as never)
              : ({
                  id: entityId,
                  kind: "app",
                  source: { repoPath: "apps/shared", effectiveVersion: "ev-1" },
                  activeExecutionDigest: currentExecutionDigest,
                  activeAuthority: authority,
                  ownerUserId: "usr_alice",
                } as never),
      },
      isLiveExtension: (callerId) => extensionLive && callerId === "@workspace-extensions/host",
      isLiveSystemRuntime: (callerId, callerKind) =>
        callerId === "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane" &&
        callerKind === "do",
      now: () => 10,
    });
    return {
      gate,
      revokeUser: () => {
        userRevoked = true;
      },
      removeMembership: () => {
        member = false;
      },
      revokeDevice: () => {
        deviceLive = false;
      },
      revokeAgent: () => {
        agentLive = false;
      },
      retireExtension: () => {
        extensionLive = false;
      },
      advanceIncarnation: () => {
        currentExecutionDigest = "b".repeat(64);
      },
    };
  }

  it("re-checks the concrete shell device, account, and membership on every call", () => {
    const subject = { userId: "usr_alice", handle: "alice" };

    const device = fixture();
    const shell = createVerifiedCaller("shell:dev_1", "shell", null, null, subject);
    expect(device.gate(shell)).toBe(true);
    device.revokeDevice();
    expect(device.gate(shell)).toBe(false);

    const account = fixture();
    expect(account.gate(shell)).toBe(true);
    account.revokeUser();
    expect(account.gate(shell)).toBe(false);

    const membership = fixture();
    expect(membership.gate(shell)).toBe(true);
    membership.removeMembership();
    expect(membership.gate(shell)).toBe(false);
  });

  it("rejects a cached agent as soon as its credential is no longer live", () => {
    const state = fixture();
    const agent = createVerifiedCaller(
      "agent:session:one",
      "agent",
      null,
      {
        agentId: "agt_1",
        entityId: "session:one",
        contextId: "ctx_1",
        channelId: "channel_1",
      },
      { userId: "usr_alice", handle: "alice" }
    );
    expect(state.gate(agent)).toBe(true);
    state.revokeAgent();
    expect(state.gate(agent)).toBe(false);
  });

  it("binds a shared app connection to its live grant issuer without assigning a global owner", () => {
    const state = fixture();
    const app = createVerifiedCaller(
      "app:shared",
      "app",
      codeIdentity("app:shared", "app", "apps/shared"),
      null,
      {
        userId: "usr_alice",
        handle: "alice",
      }
    );
    expect(state.gate(app)).toBe(false);
    expect(state.gate(app, "shell:dev_1")).toBe(true);
    state.revokeDevice();
    expect(state.gate(app, "shell:dev_1")).toBe(false);
  });

  it("rejects an admitted code caller after its active incarnation changes", () => {
    const state = fixture();
    const app = createVerifiedCaller(
      "app:shared",
      "app",
      codeIdentity("app:shared", "app", "apps/shared"),
      null,
      { userId: "usr_alice", handle: "alice" }
    );

    expect(state.gate(app, "shell:dev_1")).toBe(true);
    state.advanceIncarnation();
    expect(state.gate(app, "shell:dev_1")).toBe(false);
  });

  it("admits only the canonical system-owned extension identity", () => {
    const state = fixture();
    expect(
      state.gate(
        createVerifiedCaller("@workspace-extensions/host", "extension", null, null, {
          userId: "system",
          handle: "system",
        })
      )
    ).toBe(true);
    expect(
      state.gate(
        createVerifiedCaller("@workspace-extensions/fake", "extension", null, null, {
          userId: "system",
          handle: "system",
        })
      )
    ).toBe(false);
    state.retireExtension();
    expect(
      state.gate(
        createVerifiedCaller("@workspace-extensions/host", "extension", null, null, {
          userId: "system",
          handle: "system",
        })
      )
    ).toBe(false);
  });

  it("keeps a live server-spawned shared app authorized without inventing a user owner", () => {
    const state = fixture();
    const app = createVerifiedCaller(
      "@workspace-apps/remote-cli",
      "app",
      codeIdentity("@workspace-apps/remote-cli", "app", "apps/shared"),
      null,
      { userId: "system", handle: "system" }
    );

    expect(state.gate(app, "server")).toBe(true);
    expect(state.gate(app)).toBe(false);
    expect(state.gate(app, "shell:dev_1")).toBe(false);
  });

  it("admits only the declared system-owned runtime identity", () => {
    const state = fixture();
    const systemSubject = { userId: "system", handle: "system" };
    expect(
      state.gate(
        createVerifiedCaller(
          "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane",
          "do",
          codeIdentity(
            "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane",
            "do",
            "vibestudio/internal"
          ),
          null,
          systemSubject
        )
      )
    ).toBe(true);
    expect(
      state.gate(
        createVerifiedCaller(
          "do:vibestudio/internal:GadWorkspaceDO:other",
          "do",
          codeIdentity("do:vibestudio/internal:GadWorkspaceDO:other", "do", "vibestudio/internal"),
          null,
          systemSubject
        )
      )
    ).toBe(false);
  });
});
