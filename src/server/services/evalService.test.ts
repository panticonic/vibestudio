import { evalEngineMethods } from "@vibestudio/service-schemas/evalEngine";
import { parseSha256 } from "@vibestudio/shared/execution/identity";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
function acceptedRunFixture(runId: string) {
  return evalEngineMethods.startRun.returns.parse({
    runId,
    runDigest: "d".repeat(64),
    scopeInputRevision: "scope:initial",
    status: "pending",
    existing: false,
  });
}

import { ledgerTest } from "../../../tests/helpers/ledgerTest.js";
import { AmbiguousDoDispatchError } from "@vibestudio/shared/doDispatcher";
import {
  createVerifiedCaller,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import type { DODispatch } from "../doDispatch.js";
import {
  getInternalDOBundle,
  internalDOExecutionIdentity,
  INTERNAL_DO_SOURCE,
} from "../internalDOs/internalDoLoader.js";
import { createEvalService } from "./evalService.js";
import { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
import { TaskAuthorityRegistry } from "./taskAuthorityRegistry.js";
import { createActivityRegistry } from "./activityRegistry.js";
import { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { canonicalEntityId, type EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { workspaceStateEngineMethods } from "@vibestudio/service-schemas/workspaceStateEngine";
import type { EvalStartInput } from "@vibestudio/service-schemas/eval";
import { createTestDO, successfulTestRpcFetch } from "@vibestudio/durable/test-utils";
import { EvalDO } from "../../../packages/builtin/src/eval-engine/EvalDO.js";

function activatedEntity(input: unknown): EntityRecord {
  const spec = workspaceStateEngineMethods.entityActivate.args.parse([input])[0];
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
  className: "WorkspaceDO",
  objectKey: "ws_1",
};
const EVAL_EXECUTION_IDENTITY = internalDOExecutionIdentity(getInternalDOBundle(), "EvalDO");

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

function createHarness(
  contexts: Record<string, string | null>,
  options: {
    ownerRecord?: EntityRecord;
    ownerArtifact?: ExecutionArtifactRefV1 | null;
    rejectFirstStartRun?: boolean;
    rejectStartRun?: Error;
    retryStartGate?: Promise<void>;
    evalDomain?: Pick<EvalDO, "startRun" | "cancel" | "getRun" | "getRunReceipt">;
    rejectFirstGetRun?: boolean;
    retryGetRunGate?: Promise<void>;
    finiteEvalEntityIds?: ReadonlySet<string>;
    retiredEvalEntityIds?: ReadonlySet<string>;
    kernelLeaseError?: Error;
    preauthorize?: Parameters<typeof createEvalService>[0]["preauthorize"];
    systemTestHarness?: boolean;
    executeRunPending?: boolean;
    cancel?: (runId: string) => Promise<void>;
    terminalDuringStart?: boolean;
    recoverUnresponsiveSandbox?: Parameters<
      typeof createEvalService
    >[0]["recoverUnresponsiveSandbox"];
    livenessProbeMs?: number;
    getRunSequence?: Array<{
      status: "pending" | "running" | "cancelling" | "done" | "cancelled" | "unknown";
      gate?: Promise<void>;
    }>;
  } = {}
) {
  const calls: Array<{ ref: unknown; method: string; args: unknown[] }> = [];
  let rejectedStartRun = false;
  let rejectedGetRun = false;
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
    async dispatch(ref: unknown, method: string, ...args: unknown[]) {
      calls.push({ ref, method, args });
      if (method === "entityResolveContext") {
        return contexts[String(args[0])] ?? null;
      }
      if (method === "entityActivate") return activatedEntity(args[0]);
      if (method === "entityResolve") {
        const id = String(args[0]);
        if (id.startsWith(`do:${INTERNAL_DO_SOURCE}:EvalDO:`) && contexts[id]) {
          return {
            id,
            kind: "do",
            source: { repoPath: INTERNAL_DO_SOURCE, effectiveVersion: "test" },
            contextId: contexts[id],
            className: "EvalDO",
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
        if (options.evalDomain) return options.evalDomain.cancel(String(args[0]));
        return { ok: true, forcedReset: false };
      }
      if (method === "startRun") {
        if (options.rejectStartRun) throw options.rejectStartRun;
        if (options.rejectFirstStartRun && !rejectedStartRun) {
          rejectedStartRun = true;
          throw new AmbiguousDoDispatchError("simulated lost startRun acknowledgement");
        }
        if (rejectedStartRun && options.retryStartGate) await options.retryStartGate;
        if (options.evalDomain)
          return options.evalDomain.startRun(args[0] as Parameters<EvalDO["startRun"]>[0]);
        if (options.terminalDuringStart) {
          eventSinkTerminal.get(
            String((args[0] as { eventSinkNonce?: string }).eventSinkNonce)
          )?.();
        }
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
        if (options.evalDomain) return options.evalDomain.getRun(String(args[0]));
        if (options.rejectFirstGetRun && !rejectedGetRun) {
          rejectedGetRun = true;
          throw new Error("simulated transient getRun transport failure");
        }
        if (rejectedGetRun && options.retryGetRunGate) await options.retryGetRunGate;
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
      if (method === "getRunReceipt" && options.evalDomain)
        return options.evalDomain.getRunReceipt(String(args[0]));
      if (method === "readScopeTextPage") {
        return { length: 3, encoding: "utf16le-base64", chunk: "YQBiAGMA" };
      }
      if (method === "deleteScopeValue") {
        return { ok: true, existed: true };
      }
      if (method === "onEvalComplete") {
        return undefined;
      }
      throw new Error(`unexpected dispatch ${method}`);
    },
  } as unknown as DODispatch;
  // A real store over the mocked dispatch + cache: entity ops (activate /
  // resolveContext) flow through it to `doDispatch`, so `calls` still captures
  // them — exactly the path the eval service exercises in production.
  const entityCache = {
    resolveContext(id: string) {
      return contexts[id] ?? null;
    },
    // Explicit context entries model existing scopes. A missing scope stays
    // missing until execution admission; lookup/control cannot activate one.
    resolveActive(id: string) {
      if (options.retiredEvalEntityIds?.has(id)) return null;
      if (options.ownerRecord?.id === id) return options.ownerRecord;
      const contextId = contexts[id];
      if (contextId == null || !id.startsWith("do:")) return null;
      if (id.startsWith(`do:${INTERNAL_DO_SOURCE}:EvalDO:`)) {
        const finite = options.finiteEvalEntityIds?.has(id) === true;
        return {
          id,
          kind: "do",
          source: {
            repoPath: INTERNAL_DO_SOURCE,
            effectiveVersion: EVAL_EXECUTION_IDENTITY.effectiveVersion,
          },
          contextId,
          className: "EvalDO",
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
        } as EntityRecord;
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
      } as EntityRecord;
    },
    // Cache miss for the parent-resolution walk → falls back to entityResolve.
    resolve() {
      return null;
    },
    _onActivate() {},
    _onRetire() {},
  } as unknown as EntityCache;
  const entityStore = new WorkspaceEntityStore({
    doDispatch,
    workspaceId: "ws_1",
    entityCache,
    resolveDurableWorkQueues: () => [],
    materializeExecution: async () => undefined,
  });
  const executionSessions = new AgentExecutionSessionRegistry();
  const taskAuthorities = new TaskAuthorityRegistry();
  const activity = createActivityRegistry();
  const eventSinkTerminal = new Map<string, () => void>();
  const eventSinks = {
    register(route: { nonce: string; onTerminal?: () => void }) {
      if (route.onTerminal) eventSinkTerminal.set(route.nonce, route.onTerminal);
    },
    close(nonce: string) {
      eventSinkTerminal.delete(nonce);
    },
  };
  const retireEntity = vi.fn(async () => {});
  let shutdown: (() => Promise<void>) | null = null;
  const service = createEvalService({
    resolveExecutionArtifact: () =>
      options.ownerArtifact === undefined
        ? EVAL_EXECUTION_IDENTITY.artifact
        : options.ownerArtifact,
    doDispatch,
    entityStore,
    retireEntity,
    tokenManager: {
      ensureToken: (callerId: string) => `tok:${callerId}`,
    } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
    workspaceId: "ws_1",
    ...(options.preauthorize ? { preauthorize: options.preauthorize } : {}),
    executionSessions,
    taskAuthorities,
    eventSinks,
    activity,
    onShutdown: (callback) => {
      shutdown = callback;
    },
    ...(options.systemTestHarness ? { isSystemTestHarness: () => true } : {}),
    ...(options.recoverUnresponsiveSandbox
      ? { recoverUnresponsiveSandbox: options.recoverUnresponsiveSandbox }
      : {}),
    ...(options.livenessProbeMs ? { livenessProbeMs: options.livenessProbeMs } : {}),
    kernelLeases: {
      touch: vi.fn(async () => {
        if (options.kernelLeaseError) throw options.kernelLeaseError;
      }),
    },
    resolveContextSource: async (_contextId, sourcePath) => ({
      code: `// exact:${sourcePath}\nreturn 7;`,
      sourceDigest: createHash("sha256").update(`// exact:${sourcePath}\nreturn 7;`).digest("hex"),
      sourceState: { kind: "event", eventId: "event:source" },
      contentStateHash: `state:${"c".repeat(64)}`,
    }),
  });
  return {
    service,
    calls,
    executionSessions,
    taskAuthorities,
    activity,
    retireEntity,
    shutdown: async () => {
      if (!shutdown) throw new Error("shutdown callback was not registered");
      await shutdown();
    },
    settleLiveEvent() {
      const callbacks = [...eventSinkTerminal.values()];
      eventSinkTerminal.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe("createEvalService", () => {
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
      `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`
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
          `do:${INTERNAL_DO_SOURCE}:EvalDO:${evalKey("session:default", "default")}`
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

  it("closes admission when kernel residency cannot be established", async () => {
    const ownerId = "session:default";
    const subKey = "default";
    const { service, executionSessions } = createHarness(
      { [ownerId]: "ctx_1" },
      { kernelLeaseError: new Error("kernel lease unavailable") }
    );

    await expect(
      service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "start", [
        inlineEvalStart({
          target: { kind: "owner-session", sessionId: ownerId },
          scopeKey: subKey,
          runId: "run:lease-error",
          code: "return 1;",
        }),
      ])
    ).rejects.toThrow("kernel lease unavailable");

    const runtimeId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${evalKey(ownerId, subKey)}`;
    expect(executionSessions.resolve(runtimeId)).toBeNull();
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
    const runtimeId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${evalKey(ownerId, "default")}`;
    expect(executionSessions.resolve(runtimeId)).toBeNull();
    await expect(
      service.handler(ctx, "start", [
        inlineEvalStart({ ...input, runId: "run:after-binding-error" }),
      ])
    ).resolves.toBeDefined();
  });

  ledgerTest("execution.eval-do", async () => {
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
      args: [`do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`],
    });
    expect(calls[1]).toEqual({
      ref: WORKSPACE_REF,
      method: "entityActivate",
      args: [
        {
          kind: "do",
          source: {
            repoPath: INTERNAL_DO_SOURCE,
            effectiveVersion: EVAL_EXECUTION_IDENTITY.effectiveVersion,
          },
          contextId: "ctx_1",
          className: "EvalDO",
          key: objectKey,
          activeBuildKey: EVAL_EXECUTION_IDENTITY.buildKey,
          activeExecutionDigest: EVAL_EXECUTION_IDENTITY.executionDigest,
          activeAuthority: EVAL_EXECUTION_IDENTITY.authority,
          ownerUserId: "usr_test",
          agentBinding: undefined,
          // The EvalDO's launch parent IS its owner — bridges the lineage so entities spawned FROM an
          // eval (e.g. headless sub-agents) resolve up through the owner to the owner's panel.
          parentId: "session:default",
          stateArgs: {
            ownerPrincipalId: "session:default",
            subKey: "default",
            agentExecutionAdmission: { v: 1, ownerId: "session:default" },
          },
        },
      ],
    });
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
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
      args: [`do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`],
    });
    expect(calls[1]).toMatchObject({
      method: "entityActivate",
      args: [
        expect.objectContaining({
          contextId: "ctx_agent",
          key: objectKey,
          stateArgs: {
            ownerPrincipalId: ownerId,
            subKey: "chan_1",
            agentExecutionAdmission: { v: 1, ownerId },
          },
        }),
      ],
    });
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
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

    expect(calls.some((call) => call.method === "entityActivate")).toBe(false);
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
        if (method === "entityActivate") return activatedEntity(args[0]);
        if (method === "entityResolve") return records[String(args[0])] ?? null;
        // Durable nav→slot: the panel entity "panel:p" is the current entity of open slot "panel:tree/p".
        if (method === "slotResolveByEntity")
          return String(args[0]) === "panel:p" ? "panel:tree/p" : null;
        if (method === "startRun")
          return acceptedRunFixture(String((args[0] as { runId?: string }).runId));
        if (method === "executeRun") return { success: true, console: "", scopeKeys: [] };
        if (method === "getRun") return { status: "done" };
        throw new Error(`unexpected dispatch ${method}`);
      },
    } as unknown as DODispatch;
    const entityCache = {
      resolveContext: (id: string) => records[id]?.contextId ?? null,
      resolve: (id: string) => records[id] ?? null,
      resolveActive: (id: string) => records[id] ?? null,
      _onActivate() {},
      _onRetire() {},
    } as unknown as EntityCache;
    const entityStore = new WorkspaceEntityStore({
      doDispatch,
      workspaceId: "ws",
      entityCache,
      resolveDurableWorkQueues: () => [],
      materializeExecution: async () => undefined,
    });
    const service = createEvalService({
      resolveExecutionArtifact: () => EVAL_EXECUTION_IDENTITY.artifact,
      doDispatch,
      entityStore,
      retireEntity: vi.fn(async () => {}),
      tokenManager: {
        ensureToken: (id: string) => `tok:${id}`,
      } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
      workspaceId: "ws",
      executionSessions: new AgentExecutionSessionRegistry(),
      taskAuthorities: new TaskAuthorityRegistry(),
      kernelLeases: { touch: vi.fn(async () => {}) },
    });

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
        if (method === "entityActivate") return activatedEntity(args[0]);
        if (method === "entityResolve") return String(args[0]) === agentId ? agent : null;
        if (method === "slotResolveByEntity") return null;
        if (method === "runtimeResourceBindingsForEntity")
          return boundPanelIds.map((id) => ({
            resource: { kind: "panel-slot", id },
            capabilities: ["panel.inspect"],
            scope: { kind: "agent-channel", channelId: "quickfire-channel" },
          }));
        if (method === "startRun")
          return acceptedRunFixture(String((args[0] as { runId?: string }).runId));
        if (method === "executeRun") return { success: true, console: "", scopeKeys: [] };
        if (method === "getRun") return { status: "done" };
        throw new Error(`unexpected dispatch ${method}`);
      },
    } as unknown as DODispatch;
    const entityCache = {
      resolveContext: (id: string) => (id === agentId ? agent.contextId : null),
      resolve: (id: string) => (id === agentId ? agent : null),
      resolveActive: (id: string) => (id === agentId ? agent : null),
      _onActivate() {},
      _onRetire() {},
    } as unknown as EntityCache;
    const entityStore = new WorkspaceEntityStore({
      doDispatch,
      workspaceId: "ws",
      entityCache,
      resolveDurableWorkQueues: () => [],
      materializeExecution: async () => undefined,
    });
    const service = createEvalService({
      resolveExecutionArtifact: () => EVAL_EXECUTION_IDENTITY.artifact,
      doDispatch,
      entityStore,
      retireEntity: async () => undefined,
      tokenManager: { ensureToken: (id: string) => `tok:${id}` } as never,
      workspaceId: "ws",
      executionSessions: new AgentExecutionSessionRegistry(),
      taskAuthorities: new TaskAuthorityRegistry(),
      kernelLeases: { touch: async () => undefined },
    });

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
          resultReceiver: { kind: "caller" },
        }),
      ]
    );
    expect(ret).toEqual({
      runId,
      runDigest: "d".repeat(64),
      authorityManifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      status: "accepted",
    });

    const objectKey = evalKey(ownerId, "chan_1");
    // The run/effect key stays independent while the private causality field
    // carries the exact already-verified parent invocation.
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
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

    // Untimed asynchronous eval has no host-held execution or completion transport. The EvalDO
    // owns both after acknowledging startRun.
    expect(calls.some((c) => c.method === "executeRun")).toBe(false);
    expect(calls.some((c) => c.method === "onEvalComplete")).toBe(false);
  });

  it("retains exact context-file bytes and semantic source provenance before acceptance", async () => {
    const ownerId = "session:default";
    const { service, calls } = createHarness({ [ownerId]: "ctx:source" });
    await service.handler(
      activeInvocationContext(authenticatedCaller("shell:dev_cli", "shell")),
      "start",
      [
        {
          target: { kind: "owner-session", sessionId: ownerId },
          runId: "run:exact-source",
          source: { kind: "context-file", path: "scripts/check.ts" },
        },
      ]
    );
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

  it("retains admission and retries the same run after an ambiguous start acknowledgement", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:ambiguous";
    let acceptRetry!: () => void;
    const retryStartGate = new Promise<void>((resolve) => {
      acceptRetry = resolve;
    });
    const { service, calls, executionSessions, settleLiveEvent } = createHarness(
      { [ownerId]: "ctx_agent" },
      { rejectFirstStartRun: true, retryStartGate }
    );
    const runId = "effect:eval:ambiguous";

    await expect(
      service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
        inlineEvalStart({ scopeKey: "chan_1", code: "return 1;", runId }),
      ])
    ).rejects.toThrow(/lost startRun acknowledgement/);
    const objectKey = (
      calls.find((call) => call.method === "startRun")?.ref as { objectKey: string }
    ).objectKey;
    const runtimeId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
    expect(executionSessions.resolve(runtimeId)?.executor).toMatchObject({
      kind: "eval",
      evalRunId: runId,
    });

    acceptRetry();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.filter((call) => call.method === "startRun")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "startRun").map((call) => call.args[0])).toEqual([
      expect.objectContaining({ runId }),
      expect.objectContaining({ runId }),
    ]);
    expect(executionSessions.resolve(runtimeId)).not.toBeNull();
    settleLiveEvent();
    expect(executionSessions.resolve(runtimeId)).toMatchObject({
      executor: { kind: "eval", runtimeId, evalRunId: runId },
    });
  });

  it("fences an ambiguous original start when authenticated cancellation reaches the real domain first", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:cancel-before-reconcile";
    const { instance: domain } = await createTestDO(EvalDO, { RPC_FETCH: successfulTestRpcFetch });
    const domainStart = vi.spyOn(domain, "startRun");
    const execute = vi.fn(async () => ({ success: true, console: "must not execute" }));
    Object.defineProperty(domain, "runLocked", { value: execute });
    let releaseRetry!: () => void;
    const retryStartGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    const contexts: Record<string, string> = { [ownerId]: "ctx_agent" };
    const { service, calls, executionSessions, activity } = createHarness(contexts, {
      rejectFirstStartRun: true,
      retryStartGate,
      evalDomain: domain,
    });
    const caller = activeInvocationContext(authenticatedCaller(ownerId, "do"));
    const runId = "effect:eval:cancel-before-reconcile";
    try {
      await expect(
        service.handler(caller, "start", [
          inlineEvalStart({ scopeKey: "chan_1", code: "return 99;", runId }),
        ])
      ).rejects.toThrow("lost startRun acknowledgement");
      const ref = calls.find((call) => call.method === "startRun")!.ref as { objectKey: string };
      const runtimeId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${ref.objectKey}`;
      expect(executionSessions.resolve(runtimeId)).not.toBeNull();
      contexts[runtimeId] = "ctx_agent";
      await expect(
        service.handler(caller, "cancel", [{ runId, scopeKey: "chan_1" }])
      ).resolves.toMatchObject({ ok: true });
      const cancelled = domain.getRunReceipt(runId);
      expect(cancelled?.result).toMatchObject({ failureKind: "cancelled" });
      expect(activity.getActivity().activeRuns).toBe(0);
      releaseRetry();
      await vi.waitFor(() =>
        expect(calls.filter((call) => call.method === "startRun")).toHaveLength(2)
      );
      await vi.waitFor(() => expect(domainStart).toHaveBeenCalledTimes(1));
      await expect(domainStart.mock.results[0]!.value).resolves.toMatchObject({
        status: "cancelled",
        existing: true,
      });
      expect(domain.getRunReceipt(runId)).toEqual(cancelled);
      expect(execute).not.toHaveBeenCalled();
    } finally {
      releaseRetry();
      await domain.releaseForLifecycle({
        epoch: "test:reconcile",
        phase: "release",
        mode: "suspend",
        reason: "developer_restart",
        deadlineMs: 0,
      });
    }
  });

  it("releases the cell slot after a definitive start rejection without discarding its history", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:rejected";
    const { service, calls, executionSessions, activity } = createHarness(
      { [ownerId]: "ctx_agent" },
      { rejectStartRun: new Error("invalid eval request") }
    );
    const runId = "effect:eval:rejected";

    await expect(
      service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
        inlineEvalStart({ scopeKey: "chan_1", code: "return 1;", runId }),
      ])
    ).rejects.toThrow("invalid eval request");

    const objectKey = (
      calls.find((call) => call.method === "startRun")?.ref as { objectKey: string }
    ).objectKey;
    const runtimeId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
    expect(calls.filter((call) => call.method === "startRun")).toHaveLength(1);
    expect(executionSessions.resolve(runtimeId)).toMatchObject({
      executor: { kind: "eval", runtimeId, evalRunId: "effect:eval:rejected" },
    });
    expect(activity.getActivity().activeRuns).toBe(0);
  });

  it("does not poll after acceptance and releases the cell once from the trusted terminal sink", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:live-terminal";
    const { service, calls, executionSessions, activity, settleLiveEvent } = createHarness({
      [ownerId]: "ctx_agent",
    });
    const runId = "effect:eval:live-terminal";

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
      inlineEvalStart({
        scopeKey: "chan_1",
        code: "return 1;",
        runId,
        resultReceiver: { kind: "caller" },
      }),
    ]);

    const objectKey = (
      calls.find((call) => call.method === "startRun")?.ref as { objectKey: string }
    ).objectKey;
    const runtimeId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
    expect(calls.filter((call) => call.method === "getRun")).toHaveLength(0);
    expect(executionSessions.resolve(runtimeId)?.executor).toMatchObject({
      kind: "eval",
      evalRunId: runId,
    });
    expect(activity.getActivity().activeRuns).toBe(1);

    settleLiveEvent();
    settleLiveEvent();
    expect(executionSessions.resolve(runtimeId)).toMatchObject({
      executor: { kind: "eval", runtimeId, evalRunId: "effect:eval:live-terminal" },
    });
    expect(activity.getActivity().activeRuns).toBe(0);
    expect(calls.filter((call) => call.method === "getRun")).toHaveLength(0);
  });

  it("retains root and descendant test-history trust through cancellation", async () => {
    const ownerId = "session:default";
    const runId = "system-test-runner:cancel-lifecycle";
    const { service, calls, executionSessions, settleLiveEvent } = createHarness(
      { [ownerId]: "ctx:orchestrator" },
      { systemTestHarness: true, executeRunPending: true }
    );

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "shell")), "start", [
      inlineEvalStart({ code: "await new Promise(() => {});", runId }),
    ]);
    expect(calls.filter((call) => call.method === "getRun")).toHaveLength(0);
    const objectKey = (
      calls.find((call) => call.method === "startRun")?.ref as { objectKey: string }
    ).objectKey;
    const rootRuntimeId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
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
        kind: "eval",
        runtimeId: "do:vibestudio/internal:EvalDO:cancel-lifecycle-child",
        evalRunId: "system-test-runner:cancel-lifecycle-child",
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

    settleLiveEvent();
    expect(executionSessions.resolve(rootRuntimeId)).not.toBeNull();
    expect(executionSessions.resolve(child.executor.runtimeId)).not.toBeNull();
    expect(executionSessions.testPolicyForContext("ctx:orchestrator")).not.toBeNull();
    expect(executionSessions.testPolicyForContext("ctx:case")).not.toBeNull();
  });

  it("does not re-enter execution for a non-agent caller and closes from the terminal event", async () => {
    const ownerId = "session:default";
    const { service, calls, executionSessions, activity, settleLiveEvent } = createHarness({
      [ownerId]: "ctx:held",
    });

    const run = await service.handler(
      activeInvocationContext(authenticatedCaller(ownerId, "shell")),
      "start",
      [inlineEvalStart({ code: "return 1;", runId: "run:held" })]
    );
    const objectKey = (
      calls.find((call) => call.method === "startRun")?.ref as { objectKey: string }
    ).objectKey;
    const runtimeId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
    expect(run).toMatchObject({
      runId: "run:held",
      status: "accepted",
    });
    expect(calls.some((call) => call.method === "executeRun")).toBe(false);
    expect(executionSessions.resolve(runtimeId)).toMatchObject({
      executor: { kind: "eval", runtimeId, evalRunId: "run:held" },
    });
    expect(activity.getActivity().activeRuns).toBe(1);
    settleLiveEvent();
    expect(activity.getActivity().activeRuns).toBe(0);
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

  it("keeps missing-scope controls from admitting work and treats reset as already empty", async () => {
    const ownerId = "session:default";
    const { service, calls } = createHarness({ [ownerId]: "ctx_1" });
    const ctx = { caller: authenticatedCaller("shell:dev_cli", "shell") };
    const route = {
      target: { kind: "owner-session" as const, sessionId: ownerId },
      scopeKey: "missing",
    };
    const controls: Array<[string, unknown]> = [
      ["get", { ...route, runId: "unknown" }],
      ["receipt", { ...route, runId: "unknown" }],
      [
        "acknowledge",
        {
          ...route,
          runId: "unknown",
          receipt: { runDigest: "a".repeat(64), resultDigest: "b".repeat(64) },
        },
      ],
      ["events", { ...route, runId: "unknown" }],
      ["cancel", { ...route, runId: "unknown" }],
      ["readScopeTextPage", { ...route, key: "result", offset: 0, limit: 10 }],
      ["deleteScopeValue", { ...route, key: "result" }],
    ];
    for (const [method, args] of controls) {
      await expect(service.handler(ctx, method, [args])).rejects.toMatchObject({
        code: "ENOTFOUND",
        method,
      });
    }
    await expect(service.handler(ctx, "reset", [route])).resolves.toEqual({ ok: true });
    expect(
      calls.every((call) => ["entityResolveContext", "entityResolve"].includes(call.method))
    ).toBe(true);
  });

  it("does not rebind an admitted eval scope when its owner resolves to a different context", async () => {
    const ownerId = "session:default";
    const entityId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${evalKey(ownerId, "pinned")}`;
    const { service, calls } = createHarness({ [ownerId]: "ctx_new", [entityId]: "ctx_original" });
    await expect(
      service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "get", [
        {
          target: { kind: "owner-session", sessionId: ownerId },
          scopeKey: "pinned",
          runId: "original-run",
        },
      ])
    ).rejects.toMatchObject({ code: "EACCES", errorKind: "access" });
    expect(calls.every((call) => call.method === "entityResolveContext")).toBe(true);
  });

  it("getRun: routes to the owner's EvalDO by (owner, subKey)", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({
      [ownerId]: "ctx_agent",
      [`do:${INTERNAL_DO_SOURCE}:EvalDO:${evalKey(ownerId, "chan_1")}`]: "ctx_agent",
    });

    await service.handler({ caller: authenticatedCaller(ownerId, "do") }, "get", [
      { scopeKey: "chan_1", runId: "inv-42" },
    ]);

    const objectKey = evalKey(ownerId, "chan_1");
    expect(calls.find((c) => c.method === "getRun")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: ["inv-42"],
    });
  });

  it("large-result scope paging stays owner-scoped and forwards only bounded page fields", async () => {
    const ownerId = "session:default";
    const { service, calls } = createHarness({
      [ownerId]: "ctx_1",
      [`do:${INTERNAL_DO_SOURCE}:EvalDO:${evalKey(ownerId, "system-tests")}`]: "ctx_1",
    });
    const caller = { caller: authenticatedCaller("shell:dev_cli", "shell") };

    const page = await service.handler(caller, "readScopeTextPage", [
      {
        target: { kind: "owner-session", sessionId: ownerId },
        scopeKey: "system-tests",
        key: "__temporary",
        offset: 131_072,
        limit: 4096,
      },
    ]);
    expect(page).toEqual({ length: 3, encoding: "utf16le-base64", chunk: "YQBiAGMA" });
    expect(calls.find((call) => call.method === "readScopeTextPage")).toMatchObject({
      ref: {
        source: INTERNAL_DO_SOURCE,
        className: "EvalDO",
        objectKey: evalKey(ownerId, "system-tests"),
      },
      args: ["__temporary", 131_072, 4096],
    });

    await service.handler(caller, "deleteScopeValue", [
      {
        target: { kind: "owner-session", sessionId: ownerId },
        scopeKey: "system-tests",
        key: "__temporary",
      },
    ]);
    expect(calls.find((call) => call.method === "deleteScopeValue")).toMatchObject({
      ref: {
        source: INTERNAL_DO_SOURCE,
        className: "EvalDO",
        objectKey: evalKey(ownerId, "system-tests"),
      },
      args: ["__temporary"],
    });
  });

  it("disposes a finite eval kernel through its runtime lifecycle owner", async () => {
    const ownerId = "session:default";
    const contexts: Record<string, string | null> = { [ownerId]: "ctx_1" };
    const objectKey = evalKey(ownerId, "finite");
    const entityId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
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
    contexts[`do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`] = "ctx_1";
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
    const entityId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
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
    await expect(
      service.handler(caller, "get", [{ ...route, runId: "old-run" }])
    ).rejects.toMatchObject({ code: "ECLOSED" });
    expect(
      calls.some((call) =>
        ["entityActivate", "entityAdvanceExecution", "startRun", "getRun"].includes(call.method)
      )
    ).toBe(false);
  });

  it("routes control calls to an existing finite scope without reclassifying it", async () => {
    const ownerId = "session:default";
    const objectKey = evalKey(ownerId, "finite");
    const entityId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
    const { service, calls } = createHarness(
      {
        [ownerId]: "ctx_1",
        [entityId]: "ctx_1",
      },
      { finiteEvalEntityIds: new Set([entityId]) }
    );

    await expect(
      service.handler({ caller: authenticatedCaller("shell:dev_cli", "shell") }, "get", [
        {
          target: { kind: "owner-session", sessionId: ownerId },
          scopeKey: "finite",
          runId: "finite-run",
        },
      ])
    ).resolves.toMatchObject({ status: "done" });

    expect(calls.find((call) => call.method === "getRun")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: ["finite-run"],
    });
    expect(calls.some((call) => call.method === "entityActivate")).toBe(false);
    expect(calls.some((call) => call.method === "entityAdvanceExecution")).toBe(false);
  });

  it("refuses to reclassify a persistent eval scope as finite", async () => {
    const ownerId = "session:default";
    const objectKey = evalKey(ownerId, "default");
    const entityId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
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
    expect(calls.some((call) => call.method === "entityActivate")).toBe(false);
    expect(calls.some((call) => call.method === "entityAdvanceExecution")).toBe(false);
  });

  it("refuses to reuse a finite eval scope as a persistent notebook", async () => {
    const ownerId = "session:default";
    const objectKey = evalKey(ownerId, "finite");
    const entityId = `do:${INTERNAL_DO_SOURCE}:EvalDO:${objectKey}`;
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
    expect(calls.some((call) => call.method === "entityActivate")).toBe(false);
    expect(calls.some((call) => call.method === "entityAdvanceExecution")).toBe(false);
  });

  it("cancel: routes to the owner's EvalDO by (owner, subKey) and forwards the runId", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({
      [ownerId]: "ctx_agent",
      [`do:${INTERNAL_DO_SOURCE}:EvalDO:${evalKey(ownerId, "chan_1")}`]: "ctx_agent",
    });

    const ret = await service.handler({ caller: authenticatedCaller(ownerId, "do") }, "cancel", [
      { scopeKey: "chan_1", runId: "inv-42" },
    ]);
    expect(ret).toEqual({ ok: true, forcedReset: false });

    const objectKey = evalKey(ownerId, "chan_1");
    expect(calls.find((c) => c.method === "cancel")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: ["inv-42"],
    });
  });
});

