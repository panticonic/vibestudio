import {
  createTestServiceDispatcher,
  testAuthority,
} from "@vibestudio/shared/serviceDispatcherTestUtils";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "./serviceDispatcher.js";
import { capability } from "./authorization.js";

describe("ServiceDispatcher host routing metadata", () => {
  it("routes registered services to the host unless their definition keeps the caller on-session", () => {
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService({
      name: "local",
      authority: { principals: ["user", "code"] },
      methods: {},
      handler: vi.fn(),
    });
    dispatcher.registerService({
      name: "session-owned",
      hostRouting: { panel: "session" },
      authority: { principals: ["user", "code"] },
      methods: {},
      handler: vi.fn(),
    });

    expect(dispatcher.routesToHost("local", "panel")).toBe(true);
    expect(dispatcher.routesToHost("session-owned", "panel")).toBe(false);
    expect(dispatcher.routesToHost("session-owned", "app")).toBe(true);
    expect(dispatcher.routesToHost("not-registered", "panel")).toBe(false);
  });

  it("separates the verified eval code caller from its initiator and transport deputy", async () => {
    const dispatcher = new ServiceDispatcher();
    const initiator = createVerifiedCaller("do:workers/agent:Agent:one", "do", {
      callerId: "do:workers/agent:Agent:one",
      callerKind: "do",
      repoPath: "workers/agent",
      executionDigest: "a".repeat(64),
      requested: [{ capability: "service:probe.who", resource: { kind: "prefix", prefix: "" } }],
      delegations: [],
    });
    const deputy = createVerifiedCaller("do:product/eval:EvalDO:run-1", "do", {
      callerId: "do:product/eval:EvalDO:run-1",
      callerKind: "do",
      repoPath: "product/eval",
      executionDigest: "b".repeat(64),
      requested: [],
      delegations: [],
    });
    const evaluatedCode = createVerifiedCaller(
      "do:product/eval:EvalDO:run-1",
      "do",
      {
        callerId: "do:product/eval:EvalDO:run-1",
        callerKind: "do",
        repoPath: "eval/run-1",
        executionDigest: "c".repeat(64),
        requested: [],
        delegations: [],
      }
    );
    dispatcher.setAuthorityResolver(({ capability, resourceKey }) => ({
      ...testAuthority(initiator, capability, resourceKey),
      authorizingCaller: initiator,
      effectiveCaller: evaluatedCode,
    }));
    dispatcher.registerService({
      name: "probe",
      authority: { principals: ["code"] },
      methods: {
        who: {
          args: z.tuple([]),
          returns: z.string(),
          access: { sensitivity: "read" },
        },
      },
      handler: async (ctx) => ctx.caller.runtime.id,
    });
    dispatcher.markInitialized();
    const ctx: ServiceContext = {
      caller: deputy,
      evalInvocation: { runId: "run-1", credential: "opaque", objectKey: "eval-1" },
    };

    await expect(dispatcher.dispatch(ctx, "probe", "who", [])).resolves.toBe(
      evaluatedCode.runtime.id
    );
    expect(ctx.caller).toBe(evaluatedCode);
    expect(ctx.authorizingCaller).toBe(initiator);
    expect(ctx.transportCaller).toBe(deputy);
    expect(ctx.evalInvocation?.credential).toBe("opaque");
  });

  it("returns false when a branch probe encounters a structured eval authority miss", async () => {
    const dispatcher = new ServiceDispatcher();
    const caller = createVerifiedCaller("do:product/eval:EvalDO:run-1", "do", {
      callerId: "do:product/eval:EvalDO:run-1",
      callerKind: "do",
      repoPath: "product/eval",
      executionDigest: "b".repeat(64),
      requested: [],
      delegations: [],
    });
    dispatcher.setAuthorityResolver(({ capability: requested, resourceKey }) => {
      if (requested === "panel-hosting") {
        throw Object.assign(new Error("not exposed to eval"), {
          code: "EVAL_CAPABILITY_CLOSED",
        });
      }
      return testAuthority(caller, requested, resourceKey);
    });
    dispatcher.registerService({
      name: "branchProbe",
      authority: { principals: ["code"] },
      methods: {
        inspect: { args: z.tuple([]), returns: z.boolean(), access: { sensitivity: "read" } },
      },
      handler: async (ctx) =>
        await ctx.authority?.allows({
          capability: "panel-hosting",
          resourceKey: "platform:panel-hosting",
          requirement: capability("code", "panel-hosting"),
        }),
    });
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(
        {
          caller,
          evalInvocation: { runId: "run-1", credential: "opaque", objectKey: "eval-1" },
        },
        "branchProbe",
        "inspect",
        []
      )
    ).resolves.toBe(false);
  });

  it("enforces only schema-declared leaves selected by a registered authority preparer", async () => {
    const dispatcher = new ServiceDispatcher();
    const caller = createVerifiedCaller("panel:prepared", "panel", {
      callerId: "panel:prepared",
      callerKind: "panel",
      repoPath: "panels/prepared",
      executionDigest: "c".repeat(64),
      requested: [{ capability: "*", resource: { kind: "prefix", prefix: "" } }],
      delegations: [],
    });
    const resolved: Array<{ capability: string; challengeTitle?: string }> = [];
    dispatcher.setAuthorityResolver(({ capability: requested, resourceKey, challenge }) => {
      resolved.push({ capability: requested, challengeTitle: challenge?.title });
      return testAuthority(caller, requested, resourceKey);
    });
    dispatcher.registerService({
      name: "prepared",
      authority: { principals: ["code"] },
      methods: {
        mutate: {
          args: z.tuple([z.string()]),
          returns: z.string(),
          access: { sensitivity: "write" },
          authority: {
            requirement: capability("code", "service:prepared.mutate"),
            resource: { kind: "literal", key: "service:prepared.mutate" },
            prepared: {
              resolver: "prepared.mutate",
              leaves: [
                {
                  capability: "prepared.review",
                  requirement: capability("code", "prepared.review"),
                  evalAcquisition: {
                    kind: "approval",
                    title: "Review prepared mutation",
                    description: "Review the exact prepared resource.",
                    operation: { kind: "unknown", verb: "Mutate" },
                    grantScopes: ["run"],
                  },
                },
              ],
            },
          },
        },
      },
      authorityPreparation: {
        "prepared.mutate": (_ctx, args) => [
          {
            capability: "prepared.review",
            resourceKey: `resource:${String(args[0])}`,
            challenge: {
              title: `Review ${String(args[0])}`,
              description: "Exact prepared review",
              deniedReason: "Denied",
              resource: { type: "test", label: "Resource", value: String(args[0]) },
              operation: {
                kind: "unknown",
                verb: "Mutate",
                object: { type: "test", label: "Resource", value: String(args[0]) },
              },
            },
          },
        ],
      },
      handler: async (_ctx, _method, args) => String(args[0]),
    });
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch({ caller }, "prepared", "mutate", ["alpha"])).resolves.toBe(
      "alpha"
    );
    expect(resolved).toEqual([
      { capability: "service:prepared.mutate", challengeTitle: undefined },
      { capability: "prepared.review", challengeTitle: "Review alpha" },
    ]);
  });

  it("rejects missing, unused, and undeclared authority preparation", async () => {
    const method = {
      args: z.tuple([]),
      access: { sensitivity: "read" as const },
      authority: {
        requirement: capability("code", "service:bad.read"),
        resource: { kind: "literal" as const, key: "service:bad.read" },
        prepared: {
          resolver: "missing",
          leaves: [
            {
              capability: "bad.extra",
              requirement: capability("code", "bad.extra"),
              evalAcquisition: { kind: "baseline" as const },
            },
          ],
        },
      },
    };
    expect(() =>
      new ServiceDispatcher().registerService({
        name: "bad",
        authority: { principals: ["code"] },
        methods: { read: method },
        handler: vi.fn(),
      })
    ).toThrow(/missing authority preparer/i);
    expect(() =>
      new ServiceDispatcher().registerService({
        name: "bad",
        authority: { principals: ["code"] },
        methods: { read: { args: z.tuple([]) } },
        authorityPreparation: { unused: () => [] },
        handler: vi.fn(),
      })
    ).toThrow(/unused authority preparer/i);
  });
});
