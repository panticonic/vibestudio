import { describe, expect, it } from "vitest";
import {
  allOf,
  authorityFailureForDecision,
  capability,
  evaluateAuthority,
  relationship,
  requirementForPrincipals,
  scopeCovers,
  type AuthorizationContext,
  type AuthorityGrant,
  type Principal,
} from "./authorization.js";

const RESOURCE = "workspace:ws-1/repo:projects/vibestudio";
const user = "user:alice" as const;
const code = `code:workers/example@${"a".repeat(64)}` as `code:${string}`;
const session = "session:s1" as const;
const mission = `mission:nightly@${"b".repeat(64)}` as `mission:${string}`;

describe("resource prefix scopes", () => {
  it("covers hierarchical descendants without crossing a name boundary", () => {
    expect(scopeCovers({ kind: "prefix", prefix: "context" }, "context/panel")).toBe(true);
    expect(scopeCovers({ kind: "prefix", prefix: "context" }, "contextual")).toBe(false);
  });

  it("supports explicitly separator-terminated dynamic namespaces", () => {
    const scope = {
      kind: "prefix" as const,
      prefix: "workspace-repo-delete:projects/system-test-",
    };
    expect(scopeCovers(scope, "workspace-repo-delete:projects/system-test-vcs-push-a1b2c3d4")).toBe(
      true
    );
    expect(scopeCovers(scope, "workspace-repo-delete:projects/customer-data")).toBe(false);
    expect(scopeCovers(scope, "workspace-repo-delete:packages/system-test-helper")).toBe(false);
  });
});

