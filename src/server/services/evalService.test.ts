import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createVerifiedCaller,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import type { DODispatch } from "../doDispatch.js";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import { createEvalService } from "./evalService.js";
import { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";

const WORKSPACE_REF = {
  source: INTERNAL_DO_SOURCE,
  className: "WorkspaceDO",
  objectKey: "ws_1",
};

function evalKey(ownerId: string, subKey: string): string {
  return createHash("sha256").update(`${ownerId}\0${subKey}`).digest("hex").slice(0, 40);
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

function createHarness(contexts: Record<string, string | null>) {
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
      if (method === "entityResolveContext") {
        return contexts[String(args[0])] ?? null;
      }
      if (method === "entityActivate") {
        return undefined;
      }
      if (method === "entityResolve") {
        // No lineage in the mock → resolveParentPanel walk ends with no parent.
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
      if (method === "cancel") {
        return { ok: true };
      }
      if (method === "startRun") {
        return { runId: (args[0] as { runId: string }).runId, status: "pending" };
      }
      if (method === "executeRun") {
        return { success: true, console: "ok", scopeKeys: [] };
      }
      if (method === "getRun") {
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
  const service = createEvalService({
    doDispatch,
    entityStore,
    tokenManager: {
      ensureToken: (callerId: string) => `tok:${callerId}`,
    } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
  });
  return { service, calls };
}

describe("createEvalService", () => {
  it("runs CLI eval as the selected session owner and context", async () => {
    const { service, calls } = createHarness({ "session:default": "ctx_1" });

    await service.handler({ caller: createVerifiedCaller("shell:dev_cli", "shell") }, "run", [
      {
        ownerId: "session:default",
        contextId: "ctx_1",
        subKey: "default",
        code: "return 1;",
      },
    ]);

    const objectKey = evalKey("session:default", "default");
    expect(calls[0]).toEqual({
      ref: WORKSPACE_REF,
      method: "entityActivate",
      args: [
        {
          kind: "do",
          source: { repoPath: INTERNAL_DO_SOURCE, effectiveVersion: "internal" },
          contextId: "ctx_1",
          className: "EvalDO",
          key: objectKey,
          ownerUserId: undefined,
          agentBinding: undefined,
          // The EvalDO's launch parent IS its owner — bridges the lineage so entities spawned FROM an
          // eval (e.g. headless sub-agents) resolve up through the owner to the owner's panel.
          parentId: "session:default",
          stateArgs: {
            ownerPrincipalId: "session:default",
            subKey: "default",
            authorityDelegationPurpose: "tool-eval",
          },
        },
      ],
    });
    expect(calls.find((c) => c.method === "run")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      method: "run",
      args: [
        expect.objectContaining({
          code: "return 1;",
          contextId: "ctx_1",
        }),
      ],
    });
    expect(
      (calls.find((c) => c.method === "run")?.args[0] as { timeoutMs?: number }).timeoutMs
    ).toBeUndefined();
  });

  it("keeps entity callers bound to their verified runtime owner", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    await service.handler(activeInvocationContext(createVerifiedCaller(ownerId, "do")), "run", [
      { subKey: "chan_1", code: "return 1;" },
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
            authorityDelegationPurpose: "agentic-code-execution",
          },
        }),
      ],
    });
    expect(calls.find((c) => c.method === "run")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      method: "run",
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
      service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "run", [
        { subKey: "chan_1", code: "return 1;" },
      ])
    ).rejects.toMatchObject({ code: "EACCES", errorKind: "access" });

    expect(calls.some((call) => call.method === "entityActivate")).toBe(false);
    expect(calls.some((call) => call.method === "run")).toBe(false);
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
        if (method === "run") return { success: true, console: "", scopeKeys: [] };
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
      tokenManager: {
        ensureToken: (id: string) => `tok:${id}`,
      } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
    });

    await service.handler(
      activeInvocationContext(createVerifiedCaller("do:src:Agent:k", "do"), "c"),
      "run",
      [{ code: "return 1;" }]
    );

    const runCall = calls.find((c) => c.method === "run");
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
      service.handler({ caller: createVerifiedCaller("panel:one", "panel") }, "run", [
        {
          ownerId: "session:default",
          contextId: "ctx_1",
          subKey: "default",
          code: "return 1;",
        },
      ])
    ).rejects.toThrow(/restricted to shell\/server/);
  });

  it("rejects missing or ambiguous run sources even when handler is called directly", async () => {
    const { service } = createHarness({ "session:default": "ctx_1" });
    const ctx = { caller: createVerifiedCaller("shell:dev_cli", "shell") };

    await expect(
      service.handler(ctx, "run", [
        { ownerId: "session:default", contextId: "ctx_1", subKey: "default" },
      ])
    ).rejects.toThrow(/exactly one of code or path/);

    await expect(
      service.handler(ctx, "run", [
        {
          ownerId: "session:default",
          contextId: "ctx_1",
          subKey: "default",
          code: "return 1;",
          path: "/snippet.ts",
        },
      ])
    ).rejects.toThrow(/exactly one of code or path/);
  });

  it("keeps eval effect identity distinct from its exact causal parent", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });
    const runId = "effect:eval:42";
    const agentInvocationId = "invocation:parent:42";

    const ret = await service.handler(
      activeInvocationContext(createVerifiedCaller(ownerId, "do"), "chan_1", agentInvocationId),
      "startRun",
      [{ subKey: "chan_1", code: "return 1;", runId }]
    );
    expect(ret).toEqual({ runId });

    const objectKey = evalKey(ownerId, "chan_1");
    // The run/effect key stays independent while the private causality field
    // carries the exact already-verified parent invocation.
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: [
        expect.objectContaining({
          runId,
          agentInvocationId,
          channelId: "chan_1",
          agentRef: ownerId,
        }),
      ],
    });
    expect(
      (calls.find((c) => c.method === "startRun")?.args[0] as { timeoutMs?: number }).timeoutMs
    ).toBeUndefined();

    // The held run + completion push run on a background task — let them settle.
    await new Promise((r) => setTimeout(r, 10));
    // executeRun was dispatched HELD (the mock records dispatchHeld as a dispatch).
    expect(calls.find((c) => c.method === "executeRun")).toMatchObject({ args: [runId] });
    // Completion pushed to the owning agent DO, content-routed by channelId.
    expect(calls.find((c) => c.method === "onEvalComplete")).toMatchObject({
      ref: { source: "workers/agent-worker", className: "AiChatWorker", objectKey: "abc" },
      args: [expect.objectContaining({ runId, agentInvocationId, channelId: "chan_1" })],
    });
  });

  it("startRun without a caller runId mints a server uuid (and uses it for the run)", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    const ret = (await service.handler(
      activeInvocationContext(createVerifiedCaller(ownerId, "do")),
      "startRun",
      [{ subKey: "chan_1", code: "return 1;" }]
    )) as { runId: string };
    expect(ret.runId).toBeTruthy();
    expect(calls.find((c) => c.method === "startRun")).toMatchObject({
      args: [expect.objectContaining({ runId: ret.runId })],
    });
  });

  it("preserves an explicit agent eval deadline", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    await service.handler(
      activeInvocationContext(createVerifiedCaller(ownerId, "do")),
      "startRun",
      [{ subKey: "chan_1", code: "return 1;", timeoutMs: 12_345 }]
    );

    expect(calls.find((c) => c.method === "startRun")?.args[0]).toMatchObject({
      timeoutMs: 12_345,
    });
  });

  it("getRun: routes to the owner's EvalDO by (owner, subKey)", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    await service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "getRun", [
      { subKey: "chan_1", runId: "inv-42" },
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
    const caller = { caller: createVerifiedCaller("shell:dev_cli", "shell") };

    const page = await service.handler(caller, "readScopeTextPage", [
      {
        ownerId,
        contextId: "ctx_1",
        subKey: "system-tests",
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
        ownerId,
        contextId: "ctx_1",
        subKey: "system-tests",
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

  it("cancel: routes to the owner's EvalDO by (owner, subKey) and forwards the runId", async () => {
    const ownerId = "do:workers/agent-worker:AiChatWorker:abc";
    const { service, calls } = createHarness({ [ownerId]: "ctx_agent" });

    const ret = await service.handler({ caller: createVerifiedCaller(ownerId, "do") }, "cancel", [
      { subKey: "chan_1", runId: "inv-42" },
    ]);
    expect(ret).toEqual({ ok: true });

    const objectKey = evalKey(ownerId, "chan_1");
    expect(calls.find((c) => c.method === "cancel")).toMatchObject({
      ref: { source: INTERNAL_DO_SOURCE, className: "EvalDO", objectKey },
      args: ["inv-42"],
    });
  });
});

/**
 * F2: when the held `executeRun` dispatch dies (server restart dropped the connection), the service
 * reconciles the run's terminal state via `getRun` and pushes `onEvalComplete` itself, so the agent's
 * parked invocation settles even if its own poll backstop never re-fires.
 */
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
    tokenManager: {
      ensureToken: (id: string) => `tok:${id}`,
    } as unknown as Parameters<typeof createEvalService>[0]["tokenManager"],
    recoverUnresponsiveSandbox,
    watchdogGraceMs: 1,
  });
  return { service, calls, ownerId, recoverUnresponsiveSandbox };
}