/** Explicit deadlines retain a host-side CPU-starvation supervisor. It probes the
 * canonical run but never invokes execution or completion. */
function createHeldFailHarness(opts: {
  contextId: string;
  getRunResponse: { status: string; result?: unknown };
  heldMode?: "reject" | "hang" | "cooperative-timeout";
  /** Per-probe behavior consumed in order; the last entry repeats. Overrides heldMode. */
  getRunPlan?: Array<"running" | "done" | "hang" | "reject">;
  recoveryResult?: { status: string; result?: unknown };
  recoveryDelayMs?: number;
}) {
  const calls: Array<{ ref: unknown; method: string; args: unknown[] }> = [];
  let getRunResponse = opts.getRunResponse;
  let probeIndex = 0;
  const doDispatch = {
    async dispatchHeld(_ref: unknown, method: string, ..._args: unknown[]) {
      throw new Error(`watchdog must not hold or execute ${method}`);
    },
    async dispatch(ref: unknown, method: string, ...args: unknown[]) {
      calls.push({ ref, method, args });
      if (method === "entityResolveContext") return opts.contextId;
      if (method === "entityActivate") return activatedEntity(args[0]);
      if (method === "entityResolve") return null;
      if (method === "slotResolveByEntity") return null;
      if (method === "startRun") return acceptedRunFixture((args[0] as { runId: string }).runId);
      if (method === "getRun") {
        if (opts.getRunPlan) {
          const step =
            opts.getRunPlan[Math.min(probeIndex++, opts.getRunPlan.length - 1)] ?? "running";
          if (step === "hang") return new Promise<never>(() => {});
          if (step === "reject") throw new Error("simulated probe transport refusal");
          if (step === "done")
            return { status: "done", result: { success: true, console: "", scopeKeys: [] } };
          return { status: "running" };
        }
        if (opts.heldMode === "hang") return new Promise<never>(() => {});
        if (opts.heldMode === "reject") throw new Error("simulated probe transport refusal");
        return getRunResponse;
      }
      if (method === "onEvalComplete") return undefined;
      if (method === "runtimeResourceBindingsForEntity") return [];
      throw new Error(`unexpected dispatch ${method}`);
    },
  } as unknown as DODispatch;
  const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
  const entityCache = {
    resolveContext: () => opts.contextId,
    resolveActive: (id: string) =>
      id === ownerId
        ? ({
            id,
            kind: "do",
            source: { repoPath: "workers/agent-worker", effectiveVersion: "test" },
            contextId: opts.contextId,
            className: "AiChatWorker",
            key: "abc",
            agentBinding: {
              entityId: "session:agent",
              contextId: opts.contextId,
              channelId: "chan_1",
            },
            authoritySessionId: "authority:eval-test",
            createdAt: 0,
            status: "active",
            cleanupComplete: true,
          } as EntityRecord)
        : null,
    resolve: () => null,
    _onActivate() {},
    _onRetire() {},
  } as unknown as EntityCache;
  const entityStore = new WorkspaceEntityStore({
    doDispatch,
    workspaceId: "ws_1",
    entityCache,
    resolveDurableWorkQueues: () => [],
    materializeExecution: async () => undefined,
  });
  const recoverUnresponsiveSandbox = vi.fn(async () => {
    if (opts.recoveryDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.recoveryDelayMs));
    }
    if (opts.recoveryResult) getRunResponse = opts.recoveryResult;
  });
  const service = createEvalService({
    resolveExecutionArtifact: () => EVAL_EXECUTION_IDENTITY.artifact,
    doDispatch,
    entityStore,
    retireEntity: vi.fn(async () => {}),
    tokenManager: {
      ensureToken: (id: string) => `tok:${id}`,
    } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
    workspaceId: "ws_1",
    executionSessions: new AgentExecutionSessionRegistry(),
    taskAuthorities: new TaskAuthorityRegistry(),
    recoverUnresponsiveSandbox,
    livenessProbeMs: 2,
    kernelLeases: { touch: vi.fn(async () => {}) },
  });
  return { service, calls, ownerId, recoverUnresponsiveSandbox };
}

