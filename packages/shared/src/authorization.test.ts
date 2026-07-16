import { describe, expect, it } from "vitest";
import {
  allOf,
  capability,
  evaluateAuthority,
  relationship,
  type AuthorizationContext,
  type AuthorityGrant,
  type Principal,
} from "./authorization.js";

const user = "user:alice" as Principal;
const code = `code:workers/example@${"a".repeat(64)}` as Principal;
const entity = "entity:worker:example" as Principal;

function context(): AuthorizationContext {
  return {
    authorizingOrigin: { kind: "code", principal: code },
    host: null,
    actingUser: user,
    device: "device:laptop" as Principal,
    entity,
    incarnation: "inc:1",
    codeAuthority: {
      executor: {
        principal: code,
        requested: [
          {
            capability: "fs.write",
            resource: { kind: "exact", key: "workspace:ws-1/repo:projects/vibestudio" },
          },
        ],
      },
      execution: null,
      initiator: null,
      delegations: [],
    },
    deviceOwnership: {
      device: "device:laptop" as Principal,
      user,
      revision: "3",
    },
    ownerChain: [user],
    agentBinding: null,
    workspace: { workspaceId: "ws-1", member: true, role: "member", revision: "7" },
    session: { id: "s1", audience: "host", version: "2.1", expiresAt: 10_000 },
  };
}

function grant(subject: Principal, capabilityName: string, effect: "allow" | "deny" = "allow"):
  AuthorityGrant {
  return {
    subject,
    capability: capabilityName,
    resource: { kind: "exact", key: "workspace:ws-1/repo:projects/vibestudio" },
    effect,
    issuedBy: user,
    createdAt: 1,
    binding: { kind: "principal" },
    provenance: "test",
  };
}

