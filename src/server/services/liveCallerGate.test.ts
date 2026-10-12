import { describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createLiveCallerGate } from "./liveCallerGate.js";

describe("createLiveCallerGate", () => {
  const executionDigest = "a".repeat(64);
  const authority = { requests: [], provides: [] } as const;
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
  });

  function fixture(
    runtimeOwnerUserId = "usr_alice",
    extensionLiveness?: (callerId: string) => Promise<boolean>
  ) {
    let userRevoked = false;
    let member = true;
    let deviceLive = true;
    let agentLive = true;
    let extensionLive = true;
    let websiteLive = true;
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
                  source: {
                    repoPath: entityId.includes("GadWorkspaceDO")
                      ? "vibestudio/internal"
                      : "vibestudio/internal",
                    effectiveVersion: "ev-1",
                  },
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
                  ownerUserId: runtimeOwnerUserId,
                } as never),
      },
      isLiveWebsiteExecution: (runtimeId, website) =>
        websiteLive &&
        runtimeId === "panel:website" &&
        website.connected &&
        website.binding.documentId === "document-1",
      isLiveExtension:
        extensionLiveness ??
        (async (callerId) => extensionLive && callerId === "@workspace-extensions/host"),
      isLiveSystemRuntime: (callerId, callerKind) =>
        callerId === "do:workers/workspace-source:GadWorkspaceDO:workspace" && callerKind === "do",
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
      retireWebsite: () => {
        websiteLive = false;
      },
      retireExtension: () => {
        extensionLive = false;
      },
      advanceIncarnation: () => {
        currentExecutionDigest = "b".repeat(64);
      },
    };
  }

  it("waits for the extension's actual liveness result and propagates lookup failure", async () => {
    let resolve!: (value: boolean) => void;
    const state = fixture(
      "usr_alice",
      () =>
        new Promise<boolean>((settle) => {
          resolve = settle;
        })
    );
    const caller = createVerifiedCaller("@workspace-extensions/host", "extension", null, null, {
      userId: "system",
      handle: "system",
    });
    let settled = false;
    const result = Promise.resolve(state.gate(caller)).then((allowed) => {
      settled = true;
      return allowed;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    resolve(false);
    expect(await result).toBe(false);

    const failure = new Error("The exact extension identity could not be read");
    const failing = fixture("usr_alice", async () => {
      throw failure;
    });
    await expect(failing.gate(caller)).rejects.toBe(failure);
  });

  it("re-checks the concrete shell device, account, and membership on every call", async () => {
    const subject = { userId: "usr_alice", handle: "alice" };

    const device = fixture();
    const shell = createVerifiedCaller("shell:dev_1", "shell", null, null, subject);
    expect(await device.gate(shell)).toBe(true);
    device.revokeDevice();
    expect(await device.gate(shell)).toBe(false);

    const account = fixture();
    expect(await account.gate(shell)).toBe(true);
    account.revokeUser();
    expect(await account.gate(shell)).toBe(false);

    const membership = fixture();
    expect(await membership.gate(shell)).toBe(true);
    membership.removeMembership();
    expect(await membership.gate(shell)).toBe(false);
  });

  it("rejects a cached agent as soon as its credential is no longer live", async () => {
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
    expect(await state.gate(agent)).toBe(true);
    state.revokeAgent();
    expect(await state.gate(agent)).toBe(false);
  });

  it("requires live document proof and the current authenticated viewer for website panels", async () => {
    const state = fixture();
    const caller = {
      ...createVerifiedCaller("panel:website", "panel", null, undefined, {
        userId: "usr_alice",
        handle: "alice",
      }),
      website: {
        subject: "website:one" as const,
        userId: "user:usr_alice" as const,
        workspaceId: "ws_alpha",
        origin: "https://example.test",
        connected: true,
        binding: { subject: "website:one" as const, generation: 0, documentId: "document-1" },
      },
    };
    expect(await state.gate(caller)).toBe(false);
    expect(await state.gate(caller, "shell:dev_1")).toBe(true);
    expect(
      await state.gate(
        { ...caller, website: { ...caller.website, workspaceId: "ws_other" } },
        "shell:dev_1"
      )
    ).toBe(false);
    expect(
      await state.gate(
        { ...caller, website: { ...caller.website, userId: "user:usr_bob" } },
        "shell:dev_1"
      )
    ).toBe(false);
    state.retireWebsite();
    expect(await state.gate(caller, "shell:dev_1")).toBe(false);
    // Code evidence cannot substitute for a retired document's proof.
    expect(
      await state.gate(
        { ...caller, code: codeIdentity("panel:website", "panel", "apps/shared") },
        "shell:dev_1"
      )
    ).toBe(false);
  });

  it.each(["revokeUser", "removeMembership", "revokeDevice"] as const)(
    "withdraws website transport when %s changes",
    async (withdraw) => {
      const state = fixture();
      const caller = {
        ...createVerifiedCaller("panel:website", "panel", null, undefined, {
          userId: "usr_alice",
          handle: "alice",
        }),
        website: {
          subject: "website:one" as const,
          userId: "user:usr_alice" as const,
          workspaceId: "ws_alpha",
          origin: "https://example.test",
          connected: true,
          binding: { subject: "website:one" as const, generation: 0, documentId: "document-1" },
        },
      };
      expect(await state.gate(caller, "shell:dev_1")).toBe(true);
      state[withdraw]();
      expect(await state.gate(caller, "shell:dev_1")).toBe(false);
    }
  );

  it("binds a shared app connection to its live grant issuer without assigning a global owner", async () => {
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
    expect(await state.gate(app)).toBe(false);
    expect(await state.gate(app, "shell:dev_1")).toBe(true);
    state.revokeDevice();
    expect(await state.gate(app, "shell:dev_1")).toBe(false);
  });

  it("uses the authenticated viewer for shared panels and creator lineage for workers", async () => {
    const state = fixture("usr_bob");
    const subject = { userId: "usr_alice", handle: "alice" };
    const panel = createVerifiedCaller(
      "panel:shared",
      "panel",
      codeIdentity("panel:shared", "panel", "apps/shared"),
      null,
      subject
    );
    expect(await state.gate(panel)).toBe(false);
    expect(await state.gate(panel, "shell:dev_1")).toBe(true);
    const worker = createVerifiedCaller(
      "worker:shared",
      "worker",
      codeIdentity("worker:shared", "worker", "apps/shared"),
      null,
      subject
    );
    expect(await state.gate(worker, "shell:dev_1")).toBe(false);
    state.removeMembership();
    expect(await state.gate(panel, "shell:dev_1")).toBe(false);
  });

  it("rejects an admitted code caller after its active incarnation changes", async () => {
    const state = fixture();
    const app = createVerifiedCaller(
      "app:shared",
      "app",
      codeIdentity("app:shared", "app", "apps/shared"),
      null,
      { userId: "usr_alice", handle: "alice" }
    );

    expect(await state.gate(app, "shell:dev_1")).toBe(true);
    state.advanceIncarnation();
    expect(await state.gate(app, "shell:dev_1")).toBe(false);
  });

  it("admits only the canonical system-owned extension identity", async () => {
    const state = fixture();
    expect(
      await state.gate(
        createVerifiedCaller("@workspace-extensions/host", "extension", null, null, {
          userId: "system",
          handle: "system",
        })
      )
    ).toBe(true);
    expect(
      await state.gate(
        createVerifiedCaller("@workspace-extensions/fake", "extension", null, null, {
          userId: "system",
          handle: "system",
        })
      )
    ).toBe(false);
    state.retireExtension();
    expect(
      await state.gate(
        createVerifiedCaller("@workspace-extensions/host", "extension", null, null, {
          userId: "system",
          handle: "system",
        })
      )
    ).toBe(false);
  });

  it("never treats an app principal as a system-owned runtime", async () => {
    // Apps run on client devices under their user's device principal; no
    // server-spawned app process exists to carry the system subject.
    const state = fixture();
    const app = createVerifiedCaller(
      "@workspace-apps/terminal-browser",
      "app",
      codeIdentity("@workspace-apps/terminal-browser", "app", "apps/shared"),
      null,
      { userId: "system", handle: "system" }
    );

    expect(await state.gate(app, "server")).toBe(false);
    expect(await state.gate(app)).toBe(false);
  });

  it("admits only the declared system-owned runtime identity", async () => {
    const state = fixture();
    const systemSubject = { userId: "system", handle: "system" };
    expect(
      await state.gate(
        createVerifiedCaller(
          "do:workers/workspace-source:GadWorkspaceDO:workspace",
          "do",
          codeIdentity(
            "do:workers/workspace-source:GadWorkspaceDO:workspace",
            "do",
            "vibestudio/internal"
          ),
          null,
          systemSubject
        )
      )
    ).toBe(true);
    expect(
      await state.gate(
        createVerifiedCaller(
          "do:workers/workspace-source:GadWorkspaceDO:other",
          "do",
          codeIdentity(
            "do:workers/workspace-source:GadWorkspaceDO:other",
            "do",
            "vibestudio/internal"
          ),
          null,
          systemSubject
        )
      )
    ).toBe(false);
  });
});