describe("createEvalService — explicit timeout process watchdog", () => {
  it("does not arm supervision after a terminal event races the start acknowledgement", async () => {
    const recoverUnresponsiveSandbox = vi.fn(async () => {});
    const { service, calls } = createHarness(
      { "do:workers/agent-worker:AiChatWorker:fast": "ctx_agent" },
      {
        terminalDuringStart: true,
        recoverUnresponsiveSandbox,
        livenessProbeMs: 2,
      }
    );

    await service.handler(
      activeInvocationContext(
        authenticatedCaller("do:workers/agent-worker:AiChatWorker:fast", "do")
      ),
      "start",
      [
        inlineEvalStart({
          scopeKey: "chan_1",
          code: "return 1;",
          runId: "inv-terminal-during-start",
          timeoutMs: 5,
          resultReceiver: { kind: "caller" },
        }),
      ]
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls.some((call) => call.method === "getRun")).toBe(false);
    expect(recoverUnresponsiveSandbox).not.toHaveBeenCalled();
  });

  it("accepts a cooperative timeout without invoking process recovery", async () => {
    const { service, calls, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: {
        status: "done",
        result: { success: false, console: "", failureCode: "eval_deadline_exceeded" },
      },
      heldMode: "cooperative-timeout",
    });

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
      inlineEvalStart({
        scopeKey: "chan_1",
        code: "while (true) {}",
        runId: "inv-cooperative",
        timeoutMs: 5,
        resultReceiver: { kind: "caller" },
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(recoverUnresponsiveSandbox).not.toHaveBeenCalled();
    expect(calls.some((call) => call.method === "onEvalComplete")).toBe(false);
  });

  it("recycles only when the canonical liveness probe cannot execute", async () => {
    const interrupted = {
      success: false,
      console: "",
      error: "eval interrupted by restart",
    };
    const { service, calls, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
      heldMode: "hang",
      recoveryResult: { status: "done", result: interrupted },
      recoveryDelayMs: 5,
    });

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
      inlineEvalStart({
        scopeKey: "chan_1",
        code: "while (true) {}",
        runId: "inv-watchdog",
        timeoutMs: 5,
        resultReceiver: { kind: "caller" },
      }),
    ]);
    await vi.waitFor(() => expect(recoverUnresponsiveSandbox).toHaveBeenCalledOnce());
    expect(recoverUnresponsiveSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "inv-watchdog", timeoutMs: 5 })
    );
    expect(calls.some((call) => call.method === "getRun")).toBe(true);
    expect(calls.some((call) => call.method === "executeRun")).toBe(false);
    expect(calls.some((call) => call.method === "onEvalComplete")).toBe(false);
  });

  it("does not arm host recovery when the caller omits a deadline", async () => {
    const { service, calls, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
      heldMode: "hang",
    });

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
      inlineEvalStart({
        scopeKey: "chan_1",
        code: "while(true){}",
        runId: "inv-h3",
        resultReceiver: { kind: "caller" },
      }),
    ]);
    await new Promise((r) => setTimeout(r, 10));

    expect(recoverUnresponsiveSandbox).not.toHaveBeenCalled();
    expect(calls.some((c) => c.method === "getRun")).toBe(false);
    expect(calls.some((c) => c.method === "onEvalComplete")).toBe(false);
  });

  it("treats a rejected probe like a hang and recovers after one quick retry", async () => {
    const { service, calls, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
      getRunPlan: ["reject"],
    });

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
      inlineEvalStart({
        scopeKey: "chan_1",
        code: "while (true) {}",
        runId: "inv-probe-reject",
        timeoutMs: 5,
        resultReceiver: { kind: "caller" },
      }),
    ]);
    await vi.waitFor(() => expect(recoverUnresponsiveSandbox).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    });

    // One quick retry absorbed a transient blip before recovery was invoked.
    expect(calls.filter((call) => call.method === "getRun").length).toBeGreaterThanOrEqual(2);
    expect(calls.some((call) => call.method === "executeRun")).toBe(false);
  });

  it("keeps probing after a live answer and recovers when the isolate wedges later", async () => {
    const { service, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
      getRunPlan: ["running", "hang"],
    });

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
      inlineEvalStart({
        scopeKey: "chan_1",
        code: "while (true) {}",
        runId: "inv-late-wedge",
        timeoutMs: 5,
        resultReceiver: { kind: "caller" },
      }),
    ]);

    // The first probe answers live (which previously disarmed the watchdog
    // permanently); the second hangs and must still trigger recovery.
    await vi.waitFor(() => expect(recoverUnresponsiveSandbox).toHaveBeenCalledOnce(), {
      timeout: 1_000,
    });
  });

  it("disposes supervision once the probe observes a terminal run", async () => {
    const { service, calls, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
      getRunPlan: ["running", "done"],
    });

    await service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
      inlineEvalStart({
        scopeKey: "chan_1",
        code: "return 1;",
        runId: "inv-terminal-dispose",
        timeoutMs: 5,
        resultReceiver: { kind: "caller" },
      }),
    ]);
    await vi.waitFor(
      () => expect(calls.filter((call) => call.method === "getRun").length).toBe(2),
      { timeout: 1_000 }
    );

    // No further probes after terminal, and no recovery.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls.filter((call) => call.method === "getRun")).toHaveLength(2);
    expect(recoverUnresponsiveSandbox).not.toHaveBeenCalled();
  });

  it("arms exactly one liveness supervisor per runId across replayed starts", async () => {
    const { service, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
      heldMode: "hang",
    });
    const start = () =>
      service.handler(activeInvocationContext(authenticatedCaller(ownerId, "do")), "start", [
        inlineEvalStart({
          scopeKey: "chan_1",
          code: "while (true) {}",
          runId: "inv-replayed",
          timeoutMs: 5,
          resultReceiver: { kind: "caller" },
        }),
      ]);

    await start();
    await start();
    await vi.waitFor(() => expect(recoverUnresponsiveSandbox).toHaveBeenCalled(), {
      timeout: 1_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Two replayed starts share one supervision record — a second independent
    // loop would have invoked recovery a second time.
    expect(recoverUnresponsiveSandbox).toHaveBeenCalledOnce();
  });

  // Plan §6.4: an `agent` caller binds to its host-verified entity binding with
  // zero flags; the EvalDO trusts the binding, not client-supplied owner/context.
  it("binds agent eval to the entity binding (owner = binding.entityId, context = binding.contextId)", async () => {
    const { service, calls } = createHarness({});
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

    // Registered + ran against the EvalDO keyed by the BINDING entity, in the
    // bound context — no ownerId/contextId came from the client.
    const objectKey = evalKey("ent_agent", "default");
    const activate = calls.find((c) => c.method === "entityActivate");
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
