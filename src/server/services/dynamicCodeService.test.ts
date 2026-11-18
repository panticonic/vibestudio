import { parseSha256 } from "@vibestudio/shared/execution/identity";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { ledgerTest } from "../../../tests/helpers/ledgerTest.js";
import {
  createVerifiedCaller,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import { createDynamicCodeService } from "./dynamicCodeService.js";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
import { TaskAuthorityRegistry } from "./taskAuthorityRegistry.js";
import { createActivityRegistry } from "./activityRegistry.js";
import { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { workspaceStateEngineMethods } from "@vibestudio/service-schemas/workspaceStateEngine";
import type { EvalStartInput } from "@vibestudio/service-schemas/eval";

function activatedEntity(input: unknown): EntityRecord {
  const {
    durableWorkQueues: _durableWorkQueues,
    nativeOwner: _nativeOwner,
    ...spec
  } = workspaceStateEngineMethods.entityActivate.args.parse([input])[0];
  return workspaceStateEngineMethods.entityActivate.returns.parse({
    ...spec,
    id: canonicalEntityId({ ...spec, source: spec.source.repoPath }),
    authoritySessionId: "authority:eval-activation",
    createdAt: 0,
    status: "active",
    cleanupComplete: true,
  });
}

const WORKSPACE_REF = {
  source: INTERNAL_DO_SOURCE,
  className: "WorkspaceStateDO",
  objectKey: "ws_1",
};
const SESSION_SOURCE = "workers/session";
const SESSION_CLASS = "SessionDO";
const sessionContentRoots = [{ repoPath: SESSION_SOURCE, stateHash: `state:${"e".repeat(64)}` }];
const sessionArtifactUnsigned = {
  version: 1 as const,
  sourceState: {
    kind: "workspace" as const,
    workspaceId: "ws_1",
    effectiveVersion: parseSha256("1".repeat(64), "test effective version"),
    state: { kind: "event" as const, eventId: "event:session" },
    contentRoots: sessionContentRoots,
    sourceClosureDigest: executionSourceClosureDigest(sessionContentRoots),
  },
  recipeDigest: parseSha256("2".repeat(64), "test recipe"),
  buildKey: parseSha256("2".repeat(64), "test build key"),
  artifactDigest: parseSha256("3".repeat(64), "test artifact"),
};
/** The sealed image of the session entity that hosts a kernel (an owner with no code of its own is mediated by it). */
const EVAL_EXECUTION_IDENTITY = {
  effectiveVersion: sessionArtifactUnsigned.sourceState.effectiveVersion,
  buildKey: sessionArtifactUnsigned.buildKey,
  executionDigest: executionArtifactDigest(sessionArtifactUnsigned),
  authority: { requests: [], provides: [] },
  source: SESSION_SOURCE,
  artifact: {
    ...sessionArtifactUnsigned,
    executionDigest: executionArtifactDigest(sessionArtifactUnsigned),
  } as ExecutionArtifactRefV1,
};

/** The record `runtime.createEntity` leaves for a session entity of an owner. */
function sessionRecord(
  spec: { key?: string; contextId?: string | null },
  ownerId: string
): EntityRecord {
  return {
    id: `do:workers/session:SessionDO:${spec.key}`,
    kind: "do",
    source: {
      repoPath: SESSION_SOURCE,
      effectiveVersion: EVAL_EXECUTION_IDENTITY.effectiveVersion,
    },
    contextId: spec.contextId ?? "ctx",
    className: SESSION_CLASS,
    key: spec.key,
    activeBuildKey: EVAL_EXECUTION_IDENTITY.buildKey,
    activeExecutionDigest: EVAL_EXECUTION_IDENTITY.executionDigest,
    activeAuthority: EVAL_EXECUTION_IDENTITY.authority,
    parentId: ownerId,
    stateArgs: {
      principalId: ownerId,
      ownerPrincipalId: ownerId,
      subKey: "default",
      agentExecutionAdmission: { v: 1, ownerId },
    },
    authoritySessionId: "authority:eval-test",
    createdAt: 0,
    status: "active",
    cleanupComplete: true,
  } as EntityRecord;
}

function evalKey(ownerId: string, subKey: string): string {
  return createHash("sha256").update(`${ownerId}\0${subKey}`).digest("hex").slice(0, 40);
}

function authenticatedCaller(
  callerId: string,
  callerKind: Parameters<typeof createVerifiedCaller>[1],
  code?: Parameters<typeof createVerifiedCaller>[2],
  agentBinding?: Parameters<typeof createVerifiedCaller>[3]
): VerifiedCaller {
  return createVerifiedCaller(callerId, callerKind, code, agentBinding, {
    userId: "usr_test",
    handle: "test",
  });
}

function activeInvocationContext(
  caller: VerifiedCaller,
  channelId = "chan_1",
  invocationId = "invocation:test"
): ServiceContext {
  const trajectory = channelTrajectoryFor(channelId);
  return {
    caller,
    causalParent: {
      kind: "trajectory-invocation",
      logId: trajectory.logId,
      head: trajectory.head,
      invocationId,
    },
  };
}

function inlineEvalStart(
  input: Omit<EvalStartInput, "source" | "scope"> & {
    code: string;
    scopeKey?: string;
    lifecycle?: "persistent" | "finite";
    syntax?: "javascript" | "typescript" | "jsx" | "tsx";
    pathHint?: string;
  }
): EvalStartInput {
  const { code, scopeKey, lifecycle, syntax, pathHint, ...rest } = input;
  return {
    ...rest,
    source: { kind: "inline", code, syntax, pathHint },
    ...(scopeKey || lifecycle ? { scope: { key: scopeKey ?? "default", lifecycle } } : {}),
  };
}

/**
 * What a caller does with the service: admit the run, then start it on the entity that hosts it
 * (`dynamicCode.admit`, then the session's own `start`). The controls are the service's own.
 */
function callerView(dynamicCode: ServiceDefinition, doDispatch: DODispatch) {
  return {
    handler: async (ctx: ServiceContext, method: string, args: unknown[]) => {
      if (method === "start") {
        const admission = (await dynamicCode.handler(ctx, "admit", args)) as {
          host: unknown;
          start: unknown;
          nonce: string;
        };
        await (doDispatch as unknown as { dispatch: DODispatch["dispatch"] }).dispatch(
          admission.host as never,
          "start",
          admission.start,
          admission.nonce
        );
        return admission;
      }
      return dynamicCode.handler(ctx, method, args);
    },
  };
}

function createHarness(
  contexts: Record<string, string | null>,
  options: {
    ownerRecord?: EntityRecord;
    ownerArtifact?: ExecutionArtifactRefV1 | null;
    rejectStartRun?: Error;
    finiteEvalEntityIds?: ReadonlySet<string>;
    retiredEvalEntityIds?: ReadonlySet<string>;
    preauthorize?: Parameters<typeof createDynamicCodeService>[0]["preauthorize"];
    /** The session entity's `get` fails with this (a run it never heard of). */
    getRunError?: Error;
    systemTestHarness?: boolean;
    executeRunPending?: boolean;
    cancel?: (runId: string) => Promise<void>;
    getRunSequence?: Array<{
      status: "pending" | "running" | "cancelling" | "done" | "cancelled" | "unknown";
      gate?: Promise<void>;
    }>;
    /** A retired product EvalDO notebook is still recorded active for every scope (D5). */
    legacyNotebook?: boolean;
  } = {}
) {
  const calls: Array<{ ref: unknown; method: string; args: unknown[] }> = [];
  let getRunSequenceIndex = 0;
  const doDispatch = {
    async dispatchHeld(
      this: { dispatch: (ref: unknown, method: string, ...args: unknown[]) => Promise<unknown> },
      ref: unknown,
      method: string,
      ...args: unknown[]
    ) {
      return this.dispatch(ref, method, ...args);
    },
    async dispatch(ref: unknown, rawMethod: string, ...rawArgs: unknown[]) {
      // The host speaks to the session entity (get, cancel, reset); the caller's `start` is
      // played by the test shim below. The mock answers as the kernel, whose method names the
      // assertions use.
      let method = rawMethod;
      let args = rawArgs;
      if (rawMethod === "start") {
        method = "startRun";
        args = [rawArgs[0]];
      } else if (rawMethod === "get") method = "getRun";
      calls.push({ ref, method, args });
      if (method === "entityResolveContext") {
        return contexts[String(args[0])] ?? null;
      }
      if (method === "entityActivate") return activatedEntity(args[0]);
      if (method === "entityResolve") {
        const id = String(args[0]);
        if (id.startsWith(`do:workers/session:SessionDO:`) && contexts[id]) {
          return {
            id,
            kind: "do",
            source: { repoPath: SESSION_SOURCE, effectiveVersion: "test" },
            contextId: contexts[id],
            className: SESSION_CLASS,
            key: id.slice(id.lastIndexOf(":") + 1),
            authoritySessionId: "authority:eval-test",
            createdAt: 0,
            status: options.retiredEvalEntityIds?.has(id) ? "retired" : "active",
            cleanupComplete: true,
            ...(options.finiteEvalEntityIds?.has(id)
              ? {
                  stateArgs: {
                    ownerPrincipalId: "session:default",
                    subKey: "finite",
                    agentExecutionAdmission: { v: 1, ownerId: "session:default" },
                    lifecycle: "finite",
                  },
                }
              : {}),
          } satisfies EntityRecord;
        }
        // An owner known only by its context (a user or CLI session entity).
        if (contexts[id]) {
          return {
            id,
            kind: id.startsWith("do:") ? "do" : "session",
            source: { repoPath: "session", effectiveVersion: "test" },
            contextId: contexts[id],
            key: id,
            authoritySessionId: "authority:eval-test",
            createdAt: 0,
            status: "active",
            cleanupComplete: true,
          } satisfies EntityRecord;
        }
        // No other lineage in the mock → resolveParentPanel walk ends with no parent.
        return null;
      }
      if (method === "slotResolveByEntity") {
        // No panel slots in the mock → resolveParentPanel resolves to no owning panel.
        return null;
      }
      if (method === "runtimeResourceBindingsForEntity") return [];
      if (method === "run") {
        return { success: true, console: "", scopeKeys: [] };
      }
      if (method === "reset") {
        return { ok: true };
      }
      if (method === "dispose") {
        return { ok: true };
      }
      if (method === "cancel") {
        await options.cancel?.(String(args[0]));
        return { ok: true, forcedReset: false };
      }
      if (method === "startRun") {
        if (options.rejectStartRun) throw options.rejectStartRun;
        return {
          runId: (args[0] as { runId: string }).runId,
          runDigest: "d".repeat(64),
          scopeInputRevision: "scope:initial",
          status: "pending",
          existing: false,
        };
      }
      if (method === "executeRun") {
        if (options.executeRunPending) return new Promise(() => {});
        return { success: true, console: "ok", scopeKeys: [] };
      }
      if (method === "getRun") {
        if (options.getRunError) throw options.getRunError;
        const sequenced =
          options.getRunSequence?.[
            Math.min(getRunSequenceIndex++, options.getRunSequence.length - 1)
          ];
        if (sequenced) {
          if (sequenced.gate) await sequenced.gate;
          return { status: sequenced.status };
        }
        return { status: "done", result: { success: true, console: "", scopeKeys: [] } };
      }
      throw new Error(`unexpected dispatch ${method}`);
    },
  } as unknown as DODispatch;
  // A real store over the mocked dispatch + cache: entity ops (activate /
  // resolveContext) flow through it to `doDispatch`, so `calls` still captures
  // them — exactly the path the eval service exercises in production.
  const entityCache = new EntityCache();
  const resolveContext = entityCache.resolveContext.bind(entityCache);
  entityCache.resolveContext = (id) =>
    Object.hasOwn(contexts, id) ? (contexts[id] ?? null) : resolveContext(id);
  const resolveActive = entityCache.resolveActive.bind(entityCache);
  entityCache.resolveActive = (id) => {
    if (options.retiredEvalEntityIds?.has(id)) return null;
    if (options.legacyNotebook && id.startsWith("do:vibestudio/internal:EvalDO:"))
      return {
        id,
        kind: "do",
        source: { repoPath: "vibestudio/internal", effectiveVersion: "internal" },
        contextId: "ctx_agent",
        className: "EvalDO",
        key: id.slice(id.lastIndexOf(":") + 1),
        authoritySessionId: "authority:eval-test",
        createdAt: 0,
        status: "active",
        cleanupComplete: true,
      } satisfies EntityRecord;
    if (options.ownerRecord?.id === id) return options.ownerRecord;
    const contextId = contexts[id];
    if (contextId == null || !id.startsWith("do:")) return resolveActive(id);
    if (id.startsWith(`do:workers/session:SessionDO:`)) {
      const finite = options.finiteEvalEntityIds?.has(id) === true;
      return {
        id,
        kind: "do",
        source: {
          repoPath: SESSION_SOURCE,
          effectiveVersion: EVAL_EXECUTION_IDENTITY.effectiveVersion,
        },
        contextId,
        className: SESSION_CLASS,
        key: id.slice(id.lastIndexOf(":") + 1),
        activeBuildKey: EVAL_EXECUTION_IDENTITY.buildKey,
        activeExecutionDigest: EVAL_EXECUTION_IDENTITY.executionDigest,
        activeAuthority: EVAL_EXECUTION_IDENTITY.authority,
        parentId: "session:default",
        stateArgs: {
          ownerPrincipalId: "session:default",
          subKey: finite ? "finite" : "default",
          agentExecutionAdmission: { v: 1, ownerId: "session:default" },
          ...(finite ? { lifecycle: "finite" } : {}),
        },
        authoritySessionId: "authority:eval-test",
        createdAt: 0,
        status: "active",
        cleanupComplete: true,
      } satisfies EntityRecord;
    }
    return {
      id,
      kind: "do",
      source: { repoPath: "workers/agent-worker", effectiveVersion: "test" },
      contextId,
      className: "AiChatWorker",
      key: id,
      agentBinding: { entityId: `session:${id}`, contextId, channelId: "chan_1" },
      authoritySessionId: "authority:eval-test",
      createdAt: 0,
      status: "active",
      cleanupComplete: true,
    } satisfies EntityRecord;
  };
  const entityStore = new WorkspaceEntityStore({
    doDispatch,
    workspaceId: "ws_1",
    entityCache,
    resolveNativeOwner: () => null,
    resolveDurableWorkQueues: () => [],
    materializeExecution: async () => undefined,
  });
  const executionSessions = new AgentExecutionSessionRegistry();
  const taskAuthorities = new TaskAuthorityRegistry();
  const activity = createActivityRegistry();
  const retireEntity = vi.fn(async () => {});
  // `runtime.internal.createEntity`: records the spec and the caller whose lineage it joins,
  // and makes the session entity resolvable as the real path would.
  const createEntityMock = vi.fn(
    async (caller: VerifiedCaller, spec: { key?: string; contextId?: string | null }) => {
      const id = `do:workers/session:SessionDO:${spec.key}`;
      calls.push({ ref: null, method: "createEntity", args: [spec, caller.runtime.id] });
      contexts[id] = spec.contextId ?? null;
      return { id };
    }
  );
  let shutdown: (() => Promise<void>) | null = null;
  const resolveContextSource = vi.fn(async (_contextId: string, sourcePath: string, _ctx: ServiceContext) => ({
    code: `// exact:${sourcePath}\nreturn 7;`,
    sourceDigest: createHash("sha256").update(`// exact:${sourcePath}\nreturn 7;`).digest("hex"),
    sourceState: { kind: "event" as const, eventId: "event:source" },
    contentStateHash: `state:${"c".repeat(64)}`,
  }));
  const dynamicCode = createDynamicCodeService({
    resolveExecutionArtifact: () =>
      options.ownerArtifact === undefined
        ? EVAL_EXECUTION_IDENTITY.artifact
        : options.ownerArtifact,
    doDispatch,
    entityStore,
    createEntity: createEntityMock,
    retireEntity,
    workspaceId: "ws_1",
    ...(options.preauthorize ? { preauthorize: options.preauthorize } : {}),
    executionSessions,
    taskAuthorities,
    activity,
    onShutdown: (callback) => {
      shutdown = callback;
    },
    ...(options.systemTestHarness ? { isSystemTestHarness: () => true } : {}),
    resolveContextSource,
  });
  const service = callerView(dynamicCode, doDispatch);
  return {
    service,
    dynamicCode,
    calls,
    resolveContextSource,
    executionSessions,
    taskAuthorities,
    activity,
    retireEntity,
    shutdown: async () => {
      if (!shutdown) throw new Error("shutdown callback was not registered");
      await shutdown();
    },
  };
}

describe("dynamicCode admission", () => {
  it("cancels exact preauthorization with its owning admission and releases the scope for the next run", async () => {
    const controller = new AbortController();
    const originalFailure = new Error("Owning input cancelled");
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const preauthorize = vi.fn(async (ctx: ServiceContext) => {
      expect(ctx.signal).toBe(controller.signal);
      entered();
      await new Promise<void>((_resolve, reject) => {
        ctx.signal!.addEventListener("abort", () => reject(ctx.signal!.reason), { once: true });
      });
    });
    const ownerId = "do:workers/agent-worker:AiChatWorker:preauthorization-cancel";
    const harness = createHarness({ [ownerId]: "ctx_1" }, { preauthorize });
    const caller = authenticatedCaller(ownerId, "do", undefined, {
      entityId: ownerId,
      contextId: "ctx_1",
      channelId: "chan_1",
    });
    const ctx = { ...activeInvocationContext(caller), signal: controller.signal };
    const first = harness.service.handler(ctx, "start", [
      inlineEvalStart({
        runId: "run:cancelled-preauthorization",
        code: "return 1",
        authority: {
          preauthorize: [{ service: "permissions", method: "list", args: [] }],
        },
      }),
    ]);
    const rejected = expect(first).rejects.toBe(originalFailure);
    await ready;
    controller.abort(originalFailure);
    await rejected;
    expect(harness.activity.getActivity().activeRuns).toBe(0);
    await harness.service.handler(activeInvocationContext(caller), "start", [
      inlineEvalStart({
        runId: "run:after-preauthorization",
        code: "return 2",
      }),
    ]);
    expect(harness.calls.filter((call) => call.method === "startRun")).toHaveLength(1);
    await harness.shutdown();
  });

  it("retains the harness source tree rather than disguising its execution digest as a source ref", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:sealed-harness";
    const contentRoots = [
      { repoPath: "workers/agent-worker", stateHash: `state:${"b".repeat(64)}` },
    ];
    const unsigned = {
      version: 1 as const,
      sourceState: {
        kind: "workspace" as const,
        workspaceId: "ws_1",
        effectiveVersion: parseSha256("a".repeat(64), "test effective version"),
        state: { kind: "event" as const, eventId: "event:source" },
        contentRoots,
        sourceClosureDigest: executionSourceClosureDigest(contentRoots),
      },
      recipeDigest: parseSha256("c".repeat(64), "test recipe"),
      buildKey: parseSha256("c".repeat(64), "test build key"),
      artifactDigest: parseSha256("d".repeat(64), "test artifact"),
    };
    const ownerArtifact = { ...unsigned, executionDigest: executionArtifactDigest(unsigned) };
    const ownerRecord: EntityRecord = {
      id: ownerId,
      kind: "do",
      source: {
        repoPath: "workers/agent-worker",
        effectiveVersion: unsigned.sourceState.effectiveVersion,
      },
      contextId: "ctx_agent",
      className: "AiChatWorker",
      key: "sealed-harness",
      activeBuildKey: ownerArtifact.buildKey,
      activeExecutionDigest: ownerArtifact.executionDigest,
      activeAuthority: { requests: [], provides: [] },
      agentBinding: {
        entityId: "session:sealed-harness",
        contextId: "ctx_agent",
        channelId: "chan_1",
      },
      authoritySessionId: "authority:eval-test",
      createdAt: 0,
      status: "active",
      cleanupComplete: true,
    };
    const harness = createHarness(
      { [ownerId]: "ctx_agent" },
      { ownerRecord, ownerArtifact, executeRunPending: true }
    );
    await harness.service.handler(
      activeInvocationContext(authenticatedCaller(ownerId, "do")),
      "start",
      [inlineEvalStart({ scopeKey: "chan_1", runId: "run:sealed-source", code: "return 1;" })]
    );
    const objectKey = (
      harness.calls.find((call) => call.method === "startRun")?.ref as { objectKey: string }
    ).objectKey;
    const image = harness.executionSessions.resolve(
      `do:workers/session:SessionDO:${objectKey}`
    )?.executionImage;
    expect(image).toMatchObject({
      ref: contentRoots[0]!.stateHash,
      executionDigest: ownerArtifact.executionDigest,
      effectiveVersion: unsigned.sourceState.effectiveVersion,
    });
    expect(image?.ref).not.toBe(`state:${ownerArtifact.executionDigest}`);
    await harness.shutdown();

    const unsealed = createHarness(
      { [ownerId]: "ctx_agent" },
      { ownerRecord, ownerArtifact: null }
    );
    await expect(
      unsealed.service.handler(
        activeInvocationContext(authenticatedCaller(ownerId, "do")),
        "start",
        [inlineEvalStart({ scopeKey: "chan_1", runId: "run:missing-artifact", code: "return 1;" })]
      )
    ).rejects.toMatchObject({ code: "EEXECUTION_IDENTITY" });
    expect(unsealed.calls.some((call) => call.method === "startRun")).toBe(false);
    await unsealed.shutdown();
  });

  it("cancels admitted eval runs and closes new admission during shared shutdown", async () => {
    const ownerId = "session:default";
    const harness = createHarness({ [ownerId]: "ctx_1" }, { executeRunPending: true });

    await harness.service.handler(
      { caller: authenticatedCaller("shell:dev_cli", "shell") },
      "start",
      [
        inlineEvalStart({
          target: { kind: "owner-session", sessionId: ownerId },
          runId: "run:shutdown",
          code: "await new Promise(() => {});",
        }),
      ]
    );
    expect(harness.activity.getActivity().activeRuns).toBe(1);

    await harness.shutdown();
    expect(harness.calls.some((call) => call.method === "cancel")).toBe(true);
    expect(harness.activity.getActivity().activeRuns).toBe(0);

    await expect(
      harness.service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "start", [
        inlineEvalStart({
          target: { kind: "owner-session", sessionId: ownerId },
          runId: "run:after-shutdown",
          code: "return 1;",
        }),
      ])
    ).rejects.toThrow(/shutting down/u);
  });

  it("joins slow owned eval cancellation beyond former shutdown budgets", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let announce!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const harness = createHarness(
      { "session:default": "ctx_1" },
      {
        executeRunPending: true,
        cancel: async () => {
          announce();
          await gate;
        },
      }
    );
    let preparation: Promise<void> | undefined;
    let observed: Promise<void> | undefined;
    try {
      await harness.service.handler(
        { caller: authenticatedCaller("shell:dev_cli", "shell") },
        "start",
        [
          inlineEvalStart({
            target: { kind: "owner-session", sessionId: "session:default" },
            runId: "run:slow-shutdown",
            code: "await new Promise(() => {});",
          }),
        ]
      );
      preparation = harness.shutdown();
      let settled = false;
      observed = preparation.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        }
      );
      await entered;
      await vi.advanceTimersByTimeAsync(360_000);
      expect(settled).toBe(false);
      expect(harness.activity.getActivity().activeRuns).toBe(1);
      expect(
        harness.executionSessions.resolve(
          `do:workers/session:SessionDO:${evalKey("session:default", "default")}`
        )
      ).not.toBeNull();
      await expect(
        harness.service.handler(
          { caller: authenticatedCaller("shell:dev_cli", "shell") },
          "start",
          [
            inlineEvalStart({
              target: { kind: "owner-session", sessionId: "session:default" },
              runId: "run:late-shutdown",
              code: "return 1;",
            }),
          ]
        )
      ).rejects.toMatchObject({ code: "ESHUTDOWN" });
      release();
      await preparation;
      expect(harness.activity.getActivity().activeRuns).toBe(0);
      expect(harness.calls.filter((call) => call.method === "cancel")).toHaveLength(1);
      await harness.shutdown();
      expect(harness.calls.filter((call) => call.method === "cancel")).toHaveLength(1);
    } finally {
      release();
      await observed;
      vi.useRealTimers();
    }
  });

  it("preserves original eval cancellation failure and joins independent cleanup before shutdown rejects", async () => {
    const original = new Error("registered eval cleanup refused", {
      cause: new Error("original provider failure"),
    });
    let release!: () => void;
    let announce!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const harness = createHarness(
      { "session:default": "ctx_1" },
      {
        executeRunPending: true,
        cancel: async (runId) => {
          if (runId === "run:failed-shutdown") throw original;
          announce();
          await gate;
        },
      }
    );
    for (const [runId, scopeKey] of [
      ["run:failed-shutdown", "first"],
      ["run:joined-shutdown", "second"],
    ]) {
      await harness.service.handler(
        { caller: authenticatedCaller("shell:dev_cli", "shell") },
        "start",
        [
          inlineEvalStart({
            target: { kind: "owner-session", sessionId: "session:default" },
            runId: runId!,
            scopeKey,
            code: "await new Promise(() => {});",
          }),
        ]
      );
    }
    const failedAdmissionClosed = new Promise<void>((resolve) => {
      const end = harness.activity.end.bind(harness.activity);
      vi.spyOn(harness.activity, "end").mockImplementation((id) => {
        end(id);
        if (id.endsWith(":run:failed-shutdown")) resolve();
      });
    });
    let settled = false;
    const preparation = harness.shutdown();
    const observed = preparation.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    try {
      await entered;
      await failedAdmissionClosed;
      expect(settled).toBe(false);
      expect(harness.activity.getActivity().activeRuns).toBe(1);
      release();
      const failure = await preparation.catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AggregateError);
      expect((failure as AggregateError).errors).toEqual([original]);
      expect((failure as AggregateError).errors[0]).toBe(original);
      expect((failure as AggregateError).cause).toBe(original);
      expect(harness.activity.getActivity().activeRuns).toBe(0);
      expect(harness.calls.filter((call) => call.method === "cancel")).toHaveLength(2);
      await expect(harness.shutdown()).rejects.toBe(failure);
    } finally {
      release();
      await observed;
    }
  });

  it("rolls back failed task binding so the next eval can acquire the same cell", async () => {
    const ownerId = "session:default";
    const { service, executionSessions, taskAuthorities } = createHarness({ [ownerId]: "ctx_1" });
    vi.spyOn(taskAuthorities, "bindExecution").mockImplementationOnce(() => {
      throw new Error("Runtime subagent is already bound to another task authority");
    });
    const ctx = { caller: authenticatedCaller("shell:dev_cli", "shell") };
    const input = {
      target: { kind: "owner-session" as const, sessionId: ownerId },
      scopeKey: "default",
      code: "return 1;",
    };
    await expect(
      service.handler(ctx, "start", [inlineEvalStart({ ...input, runId: "run:binding-error" })])
    ).rejects.toThrow("already bound to another task authority");
    const runtimeId = `do:workers/session:SessionDO:${evalKey(ownerId, "default")}`;
    expect(executionSessions.resolve(runtimeId)).toBeNull();
    await expect(
      service.handler(ctx, "start", [
        inlineEvalStart({ ...input, runId: "run:after-binding-error" }),
      ])
    ).resolves.toBeDefined();
  });

  ledgerTest("execution.eval-kernel", async () => {
    const { service, calls } = createHarness({ "session:default": "ctx_1" });

    await service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "start", [
      inlineEvalStart({
        target: { kind: "owner-session", sessionId: "session:default" },
        scopeKey: "default",
        runId: "run:ledger",
        code: "return 1;",
      }),
    ]);

    const objectKey = evalKey("session:default", "default");
    expect(calls[0]).toEqual({
      ref: WORKSPACE_REF,
      method: "entityResolve",
      args: [`do:workers/session:SessionDO:${objectKey}`],
    });
    // The session entity is created through the ordinary path, the owner its parent and its context the owner's.
    expect(calls.find((call) => call.method === "createEntity")).toEqual({
      ref: null,
      method: "createEntity",
      args: [
        {
          kind: "do",
          key: objectKey,
          contextId: "ctx_1",
          className: SESSION_CLASS,
          execution: { surface: "code", source: SESSION_SOURCE },
          stateArgs: {
            principalId: "session:default",
            ownerPrincipalId: "session:default",
            subKey: "default",
            agentExecutionAdmission: { v: 1, ownerId: "session:default" },
          },
        },
        "session:default",
      ],
    });
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      ref: { source: SESSION_SOURCE, className: SESSION_CLASS, objectKey },
      method: "startRun",
      args: [
        expect.objectContaining({
          runId: expect.any(String),
          code: "return 1;",
          contextId: "ctx_1",
        }),
      ],
    });
    expect(
      (calls.find((c) => c.method === "startRun")?.args[0] as { timeoutMs?: number }).timeoutMs
    ).toBeUndefined();
  });

  it("keeps entity callers bound to their verified runtime owner", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
      inlineEvalStart({ scopeKey: "chan_1", runId: "run:entity", code: "return 1;" }),
    ]);

    const objectKey = evalKey(ownerId, "chan_1");
    expect(calls[0]).toMatchObject({
      method: "entityResolve",
      args: [`do:workers/session:SessionDO:${objectKey}`],
    });
    expect(calls[1]).toMatchObject({
      method: "createEntity",
      args: [
        expect.objectContaining({
          contextId: "ctx_agent",
          key: objectKey,
          stateArgs: expect.objectContaining({
            ownerPrincipalId: ownerId,
            subKey: "chan_1",
            agentExecutionAdmission: { v: 1, ownerId },
          }),
        }),
        ownerId,
      ],
    });
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      ref: { source: SESSION_SOURCE, className: SESSION_CLASS, objectKey },
      method: "startRun",
      args: [
        expect.objectContaining({
          contextId: "ctx_agent",
          channelId: "chan_1",
          agentRef: ownerId,
        }),
      ],
    });
  });

  it("refuses an agent-bound eval without invocation scope before activating a relay", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    await expect(
      service.handler({ caller: authenticatedCaller(ownerId, "do") }, "start", [
        inlineEvalStart({ scopeKey: "chan_1", runId: "run:unscoped", code: "return 1;" }),
      ])
    ).rejects.toMatchObject({ code: "EACCES", errorKind: "access" });

    expect(calls.some((call) => call.method === "createEntity")).toBe(false);
    expect(calls.some((call) => call.method === "startRun")).toBe(false);
  });

  it("resolves the eval's parent as the agent caller's owning panel (lineage walk)", async () => {
    // Lineage: an agent DO whose launch parent (recorded at createEntity) is a panel.
    const rec = (
      over: Partial<EntityRecord> & { id: string; kind: EntityRecord["kind"] }
    ): EntityRecord => ({
      source: { repoPath: "src", effectiveVersion: "v" },
      contextId: "ctx_agent",
      key: over.id,
      authoritySessionId: "authority:eval-test",
      createdAt: 0,
      status: "active",
      cleanupComplete: true,
      ...over,
    });
    const records: Record<string, EntityRecord> = {
      "do:src:Agent:k": rec({
        id: "do:src:Agent:k",
        kind: "do",
        parentId: "panel:p",
        agentBinding: {
          entityId: "session:agent",
          contextId: "ctx_agent",
          channelId: "c",
        },
      }),
      "panel:p": rec({ id: "panel:p", kind: "panel", contextId: "ctx_panel" }),
    };
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const doDispatch = {
      async dispatchHeld(
        this: { dispatch: (ref: unknown, method: string, ...args: unknown[]) => Promise<unknown> },
        ref: unknown,
        method: string,
        ...args: unknown[]
      ) {
        return this.dispatch(ref, method, ...args);
      },
      async dispatch(_ref: unknown, method: string, ...args: unknown[]) {
        calls.push({ method, args });
        if (method === "entityResolve") return records[String(args[0])] ?? null;
        // Durable nav→slot: the panel entity "panel:p" is the current entity of open slot "panel:tree/p".
        if (method === "slotResolveByEntity")
          return String(args[0]) === "panel:p" ? "panel:tree/p" : null;
        if (method === "start") {
          calls[calls.length - 1] = { method: "startRun", args: [args[0]] };
          return { runId: String((args[0] as { runId?: string }).runId), status: "pending" };
        }
        if (method === "get") return { status: "done" };
        throw new Error(`unexpected dispatch ${method}`);
      },
    } as unknown as DODispatch;
    const entityCache = new EntityCache();
    entityCache.hydrate(Object.values(records));
    const entityStore = new WorkspaceEntityStore({
      doDispatch,
      workspaceId: "ws",
      entityCache,
      resolveNativeOwner: () => null,
      resolveDurableWorkQueues: () => [],
      materializeExecution: async () => undefined,
    });
    const dynamicCode = createDynamicCodeService({
      resolveExecutionArtifact: () => EVAL_EXECUTION_IDENTITY.artifact,
      doDispatch,
      entityStore,
      createEntity: async (caller, spec) => {
        const record = sessionRecord(spec, caller.runtime.id);
        records[record.id] = record;
        entityCache.hydrate([record]);
        return { id: record.id };
      },
      retireEntity: vi.fn(async () => {}),
      workspaceId: "ws",
      executionSessions: new AgentExecutionSessionRegistry(),
      taskAuthorities: new TaskAuthorityRegistry(),
    });
    const service = callerView(dynamicCode, doDispatch);

    await service.handler(
      activeInvocationContext(authenticatedCaller("do:src:Agent:k", "do"), "c"),
      "start",
      [inlineEvalStart({ runId: "run:parent", code: "return 1;" })]
    );

    const runCall = calls.find((c) => c.method === "startRun");
    // The parent is the owning panel's TREE SLOT id (durable nav→slot of "panel:p" → "panel:tree/p"),
    // not the panel's entity id — so defaultOpenParentId/getPanelHandle nest under the real slot.
    expect((runCall?.args[0] as { parent?: unknown }).parent).toEqual({
      parentId: "panel:tree/p",
      parentEntityId: "panel:tree/p",
      parentKind: "panel",
    });
  });

  it("uses one host-validated panel binding as an orchestrated agent's parent", async () => {
    const agentId = "do:workers/agent-worker:AiChatWorker:quickfire";
    const agent: EntityRecord = {
      id: agentId,
      kind: "do",
      source: { repoPath: "workers/agent-worker", effectiveVersion: "v" },
      contextId: "ctx_panel",
      className: "AiChatWorker",
      key: "quickfire",
      authoritySessionId: "authority:eval-test",
      createdAt: 0,
      status: "active",
      cleanupComplete: true,
    };
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const boundPanelIds = ["panel:tree/tour"];
    const extraRecords: Record<string, EntityRecord> = {};
    const doDispatch = {
      async dispatchHeld(
        this: { dispatch: (ref: unknown, method: string, ...args: unknown[]) => Promise<unknown> },
        ref: unknown,
        method: string,
        ...args: unknown[]
      ) {
        return this.dispatch(ref, method, ...args);
      },
      async dispatch(_ref: unknown, method: string, ...args: unknown[]) {
        calls.push({ method, args });
        if (method === "entityResolve")
          return String(args[0]) === agentId ? agent : (extraRecords[String(args[0])] ?? null);
        if (method === "slotResolveByEntity") return null;
        if (method === "runtimeResourceBindingsForEntity")
          return boundPanelIds.map((id) => ({
            resource: { kind: "panel-slot", id },
            capabilities: ["panel.inspect"],
            scope: { kind: "agent-channel", channelId: "quickfire-channel" },
          }));
        if (method === "start") {
          calls[calls.length - 1] = { method: "startRun", args: [args[0]] };
          return { runId: String((args[0] as { runId?: string }).runId), status: "pending" };
        }
        if (method === "get") return { status: "done" };
        throw new Error(`unexpected dispatch ${method}`);
      },
    } as unknown as DODispatch;
    const entityCache = new EntityCache();
    entityCache._onActivate(agent);
    const entityStore = new WorkspaceEntityStore({
      doDispatch,
      workspaceId: "ws",
      entityCache,
      resolveNativeOwner: () => null,
      resolveDurableWorkQueues: () => [],
      materializeExecution: async () => undefined,
    });
    const dynamicCode = createDynamicCodeService({
      resolveExecutionArtifact: () => EVAL_EXECUTION_IDENTITY.artifact,
      doDispatch,
      entityStore,
      createEntity: async (caller, spec) => {
        const record = sessionRecord(spec, caller.runtime.id);
        extraRecords[record.id] = record;
        entityCache._onActivate(record);
        return { id: record.id };
      },
      retireEntity: async () => undefined,
      workspaceId: "ws",
      executionSessions: new AgentExecutionSessionRegistry(),
      taskAuthorities: new TaskAuthorityRegistry(),
    });
    const service = callerView(dynamicCode, doDispatch);

    await service.handler(
      activeInvocationContext(authenticatedCaller(agentId, "do"), "quickfire-channel"),
      "start",
      [inlineEvalStart({ runId: "run:bound-parent", code: "return 1;" })]
    );

    const runCall = calls.find((call) => call.method === "startRun");
    expect((runCall?.args[0] as { parent?: unknown }).parent).toEqual({
      parentId: "panel:tree/tour",
      parentEntityId: "panel:tree/tour",
      parentKind: "panel",
    });
  });

  it("rejects owner overrides from unprivileged callers", async () => {
    const { service } = createHarness({
      "panel:one": "ctx_panel",
      "session:default": "ctx_1",
    });

    await expect(
      service.handler({ caller: authenticatedCaller("panel:one", "panel") }, "start", [
        inlineEvalStart({
          target: { kind: "owner-session", sessionId: "session:default" },
          scopeKey: "default",
          runId: "run:override",
          code: "return 1;",
        }),
      ])
    ).rejects.toThrow(/restricted to shell\/server/);
  });

  it("rejects missing or malformed typed sources even when handler is called directly", async () => {
    const { service } = createHarness({ "session:default": "ctx_1" });
    const ctx = { caller: authenticatedCaller("shell:dev_cli", "shell") };

    await expect(
      service.handler(ctx, "start", [
        {
          target: { kind: "owner-session", sessionId: "session:default" },
          scope: { key: "default" },
          runId: "run:missing",
        },
      ])
    ).rejects.toThrow(/source/i);

    await expect(
      service.handler(ctx, "start", [
        {
          target: { kind: "owner-session", sessionId: "session:default" },
          scope: { key: "default" },
          runId: "run:ambiguous",
          source: { kind: "inline", code: "return 1;", path: "/snippet.ts" },
        },
      ])
    ).rejects.toThrow(/unrecognized key/i);
  });

  it("keeps eval effect identity distinct from its exact causal parent", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });
    const runId = "effect:eval:42";
    const agentInvocationId = "invocation:parent:42";

    const ret = await service.handler(
      activeInvocationContext(authenticatedCaller(ownerId, "do"), "chan_1", agentInvocationId),
      "start",
      [
        inlineEvalStart({
          scopeKey: "chan_1",
          code: "return 1;",
          runId,
        }),
      ]
    );
    expect(ret).toMatchObject({
      runId,
      runDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      authorityManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    const objectKey = evalKey(ownerId, "chan_1");
    // The run/effect key stays independent while the private causality field
    // carries the exact already-verified parent invocation.
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      ref: { source: SESSION_SOURCE, className: SESSION_CLASS, objectKey },
      args: [
        expect.objectContaining({
          runId,
          executionSessionNonce: expect.any(String),
          agentInvocationId,
          channelId: "chan_1",
          agentRef: ownerId,
        }),
      ],
    });
    expect(
      (calls.find((c) => c.method === "startRun")?.args[0] as { timeoutMs?: number }).timeoutMs
    ).toBeUndefined();

    // The host holds no execution and delivers no completion: the hosted kernel owns the run once it
    // acknowledges start, and the caller pulls its result.
    expect(calls.some((c) => c.method === "executeRun")).toBe(false);
    expect(calls.some((c) => c.method === "onEvalComplete")).toBe(false);
  });

  it("retains exact context-file bytes and semantic source provenance before acceptance", async () => {
    const ownerId = "session:default";
    const { service, calls, resolveContextSource } = createHarness({ [ownerId]: "ctx:source" });
    const ctx = activeInvocationContext(authenticatedCaller("shell:dev_cli", "shell"));
    await service.handler(
      ctx,
      "start",
      [
        {
          target: { kind: "owner-session", sessionId: ownerId },
          runId: "run:exact-source",
          source: { kind: "context-file", path: "scripts/check.ts" },
        },
      ]
    );
    expect(resolveContextSource).toHaveBeenCalledWith("ctx:source", "scripts/check.ts", ctx);
    const accepted = calls.find((call) => call.method === "startRun")?.args[0] as Record<
      string,
      unknown
    >;
    expect(accepted).toMatchObject({
      code: "// exact:scripts/check.ts\nreturn 7;",
      sourcePath: "scripts/check.ts",
      sourceState: { kind: "event", eventId: "event:source" },
      contentStateHash: `state:${"c".repeat(64)}`,
      sourceDigest: createHash("sha256")
        .update("// exact:scripts/check.ts\nreturn 7;")
        .digest("hex"),
    });
    expect(accepted["path"]).toBeUndefined();
  });

  it("retains root and descendant test-history trust through cancellation", async () => {
    const ownerId = "session:default";
    const runId = "system-test-runner:cancel-lifecycle";
    const { service, dynamicCode, calls, executionSessions } = createHarness(
      { [ownerId]: "ctx:orchestrator" },
      { systemTestHarness: true, executeRunPending: true }
    );

    const initiator = activeInvocationContext(authenticatedCaller(ownerId, "shell"));
    await service.handler(initiator, "start", [
      inlineEvalStart({ code: "await new Promise(() => {});", runId }),
    ]);
    expect(calls.filter((call) => call.method === "getRun")).toHaveLength(0);
    const objectKey = (
      calls.find((call) => call.method === "startRun")?.ref as { objectKey: string }
    ).objectKey;
    const rootRuntimeId = `do:workers/session:SessionDO:${objectKey}`;
    const root = executionSessions.resolve(rootRuntimeId);
    expect(root?.testPolicy?.kind).toBe("orchestrator");

    executionSessions.inheritTestContext("ctx:case", "ctx:orchestrator");
    executionSessions.attachCasePolicy("ctx:case", "ctx:orchestrator", {
      testId: "cancel-lifecycle-case",
      agent: {
        model: "openai-codex:gpt-5.3-codex-spark",
        approvalLevel: 2,
        fallback: "disabled",
      },
      authority: [],
      unexpectedPrompts: "fail",
    });
    const casePolicy = executionSessions.testPolicyForContext("ctx:case");
    if (!casePolicy) throw new Error("Expected inherited case policy");
    const child = executionSessions.admit({
      controllerRuntimeId: "agent:test-controller",
      mode: "test",
      ownerUser: "user:usr_test",
      workspaceId: "ws_1",
      contextId: "ctx:case",
      agentBinding: null,
      taskRef: "system-test:cancel-lifecycle-case",
      taskAuthority: "task:system-test-cancel-lifecycle-case",
      executionImage: {
        principal: `code:workers/system-test-runner@test`,
        repoPath: "workers/system-test-runner",
        ref: "state:test",
        effectiveVersion: "test",
        executionDigest: "a".repeat(64),
      },
      admissionKey: "test:cancel-lifecycle-child",
      executor: {
        kind: "dynamic-code",
        runtimeId: "do:workers/session:SessionDO:cancel-lifecycle-child",
        runId: "system-test-runner:cancel-lifecycle-child",
        authorityManifest: {
          mode: "adaptive",
          effects: "read-write",
          approvals: "prompt",
          requests: [],
          digest: "0".repeat(64),
        },
      },
      parent: null,
      causalParent: null,
      testPolicy: casePolicy,
    });

    expect(executionSessions.resolve(rootRuntimeId)?.nonce).toBe(root?.nonce);
    expect(executionSessions.resolve(child.executor.runtimeId)?.nonce).toBe(child.nonce);
    expect(executionSessions.resolve(rootRuntimeId)).not.toBeNull();
    expect(executionSessions.resolve(child.executor.runtimeId)).not.toBeNull();

    // The caller releases the root's admission once its run is terminal: the case's trust outlives it.
    await dynamicCode.handler(initiator, "release", [{ runId, hostId: rootRuntimeId }]);
    expect(executionSessions.resolve(rootRuntimeId)).not.toBeNull();
    expect(executionSessions.resolve(child.executor.runtimeId)).not.toBeNull();
    expect(executionSessions.testPolicyForContext("ctx:orchestrator")).not.toBeNull();
    expect(executionSessions.testPolicyForContext("ctx:case")).not.toBeNull();
  });

  it("start requires a caller-owned runId", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    await expect(
      service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
        {
          scope: { key: "chan_1" },
          source: { kind: "inline", code: "return 1;" },
        },
      ])
    ).rejects.toThrow(/runId/);
    expect(calls.some((c) => c.method === "startRun")).toBe(false);
  });

  it("preserves an explicit agent eval deadline", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
      inlineEvalStart({
        scopeKey: "chan_1",
        runId: "run:deadline",
        code: "return 1;",
        timeoutMs: 12_345,
      }),
    ]);

    expect(calls.find((c) => c.method === "startRun")?.args[0]).toMatchObject({
      timeoutMs: 12_345,
    });
  });

  it("hands the kernel the fact that a retired EvalDO notebook was dropped, only when one was recorded (D5)", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    for (const legacyNotebook of [true, false]) {
      const { service, calls } = createHarness({ [ownerId]: "ctx_agent" }, { legacyNotebook });
      await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
        inlineEvalStart({
          scopeKey: "chan_1",
          runId: `run:legacy:${legacyNotebook}`,
          code: "return 1;",
        }),
      ]);
      const started = calls.find((c) => c.method === "startRun")?.args[0] as Record<
        string,
        unknown
      >;
      if (legacyNotebook) expect(started).toMatchObject({ legacyNotebookDropped: true });
      else expect(started).not.toHaveProperty("legacyNotebookDropped");
    }
  });

  it("keeps missing-scope controls from admitting work and treats reset as already empty", async () => {
    const ownerId = "session:default";
    const { service, calls } = createHarness({ [ownerId]: "ctx_1" });
    const ctx = { caller: authenticatedCaller("shell:dev_cli", "shell") };
    const route = {
      target: { kind: "owner-session" as const, sessionId: ownerId },
      scopeKey: "missing",
    };
    await expect(service.handler(ctx, "reset", [route])).resolves.toEqual({ ok: true });
    expect(
      calls.every((call) => ["entityResolveContext", "entityResolve"].includes(call.method))
    ).toBe(true);
  });

  it("does not rebind an admitted eval scope when its owner resolves to a different context", async () => {
    const ownerId = "session:default";
    const entityId = `do:workers/session:SessionDO:${evalKey(ownerId, "pinned")}`;
    const { service, calls } = createHarness({ [ownerId]: "ctx_new", [entityId]: "ctx_original" });
    await expect(
      service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "reset", [
        {
          target: { kind: "owner-session", sessionId: ownerId },
          scopeKey: "pinned",
        },
      ])
    ).rejects.toMatchObject({ code: "EACCES", errorKind: "access" });
    expect(calls.every((call) => call.method === "entityResolveContext")).toBe(true);
  });

  it("disposes a finite eval kernel through its runtime lifecycle owner", async () => {
    const ownerId = "session:default";
    const contexts: Record<string, string | null> = { [ownerId]: "ctx_1" };
    const objectKey = evalKey(ownerId, "finite");
    const entityId = `do:workers/session:SessionDO:${objectKey}`;
    contexts[entityId] = "ctx_1";
    const { service, calls, retireEntity } = createHarness(contexts, {
      finiteEvalEntityIds: new Set([entityId]),
    });

    await expect(
      service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "dispose", [
        {
          target: { kind: "owner-session", sessionId: ownerId },
          scopeKey: "finite",
        },
      ])
    ).resolves.toEqual({ ok: true });

    expect(calls.some((call) => call.method === "dispose")).toBe(false);
    expect(retireEntity).toHaveBeenCalledWith(entityId);
  });

  it("refuses to dispose a persistent eval scope", async () => {
    const ownerId = "session:default";
    const contexts: Record<string, string | null> = { [ownerId]: "ctx_1" };
    const objectKey = evalKey(ownerId, "default");
    contexts[`do:workers/session:SessionDO:${objectKey}`] = "ctx_1";
    const { service, retireEntity } = createHarness(contexts);

    await expect(
      service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "dispose", [
        { target: { kind: "owner-session", sessionId: ownerId } },
      ])
    ).rejects.toMatchObject({ code: "EACCES", errorKind: "access" });
    expect(retireEntity).not.toHaveBeenCalled();
  });

  it("refuses retired finite scope admission and control after a cache miss", async () => {
    const ownerId = "session:default";
    const objectKey = evalKey(ownerId, "finite");
    const entityId = `do:workers/session:SessionDO:${objectKey}`;
    const { service, calls } = createHarness(
      { [ownerId]: "ctx_1", [entityId]: "ctx_1" },
      { finiteEvalEntityIds: new Set([entityId]), retiredEvalEntityIds: new Set([entityId]) }
    );
    const caller = { caller: authenticatedCaller("shell:dev_cli", "shell") };
    const route = {
      target: { kind: "owner-session" as const, sessionId: ownerId },
      scopeKey: "finite",
    };
    await expect(
      service.handler(caller, "start", [
        inlineEvalStart({
          target: route.target,
          scopeKey: route.scopeKey,
          lifecycle: "finite",
          runId: "old-run",
          code: "return 1;",
        }),
      ])
    ).rejects.toMatchObject({ code: "ECLOSED" });
    await expect(service.handler(caller, "reset", [route])).rejects.toMatchObject({
      code: "ECLOSED",
    });
    expect(calls.some((call) => ["createEntity", "startRun", "reset"].includes(call.method))).toBe(
      false
    );
  });

  it("routes control calls to an existing finite scope without reclassifying it", async () => {
    const ownerId = "session:default";
    const objectKey = evalKey(ownerId, "finite");
    const entityId = `do:workers/session:SessionDO:${objectKey}`;
    const { service, calls } = createHarness(
      {
        [ownerId]: "ctx_1",
        [entityId]: "ctx_1",
      },
      { finiteEvalEntityIds: new Set([entityId]) }
    );

    await expect(
      service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "reset", [
        {
          target: { kind: "owner-session", sessionId: ownerId },
          scopeKey: "finite",
        },
      ])
    ).resolves.toEqual({ ok: true });

    expect(calls.find((call) => call.method === "reset")).toMatchObject({
      ref: { source: SESSION_SOURCE, className: SESSION_CLASS, objectKey },
    });
    expect(calls.some((call) => call.method === "createEntity")).toBe(false);
    expect(calls.some((call) => call.method === "entityAdvanceExecution")).toBe(false);
  });

  it("refuses to reclassify a persistent eval scope as finite", async () => {
    const ownerId = "session:default";
    const objectKey = evalKey(ownerId, "default");
    const entityId = `do:workers/session:SessionDO:${objectKey}`;
    const { service, calls } = createHarness({
      [ownerId]: "ctx_1",
      [entityId]: "ctx_1",
    });

    await expect(
      service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "start", [
        inlineEvalStart({
          target: { kind: "owner-session", sessionId: ownerId },
          scopeKey: "default",
          runId: "run:reclassify",
          lifecycle: "finite",
          code: "return 1;",
        }),
      ])
    ).rejects.toMatchObject({ code: "EINVAL", errorKind: "application" });
    expect(calls.some((call) => call.method === "createEntity")).toBe(false);
    expect(calls.some((call) => call.method === "entityAdvanceExecution")).toBe(false);
  });

  it("refuses to reuse a finite eval scope as a persistent notebook", async () => {
    const ownerId = "session:default";
    const objectKey = evalKey(ownerId, "finite");
    const entityId = `do:workers/session:SessionDO:${objectKey}`;
    const { service, calls } = createHarness(
      {
        [ownerId]: "ctx_1",
        [entityId]: "ctx_1",
      },
      { finiteEvalEntityIds: new Set([entityId]) }
    );

    await expect(
      service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "start", [
        inlineEvalStart({
          target: { kind: "owner-session", sessionId: ownerId },
          scopeKey: "finite",
          runId: "run:finite-persistent",
          code: "return 1;",
        }),
      ])
    ).rejects.toMatchObject({ code: "EINVAL", errorKind: "application" });
    expect(calls.some((call) => call.method === "createEntity")).toBe(false);
    expect(calls.some((call) => call.method === "entityAdvanceExecution")).toBe(false);
  });
});

