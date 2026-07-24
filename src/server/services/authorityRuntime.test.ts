import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateAuthority, requirementForPrincipals } from "@vibestudio/shared/authorization";
import { createHostCaller, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  authorizeVerifiedCaller,
  attestDirectRpc,
  callerMatchesMissionHarness,
  directAuthorityAudience,
  directAuthorityCapability,
} from "./authorityRuntime.js";
import {
  getInternalDOBundle,
  internalDOExecutionIdentity,
} from "../internalDOs/internalDoLoader.js";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";

const digest = "a".repeat(64);

describe("authority runtime", () => {
  it("joins mission harnesses to the exact canonical sealed code identity", () => {
    const caller = createVerifiedCaller("do:workers/system-agent:SystemAgentWorker:run", "do", {
      callerId: "do:workers/system-agent:SystemAgentWorker:run",
      callerKind: "do",
      repoPath: "workers/system-agent",
      effectiveVersion: digest,
      executionDigest: "b".repeat(64),
    });
    const mission = {
      missionId: "msn_system_agent",
      closureDigest: "c".repeat(64),
      harness: { unit: "workers/system-agent", ev: digest },
    };

    expect(callerMatchesMissionHarness(caller, mission)).toBe(true);
    expect(
      callerMatchesMissionHarness(caller, {
        ...mission,
        harness: { ...mission.harness, unit: "workers/other" },
      })
    ).toBe(false);
    expect(
      callerMatchesMissionHarness(caller, {
        ...mission,
        harness: { ...mission.harness, ev: "d".repeat(64) },
      })
    ).toBe(false);
  });

  it("binds direct human critical calls to the exact authenticated session", () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-runtime-human-critical-")),
    });
    grantStore.issue({
      effect: "allow",
      capability: "workspace.members.remove",
      resource: { kind: "exact", key: "service:hubControl.removeWorkspaceMember" },
      subject: "session:hub-control:shell:device",
      constraints: {
        sessionId: "hub-control:shell:device",
        invocationDigest: "critical-ask",
        lineageAtConsent: [],
      },
      issuedBy: "user:usr_alice",
      provenance: "critical-confirmation",
      createdAt: 99,
    });
    const resolved = authorizeVerifiedCaller(
      createVerifiedCaller("shell:device", "shell", null, null, {
        userId: "usr_alice",
        handle: "alice",
      }),
      {
        workspaceId: "hub",
        workspaceMember: true,
        sessionId: "hub-control:shell:device",
        audience: "hub-control",
        capability: "workspace.members.remove",
        resourceKey: "service:hubControl.removeWorkspaceMember",
        tier: "critical",
        grantStore,
        now: 100,
      }
    );

    expect(resolved.context.authorizingOrigin).toEqual({
      kind: "user",
      principal: "user:usr_alice",
    });
    expect(resolved.context.actingUser).toBe("user:usr_alice");
    expect(
      evaluateAuthority({
        context: resolved.context,
        requirement: requirementForPrincipals(["user"], "workspace.members.remove"),
        resourceKey: "service:hubControl.removeWorkspaceMember",
        grants: resolved.grants,
        invocationDigest: "critical-ask",
        tier: "critical",
        now: 100,
      })
    ).toMatchObject({ allowed: true, consumable: true });
    grantStore.close();
  });

  it("keeps installed code code-originated at critical tier", () => {
    const caller = createVerifiedCaller("panel:danger", "panel", {
      callerId: "panel:danger",
      callerKind: "panel",
      repoPath: "panels/danger",
      effectiveVersion: "ev-danger",
      executionDigest: digest,
      requested: [
        {
          capability: "workspace.members.remove",
          resource: { kind: "exact", key: "service:hubControl.removeWorkspaceMember" },
        },
      ],
    });
    const resolved = authorizeVerifiedCaller(caller, {
      workspaceId: "hub",
      workspaceMember: true,
      sessionId: "panel-session",
      audience: "hub-control",
      capability: "workspace.members.remove",
      resourceKey: "service:hubControl.removeWorkspaceMember",
      tier: "critical",
      now: 100,
    });

    expect(resolved.context.authorizingOrigin).toEqual({
      kind: "code",
      principal: `code:panels/danger@${digest}`,
    });
  });

  it("treats extension lifecycle protocol as open runtime plumbing, not unit authority", () => {
    const ready = "service:extensions.ready";
    const unreviewed = "service:extensions.invoke";
    const caller = createVerifiedCaller("@workspace-extensions/new", "extension", {
      callerId: "@workspace-extensions/new",
      callerKind: "extension",
      repoPath: "extensions/new",
      effectiveVersion: "ev-new",
      executionDigest: digest,
      requested: [{ capability: unreviewed, resource: { kind: "prefix", prefix: "" } }],
    });
    const resolve = (capability: string) =>
      authorizeVerifiedCaller(caller, {
        workspaceId: "ws-1",
        workspaceMember: true,
        sessionId: "s-extension",
        audience: `service:${capability}`,
        capability,
        resourceKey: capability,
        now: 100,
      });
    const readyAuthority = resolve(ready);
    expect(
      evaluateAuthority({
        context: readyAuthority.context,
        requirement: requirementForPrincipals(["code"], ready),
        resourceKey: ready,
        grants: readyAuthority.grants,
        now: 101,
        tier: "open",
      })
    ).toMatchObject({ allowed: true });
    expect(readyAuthority.grants).toEqual([]);

    const denied = resolve(unreviewed);
    expect(
      evaluateAuthority({
        context: denied.context,
        requirement: requirementForPrincipals(["code"], unreviewed),
        resourceKey: unreviewed,
        grants: denied.grants,
        now: 101,
        tier: "gated",
      })
    ).toMatchObject({ allowed: false, code: "approval-required" });
  });

  it("binds code authority to the exact execution and target", () => {
    const grantStore = new CapabilityGrantStore({
      statePath: mkdtempSync(join(tmpdir(), "authority-runtime-")),
    });
    grantStore.issue({
      effect: "allow",
      capability: directAuthorityCapability("chatOp"),
      resource: {
        kind: "exact",
        key: directAuthorityAudience("workers/target", "TargetDO", "object-1"),
      },
      subject: `code:workers/example@${digest}`,
      constraints: { lineageAtConsent: [] },
      issuedBy: "user:u1",
      provenance: "acquisition",
      createdAt: 99,
    });
    const attestation = attestDirectRpc({
      caller: createVerifiedCaller(
        "do:workers/example:ExampleDO:key",
        "do",
        {
          callerId: "do:workers/example:ExampleDO:key",
          callerKind: "do",
          repoPath: "workers/example",
          effectiveVersion: "ev-1",
          executionDigest: digest,
          requested: [{ capability: "rpc:chatOp", resource: { kind: "prefix", prefix: "" } }],
        },
        null,
        { userId: "u1", handle: "u1" }
      ),
      source: "workers/target",
      className: "TargetDO",
      objectKey: "object-1",
      method: "chatOp",
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      grantStore,
      now: 100,
    });
    const capability = directAuthorityCapability("chatOp");
    expect(attestation.context.executingCode?.principal).toBe(`code:workers/example@${digest}`);
    expect(
      evaluateAuthority({
        context: attestation.context,
        requirement: requirementForPrincipals(["code"], capability),
        resourceKey: attestation.resourceKey,
        grants: attestation.grants,
        now: 101,
      }).allowed
    ).toBe(true);
    expect(
      evaluateAuthority({
        context: attestation.context,
        requirement: requirementForPrincipals(["code"], `${capability}.other`),
        resourceKey: attestation.resourceKey,
        grants: attestation.grants,
        now: 101,
      }).allowed
    ).toBe(false);
    grantStore.close();
  });

  it("does not lend the host principal to a relayed user request", () => {
    const attestation = attestDirectRpc({
      caller: createVerifiedCaller("panel:one", "panel", null, null, {
        userId: "u1",
        handle: "u1",
      }),
      source: "workers/target",
      className: "TargetDO",
      objectKey: "object-1",
      method: "read",
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      now: 100,
    });
    expect(attestation.context.host).toBeNull();
    expect(attestation.context.actingUser).toBe("user:u1");
  });

  it("never derives the host principal from a server runtime label", () => {
    const input = {
      source: "workers/target",
      className: "TargetDO",
      objectKey: "object-1",
      method: "read",
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      now: 100,
    } as const;
    expect(
      attestDirectRpc({ caller: createVerifiedCaller("main", "server"), ...input }).context.host
    ).toBeNull();
    expect(attestDirectRpc({ caller: createHostCaller("main"), ...input }).context.host).toMatch(
      /^host:[0-9a-f]{64}$/
    );
  });

  it("does not turn an entity relationship into session authority when code identity is incomplete", () => {
    const capability = "service:workers.resolveService";
    const caller = createVerifiedCaller(
      "@workspace-apps/shell",
      "app",
      {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-legacy",
      },
      {
        entityId: "@workspace-apps/shell",
        contextId: "ctx-shell",
        channelId: "shell",
        agentId: "@workspace-apps/shell",
      },
      { userId: "u1", handle: "u1" }
    );
    const resolved = authorizeVerifiedCaller(caller, {
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-partial-code-entity",
      audience: "service:workers",
      capability,
      resourceKey: capability,
      now: 100,
    });

    expect(resolved.context.authorizingOrigin).toEqual({
      kind: "user",
      principal: "user:u1",
    });
    expect(
      evaluateAuthority({
        context: resolved.context,
        requirement: requirementForPrincipals(["session"], capability),
        resourceKey: capability,
        grants: resolved.grants,
        now: 101,
      }).allowed
    ).toBe(false);
  });

  it("keeps a harness-owned agent call on its sealed code origin", () => {
    const capability = "service:credentials.resolveCredential";
    const caller = createVerifiedCaller(
      "do:workers/agent-worker:AiChatWorker:worker-1",
      "do",
      {
        callerId: "do:workers/agent-worker:AiChatWorker:worker-1",
        callerKind: "do",
        repoPath: "workers/agent-worker",
        effectiveVersion: "ev-agent",
        executionDigest: digest,
        requested: [{ capability, resource: { kind: "prefix", prefix: "" } }],
      },
      {
        entityId: "agent:worker-1",
        contextId: "ctx-agent",
        channelId: "channel-agent",
        agentId: "agent:worker-1",
      },
      { userId: "u1", handle: "u1" }
    );
    const resolved = authorizeVerifiedCaller(caller, {
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "channel-agent",
      audience: "service:credentials",
      capability,
      resourceKey: capability,
      now: 100,
    });

    expect(resolved.context.authorizingOrigin).toEqual({
      kind: "code",
      principal: `code:workers/agent-worker@${digest}`,
    });
    expect(resolved.context.agentBinding?.channelId).toBe("channel-agent");
    expect(resolved.context.contextIntegrity?.class).toBe("not-applicable");
  });

  it("falls back to the authenticated user when incomplete code metadata has no entity binding", () => {
    const capability = "service:workers.resolveService";
    const caller = createVerifiedCaller(
      "@workspace-apps/shell",
      "app",
      {
        callerId: "@workspace-apps/shell",
        callerKind: "app",
        repoPath: "apps/shell",
        effectiveVersion: "ev-legacy",
      },
      null,
      { userId: "u1", handle: "u1" }
    );
    const resolved = authorizeVerifiedCaller(caller, {
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-partial-code-user",
      audience: "service:workers",
      capability,
      resourceKey: capability,
      now: 100,
    });

    expect(resolved.context.authorizingOrigin).toEqual({
      kind: "user",
      principal: "user:u1",
    });
    expect(resolved.context.entity).toBeNull();
    expect(
      evaluateAuthority({
        context: resolved.context,
        requirement: requirementForPrincipals(["user"], capability),
        resourceKey: capability,
        grants: resolved.grants,
        now: 101,
      }).allowed
    ).toBe(true);
  });

  it("does not grant a newly invented direct method", () => {
    const method = "futureMethodThatWasNeverReviewed";
    const attestation = attestDirectRpc({
      caller: createVerifiedCaller("worker:example", "worker", {
        callerId: "worker:example",
        callerKind: "worker",
        repoPath: "product/eval",
        effectiveVersion: "ev-1",
        executionDigest: digest,
        requested: [{ capability: `rpc:${method}`, resource: { kind: "prefix", prefix: "" } }],
      }),
      source: "workers/target",
      className: "TargetDO",
      objectKey: "object-1",
      method,
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      now: 100,
    });
    expect(
      evaluateAuthority({
        context: attestation.context,
        requirement: requirementForPrincipals(["code"], directAuthorityCapability(method)),
        resourceKey: attestation.resourceKey,
        grants: attestation.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "approval-required" });
  });

  it("keeps exact code identity while withholding a live provider grant", () => {
    const attestation = attestDirectRpc({
      caller: createVerifiedCaller("@workspace-extensions/other", "extension", {
        callerId: "@workspace-extensions/other",
        callerKind: "extension",
        repoPath: "product/eval",
        effectiveVersion: "ev-1",
        executionDigest: digest,
        requested: [{ capability: "rpc:getCookies", resource: { kind: "prefix", prefix: "" } }],
      }),
      source: "product/browser-data",
      className: "BrowserDataDO",
      objectKey: "global",
      method: "getCookies",
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-1",
      grantCode: false,
      now: 100,
    });
    const capability = directAuthorityCapability("getCookies");
    expect(attestation.context.executingCode?.principal).toBe(`code:product/eval@${digest}`);
    expect(
      evaluateAuthority({
        context: attestation.context,
        requirement: requirementForPrincipals(["code"], capability),
        resourceKey: attestation.resourceKey,
        grants: attestation.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "approval-required" });
  });

  it("does not let code borrow its acting user's grant", () => {
    const capability = "service:app.getInfo";
    const resourceKey = capability;
    const resolved = authorizeVerifiedCaller(
      createVerifiedCaller(
        "app:unreviewed",
        "app",
        {
          callerId: "app:unreviewed",
          callerKind: "app",
          repoPath: "apps/unreviewed",
          effectiveVersion: "ev-1",
          executionDigest: digest,
          requested: [{ capability, resource: { kind: "exact", key: resourceKey } }],
        },
        null,
        { userId: "u1", handle: "u1" }
      ),
      {
        workspaceId: "ws-1",
        workspaceMember: true,
        sessionId: "s-confused-deputy",
        audience: "service:app",
        capability,
        resourceKey,
        now: 100,
      }
    );
    expect(resolved.context.actingUser).toBe("user:u1");
    expect(
      evaluateAuthority({
        context: resolved.context,
        requirement: requirementForPrincipals(["user", "code"], capability),
        resourceKey,
        grants: resolved.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "approval-required" });
  });

  it("does not give sealed control-plane plumbing discretionary service authority", () => {
    const identity = internalDOExecutionIdentity(getInternalDOBundle(), "GadWorkspaceDO");
    const capability = "workspace.runtime-state.manage";
    expect(identity.authorityRequests).toEqual([]);
    const caller = {
      ...createVerifiedCaller("do:vibestudio/internal:GadWorkspaceDO:gad", "do", {
        callerId: "do:vibestudio/internal:GadWorkspaceDO:gad",
        callerKind: "do",
        repoPath: identity.source,
        effectiveVersion: identity.effectiveVersion,
        executionDigest: identity.executionDigest,
        requested: identity.authorityRequests,
      }),
      codeApproved: true as const,
    };
    const resolved = authorizeVerifiedCaller(caller, {
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-internal-gad",
      audience: "service:workspace-state",
      capability,
      resourceKey: capability,
      now: 100,
    });

    expect(
      evaluateAuthority({
        context: resolved.context,
        requirement: requirementForPrincipals(["code"], capability),
        resourceKey: capability,
        grants: resolved.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "fixed-code-not-requested" });

    const unrequested = "service:credentials.listStoredCredentials";
    const denied = authorizeVerifiedCaller(caller, {
      workspaceId: "ws-1",
      workspaceMember: true,
      sessionId: "s-internal-gad",
      audience: "service:credentials",
      capability: unrequested,
      resourceKey: unrequested,
      now: 100,
    });
    expect(
      evaluateAuthority({
        context: denied.context,
        requirement: requirementForPrincipals(["code"], unrequested),
        resourceKey: unrequested,
        grants: denied.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "fixed-code-not-requested" });
  });
});
