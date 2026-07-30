import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AttachedHostExecutionFact, CapabilityScope } from "@vibestudio/rpc";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "./serviceDispatcher.js";
import { sha256Canonical } from "./authority/invocationSnapshot.js";
import { createTestExecutionSession, testAuthority } from "./serviceDispatcherTestUtils.js";

const CAPABILITY = "workspace.file.write";
const RESOURCE = "context:one/file.txt";

function attachedFact(
  authorityCeiling: readonly CapabilityScope[],
  overrides: Partial<AttachedHostExecutionFact> = {}
): AttachedHostExecutionFact {
  return {
    v: 1,
    sessionId: "attached-one",
    requestId: "attached-request-one",
    parentHostId: "host:parent",
    childHostId: "host:child",
    childGenerationId: "0123456789abcdef0123456789abcdef",
    developmentRunId: "development-one",
    ownerRuntimeId: "agent:one",
    ownerRuntimeKind: overrides.ownerRuntimeKind ?? "agent",
    ownerUserId: "usr_one",
    authorityCeiling,
    authorityCeilingDigest: sha256Canonical(authorityCeiling),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

function setup(attachedHost: AttachedHostExecutionFact, throughEvalSession = false) {
  const executionSession = createTestExecutionSession({
    runtimeId: "do:eval:attached",
    agentBinding: null,
  });
  if (throughEvalSession) executionSession.attachedHost = attachedHost;
  const caller = createVerifiedCaller(
    "do:eval:attached",
    "do",
    null,
    null,
    { userId: "usr_one", handle: "one" },
    executionSession
  );
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(({ caller: resolvedCaller }) => {
    const resolved = testAuthority(resolvedCaller, CAPABILITY, RESOURCE);
    return {
      ...resolved,
      grants: resolved.grants.map((grant) => ({
        ...grant,
        resource: { kind: "prefix" as const, prefix: "context:" },
      })),
    };
  });
  dispatcher.setAuthorityAcquirer({
    request: vi.fn(),
    acquire: vi.fn(),
    consume: vi.fn(() => true),
    invalidate: vi.fn(),
  });
  const handler = vi.fn(async () => "written");
  dispatcher.registerService({
    name: "attachedTest",
    description: "attached route test",
    authority: { principals: ["session"] },
    methods: {
      write: {
        args: z.tuple([]),
        capability: CAPABILITY,
        tier: {
          tier: "gated",
          session: "family",
          rationale: "Attached-host authority test effect",
        },
        authority: {
          requirement: {
            kind: "capability",
            principal: "session",
            capability: CAPABILITY,
          },
          resource: { kind: "literal", key: RESOURCE },
        },
        access: { sensitivity: "write" },
      },
    },
    handler,
  });
  dispatcher.markInitialized();
  const context: ServiceContext = {
    caller,
    ...(throughEvalSession ? {} : { attachedHost }),
  };
  return { dispatcher, context, handler };
}

describe("attached-host canonical route ceiling", () => {
  it("admits an exact covered operation through the ordinary authority evaluator", async () => {
    const ceiling = [
      {
        capability: CAPABILITY,
        resource: { kind: "exact" as const, key: RESOURCE },
      },
    ];
    const { dispatcher, context } = setup(attachedFact(ceiling));
    await expect(dispatcher.dispatch(context, "attachedTest", "write", [])).resolves.toBe(
      "written"
    );
  });

  it("intersects a direct routed call before a broad live grant can widen it", async () => {
    const ceiling = [
      {
        capability: "workspace.file.read",
        resource: { kind: "prefix" as const, prefix: "context:" },
      },
    ];
    const { dispatcher, context, handler } = setup(attachedFact(ceiling));
    await expect(dispatcher.dispatch(context, "attachedTest", "write", [])).rejects.toMatchObject({
      code: "EROUTECEILING",
      errorData: {
        authorityFailure: { reasonCode: "attached-route-ceiling-denied" },
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("carries the same immutable ceiling into child eval service calls", async () => {
    const ceiling = [
      {
        capability: "workspace.file.read",
        resource: { kind: "prefix" as const, prefix: "context:" },
      },
    ];
    const { dispatcher, context } = setup(attachedFact(ceiling), true);
    await expect(dispatcher.dispatch(context, "attachedTest", "write", [])).rejects.toMatchObject({
      code: "EROUTECEILING",
    });
  });

  it.each([
    ["expired", { expiresAt: Date.now() - 1 }],
    ["digest drift", { authorityCeilingDigest: "0".repeat(64) }],
  ])("fails closed for %s route provenance", async (_label, override) => {
    const ceiling = [
      {
        capability: CAPABILITY,
        resource: { kind: "exact" as const, key: RESOURCE },
      },
    ];
    const { dispatcher, context } = setup(attachedFact(ceiling, override));
    await expect(dispatcher.dispatch(context, "attachedTest", "write", [])).rejects.toMatchObject({
      code: "EROUTECEILING",
    });
  });
});
