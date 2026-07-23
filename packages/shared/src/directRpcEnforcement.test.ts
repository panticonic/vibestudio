import { describe, expect, it } from "vitest";
import type { AuthorizationContext, DirectAuthorityAttestation } from "@vibestudio/rpc";
import {
  DirectRpcNonceWindow,
  assertEventIntakeRules,
  directRpcDenial,
  eventIntakeAuthority,
} from "./directRpcEnforcement.js";

const code = `code:workers/test@${"a".repeat(64)}` as const;
const context: AuthorizationContext = {
  authorizingOrigin: { kind: "code", principal: code },
  host: null,
  actingUser: "user:test",
  entity: null,
  incarnation: null,
  executingCode: { principal: code, requested: [], sourceLineage: { class: "internal", externalKeys: [] } },
  initiatorChain: [code],
  ownerChain: ["user:test"],
  agentBinding: null,
  workspace: { workspaceId: "ws", member: true, role: "member", revision: "1" },
  session: { id: "s", audience: "do:x", version: "1", expiresAt: 10_000 },
  contextIntegrity: { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
};

function attestation(overrides: Partial<DirectAuthorityAttestation> = {}): DirectAuthorityAttestation {
  return {
    audience: "do:x",
    method: "read",
    effect: { kind: "runtime-intrinsic" },
    capability: "rpc:read",
    resourceKey: "do:x",
    issuedAt: 10,
    expiresAt: 1_000,
    nonce: "12345678-1234-4123-8123-123456789abc",
    context,
    grants: [],
    ...overrides,
  };
}

describe("directRpcDenial", () => {
  it("allows an open method without a manifest request or grant", () => {
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: attestation(),
        declaration: { tier: "open", principals: ["code"], sensitivity: "read", effect: { kind: "runtime-intrinsic" } },
        audience: "do:x",
        resourceKey: "do:x",
        capability: "rpc:read",
        now: 100,
      })
    ).toBeNull();
  });

  it("rejects a host effect stamp that differs from the sealed receiver declaration", () => {
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: attestation({ effect: { kind: "workspace-service" } }),
        declaration: {
          tier: "open",
          principals: ["code"],
          sensitivity: "read",
          effect: { kind: "runtime-intrinsic" },
        },
        audience: "do:x",
        resourceKey: "do:x",
        capability: "rpc:read",
        now: 100,
      })?.reason
    ).toContain("attested effect does not match");
  });

  it.each(["audience", "method", "resourceKey"] as const)("rejects a mismatched %s", (field) => {
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: attestation({ [field]: "other" }),
        declaration: { tier: "open", principals: ["code"], sensitivity: "read", effect: { kind: "runtime-intrinsic" } },
        audience: "do:x",
        resourceKey: "do:x",
        capability: "rpc:read",
        now: 100,
      })?.code
    ).toBe("EACCES");
  });

  it("enforces read-only after tier admission", () => {
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: attestation({ readOnly: true }),
        declaration: { tier: "open", principals: ["code"], sensitivity: "write", effect: { kind: "runtime-intrinsic" } },
        audience: "do:x",
        resourceKey: "do:x",
        capability: "rpc:read",
        now: 100,
      })?.code
    ).toBe("EVAL_READ_ONLY");
  });

  it("composes a live workspace-service declaration with receiver method authority", () => {
    const capability = "workspace-service:notes";
    const dynamicContext: AuthorizationContext = {
      ...context,
      executingCode: {
        ...context.executingCode!,
        requested: [{ capability, resource: { kind: "exact", key: "do:x" } }],
      },
    };
    const dynamic = attestation({
      effect: { kind: "workspace-service" },
      capability,
      context: dynamicContext,
      targetRequirement: { kind: "capability", principal: "code", capability },
      targetCapability: capability,
      targetTier: "gated",
      grants: [
        {
          subject: code,
          effect: "allow",
          capability,
          resource: { kind: "exact", key: "do:x" },
          issuedBy: "user:test",
          provenance: "acquisition",
          createdAt: 1,
        },
      ],
    });
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: dynamic,
        declaration: { tier: "open", principals: ["code", "user"], sensitivity: "read", effect: { kind: "workspace-service" } },
        audience: "do:x",
        resourceKey: "do:x",
        capability,
        now: 100,
      })
    ).toBeNull();
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: {
          ...dynamic,
          targetRequirement: { kind: "capability", principal: "user", capability },
        },
        declaration: { tier: "open", principals: ["code", "user"], sensitivity: "read", effect: { kind: "workspace-service" } },
        audience: "do:x",
        resourceKey: "do:x",
        capability,
        now: 100,
      })?.code
    ).toBe("EACCES");
  });

  it("binds a critical receiver confirmation to the host-stamped invocation digest", () => {
    const capability = "channel.members.remove";
    const invocationDigest = "d".repeat(64);
    const criticalContext: AuthorizationContext = {
      ...context,
      executingCode: {
        ...context.executingCode!,
        requested: [{ capability, resource: { kind: "exact", key: "do:x" } }],
      },
    };
    const critical = attestation({
      effect: { kind: "semantic", capability },
      capability,
      invocationDigest,
      context: criticalContext,
      grants: [{
        id: "grant-once",
        subject: code,
        effect: "allow",
        capability,
        resource: { kind: "exact", key: "do:x" },
        issuedBy: "user:test",
        provenance: "critical-confirmation",
        constraints: { invocationDigest },
        createdAt: 1,
      }],
    });
    const input = {
      kind: "call" as const,
      method: "read",
      caller: null,
      attestation: critical,
      declaration: {
        tier: "critical" as const,
        principals: ["code" as const],
        sensitivity: "destructive" as const,
        effect: { kind: "semantic" as const, capability },
      },
      audience: "do:x",
      resourceKey: "do:x",
      capability,
      now: 100,
    };
    expect(directRpcDenial(input)).toBeNull();
    expect(
      directRpcDenial({
        ...input,
        attestation: { ...critical, invocationDigest: "e".repeat(64) },
      })?.code
    ).toBe("EACCES");
  });

  it("consumes each attestation nonce at most once", () => {
    const window = new DirectRpcNonceWindow();
    expect(window.consume(attestation().nonce, 1_000, 100)).toBe(true);
    expect(window.consume(attestation().nonce, 1_000, 101)).toBe(false);
  });
});