describe("dynamicCode admission — an entity that hosts its own kernel (§6.11.6)", () => {
  const AGENT_ID = "do:workers/agent-worker:AiChatWorker:k";
  // The owner's own sealed image (an agent has code of its own, so it is its own harness).
  const agentRoots = [{ repoPath: "workers/agent-worker", stateHash: `state:${"e".repeat(64)}` }];
  const agentArtifactUnsigned = {
    ...sessionArtifactUnsigned,
    sourceState: {
      ...sessionArtifactUnsigned.sourceState,
      contentRoots: agentRoots,
      sourceClosureDigest: executionSourceClosureDigest(agentRoots),
    },
  };
  const agentArtifact = {
    ...agentArtifactUnsigned,
    executionDigest: executionArtifactDigest(agentArtifactUnsigned),
  } as ExecutionArtifactRefV1;
  function selfHostingHarness(hostsEvalKernel: boolean) {
    const agent: EntityRecord = {
      id: AGENT_ID,
      kind: "do",
      source: {
        repoPath: "workers/agent-worker",
        effectiveVersion: EVAL_EXECUTION_IDENTITY.effectiveVersion,
      },
      contextId: "ctx_agent",
      className: "AiChatWorker",
      key: "k",
      activeBuildKey: agentArtifact.buildKey,
      activeExecutionDigest: agentArtifact.executionDigest,
      activeAuthority: EVAL_EXECUTION_IDENTITY.authority,
      agentBinding: { entityId: "session:agent", contextId: "ctx_agent", channelId: "c" },
      authoritySessionId: "authority:eval-test",
      createdAt: 0,
      status: "active",
      cleanupComplete: true,
    };
    const records: Record<string, EntityRecord> = { [AGENT_ID]: agent };
    const calls: Array<{ ref: unknown; method: string; args: unknown[] }> = [];
    const doDispatch = {
      async dispatchHeld(
        this: { dispatch: (ref: unknown, method: string, ...args: unknown[]) => Promise<unknown> },
        ref: unknown,
        method: string,
        ...args: unknown[]
      ) {
        return this.dispatch(ref, method, ...args);
      },
      async dispatch(ref: unknown, method: string, ...args: unknown[]) {
        calls.push({ ref, method, args });
        if (method === "entityResolve") return records[String(args[0])] ?? null;
        if (method === "slotResolveByEntity") return null;
        if (method === "runtimeResourceBindingsForEntity") return [];
        if (method === "start")
          return { runId: String((args[0] as { runId: string }).runId), status: "pending" };
        if (method === "get") return { status: "done" };
        if (method === "reset") return { ok: true };
        throw new Error(`unexpected dispatch ${method}`);
      },
    } as unknown as DODispatch;
    const entityCache = new EntityCache();
    entityCache.hydrate(Object.values(records));
    const entityStore = new WorkspaceEntityStore({
      doDispatch,
      workspaceId: "ws",
      entityCache,
      resolveNativeOwner: () => null,
      resolveDurableWorkQueues: () => [],
      materializeExecution: async () => undefined,
    });
    const createEntity = vi.fn(async (_caller: VerifiedCaller, spec: { key?: string }) => {
      const record = sessionRecord(spec, AGENT_ID);
      records[record.id] = record;
      entityCache.hydrate([record]);
      return { id: record.id };
    });
    const executionSessions = new AgentExecutionSessionRegistry();
    const dynamicCode = createDynamicCodeService({
      resolveExecutionArtifact: (code) =>
        code.callerId === AGENT_ID ? agentArtifact : EVAL_EXECUTION_IDENTITY.artifact,
      doDispatch,
      entityStore,
      createEntity,
      retireEntity: vi.fn(async () => {}),
      workspaceId: "ws",
      executionSessions,
      taskAuthorities: new TaskAuthorityRegistry(),
      ...(hostsEvalKernel
        ? {
            hostsEvalKernel: (source: string, className: string) =>
              source === "workers/agent-worker" && className === "AiChatWorker",
          }
        : {}),
    });
    return { dynamicCode, calls, createEntity, executionSessions };
  }
  const agentCtx = () =>
    activeInvocationContext(authenticatedCaller(AGENT_ID, "do"), "c", "invocation:self-host");

  it("runs on the owner itself: no session entity is created and the owner is the executor", async () => {
    const h = selfHostingHarness(true);
    const admission = (await h.dynamicCode.handler(agentCtx(), "admit", [
      inlineEvalStart({ runId: "run:self", code: "return 1;" }),
    ])) as { host: unknown; hostId: string; nonce: string; start: Record<string, unknown> };
    expect(h.createEntity).not.toHaveBeenCalled();
    expect(admission.hostId).toBe(AGENT_ID);
    expect(admission.host).toEqual({
      source: "workers/agent-worker",
      className: "AiChatWorker",
      objectKey: "k",
    });
    // The harness identity is the owner's own sealed code, and the executor is the owner.
    expect(h.executionSessions.activeRunId(AGENT_ID)).toBe("run:self");
    expect(h.executionSessions.resolve(AGENT_ID)?.executor).toMatchObject({
      kind: "dynamic-code",
      runtimeId: AGENT_ID,
      runId: "run:self",
    });
    // A scope reset, a host call, reaches the owner's own entity.
    await h.dynamicCode.handler(
      { caller: authenticatedCaller(AGENT_ID, "do"), causalParent: agentCtx().causalParent },
      "reset",
      [{}]
    );
    expect(h.calls.find((call) => call.method === "reset")?.ref).toMatchObject({
      className: "AiChatWorker",
      objectKey: "k",
    });
    // A finite scope is a utility scope with a life of its own: it stays a session entity, which the
    // owner (or its harness) disposes; the owner's own work is its kernel.
    const finite = (await h.dynamicCode.handler(agentCtx(), "admit", [
      inlineEvalStart({
        runId: "run:finite",
        code: "return 1;",
        lifecycle: "finite",
        scopeKey: "probe",
      }),
    ])) as { hostId: string };
    expect(finite.hostId).toMatch(/^do:workers\/session:SessionDO:/);
    expect(h.createEntity).toHaveBeenCalledOnce();
  });

  it("keeps a session entity when another principal selects the entity as its target: that run is not the entity's own", async () => {
    const h = selfHostingHarness(true);
    const shell = authenticatedCaller("shell:dev_cli", "shell");
    const admission = (await h.dynamicCode.handler({ caller: shell }, "admit", [
      {
        runId: "run:targeted",
        target: { kind: "owner-session" as const, sessionId: AGENT_ID },
        scope: { key: "probe", lifecycle: "finite" as const },
        source: { kind: "inline" as const, code: "return 1;" },
      },
    ])) as { hostId: string };
    expect(h.createEntity).toHaveBeenCalledOnce();
    expect(admission.hostId).toMatch(/^do:workers\/session:SessionDO:/);
  });

  it("keeps a session entity for an owner whose class does not declare that it hosts the kernel", async () => {
    const h = selfHostingHarness(false);
    const admission = (await h.dynamicCode.handler(agentCtx(), "admit", [
      inlineEvalStart({ runId: "run:session", code: "return 1;" }),
    ])) as { hostId: string };
    expect(h.createEntity).toHaveBeenCalledOnce();
    expect(admission.hostId).toMatch(/^do:workers\/session:SessionDO:/);
  });
});

