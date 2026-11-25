import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "./serviceDispatcher.js";
import { createTestExecutionSession, testAuthority } from "./serviceDispatcherTestUtils.js";

function setup(input: {
  mode: "adaptive" | "strict";
  approvals: "prompt" | "pregranted-only";
  requests?: Array<{ capability: string; resource: { kind: "exact"; key: string } }>;
  granted: boolean;
  testPolicy?: boolean;
  testDecision?: "once" | "deny";
  capability?: string;
  nativeReferenceOnly?: boolean;
}) {
  const capability = input.capability ?? "workspace.file.write";
  const resourceKey = "context:one/file.txt";
  const session = createTestExecutionSession({
    runtimeId: "do:eval:one",
    agentBinding: null,
    ...(input.testPolicy
      ? {
          testPolicy: {
            policyId: "policy:manifest-test",
            kind: "case" as const,
            orchestratorPolicyId: "policy:orchestrator",
            case: {
              testId: "manifest-test",
              agent: {
                model: "test:model",
                approvalLevel: 2 as const,
                fallback: "disabled" as const,
              },
              authority: [
                {
                  ruleId: "manifest-write",
                  capability: { kind: "exact" as const, key: capability },
                  resource: { kind: "exact" as const, key: resourceKey },
                  tier: "gated" as const,
                  decision: input.testDecision ?? "once" as const,
                },
              ],
              unexpectedPrompts: "fail" as const,
            },
          },
        }
      : {}),
  });
  session.executor.authorityManifest = {
    mode: input.mode,
    effects: "read-write",
    approvals: input.approvals,
    requests: input.requests ?? [],
    digest: "a".repeat(64),
  };
  const caller = createVerifiedCaller(
    "do:eval:one",
    "do",
    null,
    null,
    { userId: "one", handle: "one" },
    session
  );
  const dispatcher = new ServiceDispatcher({nativeReferenceOnly:input.nativeReferenceOnly});
  let granted = input.granted;
  dispatcher.setAuthorityResolver(({ caller: resolvedCaller }) => {
    const resolved = testAuthority(resolvedCaller, capability, resourceKey);
    return { ...resolved, grants: granted ? resolved.grants : [] };
  });
  const request = vi.fn(() => {
    throw new Error("approval queue must not be reached");
  });
  dispatcher.setAuthorityAcquirer({
    request,
    acquire: vi.fn(async () => {
      granted = true;
      return { state: "decided" as const, decision: "once" as const };
    }),
    consume: vi.fn(),
    invalidate: vi.fn(),
  });
  const handler = vi.fn(async () => "written");
  dispatcher.registerService({
    name: "manifestTest",
    description: "manifest test",
    authority: { principals: ["session"] },
    methods: {
      write: {
        website: {
          kind: "closed",
          reason: "This fixture is not exposed to website origins.",
        } as const,
        args: z.tuple([]),
        capability,
        tier: {
          tier: "gated",
          session: "family",
          rationale: "Evaluated-run authority test effect",
        },
        authority: {
          requirement: {
            kind: "capability",
            principal: "session",
            capability,
          },
          resource: { kind: "literal", key: resourceKey },
        },
        access: { sensitivity: "write" },
      },
    },
    handler,
  });
  dispatcher.markInitialized();
  const context: ServiceContext = { caller };
  return { dispatcher, context, handler, request, capability, resourceKey };
}