describe("compositional authority", () => {
  it("intersects the authorizing code capability with live relationship facts", () => {
    const decision = evaluateAuthority({
      context: context(),
      requirement: allOf(
        capability("code", "fs.write"),
        relationship("workspace-member")
      ),
      resourceKey: "workspace:ws-1/repo:projects/vibestudio",
      grants: [grant(code, "fs.write")],
      now: 100,
    });
    expect(decision.allowed).toBe(true);
  });

  it("never lets acting-user grants authorize a code-originated branch", () => {
    const decision = evaluateAuthority({
      context: context(),
      requirement: {
        kind: "any",
        requirements: [
          capability("code", "fs.write"),
          capability("user", "workspace.edit"),
        ],
      },
      resourceKey: "workspace:ws-1/repo:projects/vibestudio",
      grants: [grant(user, "fs.write"), grant(user, "workspace.edit")],
      now: 100,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("lacks fs.write");
  });

  it("fails closed when an anyOf graph has no branch for the authorizing origin", () => {
    const decision = evaluateAuthority({
      context: context(),
      requirement: {
        kind: "any",
        requirements: [capability("user", "workspace.edit")],
      },
      resourceKey: "workspace:ws-1/repo:projects/vibestudio",
      grants: [grant(user, "workspace.edit")],
      now: 100,
    });
    expect(decision).toMatchObject({ allowed: false, code: "missing-principal" });
    expect(decision.reason).toContain("no authority branch admits the code origin");
  });

  it("applies exact-principal denies before allows", () => {
    const decision = evaluateAuthority({
      context: context(),
      requirement: capability("code", "fs.write"),
      resourceKey: "workspace:ws-1/repo:projects/vibestudio",
      grants: [grant(code, "fs.write"), grant(code, "fs.write", "deny")],
      now: 100,
    });
    expect(decision).toMatchObject({ allowed: false, code: "denied", principal: code });
  });

  it("does not turn workspace membership into a capability", () => {
    const decision = evaluateAuthority({
      context: context(),
      requirement: allOf(capability("code", "fs.write"), relationship("workspace-member")),
      resourceKey: "workspace:ws-1/repo:projects/vibestudio",
      grants: [],
      now: 100,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe("missing-grant");
  });

  it("requires code to request the granted capability in its exact manifest", () => {
    const ctx = context();
    ctx.codeAuthority.executor = { principal: code, requested: [] };
    const decision = evaluateAuthority({
      context: ctx,
      requirement: capability("code", "fs.write"),
      resourceKey: "workspace:ws-1/repo:projects/vibestudio",
      grants: [grant(code, "fs.write")],
      now: 100,
    });
    expect(decision).toMatchObject({ allowed: false, code: "not-requested" });
  });

  it("does not accept a grant issued to an altered execution digest", () => {
    const altered = `code:workers/example@${"b".repeat(64)}` as Principal;
    const decision = evaluateAuthority({
      context: context(),
      requirement: capability("code", "fs.write"),
      resourceKey: "workspace:ws-1/repo:projects/vibestudio",
      grants: [grant(altered, "fs.write")],
      now: 100,
    });
    expect(decision).toMatchObject({ allowed: false, code: "missing-grant", principal: code });
  });

  it("requires a verified ownership edge for a user-device relationship", () => {
    const ctx = context();
    ctx.deviceOwnership = {
      device: "device:attacker" as Principal,
      user,
      revision: "4",
    };
    const decision = evaluateAuthority({
      context: ctx,
      requirement: relationship("device-owned-by-user"),
      resourceKey: "workspace:ws-1",
      grants: [],
      now: 100,
    });
    expect(decision).toMatchObject({ allowed: false, code: "relationship" });
  });

  it("uses a live relationship resolver instead of cached membership", () => {
    const decision = evaluateAuthority({
      context: context(),
      requirement: relationship("workspace-member"),
      resourceKey: "workspace:ws-1",
      grants: [],
      now: 100,
      relation: () => false,
    });
    expect(decision).toMatchObject({ allowed: false, code: "relationship" });
  });

  it("requires an audience- and purpose-bound attenuated delegation", () => {
    const ctx = context();
    ctx.codeAuthority.delegations = [
      {
        id: "delegation-1",
        issuer: user,
        subject: code,
        audience: "another-host",
        purpose: "workspace-development",
        capabilities: [
          {
            capability: "fs.write",
            resource: { kind: "prefix", prefix: "workspace:ws-1" },
          },
        ],
        expiresAt: 1_000,
      },
    ];
    const decision = evaluateAuthority({
      context: ctx,
      requirement: capability("code", "fs.write", {
        audience: "host",
        purpose: "workspace-development",
        issuer: user,
      }),
      resourceKey: "workspace:ws-1/repo:projects/vibestudio",
      grants: [grant(code, "fs.write")],
      now: 100,
    });
    expect(decision).toMatchObject({ allowed: false, code: "delegation" });
  });

  it("honors revocation time and session constraints", () => {
    const bound = {
      ...grant(code, "fs.write"),
      revokedAt: 200,
      constraints: { sessionId: "s1", minVersion: "2.0", maxVersion: "2.2" },
    } satisfies AuthorityGrant;
    expect(
      evaluateAuthority({
        context: context(),
        requirement: capability("code", "fs.write"),
        resourceKey: "workspace:ws-1/repo:projects/vibestudio",
        grants: [bound],
        now: 100,
      }).allowed
    ).toBe(true);
    expect(
      evaluateAuthority({
        context: context(),
        requirement: capability("code", "fs.write"),
        resourceKey: "workspace:ws-1/repo:projects/vibestudio",
        grants: [bound],
        now: 200,
      }).code
    ).toBe("missing-grant");

    const wrongSession = context();
    wrongSession.session = { ...wrongSession.session, id: "s2" };
    expect(
      evaluateAuthority({
        context: wrongSession,
        requirement: capability("code", "fs.write"),
        resourceKey: "workspace:ws-1/repo:projects/vibestudio",
        grants: [bound],
        now: 100,
      }).code
    ).toBe("missing-grant");
  });
});
