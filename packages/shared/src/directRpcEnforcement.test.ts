import { describe, expect, it } from "vitest";
import type { AuthorizationContext } from "@vibestudio/rpc";
import type { DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import {
  DirectRpcNonceWindow,
  assertEventIntakeRules,
  directRpcDenial,
  directRpcInvocationResourceKey,
  eventIntakeAuthority,
} from "./directRpcEnforcement.js";

const code = `code:workers/test@${"a".repeat(64)}` as const;
const context: AuthorizationContext = {
  authorizingOrigin: { kind: "code", principal: code },
  host: null,
  actingUser: "user:test",
  entity: null,
  incarnation: null,
  executingCode: {
    principal: code,
    requested: [],
    sourceLineage: { class: "internal", externalKeys: [] },
  },
  initiatorChain: [code],
  ownerChain: ["user:test"],
  agentBinding: null,
  executionSession: null,
  testPolicy: null,
  workspace: { workspaceId: "ws", member: true, role: "member", revision: "1" },
  session: { id: "s", audience: "do:x", version: "1", expiresAt: 10_000 },
  contextIntegrity: { class: "not-applicable", latchEpoch: 0, externalKeys: [] },
};

function attestation(
  overrides: Partial<DirectAuthorityAttestation> = {}
): DirectAuthorityAttestation {
  return {
    audience: "do:x",
    method: "read",
    effect: { kind: "open" },
    capability: "rpc:read",
    resourceKey: "do:x",
    issuedAt: 10,
    expiresAt: 1_000,
    nonce: "12345678-1234-4123-8123-123456789abc",
    context,
    grants: [],
    ...overrides,
    capabilityDefinitionDigest: overrides.capabilityDefinitionDigest ?? "-",
    resourceType: overrides.resourceType ?? "rpc:read",
    provider: overrides.provider ?? "-",
    providerExecutionDigest: overrides.providerExecutionDigest ?? "-",
  };
}

describe("directRpcInvocationResourceKey", () => {
  it("binds receiver-owned userland authority to its declared resource namespace", () => {
    const authorization = attestation({
      effect: {
        kind: "userland-capability",
        capability: "browser-data.write",
        resource: { kind: "receiver-object" },
      },
      capability: "userland:workers/browser-data/browser-data.write#digest",
      resourceType: "browser-data",
      resourceKey: "browser-data:do:workers/browser-data:BrowserDataDO:key",
    });
    expect(
      directRpcInvocationResourceKey({
        audience: "do:workers/browser-data:BrowserDataDO:key",
        declaration: {
          tier: "gated",
          sensitivity: "write",
          principals: ["code"],
          effect: authorization.effect,
        },
        attestation: authorization,
        args: [],
      })
    ).toBe("browser-data:do:workers/browser-data:BrowserDataDO:key");
  });

  it("keeps host and open receiver resources bound to the raw audience", () => {
    expect(
      directRpcInvocationResourceKey({
        audience: "do:workers/example:ExampleDO:key",
        declaration: {
          tier: "open",
          sensitivity: "read",
          principals: ["code"],
          effect: { kind: "open" },
        },
        attestation: attestation(),
        args: [],
      })
    ).toBe("do:workers/example:ExampleDO:key");
  });
});

describe("directRpcDenial", () => {
  it("identifies an undeclared receiver as a provider defect, not an acquirable grant", () => {
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: attestation(),
        declaration: null,
        audience: "do:x",
        resourceKey: "do:x",
        capability: "rpc:read",
        now: 100,
      })
    ).toMatchObject({
      code: "EACCES",
      failure: {
        reasonCode: "receiver-undeclared",
        remediation: { kind: "declare-rpc-receiver" },
      },
    });
  });

  it("allows an open method without a manifest request or grant", () => {
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: attestation(),
        declaration: {
          tier: "open",
          principals: ["code"],
          sensitivity: "read",
          effect: { kind: "open" },
        },
        audience: "do:x",
        resourceKey: "do:x",
        capability: "rpc:read",
        now: 100,
      })
    ).toBeNull();
  });

  it("admits installed code that requested a canonical userland receiver capability", () => {
    const audience = "do:workers/browser-data:BrowserDataDO:key";
    const resourceKey = `browser-data:${audience}`;
    const capability = `userland:workers/browser-data/browser-data.write#${"d".repeat(64)}`;
    const effect = {
      kind: "userland-capability" as const,
      capability: "browser-data.write",
      resource: { kind: "receiver-object" as const },
    };
    const authorization = attestation({
      audience,
      method: "upsertImportJob",
      effect,
      capability,
      resourceKey,
      resourceType: "browser-data",
      capabilityDefinitionDigest: "d".repeat(64),
      provider: "workers/browser-data",
      providerExecutionDigest: "e".repeat(64),
      context: {
        ...context,
        executingCode: {
          ...context.executingCode!,
          requested: [{ capability, resource: { kind: "exact", key: resourceKey } }],
        },
      },
      grants: [
        {
          subject: code,
          effect: "allow",
          capability,
          resource: { kind: "exact", key: resourceKey },
          issuedBy: "user:test",
          provenance: "acquisition",
          createdAt: 1,
        },
      ],
    });

    expect(
      directRpcDenial({
        kind: "call",
        method: "upsertImportJob",
        caller: null,
        attestation: authorization,
        declaration: {
          tier: "gated",
          principals: ["code"],
          sensitivity: "write",
          effect,
        },
        audience,
        resourceKey,
        capability,
        now: 100,
      })
    ).toBeNull();
  });

  it("does not use attestation timestamps as an authority decision", () => {
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: attestation({ issuedAt: 200, expiresAt: 50 }),
        declaration: {
          tier: "open",
          principals: ["code"],
          sensitivity: "read",
          effect: { kind: "open" },
        },
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
        attestation: attestation({
          effect: {
            kind: "host-capability",
            capability: "files.read",
            resource: { kind: "receiver-object" },
          },
          capability: "files.read",
        }),
        declaration: {
          tier: "open",
          principals: ["code"],
          sensitivity: "read",
          effect: { kind: "open" },
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
        declaration: {
          tier: "open",
          principals: ["code"],
          sensitivity: "read",
          effect: { kind: "open" },
        },
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
        declaration: {
          tier: "open",
          principals: ["code"],
          sensitivity: "write",
          effect: { kind: "open" },
        },
        audience: "do:x",
        resourceKey: "do:x",
        capability: "rpc:read",
        now: 100,
      })
    ).toMatchObject({
      code: "EVAL_READ_ONLY",
      failure: {
        reasonCode: "eval-read-only",
        remediation: { kind: "use-writable-session" },
      },
    });
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
      effect: { kind: "open" },
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
        declaration: {
          tier: "open",
          principals: ["code", "user"],
          sensitivity: "read",
          effect: { kind: "open" },
        },
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
        declaration: {
          tier: "open",
          principals: ["code", "user"],
          sensitivity: "read",
          effect: { kind: "open" },
        },
        audience: "do:x",
        resourceKey: "do:x",
        capability,
        now: 100,
      })?.code
    ).toBe("EACCES");
  });

  it("accepts a declared live target without manufacturing a consent grant", () => {
    const capability = "workspace-service:gad.workspace";
    const dynamicContext: AuthorizationContext = {
      ...context,
      executingCode: {
        ...context.executingCode!,
        requested: [{ capability, resource: { kind: "exact", key: "do:x" } }],
      },
    };

    expect(
      directRpcDenial({
        kind: "call",
        method: "readGraph",
        caller: null,
        attestation: attestation({
          method: "readGraph",
          effect: { kind: "open" },
          capability,
          context: dynamicContext,
          targetRequirement: { kind: "capability", principal: "code", capability },
          targetCapability: capability,
          targetTier: "open",
          grants: [],
        }),
        declaration: {
          tier: "open",
          principals: ["code"],
          sensitivity: "read",
          effect: { kind: "open" },
        },
        audience: "do:x",
        resourceKey: "do:x",
        capability,
        now: 100,
      })
    ).toBeNull();
  });

  it("evaluates the live target against its own invocation-bound grant", () => {
    const capability = "workspace-service:notes";
    const methodDigest = "m".repeat(64);
    const targetDigest = "t".repeat(64);
    const dynamicContext: AuthorizationContext = {
      ...context,
      executingCode: {
        ...context.executingCode!,
        requested: [{ capability, resource: { kind: "exact", key: "do:x" } }],
      },
    };
    const dynamic = attestation({
      capability,
      context: dynamicContext,
      invocationDigest: methodDigest,
      targetInvocationDigest: targetDigest,
      targetRequirement: { kind: "capability", principal: "code", capability },
      targetCapability: capability,
      targetTier: "gated",
      grants: [
        {
          subject: code,
          effect: "allow",
          capability,
          resource: { kind: "exact", key: "do:x" },
          constraints: { invocationDigest: targetDigest },
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
        declaration: {
          tier: "open",
          principals: ["code"],
          sensitivity: "read",
          effect: { kind: "open" },
        },
        audience: "do:x",
        resourceKey: "do:x",
        capability,
        now: 100,
      })
    ).toBeNull();
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
      effect: {
        kind: "host-capability",
        capability,
        resource: { kind: "receiver-object" },
      },
      capability,
      invocationDigest,
      context: criticalContext,
      grants: [
        {
          id: "grant-once",
          subject: code,
          effect: "allow",
          capability,
          resource: { kind: "exact", key: "do:x" },
          issuedBy: "user:test",
          provenance: "critical-confirmation",
          constraints: { invocationDigest },
          createdAt: 1,
        },
      ],
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
        effect: {
          kind: "host-capability" as const,
          capability,
          resource: { kind: "receiver-object" as const },
        },
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

  it("pins only version-scoped userland grants to the receiver execution digest", () => {
    const canonical = `userland:workers/notes/notes.write#${"d".repeat(64)}`;
    const userlandContext: AuthorizationContext = {
      ...context,
      authorizingOrigin: { kind: "session", principal: "session:s" },
      executingCode: null,
    };
    const declaration = {
      tier: "gated" as const,
      principals: ["session" as const],
      sensitivity: "write" as const,
      effect: {
        kind: "userland-capability" as const,
        capability: "notes.write",
        resource: { kind: "receiver-object" as const },
      },
    };
    const base = attestation({
      effect: declaration.effect,
      capability: canonical,
      capabilityDefinitionDigest: "d".repeat(64),
      resourceType: "note-store",
      provider: "workers/notes",
      providerExecutionDigest: "a".repeat(64),
      context: userlandContext,
      grants: [
        {
          subject: "session:s",
          capability: canonical,
          resource: { kind: "exact", key: "note-store:do:x" },
          effect: "allow",
          issuedBy: "user:test",
          createdAt: 1,
          scope: "session",
          constraints: { sessionId: "s", lineageAtConsent: [] },
          provenance: "acquisition",
        },
      ],
      resourceKey: "note-store:do:x",
    });
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: base,
        declaration,
        audience: "do:x",
        resourceKey: "note-store:do:x",
        capability: canonical,
        now: 100,
      })
    ).toBeNull();

    const versionGrant = {
      ...base.grants[0]!,
      scope: "version" as const,
      constraints: {
        lineageAtConsent: [],
        providerExecutionDigest: "b".repeat(64),
      },
    };
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: { ...base, grants: [versionGrant] },
        declaration,
        audience: "do:x",
        resourceKey: "note-store:do:x",
        capability: canonical,
        now: 100,
      })
    ).toMatchObject({ code: "EACCES" });
  });

  it("consumes each attestation nonce at most once", () => {
    const window = new DirectRpcNonceWindow();
    expect(window.consume(attestation().nonce, 1_000, 100)).toBe(true);
    expect(window.consume(attestation().nonce, 1_000, 101)).toBe(false);
  });

  it("rejects a nonce after its retention bound because unusedness is no longer provable", () => {
    const window = new DirectRpcNonceWindow();
    expect(window.consume(attestation().nonce, 99, 100)).toBe(false);
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
          effect: { kind: "open" },
          requires: () =>
            ({ kind: "capability", principal: "host", capability: "ignored" }) as const,
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
          {
            topicPrefix: "*",
            tier: "open",
            sensitivity: "write",
            effect: { kind: "open" },
            principals: ["host"],
          },
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
            effect: { kind: "open" },
            principals: ["host"],
            requires: { kind: "capability", principal: "host", capability: "x" },
          },
        ],
      })
    ).toThrow(/exactly one/);
  });
});
