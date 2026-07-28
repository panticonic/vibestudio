import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ledgerTest } from "../../../tests/helpers/ledgerTest.js";
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
import { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { EvalStartInput } from "@vibestudio/service-schemas/eval";

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
    rejectFirstStartRun?: boolean;
    retryStartGate?: Promise<void>;
    rejectFirstGetRun?: boolean;
    retryGetRunGate?: Promise<void>;
    finiteEvalEntityIds?: ReadonlySet<string>;
    kernelLeaseError?: Error;
    systemTestHarness?: boolean;
    executeRunPending?: boolean;
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
      if (method === "entityActivate") {
        return undefined;
      }
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
            createdAt: 0,
            status: "active",
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
        return { ok: true };
      }
      if (method === "startRun") {
        if (options.rejectFirstStartRun && !rejectedStartRun) {
          rejectedStartRun = true;
          throw new Error("simulated lost startRun acknowledgement");
        }
        if (rejectedStartRun && options.retryStartGate) await options.retryStartGate;
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
    // Always a cache miss → ensureEvalDO takes the activate path, so the existing
    // entityActivate-dispatch assertions still hold.
    resolveActive(id: string) {
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
          activeAuthority: { requests: EVAL_EXECUTION_IDENTITY.authorityRequests },
          parentId: "session:default",
          stateArgs: {
            ownerPrincipalId: "session:default",
            subKey: finite ? "finite" : "default",
            agentExecutionAdmission: { v: 1, ownerId: "session:default" },
            ...(finite ? { lifecycle: "finite" } : {}),
          },
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
  const entityStore = new WorkspaceEntityStore({ doDispatch, workspaceId: "ws_1", entityCache });
  const executionSessions = new AgentExecutionSessionRegistry();
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
  const service = createEvalService({
    doDispatch,
    entityStore,
    retireEntity,
    tokenManager: {
      ensureToken: (callerId: string) => `tok:${callerId}`,
    } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
    workspaceId: "ws_1",
    executionSessions,
    eventSinks,
    ...(options.systemTestHarness ? { isSystemTestHarness: () => true } : {}),
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
    retireEntity,
    settleLiveEvent() {
      const callbacks = [...eventSinkTerminal.values()];
      eventSinkTerminal.clear();
      for (const callback of callbacks) callback();
    },
  };
}

describe("createEvalService", () => {
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
          activeAuthority: { requests: EVAL_EXECUTION_IDENTITY.authorityRequests },
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
        if (method === "entityActivate") return undefined;
        if (method === "entityResolve") return records[String(args[0])] ?? null;
        // Durable nav→slot: the panel entity "panel:p" is the current entity of open slot "panel:tree/p".
        if (method === "slotResolveByEntity")
          return String(args[0]) === "panel:p" ? "panel:tree/p" : null;
        if (method === "startRun")
          return { runId: String((args[0] as { runId?: string }).runId), status: "pending" };
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
    const entityStore = new WorkspaceEntityStore({ doDispatch, workspaceId: "ws", entityCache });
    const service = createEvalService({
      doDispatch,
      entityStore,
      retireEntity: vi.fn(async () => {}),
      tokenManager: {
        ensureToken: (id: string) => `tok:${id}`,
      } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
      workspaceId: "ws",
      executionSessions: new AgentExecutionSessionRegistry(),
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
    expect(executionSessions.resolve(runtimeId)?.eval.runId).toBe(runId);

    acceptRetry();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.filter((call) => call.method === "startRun")).toHaveLength(2);
    expect(calls.filter((call) => call.method === "startRun").map((call) => call.args[0])).toEqual([
      expect.objectContaining({ runId }),
      expect.objectContaining({ runId }),
    ]);
    expect(executionSessions.resolve(runtimeId)).not.toBeNull();
    settleLiveEvent();
    expect(executionSessions.resolve(runtimeId)).toBeNull();
  });

  it("does not poll after acceptance and closes admission once from the trusted terminal sink", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:live-terminal";
    const { service, calls, executionSessions, settleLiveEvent } = createHarness({
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
    expect(executionSessions.resolve(runtimeId)?.eval.runId).toBe(runId);

    settleLiveEvent();
    settleLiveEvent();
    expect(executionSessions.resolve(runtimeId)).toBeNull();
    expect(calls.filter((call) => call.method === "getRun")).toHaveLength(0);
  });

  it("retains root and descendant test admissions through cancelling and revokes them at cancelled", async () => {
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
      userland: [],
      unexpectedPrompts: "fail",
    });
    const casePolicy = executionSessions.testPolicyForContext("ctx:case");
    if (!casePolicy) throw new Error("Expected inherited case policy");
    const child = executionSessions.admit({
      mode: "test",
      ownerUser: "user:usr_test",
      workspaceId: "ws_1",
      contextId: "ctx:case",
      agentBinding: null,
      taskRef: "system-test:cancel-lifecycle-case",
      harness: {
        principal: `code:workers/system-test-runner@${"a".repeat(64)}`,
        repoPath: "workers/system-test-runner",
        effectiveVersion: "test",
      },
      eval: {
        runtimeId: "do:vibestudio/internal:EvalDO:cancel-lifecycle-child",
        runId: "system-test-runner:cancel-lifecycle-child",
        authorityManifest: {
          mode: "adaptive",
          effects: "mutable",
          approvals: "prompt",
          requests: [],
          digest: "0".repeat(64),
        },
      },
      causalParent: null,
      testPolicy: casePolicy,
    });

    expect(executionSessions.resolve(rootRuntimeId)?.nonce).toBe(root?.nonce);
    expect(executionSessions.resolve(child.eval.runtimeId)?.nonce).toBe(child.nonce);
    expect(executionSessions.resolve(rootRuntimeId)).not.toBeNull();
    expect(executionSessions.resolve(child.eval.runtimeId)).not.toBeNull();

    settleLiveEvent();
    expect(executionSessions.resolve(rootRuntimeId)).toBeNull();
    expect(executionSessions.resolve(child.eval.runtimeId)).toBeNull();
    expect(executionSessions.testPolicyForContext("ctx:orchestrator")).toBeNull();
    expect(executionSessions.testPolicyForContext("ctx:case")).toBeNull();
  });

  it("closes admission immediately for a start that returns its terminal snapshot", async () => {
    const ownerId = "session:default";
    const { service, calls, executionSessions } = createHarness({ [ownerId]: "ctx:held" });

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
      status: "terminal",
      snapshot: { status: "done", result: { success: true } },
    });
    expect(executionSessions.resolve(runtimeId)).toBeNull();
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

  it("getRun: routes to the owner's EvalDO by (owner, subKey)", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

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
    const { service, calls } = createHarness({ [ownerId]: "ctx_1" });
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

    expect(calls.find((call) => call.method === "dispose")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: [],
    });
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
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    const ret = await service.handler({ caller: authenticatedCaller(ownerId, "do") }, "cancel", [
      { scopeKey: "chan_1", runId: "inv-42" },
    ]);
    expect(ret).toEqual({ ok: true });

    const objectKey = evalKey(ownerId, "chan_1");
    expect(calls.find((c) => c.method === "cancel")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: ["inv-42"],
    });
  });
});