describe("evaluated-run authority ceiling", () => {
  it.each(["model.use", "internal-model-runtime.use"])("process ceiling denies %s without a resident case policy, including existing grants", async capability => {
    const {dispatcher,context,handler,request}=setup({mode:"adaptive",approvals:"prompt",granted:true,capability,nativeReferenceOnly:true});
    await expect(dispatcher.dispatch(context,"manifestTest","write",[])).rejects.toMatchObject({code:"ENATIVEREFERENCEONLY",errorData:{authorityFailure:{remediation:{kind:"respect-denial"}}}});
    const preflight=await dispatcher.preflightAuthority(context,"manifestTest","write",[]);
    expect(preflight.leaves[0]?.status).toBe("denied");
    expect(handler).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
  });
  it("process ceiling preserves exact non-model credential grants",async()=>{
    const {dispatcher,context,handler}=setup({mode:"adaptive",approvals:"prompt",granted:true,capability:"credential.use",nativeReferenceOnly:true});
    await dispatcher.dispatch(context,"manifestTest","write",[]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it.each(["model.use", "credential.use", "internal-model-runtime.use"])("denies explicit native-reference %s despite a preexisting grant", async capability => {
    const {dispatcher,context,handler,request}=setup({mode:"adaptive",approvals:"prompt",granted:true,testPolicy:true,testDecision:"deny",capability});
    await expect(dispatcher.dispatch(context,"manifestTest","write",[])).rejects.toMatchObject({code:"ETESTPOLICYDENIED",errorData:{authorityFailure:{remediation:{kind:"respect-denial"}}}});
    expect(handler).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
    const preflight=await dispatcher.preflightAuthority(context,"manifestTest","write",[]);
    expect(preflight.leaves).toEqual(expect.arrayContaining([expect.objectContaining({status:"denied",failure:expect.objectContaining({remediation:expect.objectContaining({kind:"respect-denial"})})})]));
  });
  it("returns typed writable-session recovery for a read-only eval", async () => {
    const { dispatcher, context, handler } = setup({
      mode: "adaptive",
      approvals: "prompt",
      granted: true,
    });
    context.readOnly = true;

    await expect(dispatcher.dispatch(context, "manifestTest", "write", [])).rejects.toMatchObject({
      code: "EVAL_READ_ONLY",
      errorData: {
        authorityFailure: {
          reasonCode: "eval-read-only",
          remediation: {
            kind: "use-writable-session",
            message: expect.stringContaining('authority.effects set to "read-write"'),
          },
        },
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies strict missing coverage before a broad live grant can widen the run", async () => {
    const { dispatcher, context, handler } = setup({
      mode: "strict",
      approvals: "prompt",
      granted: true,
    });
    await expect(dispatcher.dispatch(context, "manifestTest", "write", [])).rejects.toMatchObject({
      code: "ERUNMANIFEST",
      errorData: {
        authorityFailure: { reasonCode: "run-manifest-denied" },
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("admits an exact strict request through the ordinary grant intersection", async () => {
    const configured = setup({
      mode: "strict",
      approvals: "prompt",
      granted: true,
      requests: [
        {
          capability: "workspace.file.write",
          resource: { kind: "exact", key: "context:one/file.txt" },
        },
      ],
    });
    await expect(
      configured.dispatcher.dispatch(configured.context, "manifestTest", "write", [])
    ).resolves.toBe("written");
  });

  it("never enqueues an approval for pregranted-only runs", async () => {
    const { dispatcher, context, request } = setup({
      mode: "adaptive",
      approvals: "pregranted-only",
      granted: false,
    });
    await expect(dispatcher.dispatch(context, "manifestTest", "write", [])).rejects.toMatchObject({
      code: "ERUNPREGRANTED",
      errorData: {
        authorityFailure: { reasonCode: "run-pregranted-only" },
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("accepts host-attested test preauthorization without presenting a human prompt", async () => {
    const { dispatcher, context, request } = setup({
      mode: "adaptive",
      approvals: "pregranted-only",
      granted: false,
      testPolicy: true,
    });
    await expect(dispatcher.dispatch(context, "manifestTest", "write", [])).resolves.toBe(
      "written"
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("does not let an asynchronous authority observer gate the authorized operation", async () => {
    const configured = setup({
      mode: "adaptive",
      approvals: "prompt",
      granted: false,
    });
    let release!: () => void;
    const blockedObservation = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observer = vi.fn(
      (_event: { kind: "authority-requested" | "authority-decided" }) => blockedObservation
    );
    configured.dispatcher.setAuthorityObserver(observer);

    await expect(
      configured.dispatcher.dispatch(configured.context, "manifestTest", "write", [])
    ).resolves.toBe("written");
    expect(observer.mock.calls.map(([observed]) => observed.kind)).toEqual([
      "authority-requested",
      "authority-decided",
    ]);

    release();
    await blockedObservation;
  });
});