describe("createEvalService — F2 held-run failure reconciliation", () => {
  it("accepts a cooperative synchronous timeout without invoking process recovery", async () => {
    const { service, calls, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
      heldMode: "cooperative-timeout",
    });

    await service.handler(
      activeInvocationContext(createVerifiedCaller(ownerId, "do")),
      "startRun",
      [{ subKey: "chan_1", code: "while (true) {}", runId: "inv-cooperative", timeoutMs: 5 }]
    );
    await new Promise((resolve) => setTimeout(resolve, 15));

    expect(recoverUnresponsiveSandbox).not.toHaveBeenCalled();
    expect(calls.find((call) => call.method === "onEvalComplete")?.args[0]).toMatchObject({
      runId: "inv-cooperative",
      result: { success: false, error: "eval timed out after 5ms" },
    });
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

    await service.handler(
      activeInvocationContext(createVerifiedCaller(ownerId, "do")),
      "startRun",
      [{ subKey: "chan_1", code: "while (true) {}", runId: "inv-watchdog", timeoutMs: 5 }]
    );
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(recoverUnresponsiveSandbox).toHaveBeenCalledOnce();
    expect(recoverUnresponsiveSandbox).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "inv-watchdog", timeoutMs: 5 })
    );
    expect(calls.find((call) => call.method === "getRun")).toMatchObject({
      args: ["inv-watchdog"],
    });
    expect(calls.find((call) => call.method === "onEvalComplete")?.args[0]).toMatchObject({
      runId: "inv-watchdog",
      result: interrupted,
    });
  });

  it("pushes onEvalComplete with the reconciled getRun result when the held run died but completed (done)", async () => {
    const result = { success: true, console: "ok", returnValue: 7 };
    const { service, calls, ownerId } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "done", result },
    });

    await service.handler(
      activeInvocationContext(createVerifiedCaller(ownerId, "do")),
      "startRun",
      [{ subKey: "chan_1", code: "return 7;", runId: "inv-h1" }]
    );
    await new Promise((r) => setTimeout(r, 10));

    // After the held dispatch threw, the service reconciled via getRun and pushed the REAL result.
    expect(calls.find((c) => c.method === "getRun")).toMatchObject({ args: ["inv-h1"] });
    expect(calls.find((c) => c.method === "onEvalComplete")).toMatchObject({
      ref: { source: "workers/agent-worker", className: "AiChatWorker", objectKey: "abc" },
      args: [expect.objectContaining({ runId: "inv-h1", channelId: "chan_1", result })],
    });
  });

  it("pushes a synthetic terminal failure when the held run is gone (cancelled/unknown)", async () => {
    const { service, calls, ownerId } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "cancelled" },
    });

    await service.handler(
      activeInvocationContext(createVerifiedCaller(ownerId, "do")),
      "startRun",
      [{ subKey: "chan_1", code: "return 1;", runId: "inv-h2" }]
    );
    await new Promise((r) => setTimeout(r, 10));

    const push = calls.find((c) => c.method === "onEvalComplete");
    expect(push).toBeTruthy();
    expect((push!.args[0] as { result: { success: boolean } }).result.success).toBe(false);
    expect((push!.args[0] as { runId: string }).runId).toBe("inv-h2");
  });

  it("does not arm host recovery when the caller omits a deadline", async () => {
    const { service, calls, ownerId, recoverUnresponsiveSandbox } = createHeldFailHarness({
      contextId: "ctx_agent",
      getRunResponse: { status: "running" },
      heldMode: "hang",
    });

    await service.handler(
      activeInvocationContext(createVerifiedCaller(ownerId, "do")),
      "startRun",
      [{ subKey: "chan_1", code: "while(true){}", runId: "inv-h3" }]
    );
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
        createVerifiedCaller("agent:ent_agent", "agent", null, binding),
        binding.channelId,
        "invocation:bound-agent"
      ),
      "run",
      [{ code: "return 1;" }]
    );

    // Registered + ran against the EvalDO keyed by the BINDING entity, in the
    // bound context — no ownerId/contextId came from the client.
    const objectKey = evalKey("ent_agent", "default");
    const activate = calls.find((c) => c.method === "entityActivate");
    expect(activate).toBeTruthy();
    expect((activate!.args[0] as { contextId?: string }).contextId).toBe("ctx_bound");
    const run = calls.find((c) => c.method === "run");
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
        { caller: createVerifiedCaller("agent:ent_agent", "agent", null, binding) },
        "run",
        [{ ownerId: "someone_else", contextId: "ctx_bound", code: "return 1;" }]
      )
    ).rejects.toThrow(/must match the connection's entity binding/);
  });
});
