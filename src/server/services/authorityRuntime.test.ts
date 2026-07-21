import { describe, expect, it } from "vitest";
import { evaluateAuthority, requirementForPrincipals } from "@vibestudio/shared/authorization";
import { createHostCaller, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  authorizeVerifiedCaller,
  attestDirectRpc,
  directAuthorityCapability,
} from "./authorityRuntime.js";
import {
  getInternalDOBundle,
  internalDOExecutionIdentity,
} from "../internalDOs/internalDoLoader.js";

const digest = "a".repeat(64);

describe("authority runtime", () => {
  it("grants only the sealed lifecycle protocol to newly created extensions", () => {
    const ready = "service:extensions.ready";
    const unreviewed = "service:extensions.invoke";
    const caller = createVerifiedCaller("@workspace-extensions/new", "extension", {
      callerId: "@workspace-extensions/new",
      callerKind: "extension",
      repoPath: "extensions/new",
      effectiveVersion: "ev-new",
      executionDigest: digest,
      delegations: [],
      requested: [
        { capability: ready, resource: { kind: "prefix", prefix: "" } },
        { capability: unreviewed, resource: { kind: "prefix", prefix: "" } },
      ],
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
      })
    ).toMatchObject({ allowed: true });
    expect(readyAuthority.grants).toContainEqual(
      expect.objectContaining({ provenance: "extension-runtime-authority-v1" })
    );

    const denied = resolve(unreviewed);
    expect(
      evaluateAuthority({
        context: denied.context,
        requirement: requirementForPrincipals(["code"], unreviewed),
        resourceKey: unreviewed,
        grants: denied.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "missing-grant" });
  });

  it("binds code authority to the exact execution and target", () => {
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
          delegations: [],
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
      grantStore: {
        hasGrant: () => true,
        hasDenial: () => false,
      } as never,
      now: 100,
    });
    const capability = directAuthorityCapability("chatOp");
    expect(attestation.context.codeAuthority.executor?.principal).toBe(
      `code:workers/example@${digest}`
    );
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

  it("uses an explicit entity binding when legacy code metadata has no execution digest", () => {
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
      kind: "entity",
      principal: "entity:@workspace-apps/shell",
    });
    expect(
      evaluateAuthority({
        context: resolved.context,
        requirement: requirementForPrincipals(["entity"], capability),
        resourceKey: capability,
        grants: resolved.grants,
        now: 101,
      }).allowed
    ).toBe(true);
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
        delegations: [],
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
    ).toMatchObject({ allowed: false, code: "missing-grant" });
  });

  it("keeps exact code identity while withholding a live provider grant", () => {
    const attestation = attestDirectRpc({
      caller: createVerifiedCaller("@workspace-extensions/other", "extension", {
        callerId: "@workspace-extensions/other",
        callerKind: "extension",
        repoPath: "product/eval",
        effectiveVersion: "ev-1",
        executionDigest: digest,
        delegations: [],
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
    expect(attestation.context.codeAuthority.executor?.principal).toBe(
      `code:product/eval@${digest}`
    );
    expect(
      evaluateAuthority({
        context: attestation.context,
        requirement: requirementForPrincipals(["code"], capability),
        resourceKey: attestation.resourceKey,
        grants: attestation.grants,
        now: 101,
      })
    ).toMatchObject({ allowed: false, code: "missing-grant" });
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
          delegations: [],
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
    ).toMatchObject({ allowed: false, code: "missing-grant" });
  });

  it("authorizes a sealed internal DO only through its reviewed request intersection", () => {
    const identity = internalDOExecutionIdentity(getInternalDOBundle(), "GadWorkspaceDO");
    const capability = "service:workspace-state.alarmClear";
    const caller = createVerifiedCaller("do:vibestudio/internal:GadWorkspaceDO:gad", "do", {
      callerId: "do:vibestudio/internal:GadWorkspaceDO:gad",
      callerKind: "do",
      repoPath: identity.source,
      effectiveVersion: identity.effectiveVersion,
      executionDigest: identity.executionDigest,
      delegations: identity.authorityDelegations,
      requested: identity.authorityRequests,
    });
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
    ).toMatchObject({ allowed: true });

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
    ).toMatchObject({ allowed: false, code: "not-requested" });
  });
});