describe("dynamicCode admission — agent bindings", () => {
  // Plan §6.4: an `agent` caller binds to its host-verified entity binding with
  // zero flags; the kernel trusts the binding, not client-supplied owner/context.
  it("binds agent eval to the entity binding (owner = binding.entityId, context = binding.contextId)", async () => {
    const { service, calls } = createHarness({ ent_agent: "ctx_bound" });
    const binding = {
      entityId: "ent_agent",
      contextId: "ctx_bound",
      channelId: "chan_1",
      agentId: "ag_1",
      userId: "usr_test",
    };

    await service.handler(
      activeInvocationContext(
        authenticatedCaller("agent:ent_agent", "agent", null, binding),
        binding.channelId,
        "invocation:bound-agent"
      ),
      "start",
      [inlineEvalStart({ runId: "run:bound-agent", code: "return 1;" })]
    );

    // Registered + ran against the session entity keyed by the BINDING entity, in the
    // bound context — no ownerId/contextId came from the client.
    const objectKey = evalKey("ent_agent", "default");
    const activate = calls.find((c) => c.method === "createEntity");
    expect(activate).toBeTruthy();
    expect((activate!.args[0] as { contextId?: string }).contextId).toBe("ctx_bound");
    const run = calls.find((c) => c.method === "startRun");
    expect((run!.ref as { objectKey: string }).objectKey).toBe(objectKey);
  });

  it("rejects an agent eval whose client-supplied owner/context contradicts the binding", async () => {
    const { service } = createHarness({});
    const binding = {
      entityId: "ent_agent",
      contextId: "ctx_bound",
      channelId: "chan_1",
      agentId: "ag_1",
      userId: "usr_test",
    };

    await expect(
      service.handler(
        { caller: authenticatedCaller("agent:ent_agent", "agent", null, binding) },
        "start",
        [
          inlineEvalStart({
            target: { kind: "owner-session", sessionId: "someone_else" },
            runId: "run:contradict-binding",
            code: "return 1;",
          }),
        ]
      )
    ).rejects.toThrow(/must match the connection's entity binding/);
  });
});

describe("dynamicCode (the pull model's host service)", () => {
  const shell = () => authenticatedCaller("shell:dev_cli", "shell");
  const admitInput = (runId: string, extra: Record<string, unknown> = {}) => ({
    runId,
    target: { kind: "owner-session" as const, sessionId: "session:default" },
    scope: { key: "default" },
    source: { kind: "inline" as const, code: "return 1;" },
    ...extra,
  });

  it("admits a run without starting it and returns what the caller starts it with", async () => {
    const h = createHarness({ "session:default": "ctx_1" });
    const admission = (await h.dynamicCode.handler({ caller: shell() }, "admit", [
      admitInput("run:admit"),
    ])) as {
      runId: string;
      hostId: string;
      host: { source: string; className: string; objectKey: string };
      nonce: string;
      start: Record<string, unknown>;
      runDigest: string;
    };
    const objectKey = evalKey("session:default", "default");
    expect(admission.host).toEqual({
      source: SESSION_SOURCE,
      className: SESSION_CLASS,
      objectKey,
    });
    expect(admission.hostId).toBe(`do:${SESSION_SOURCE}:${SESSION_CLASS}:${objectKey}`);
    expect(admission.start).toMatchObject({
      runId: "run:admit",
      code: "return 1;",
      contextId: "ctx_1",
      executionSessionNonce: admission.nonce,
    });
    // Nothing is pushed to the caller: no event route exists, it pulls `events` from the entity.
    expect(admission.start).not.toHaveProperty("eventSinkNonce");
    // The host starts nothing: the caller starts the run on the session entity.
    expect(h.calls.filter((call) => call.method === "startRun")).toEqual([]);
    expect(h.activity.getActivity().activeRuns).toBe(1);
    expect(h.executionSessions.activeRunId(admission.hostId)).toBe("run:admit");
  });

  it("releases an admission for its caller only, and a released slot admits the next run", async () => {
    const h = createHarness({ "session:default": "ctx_1" });
    const admission = (await h.dynamicCode.handler({ caller: shell() }, "admit", [
      admitInput("run:one"),
    ])) as { hostId: string };
    const other = authenticatedCaller("shell:dev_other", "shell");
    await expect(
      h.dynamicCode.handler({ caller: other }, "release", [
        { runId: "run:one", hostId: admission.hostId },
      ])
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      h.dynamicCode.handler({ caller: shell() }, "release", [
        { runId: "run:one", hostId: admission.hostId },
      ])
    ).resolves.toEqual({ released: true });
    await expect(
      h.dynamicCode.handler({ caller: shell() }, "release", [
        { runId: "run:one", hostId: admission.hostId },
      ])
    ).resolves.toEqual({ released: false });
    expect(h.executionSessions.activeRunId(admission.hostId)).toBeUndefined();
    expect(h.activity.getActivity().activeRuns).toBe(0);
    await expect(
      h.dynamicCode.handler({ caller: shell() }, "admit", [admitInput("run:two")])
    ).resolves.toMatchObject({ runId: "run:two" });
  });

  it("releases the slot of a run that ended while its caller was gone, when the next run waits for it", async () => {
    vi.useFakeTimers();
    try {
      // The session entity answers `get` with a terminal row: the first caller never released.
      const h = createHarness({ "session:default": "ctx_1" });
      await h.dynamicCode.handler({ caller: shell() }, "admit", [admitInput("run:abandoned")]);
      const next = h.dynamicCode.handler({ caller: shell() }, "admit", [admitInput("run:next")]);
      let settled = false;
      void next.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(1_500);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(next).resolves.toMatchObject({ runId: "run:next" });
      expect(h.calls.filter((call) => call.method === "getRun")[0]!.args).toEqual([
        "run:abandoned",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the slot of a run that is still executing, and of a fresh admission that was not started yet", async () => {
    vi.useFakeTimers();
    try {
      const running = createHarness(
        { "session:default": "ctx_1" },
        { getRunSequence: [{ status: "running" }] }
      );
      await running.dynamicCode.handler({ caller: shell() }, "admit", [admitInput("run:long")]);
      const next = running.dynamicCode.handler({ caller: shell() }, "admit", [
        admitInput("run:waiting"),
      ]);
      let settled = false;
      void next.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(settled).toBe(false);
      expect(
        running.executionSessions.activeRunId(
          `do:${SESSION_SOURCE}:${SESSION_CLASS}:${evalKey("session:default", "default")}`
        )
      ).toBe("run:long");

      // The entity never heard of the run (the caller died before `start`): released after a grace.
      const unstarted = createHarness(
        { "session:default": "ctx_1" },
        { getRunError: Object.assign(new Error("not found"), { code: "ENOTFOUND" }) }
      );
      await unstarted.dynamicCode.handler({ caller: shell() }, "admit", [admitInput("run:dead")]);
      const after = unstarted.dynamicCode.handler({ caller: shell() }, "admit", [
        admitInput("run:after"),
      ]);
      let afterSettled = false;
      void after.then(() => (afterSettled = true));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(afterSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(after).resolves.toMatchObject({ runId: "run:after" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resets the caller's hosted scope through the host (the kernel is reset by the session, host only)", async () => {
    const h = createHarness({ "session:default": "ctx_1" });
    await expect(
      h.dynamicCode.handler({ caller: shell() }, "reset", [
        { target: { kind: "owner-session", sessionId: "session:default" } },
      ])
    ).resolves.toEqual({ ok: true });
    expect(h.calls.some((call) => call.method === "reset")).toBe(false);
  });
});
