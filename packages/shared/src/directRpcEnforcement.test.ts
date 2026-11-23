import { describe, expect, it } from "vitest";
import type { AuthorizationContext } from "@vibestudio/rpc";
import type { DirectAuthorityAttestation } from "@vibestudio/rpc/internal";
import {
  allOf,
  anyOf,
  capability as requiredCapability,
  relationship,
} from "./authorityRequirements.js";
import {
  ATTESTATION_STALE_CODE,
  DIRECT_RPC_NONCE_LOCAL_TABLE,
  DirectCallNonceGate,
  DirectRpcNonceWindow,
  DurableDirectRpcNonceLedger,
  isStaleAttestationFailure,
  restampAttestation,
  retryOnStaleAttestation,
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
  it("keeps closed receivers closed to accepted website execution", () => {
    const scoped = {
      ...context,
      executionAuthority: {
        kind: "website" as const,
        website: {
          subject: "website:example" as const,
          userId: "user:test" as const,
          workspaceId: "ws",
          origin: "https://example.com",
          binding: { subject: "website:example" as const, generation: 1 },
        },
      },
    };
    expect(
      directRpcDenial({
        kind: "call",
        method: "read",
        caller: null,
        attestation: attestation({ context: scoped }),
        audience: "do:x",
        resourceKey: "do:x",
        capability: "rpc:read",
        now: 100,
        declaration: {
          website: { kind: "closed", reason: "Private state" },
          principals: ["code"],
          tier: "open",
          sensitivity: "read",
          effect: { kind: "open" },
        },
      })
    ).toMatchObject({ code: "EACCES", reason: "read: receiver is closed to websites" });
  });

  it("keeps service admission on the target object when a method protects a separate resource", () => {
    const audience = "do:workers/notes:Notes:main";
    const resourceKey = `notes:${audience}`;
    const capability = `userland:workers/notes/read#${"d".repeat(64)}`;
    const targetCapability = "workspace-service:notes";
    const methodGrant = {
      subject: code,
      effect: "allow" as const,
      capability,
      resource: { kind: "exact" as const, key: resourceKey },
      issuedBy: "user:test",
      provenance: "acquisition" as const,
      createdAt: 1,
    };
    const targetGrant = {
      ...methodGrant,
      capability: targetCapability,
      resource: { kind: "exact" as const, key: audience },
    };
    const effect = {
      kind: "userland-capability" as const,
      capability: "read",
      resource: { kind: "receiver-object" as const },
    };
    const authorization = attestation({
      audience,
      resourceKey,
      capability,
      effect,
      context: {
        ...context,
        executingCode: { ...context.executingCode!, requested: [methodGrant, targetGrant] },
      },
      targetCapability,
      targetTier: "gated",
      targetRequirement: requiredCapability("code", targetCapability),
      grants: [methodGrant, targetGrant],
    });
    const input = {
      kind: "call" as const,
      method: "read",
      caller: null,
      attestation: authorization,
      audience,
      resourceKey,
      capability,
      now: 100,
      declaration: {
        website: { kind: "closed" as const, reason: "Test receiver" },
        principals: ["code" as const],
        tier: "gated" as const,
        sensitivity: "read" as const,
        effect,
      },
    };
    expect(directRpcDenial(input)).toBeNull();
    expect(
      directRpcDenial({ ...input, attestation: { ...authorization, grants: [methodGrant] } })
    ).toMatchObject({ failure: { capability: targetCapability, resourceKey: audience } });
    expect(
      directRpcDenial({ ...input, attestation: { ...authorization, grants: [targetGrant] } })
    ).toMatchObject({ failure: { capability, resourceKey } });
    expect(
      directRpcDenial({
        ...input,
        attestation: {
          ...authorization,
          grants: [methodGrant, { ...targetGrant, resource: { kind: "exact", key: resourceKey } }],
        },
      })
    ).toMatchObject({ failure: { capability: targetCapability, resourceKey: audience } });
  });
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
  it("requires the actual receiver to opt in to a foreign workspace call", () => {
    const input = {
      kind: "call" as const,
      method: "read",
      caller: { workspaceId: "other" },
      attestation: attestation(),
      declaration: {
        website: {
          kind: "closed",
          reason: "This fixture is not exposed to website origins.",
        } as const,
        tier: "open" as const,
        principals: ["code" as const],
        sensitivity: "read" as const,
        effect: { kind: "open" as const },
      },
      audience: "do:x",
      resourceKey: "do:x",
      capability: "rpc:read",
      now: 100,
    };
    expect(directRpcDenial(input)).toMatchObject({
      code: "EACCES",
      reason: expect.stringContaining("cross-workspace"),
    });
    expect(
      directRpcDenial({ ...input, declaration: { ...input.declaration, crossWorkspace: true } })
    ).toBeNull();
    expect(directRpcDenial({ ...input, caller: { workspaceId: "ws" } })).toBeNull();
  });
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
          tier: "gated",
          requires: anyOf(
            requiredCapability("host", "browser-data.write"),
            requiredCapability("user", "browser-data.write"),
            allOf(
              requiredCapability("code", "browser-data.write"),
              relationship("code-source", "workers/test")
            )
          ),
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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

  it("admits committed host grants when the receiver clock precedes their audit timestamp", () => {
    const host = `host:${"b".repeat(64)}` as const;
    const audience = "do:vibestudio/internal:WorkspaceDO:ws";
    const capability = "workspace.runtime-state.manage";
    const effect = {
      kind: "host-capability" as const,
      capability,
      resource: { kind: "receiver-object" as const },
    };
    const authorization = attestation({
      audience,
      method: "entityAdvanceExecution",
      resourceKey: audience,
      capability,
      effect,
      issuedAt: 101,
      context: {
        ...context,
        authorizingOrigin: { kind: "host", principal: host },
        host,
        executingCode: null,
      },
      grants: [
        {
          subject: host,
          capability,
          resource: { kind: "exact", key: audience },
          effect: "allow",
          issuedBy: host,
          createdAt: 101,
          provenance: "reviewed-product-admission-v1",
        },
      ],
    });
    const input = {
      kind: "call" as const,
      method: "entityAdvanceExecution",
      caller: null,
      attestation: authorization,
      declaration: {
        website: { kind: "closed" as const, reason: "Internal runtime state" },
        tier: "gated" as const,
        principals: ["host" as const],
        sensitivity: "write" as const,
        effect,
      },
      audience,
      resourceKey: audience,
      capability,
      now: 100,
    };
    expect(directRpcDenial(input)).toBeNull();
    for (const state of [{ revokedAt: 100 }, { expiresAt: 100 }]) {
      expect(
        directRpcDenial({
          ...input,
          attestation: {
            ...authorization,
            grants: authorization.grants.map((grant) => ({ ...grant, ...state })),
          },
        })
      ).toMatchObject({ code: "EACCES" });
    }
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
        website: {
          kind: "closed",
          reason: "This fixture is not exposed to website origins.",
        } as const,
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
      website: {
        kind: "closed",
        reason: "This fixture is not exposed to website origins.",
      } as const,
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
          website: {
            kind: "closed",
            reason: "This fixture is not exposed to website origins.",
          } as const,
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
            website: {
              kind: "closed",
              reason: "This fixture is not exposed to website origins.",
            } as const,
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
            website: {
              kind: "closed",
              reason: "This fixture is not exposed to website origins.",
            } as const,
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

describe("DirectCallNonceGate", () => {
  /** A tiny in-memory stand-in for the nonce table. */
  function fakeLedger() {
    const rows = new Map<string, number>();
    let transactions = 0;
    const storage = {
      exec(query: string, ...b: unknown[]) {
        if (query.startsWith("CREATE")) return { toArray: () => [] };
        if (query.startsWith("DELETE")) {
          for (const [k, v] of rows) if (v <= (b[0] as number)) rows.delete(k);
          return { toArray: () => [] };
        }
        if (query.startsWith("SELECT")) {
          const hit =
            rows.has(b[0] as string) &&
            (b.length < 2 || rows.get(b[0] as string)! > (b[1] as number));
          return { toArray: () => (hit ? [{ nonce: b[0] }] : []) };
        }
        rows.set(b[0] as string, b[1] as number);
        return { toArray: () => [] };
      },
      transactionSync<T>(cb: () => T): T {
        transactions++;
        return cb();
      },
    };
    return {
      rows,
      ledger: new DurableDirectRpcNonceLedger(storage, { table: DIRECT_RPC_NONCE_LOCAL_TABLE }),
      transactions: () => transactions,
    };
  }
  const n = (i: number) => `12345678-1234-4123-8123-${String(i).padStart(12, "0")}`;
  const att = (i: number, issuedAt = 2_000) => ({
    nonce: n(i),
    issuedAt,
    expiresAt: issuedAt + 60_000,
  });

  it("admits a read from memory with no write, and refuses a repeat", () => {
    const f = fakeLedger();
    const gate = new DirectCallNonceGate(f.ledger, { dolt: true, activatedAt: 1_000 });
    expect(gate.admit(att(1), false, 2_000)).toEqual({ ok: true, pending: null });
    expect(gate.admit(att(1), false, 2_001)).toEqual({ ok: false, reason: "replayed" });
    expect(f.transactions()).toBe(0);
    expect(f.rows.size).toBe(0);
  });

  it("refuses a request issued at or before the activation as stale (a replay after a restart)", () => {
    const gate = new DirectCallNonceGate(fakeLedger().ledger, { dolt: true, activatedAt: 5_000 });
    expect(gate.admit(att(1, 4_999), false, 5_100)).toEqual({ ok: false, reason: "stale" });
    expect(gate.admit(att(2, 5_000), true, 5_100)).toEqual({ ok: false, reason: "stale" });
    expect(gate.admit(att(3, 5_001), true, 5_100).ok).toBe(true);
  });

  it("a mutating call hands back a pending nonce the call's own transaction records", () => {
    const f = fakeLedger();
    const gate = new DirectCallNonceGate(f.ledger, { dolt: true, activatedAt: 1_000 });
    const admitted = gate.admit(att(1), true, 2_000);
    if (!admitted.ok || !admitted.pending) throw new Error("expected a pending nonce");
    expect(f.rows.size).toBe(0);
    gate.recordInTransaction(admitted.pending, 2_000);
    expect(f.rows.get(n(1))).toBe(62_000);
    expect(f.transactions()).toBe(0); // it ran inside the caller's transaction
    // A later activation, whatever its floor, still finds the durable record.
    const later = new DirectCallNonceGate(f.ledger, { dolt: true, activatedAt: 1_000 });
    expect(later.admit(att(1), true, 2_100)).toEqual({ ok: false, reason: "replayed" });
  });

  it("records a pending nonce standalone when no transaction carried it", () => {
    const f = fakeLedger();
    const gate = new DirectCallNonceGate(f.ledger, { dolt: true, activatedAt: 1_000 });
    const admitted = gate.admit(att(1), true, 2_000);
    if (!admitted.ok || !admitted.pending) throw new Error("expected a pending nonce");
    gate.recordStandalone(admitted.pending, 2_000);
    expect(admitted.pending.persisted).toBe(true);
    expect(f.rows.has(n(1))).toBe(true);
  });

  it("a full set raises the floor instead of forgetting an unexpired nonce", () => {
    const gate = new DirectCallNonceGate(fakeLedger().ledger, {
      dolt: true,
      activatedAt: 1_000,
      capacity: 2,
    });
    expect(gate.admit(att(1, 2_000), false, 2_000).ok).toBe(true);
    expect(gate.admit(att(2, 2_001), false, 2_001).ok).toBe(true);
    expect(gate.admit(att(3, 2_002), false, 2_002).ok).toBe(true); // evicts nonce 1, floor = 2_000
    // The evicted nonce is refused by the floor, not accepted again.
    expect(gate.admit(att(1, 2_000), false, 2_003)).toEqual({ ok: false, reason: "stale" });
    expect(gate.admit(att(2, 2_001), false, 2_003)).toEqual({ ok: false, reason: "replayed" });
  });

  it("refuses an expired or malformed attestation", () => {
    const gate = new DirectCallNonceGate(fakeLedger().ledger, { dolt: true, activatedAt: 1_000 });
    expect(gate.admit({ nonce: n(1), issuedAt: 2_000, expiresAt: 2_500 }, false, 3_000)).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(gate.admit({ nonce: "nope", issuedAt: 2_000, expiresAt: 9_000 }, false, 3_000)).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("a SQLite object keeps the durable ledger: every call is one recorded nonce", () => {
    const f = fakeLedger();
    const gate = new DirectCallNonceGate(f.ledger, { dolt: false, activatedAt: 1_000 });
    expect(gate.admit(att(1, 500), false, 2_000)).toEqual({ ok: true, pending: null }); // no floor
    expect(f.rows.has(n(1))).toBe(true);
    expect(gate.admit(att(1, 500), false, 2_001)).toEqual({ ok: false, reason: "replayed" });
  });

  it("the host re-stamps a stale refusal once, with the same nonce", async () => {
    const stale = Object.assign(new Error("stale"), { code: ATTESTATION_STALE_CODE });
    expect(isStaleAttestationFailure(stale)).toBe(true);
    expect(isStaleAttestationFailure(new Error("x"))).toBe(false);
    const first = { nonce: n(1), issuedAt: 100, expiresAt: 60_100 };
    const seen: number[] = [];
    const result = await retryOnStaleAttestation(first, async (a) => {
      seen.push(a!.issuedAt);
      if (seen.length === 1) throw stale;
      expect(a!.nonce).toBe(n(1));
      expect(a!.expiresAt - a!.issuedAt).toBe(60_000);
      return "ok";
    });
    expect(result).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(100);
    // Only one retry, and only for the stale refusal.
    let attempts = 0;
    await expect(
      retryOnStaleAttestation(first, async () => {
        attempts++;
        throw stale;
      })
    ).rejects.toBe(stale);
    expect(attempts).toBe(2);
    await expect(
      retryOnStaleAttestation(first, async () => {
        throw new Error("other");
      })
    ).rejects.toThrow("other");
    expect(restampAttestation(first, 500)).toEqual({
      nonce: n(1),
      issuedAt: 500,
      expiresAt: 60_500,
    });
  });
});