function codeContext(): AuthorizationContext {
  return {
    authorizingOrigin: { kind: "code", principal: code },
    host: null,
    actingUser: user,
    entity: "entity:worker:example",
    incarnation: "inc:1",
    executingCode: {
      principal: code,
      requested: [{ capability: "fs.write", resource: { kind: "exact", key: RESOURCE } }],
      sourceLineage: { class: "internal", externalKeys: [] },
    },
    initiatorChain: [user, code],
    ownerChain: [user],
    agentBinding: null,
    workspace: { workspaceId: "ws-1", member: true, role: "member", revision: "7" },
    session: { id: "s1", audience: "host", version: "2.1", expiresAt: 10_000 },
    contextIntegrity: { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
  };
}

function sessionContext(externalKeys: readonly string[] = []): AuthorizationContext {
  return {
    ...codeContext(),
    authorizingOrigin: { kind: "session", principal: session },
    executingCode: null,
    session: {
      id: "s1",
      audience: "host",
      version: "2.1",
      expiresAt: 10_000,
      mission: {
        missionId: "nightly",
        closureDigest: "b".repeat(64),
        harness: { unit: "workers/system-agent", ev: "c".repeat(64) },
      },
    },
    contextIntegrity: {
      class: externalKeys.length > 0 ? "external" : "internal",
      latchEpoch: externalKeys.length,
      externalKeys,
    },
  };
}

function codeMediatedEvalContext(requestedCapability = "fs.write"): AuthorizationContext {
  const context = sessionContext();
  context.executingCode = {
    principal: code,
    requested: [{ capability: requestedCapability, resource: { kind: "exact", key: RESOURCE } }],
    sourceLineage: { class: "internal", externalKeys: [] },
  };
  return context;
}

function grant(
  subject: Principal,
  capabilityName = "fs.write",
  effect: "allow" | "deny" = "allow",
  constraints?: AuthorityGrant["constraints"]
): AuthorityGrant {
  return {
    id: `${effect}-${subject}`,
    subject,
    capability: capabilityName,
    resource: { kind: "exact", key: RESOURCE },
    effect,
    issuedBy: user,
    createdAt: 1,
    ...(constraints ? { constraints } : {}),
    provenance: "test",
  };
}

describe("compositional authority", () => {
  it("distinguishes an immutable manifest ceiling from a promptable missing grant", () => {
    const undeclared = codeContext();
    undeclared.executingCode = { ...undeclared.executingCode!, requested: [] };
    const notRequested = evaluateAuthority({
      context: undeclared,
      requirement: capability("code", "fs.write"),
      resourceKey: RESOURCE,
      grants: [grant(code)],
      now: 100,
    });
    expect(
      authorityFailureForDecision(notRequested, {
        capability: "fs.write",
        resourceKey: RESOURCE,
        tier: "gated",
      })
    ).toEqual({
      reasonCode: "not-requested",
      reason: notRequested.reason,
      capability: "fs.write",
      resourceKey: RESOURCE,
      remediation: {
        kind: "update-authority-manifest",
        message:
          "Add this authority request to the installed unit manifest or owning agent eval ceiling, then submit the new exact version for user review.",
        request: {
          capability: "fs.write",
          resource: { kind: "exact", key: RESOURCE },
          tier: "gated",
        },
      },
    });

    const missingGrant = evaluateAuthority({
      context: codeContext(),
      requirement: capability("code", "fs.write"),
      resourceKey: RESOURCE,
      grants: [],
      now: 100,
    });
    expect(
      authorityFailureForDecision(missingGrant, {
        capability: "fs.write",
        resourceKey: RESOURCE,
        tier: "gated",
      }).remediation.kind
    ).toBe("request-user-approval");
  });

  it("intersects installed-code grants with the sealed explicit request", () => {
    expect(
      evaluateAuthority({
        context: codeContext(),
        requirement: allOf(capability("code", "fs.write"), relationship("workspace-member")),
        resourceKey: RESOURCE,
        grants: [grant(code)],
        now: 100,
      }).allowed
    ).toBe(true);

    const ctx = codeContext();
    ctx.executingCode = { ...ctx.executingCode!, requested: [] };
    expect(
      evaluateAuthority({
        context: ctx,
        requirement: capability("code", "fs.write"),
        resourceKey: RESOURCE,
        grants: [grant(code)],
        now: 100,
      })
    ).toMatchObject({ allowed: false, code: "not-requested" });
  });

  it("never unions the acting user's grants into a code origin", () => {
    expect(
      evaluateAuthority({
        context: codeContext(),
        requirement: {
          kind: "any",
          requirements: [capability("code", "fs.write"), capability("user", "fs.write")],
        },
        resourceKey: RESOURCE,
        grants: [grant(user)],
        now: 100,
      })
    ).toMatchObject({ allowed: false, code: "missing-grant" });
  });

  it("matches a session's exact session and authenticated mission subjects", () => {
    const requirement = requirementForPrincipals(["code"], "fs.write");
    expect(
      evaluateAuthority({
        context: sessionContext(),
        requirement,
        resourceKey: RESOURCE,
        grants: [grant(mission)],
        now: 100,
      }).allowed
    ).toBe(true);
    expect(
      evaluateAuthority({
        context: sessionContext(),
        requirement,
        resourceKey: RESOURCE,
        grants: [grant(session)],
        now: 100,
      }).allowed
    ).toBe(true);
  });

  it("caps code-mediated eval acquisition at the owner's sealed eval ceiling", () => {
    const requirement = requirementForPrincipals(["code"], "fs.write");
    expect(
      evaluateAuthority({
        context: codeMediatedEvalContext(),
        requirement,
        resourceKey: RESOURCE,
        grants: [grant(session)],
        tier: "gated",
        now: 100,
      }).allowed
    ).toBe(true);
    expect(
      evaluateAuthority({
        context: codeMediatedEvalContext("workspace.read"),
        requirement,
        resourceKey: RESOURCE,
        grants: [grant(session)],
        tier: "gated",
        now: 100,
      })
    ).toMatchObject({ allowed: false, code: "not-requested" });
  });

  it("applies deny precedence across session and mission facets", () => {
    expect(
      evaluateAuthority({
        context: sessionContext(),
        requirement: capability("session", "fs.write"),
        resourceKey: RESOURCE,
        grants: [grant(mission), grant(session, "fs.write", "deny")],
        now: 100,
      })
    ).toMatchObject({ allowed: false, code: "denied" });
  });

  it("lets codeOnly exclude eval sessions", () => {
    const requirement = requirementForPrincipals(["code"], "fs.write", { codeOnly: true });
    expect(
      evaluateAuthority({
        context: sessionContext(),
        requirement,
        resourceKey: RESOURCE,
        grants: [grant(session)],
        now: 100,
      })
    ).toMatchObject({ allowed: false, code: "missing-principal" });
  });

  it("requires lineageAtConsent to cover every current outside source", () => {
    const ctx = sessionContext(["web:example.com", "api:github"]);
    expect(
      evaluateAuthority({
        context: ctx,
        requirement: capability("session", "fs.write"),
        resourceKey: RESOURCE,
        grants: [grant(session, "fs.write", "allow", { lineageAtConsent: ["web:example.com"] })],
        now: 100,
      })
    ).toMatchObject({ allowed: false, code: "lineage" });
    expect(
      evaluateAuthority({
        context: ctx,
        requirement: capability("session", "fs.write"),
        resourceKey: RESOURCE,
        grants: [
          grant(session, "fs.write", "allow", {
            lineageAtConsent: ["web:example.com", "api:github"],
          }),
        ],
        now: 100,
      }).allowed
    ).toBe(true);
  });

  it("binds once grants and critical confirmations to the exact invocation", () => {
    const once = {
      ...grant(session, "fs.write", "allow", { invocationDigest: "ask-1" }),
      provenance: "critical-confirmation",
    } satisfies AuthorityGrant;
    const base = {
      context: sessionContext(),
      requirement: capability("session", "fs.write"),
      resourceKey: RESOURCE,
      grants: [once],
      now: 100,
      tier: "critical" as const,
    };
    expect(evaluateAuthority({ ...base, invocationDigest: "ask-2" }).allowed).toBe(false);
    expect(evaluateAuthority({ ...base, invocationDigest: "ask-1" })).toMatchObject({
      allowed: true,
      grantId: once.id,
      consumable: true,
    });
  });

  it("never reuses a consumed invocation-bound grant at gated tier", () => {
    const consumed = {
      ...grant(session, "fs.write", "allow", { invocationDigest: "ask-1" }),
      consumedAt: 50,
    } satisfies AuthorityGrant;
    const fresh = {
      ...grant(session, "fs.write", "allow", { invocationDigest: "ask-1" }),
      id: "fresh-once",
    } satisfies AuthorityGrant;
    const input = {
      context: sessionContext(),
      requirement: capability("session", "fs.write"),
      resourceKey: RESOURCE,
      now: 100,
      tier: "gated" as const,
      invocationDigest: "ask-1",
    };

    expect(evaluateAuthority({ ...input, grants: [consumed] })).toMatchObject({
      allowed: false,
      code: "missing-grant",
    });
    expect(evaluateAuthority({ ...input, grants: [consumed, fresh] })).toMatchObject({
      allowed: true,
      grantId: "fresh-once",
      consumable: true,
    });
  });

  it("intersects installed-code critical requests with a session-scoped confirmation", () => {
    const confirmation = {
      ...grant(session, "fs.write", "allow", {
        sessionId: "s1",
        invocationDigest: "critical-ask",
      }),
      provenance: "critical-confirmation",
    } satisfies AuthorityGrant;
    const base = {
      context: codeContext(),
      requirement: allOf(capability("code", "fs.write"), relationship("workspace-member")),
      resourceKey: RESOURCE,
      grants: [confirmation],
      now: 100,
      tier: "critical" as const,
      invocationDigest: "critical-ask",
    };

    expect(evaluateAuthority(base)).toMatchObject({
      allowed: true,
      grantId: confirmation.id,
      consumable: true,
    });

    const undeclared = codeContext();
    undeclared.executingCode = { ...undeclared.executingCode!, requested: [] };
    expect(evaluateAuthority({ ...base, context: undeclared })).toMatchObject({
      allowed: false,
      code: "not-requested",
    });
  });

  it("does not accept an altered installed-unit execution digest", () => {
    const altered = `code:workers/example@${"d".repeat(64)}` as `code:${string}`;
    expect(
      evaluateAuthority({
        context: codeContext(),
        requirement: capability("code", "fs.write"),
        resourceKey: RESOURCE,
        grants: [grant(altered)],
        now: 100,
      })
    ).toMatchObject({ allowed: false, code: "missing-grant", principal: code });
  });

  it("uses live relationship resolution instead of cached membership", () => {
    expect(
      evaluateAuthority({
        context: codeContext(),
        requirement: relationship("workspace-member"),
        resourceKey: "workspace:ws-1",
        grants: [],
        now: 100,
        relation: () => false,
      })
    ).toMatchObject({ allowed: false, code: "relationship" });
  });
});