describe("event intake", () => {
  it("selects a topic family and resolves instance requirements", () => {
    class Receiver {
      static eventIntake = [
        {
          topicPrefix: "channel:",
          tier: "open",
          sensitivity: "write",
          effect: { kind: "runtime-intrinsic" },
          requires: () => ({ kind: "capability", principal: "host", capability: "ignored" }) as const,
        },
      ] as const;
    }
    const receiver = new Receiver();
    expect(eventIntakeAuthority(receiver, "channel:updated")).toMatchObject({
      tier: "open",
      sensitivity: "write",
      requires: { kind: "capability", principal: "host" },
    });
    expect(eventIntakeAuthority(receiver, "other:event")).toBeNull();
  });

  it("rejects catch-all and ambiguous intake declarations", () => {
    expect(() =>
      assertEventIntakeRules({
        eventIntake: [
          { topicPrefix: "*", tier: "open", sensitivity: "write", effect: { kind: "runtime-intrinsic" }, principals: ["host"] },
        ],
      })
    ).toThrow(/cannot contain/);
    expect(() =>
      assertEventIntakeRules({
        eventIntake: [
          {
            topicPrefix: "channel:",
            tier: "open",
            sensitivity: "write",
            effect: { kind: "runtime-intrinsic" },
            principals: ["host"],
            requires: { kind: "capability", principal: "host", capability: "x" },
          },
        ],
      })
    ).toThrow(/exactly one/);
  });
});