/** Explicit deadlines retain a host-side CPU-starvation watchdog. It observes but does not execute
 * or deliver the EvalDO-owned asynchronous run. */
function createHeldFailHarness(opts: {
  contextId: string;
  getRunResponse: { status: string; result?: unknown };
  heldMode?: "reject" | "hang" | "cooperative-timeout";
  recoveryResult?: { status: string; result?: unknown };
  recoveryDelayMs?: number;
}) {
  const calls: Array<{ ref: unknown; method: string; args: unknown[] }> = [];
  let getRunResponse = opts.getRunResponse;
  let rejectHeld: ((error: Error) => void) | undefined;
  const doDispatch = {
    async dispatchHeld(_ref: unknown, method: string, ..._args: unknown[]) {
      if (method === "executeRun") {
        if (opts.heldMode === "cooperative-timeout") {
          return { success: false, console: "", error: "eval timed out after 5ms" };
        }
        if (opts.heldMode === "hang") {
          return new Promise<never>((_resolve, reject) => {
            rejectHeld = reject;
          });
        }
        throw new Error("held connection dropped (server restart)");
      }
      // run (the synchronous held path) is not exercised here.
      throw new Error(`unexpected dispatchHeld ${method}`);
    },
    async dispatch(ref: unknown, method: string, ...args: unknown[]) {
      calls.push({ ref, method, args });
      if (method === "entityResolveContext") return opts.contextId;
      if (method === "entityActivate") return undefined;
      if (method === "entityResolve") return null;
      if (method === "slotResolveByEntity") return null;
      if (method === "startRun")
        return { runId: (args[0] as { runId: string }).runId, status: "pending" };
      if (method === "getRun") return getRunResponse;
      if (method === "onEvalComplete") return undefined;
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
            createdAt: 0,
            status: "active",
            cleanupComplete: true,
          } as EntityRecord)
        : null,
    resolve: () => null,
    _onActivate() {},
    _onRetire() {},
  } as unknown as EntityCache;
  const entityStore = new WorkspaceEntityStore({ doDispatch, workspaceId: "ws_1", entityCache });
  const recoverUnresponsiveSandbox = vi.fn(async () => {
    // Model the real recovery race: killing workerd rejects the held request
    // before the replacement runtime has restored the durable run state.
    rejectHeld?.(new Error("held connection dropped during sandbox recovery"));
    if (opts.recoveryDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, opts.recoveryDelayMs));
    }
    if (opts.recoveryResult) getRunResponse = opts.recoveryResult;
  });
  const service = createEvalService({
    doDispatch,
    entityStore,
    retireEntity: vi.fn(async () => {}),
    tokenManager: {
      ensureToken: (id: string) => `tok:${id}`,
    } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
    workspaceId: "ws_1",
    executionSessions: new AgentExecutionSessionRegistry(),
    recoverUnresponsiveSandbox,
    watchdogGraceMs: 1,
    kernelLeases: { touch: vi.fn(async () => {}) },
  });
  return { service, calls, ownerId, recoverUnresponsiveSandbox };
}

describe("createEvalService — explicit timeout process watchdog", () => {
  it("accepts a cooperative timeout without invoking process recovery", async () => {
    const { service, calls, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
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

  it("recycles an unresponsive synchronous sandbox at its host deadline and delivers the reconciled terminal", async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(recoverUnresponsiveSandbox).toHaveBeenCalledOnce();
    expect(recoverUnresponsiveSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "inv-watchdog", timeoutMs: 5 })
    );
    // Terminal admission closure is producer-pushed; watchdog recovery never
    // creates a per-run status polling loop.
    expect(calls.some((call) => call.method === "getRun")).toBe(false);
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
