import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import { evalMethods, type EvalRunArgs } from "@vibestudio/service-schemas/eval";
import {
  getInternalDOBundle,
  internalDOExecutionIdentity,
  INTERNAL_DO_SOURCE,
} from "../internalDOs/internalDoLoader.js";
import type { HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { resolveOwningPanelSlot } from "@vibestudio/shared/panel/owningPanelSlot";
import type { TokenManager } from "@vibestudio/shared/tokenManager";
import { createHash, randomUUID } from "node:crypto";
import type { RuntimeAgentBinding } from "@vibestudio/shared/runtime/entitySpec";
import { channelTrajectoryFor } from "@vibestudio/trajectory-identity";
import type { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
import { resolveCodeIdentity } from "./principalIdentity.js";
import { EvalKernelLeaseCoordinator, type EvalKernelLease } from "./evalKernelLease.js";

const DEFAULT_EVAL_WATCHDOG_GRACE_MS = 1_000;

interface EvalSandboxRecoveryInput {
  runId: string;
  timeoutMs: number;
  evalDoRef: { source: string; className: string; objectKey: string };
}

/**
 * Only an explicitly timed run needs a host-held observer: a synchronous CPU loop can prevent the
 * EvalDO's own AbortSignal timer from firing. This observer is therefore an external process
 * watchdog, not the execution or completion channel. Untimed runs never hold a host request.
 */
async function watchTimedRun(
  doDispatch: HeldDoDispatcher,
  evalDoRef: { source: string; className: string; objectKey: string },
  runId: string,
  timeoutMs: number,
  recoverUnresponsiveSandbox: (input: EvalSandboxRecoveryInput) => Promise<void>,
  watchdogGraceMs: number
): Promise<void> {
  const held = doDispatch.dispatchHeld(evalDoRef, "executeRun", runId);
  const timeoutError = new Error(
    `eval run ${runId} exceeded its ${timeoutMs}ms sandbox deadline and required runtime recovery`
  );
  let recovery: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waitForRecovery = async (): Promise<never> => {
    if (recovery) await recovery;
    throw timeoutError;
  };
  const guardedHeld = held.then(
    async (result) => (recovery ? waitForRecovery() : result),
    async (error) => {
      if (recovery) await recovery;
      throw error;
    }
  );
  const watchdog = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      recovery = recoverUnresponsiveSandbox({ runId, timeoutMs, evalDoRef });
      void recovery.then(
        () => reject(timeoutError),
        (error) => reject(error)
      );
    }, timeoutMs + watchdogGraceMs);
    timer.unref?.();
  });
  try {
    await Promise.race([guardedHeld, watchdog]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

const EVAL_DO_CLASS = "EvalDO";

interface EvalOwner {
  ownerId: string;
  contextId: string;
}

/** Server-resolved launch parent for an eval session (the owning panel). */
interface EvalParentMeta {
  parentId: string;
  parentEntityId: string;
  parentKind: "panel";
}

/**
 * Owner-scoped sandbox eval service — replaces the `scope` service. Any entity-principal
 * (panel/app/worker/do/shell) calls `eval.run`/`eval.reset`; the owner is the verified
 * `ctx.caller` unless a privileged shell/server caller selects a session owner. The EvalDO
 * `objectKey` is derived (hashed) from the owner id + subKey, so unprivileged callers can
 * only address their own EvalDO. The EvalDO entity is registered with the owner's context so
 * the kernel's own fs/git/vcs resolve the owner's workspace.
 */
export function createEvalService(deps: {
  /** Generic DO dispatcher — used to invoke `run`/`reset` on the per-owner EvalDO. */
  doDispatch: HeldDoDispatcher;
  /**
   * The single owner of WorkspaceDO entity state. Eval registers the EvalDO
   * entity via `store.activate`, which pairs the durable write with the server
   * hot-cache mirror. Bypassing it (dispatching `entityActivate` directly) is
   * exactly what caused every EvalDO→main RPC to 403 with "Unknown principal
   * kind" — the cache never learned the EvalDO's identity.
   */
  entityStore: WorkspaceEntityStore;
  tokenManager: TokenManager;
  workspaceId: string;
  executionSessions: AgentExecutionSessionRegistry;
  missionFactForSession?: (
    sessionId: string
  ) => import("@vibestudio/rpc").SessionMissionFact | null;
  isSystemTestHarness?: (caller: ServiceContext["caller"], runId: string) => boolean;
  /**
   * Host-wide background-work registry (idle-exit monitor). Synchronous calls and explicit
   * host watchdogs report begin/end; ordinary asynchronous runs live inside the EvalDO.
   */
  activity?: import("./activityRegistry.js").ActivityRegistry;
  /** Host-process safety boundary for synchronous sandbox CPU starvation. */
  recoverUnresponsiveSandbox?: (input: EvalSandboxRecoveryInput) => Promise<void>;
  /** Test seam for the host watchdog's post-deadline scheduling grace. */
  watchdogGraceMs?: number;
  /** Test seam; production uses one held inter-cell lease per EvalDO. */
  kernelLeases?: EvalKernelLease;
}): ServiceDefinition {
  const store = deps.entityStore;
  const kernelLeases =
    deps.kernelLeases ??
    new EvalKernelLeaseCoordinator(deps.doDispatch, {
      onError: (message, error) =>
        console.warn(message, error instanceof Error ? error.message : error),
    });
  const evalExecutionIdentity = internalDOExecutionIdentity(getInternalDOBundle(), EVAL_DO_CLASS);

  const evalDoKey = (ownerId: string, subKey: string): string =>
    createHash("sha256")
      .update(ownerId + "\0" + subKey)
      .digest("hex")
      .slice(0, 40);

  /**
   * The EvalDO's canonical entity id (kind `do`). This is the principal the
   * server resolves on every EvalDO→main callback AND the subject of the
   * owner-scoped gateway token — the two MUST agree, so both derive it here.
   */
  const evalDoEntityId = (objectKey: string): string =>
    `do:${INTERNAL_DO_SOURCE}:${EVAL_DO_CLASS}:${objectKey}`;

  /**
   * Owner-scoped gateway token for THIS EvalDO. Pinned to the concrete
   * `do:vibestudio/internal:EvalDO:<objectKey>` identity (kind `do`), NOT the
   * shared `do-service:*` bearer — so the kernel's `gatewayFetch` resolves the
   * owner's context and a leak's blast radius is the owner alone (eval code can
   * read `gatewayConfig.token`, but it IS the owner's own authority). Minted
   * here (server-internal, owner already verified) and handed to `EvalDO.run`
   * over the authenticated server→DO dispatch — no new callable token-issuing
   * surface, so nothing rides the worker→do policy fallthrough. `ensureToken`
   * is idempotent per callerId, so it's a stable per-owner token.
   */
  const mintGatewayToken = (objectKey: string): string =>
    deps.tokenManager.ensureToken(evalDoEntityId(objectKey), "do");

  async function resolveRegisteredContext(ownerId: string): Promise<string | null> {
    return store.resolveContext(ownerId);
  }

  /**
   * Resolve the nearest panel ancestor-or-self of `callerId` from the entity
   * store (cache-first) — the panel that "owns" this eval. Walks `parentId` up
   * the launch chain: a panel caller resolves to itself; an agent/worker caller
   * resolves to its owning panel (recorded at `runtime.createEntity` from the
   * verified caller); anything with no panel ancestor → null. Server-
   * authoritative — never eval user input. Becomes `RunArgs.parent`, from which
   * the EvalDO derives the portable `parent`/`getParent`.
   */
  async function resolveParentPanel(callerId: string): Promise<EvalParentMeta | null> {
    // Shared resolver: walk the entity lineage to the nearest OPEN panel and return its TREE SLOT id
    // (durable nav→slot via the slot store — the SAME source the server create handler uses, so the
    // eval's defaultOpenParentId and the server's nesting decision can't drift, and it works even when
    // the owning panel isn't currently loaded). The lineage is entity-id space, so a node is never
    // itself a slot id (isOpenSlot is constant false here).
    const slotId = await resolveOwningPanelSlot(callerId, {
      isOpenSlot: () => false,
      resolveOpenSlotForEntity: async (id) => (await store.resolveSlotByEntity(id)) ?? undefined,
      resolveParentId: async (id) =>
        (store.cache.resolve(id) ?? (await store.resolveRecord(id)))?.parentId,
    });
    if (!slotId) return null;
    // parentEntityId is only consumed for worker/do parent kinds (createRuntimeParentHandle); a panel
    // parent resolves via getPanelHandle(slotId), so the slot id is the operative identity.
    return { parentId: slotId, parentEntityId: slotId, parentKind: "panel" };
  }

  async function resolveOwner(
    callerKind: string,
    callerId: string,
    requested: { ownerId?: string; contextId?: string },
    agentBinding?: { entityId: string; contextId: string }
  ): Promise<EvalOwner> {
    // Agent callers (plan §6.4): the host-verified entity binding IS the owner
    // and context the EvalDO trusts. Client-supplied ownerId/contextId are never
    // honored as overrides for an autonomous agent — if present they must match
    // the binding, else the call is rejected (no cross-entity escalation).
    if (callerKind === "agent") {
      if (!agentBinding) {
        throw new Error("eval: agent caller has no entity binding");
      }
      if (
        (requested.ownerId !== undefined && requested.ownerId !== agentBinding.entityId) ||
        (requested.contextId !== undefined && requested.contextId !== agentBinding.contextId)
      ) {
        throw new Error(
          "eval: agent ownerId/contextId overrides must match the connection's entity binding"
        );
      }
      return { ownerId: agentBinding.entityId, contextId: agentBinding.contextId };
    }
    if (requested.ownerId !== undefined || requested.contextId !== undefined) {
      if (callerKind !== "shell" && callerKind !== "server") {
        throw new Error("eval: ownerId/contextId overrides are restricted to shell/server callers");
      }
      if (!requested.ownerId || !requested.contextId) {
        throw new Error("eval: ownerId and contextId must be provided together");
      }
      const registeredContext = await resolveRegisteredContext(requested.ownerId);
      if (registeredContext == null) {
        throw new Error(`eval: no context registered for owner ${requested.ownerId}`);
      }
      if (registeredContext !== requested.contextId) {
        throw new Error(
          `eval: owner ${requested.ownerId} is registered to ${registeredContext}, not ${requested.contextId}`
        );
      }
      return { ownerId: requested.ownerId, contextId: requested.contextId };
    }

    const contextId = await resolveRegisteredContext(callerId);
    if (contextId == null) {
      throw new Error(`eval: no context registered for caller ${callerId}`);
    }
    return { ownerId: callerId, contextId };
  }

  async function ensureEvalDO(
    owner: EvalOwner,
    subKey: string,
    ownerUserId: string | undefined,
    agentBinding: RuntimeAgentBinding | undefined
  ): Promise<{ objectKey: string }> {
    const { ownerId, contextId } = owner;
    const objectKey = evalDoKey(ownerId, subKey);
    // Fast path: the EvalDO entity is sticky (idle-eviction aborts the instance
    // but never retires the entity), so once it's active in the cache for the
    // right context there's nothing to do — re-activating every run is a wasted
    // WorkspaceDO round-trip. Gating on the cache (not a private "seen" set)
    // keeps us self-consistent: a retired entity (cache miss) or a fresh server
    // process (empty cache) re-activates; the cache IS the source of truth the
    // server's principal resolution reads.
    const active = store.cache.resolveActive(evalDoEntityId(objectKey));
    const activeStateArgs =
      active?.stateArgs && typeof active.stateArgs === "object" && !Array.isArray(active.stateArgs)
        ? (active.stateArgs as Record<string, unknown>)
        : null;
    if (
      active &&
      active.contextId === contextId &&
      JSON.stringify(active.agentBinding ?? null) === JSON.stringify(agentBinding ?? null) &&
      activeStateArgs?.["ownerPrincipalId"] === ownerId &&
      typeof activeStateArgs["agentExecutionAdmission"] === "object" &&
      active.activeBuildKey === evalExecutionIdentity.buildKey &&
      active.activeExecutionDigest === evalExecutionIdentity.executionDigest
    ) {
      return { objectKey };
    }
    // Register/refresh the EvalDO entity with the owner's context so the kernel's
    // own fs/git/vcs calls resolve the owner's workspace. The store pairs the
    // durable upsert with the server hot-cache mirror, so the server can resolve
    // THIS EvalDO's principal when it calls back to `main`. Idempotent.
    const activation = {
      kind: "do",
      source: {
        repoPath: INTERNAL_DO_SOURCE,
        effectiveVersion: evalExecutionIdentity.effectiveVersion,
      },
      contextId,
      className: EVAL_DO_CLASS,
      key: objectKey,
      activeBuildKey: evalExecutionIdentity.buildKey,
      activeExecutionDigest: evalExecutionIdentity.executionDigest,
      activeAuthority: { requests: evalExecutionIdentity.authorityRequests },
      // The EvalDO's launch parent IS its owner. An entity spawned FROM an eval (e.g. a headless
      // sub-agent the orchestrator's eval creates via runtime.createEntity) records THIS EvalDO as its
      // parentId — so without this link the lineage dead-ends at the EvalDO and the sub-agent's panels
      // resolve to root. With it, the walk continues owner → owner's panel, so the sub-agent's panels
      // nest under the owner's panel. ownerId is stable; the panel is re-resolved live at walk time.
      parentId: ownerId,
      // Attribute the EvalDO to the human whose subject launched this run (WP0
      // §6). Write-once, so the first activation's owner sticks; undefined for a
      // bootstrap caller with no subject.
      ownerUserId,
      agentBinding,
      stateArgs: {
        ownerPrincipalId: ownerId,
        subKey,
        agentExecutionAdmission: { v: 1, ownerId },
      },
    } as const;
    if (active) {
      await store.advanceExecution(activation);
    } else {
      await store.activate(activation);
    }
    return { objectKey };
  }

  function assertRunSource(args: { code?: string; path?: string; sourcePath?: string }): void {
    const hasCode = args.code !== undefined;
    const hasPath = args.path !== undefined;
    if (hasCode === hasPath) {
      throw new Error("eval: provide exactly one of code or path");
    }
  }

  type EvalRoute = { ownerId?: string; contextId?: string; subKey?: string };

  async function resolveOwnerForCaller(
    ctx: ServiceContext,
    requested: EvalRoute
  ): Promise<EvalOwner> {
    return await resolveOwner(
      ctx.caller.runtime.kind,
      ctx.caller.runtime.id,
      requested,
      ctx.caller.agentBinding
    );
  }

  function trustedAgentRelay(ctx: ServiceContext): RuntimeAgentBinding | undefined {
    if (ctx.caller.runtime.kind === "agent") {
      const binding = ctx.caller.agentBinding;
      return binding
        ? {
            entityId: binding.entityId,
            contextId: binding.contextId,
            channelId: binding.channelId,
          }
        : undefined;
    }
    if (ctx.caller.runtime.kind !== "do" && ctx.caller.runtime.kind !== "worker") {
      return undefined;
    }
    return store.cache.resolveActive(ctx.caller.runtime.id)?.agentBinding;
  }

  async function evalDoRefFor(
    ctx: ServiceContext,
    route: EvalRoute
  ): Promise<{ source: string; className: string; objectKey: string }> {
    const owner = await resolveOwnerForCaller(ctx, route);
    const agentBinding = trustedAgentRelay(ctx);
    const { objectKey } = await ensureEvalDO(
      owner,
      route.subKey ?? "default",
      ctx.caller.subject?.userId,
      agentBinding
    );
    return { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey };
  }

  async function prepareRun(
    ctx: ServiceContext,
    runArgs: EvalRunArgs,
    runId: string
  ): Promise<{
    evalDoRef: { source: string; className: string; objectKey: string };
    assembledArgs: Record<string, unknown>;
    agentRef: string | undefined;
    channelId: string | undefined;
  }> {
    assertRunSource(runArgs);
    const owner = await resolveOwnerForCaller(ctx, runArgs);
    const ownerId = owner.ownerId;
    const agentBinding = trustedAgentRelay(ctx);
    if (agentBinding && !ctx.causalParent) {
      throw new ServiceError(
        "eval",
        "run",
        "Agent-bound eval execution requires an exact causal tool invocation",
        "EACCES",
        undefined,
        "access"
      );
    }
    if (agentBinding && ctx.causalParent) {
      const expected = channelTrajectoryFor(agentBinding.channelId);
      if (ctx.causalParent.logId !== expected.logId || ctx.causalParent.head !== expected.head) {
        throw new ServiceError(
          "eval",
          "run",
          "Agent eval cause does not belong to the relay's host-bound trajectory",
          "EACCES",
          undefined,
          "access"
        );
      }
    }
    // Refuse an unscoped or trajectory-drifting agent relay before activating
    // an EvalDO or exposing any presenter authority ceiling.
    const { objectKey } = await ensureEvalDO(
      owner,
      runArgs.subKey ?? "default",
      ctx.caller.subject?.userId,
      agentBinding
    );
    const isAgentDo = ctx.caller.runtime.kind === "do" && agentBinding !== undefined;
    const timeoutMs = runArgs.timeoutMs;
    const chatBinding = isAgentDo ? { channelId: agentBinding.channelId, agentRef: ownerId } : {};
    const parent = (await resolveParentPanel(ownerId)) ?? undefined;
    const evalRuntimeId = evalDoEntityId(objectKey);
    const ownerHarness = resolveCodeIdentity(store.cache, ownerId);
    const harness = ownerHarness
      ? {
          repoPath: ownerHarness.repoPath,
          effectiveVersion: ownerHarness.effectiveVersion,
          executionDigest: ownerHarness.executionDigest,
        }
      : {
          repoPath: evalExecutionIdentity.source,
          effectiveVersion: evalExecutionIdentity.effectiveVersion,
          executionDigest: evalExecutionIdentity.executionDigest,
        };
    if (!ctx.caller.subject) {
      throw new ServiceError(
        "eval",
        "run",
        "Evaluated execution requires an authenticated user",
        "EACCES",
        undefined,
        "access"
      );
    }
    const sessionId = agentBinding?.channelId ?? evalRuntimeId;
    const mission = deps.missionFactForSession?.(sessionId) ?? null;
    const inheritedTestPolicy = deps.executionSessions.testPolicyForContext(owner.contextId);
    const testPolicy =
      !mission &&
      (inheritedTestPolicy ??
        (deps.isSystemTestHarness?.(ctx.caller, runId)
          ? deps.executionSessions.createTestPolicy(runId)
          : null));
    await deps.executionSessions.admitWhenAvailable(
      {
        mode: mission ? "mission" : testPolicy ? "test" : "interactive",
        ownerUser: `user:${ctx.caller.subject.userId}`,
        workspaceId: deps.workspaceId,
        contextId: owner.contextId,
        agentBinding: agentBinding
          ? {
              entityId: agentBinding.entityId,
              channelId: agentBinding.channelId,
              bindingId: `${agentBinding.entityId}@${agentBinding.contextId}`,
            }
          : null,
        taskRef: agentBinding?.channelId ?? `eval:${ownerId}:${runId}`,
        harness: {
          principal: `code:${harness.repoPath}@${harness.executionDigest}`,
          repoPath: harness.repoPath,
          effectiveVersion: harness.effectiveVersion,
        },
        eval: { runtimeId: evalRuntimeId, runId },
        causalParent: ctx.causalParent
          ? {
              logId: ctx.causalParent.logId,
              head: ctx.causalParent.head,
              invocationId: ctx.causalParent.invocationId,
            }
          : null,
        ...(mission ? { mission } : {}),
        ...(testPolicy ? { testPolicy } : {}),
      },
      ctx.signal
    );
    const evalDoRef = { source: INTERNAL_DO_SOURCE, className: EVAL_DO_CLASS, objectKey };
    try {
      await kernelLeases.touch(evalDoRef);
    } catch (error) {
      // Admission and kernel residency are one preparation transaction. If the
      // lease cannot be established, no run can start and nothing downstream
      // will reach the normal completion cleanup.
      deps.executionSessions.close(evalRuntimeId, runId);
      throw error;
    }
    return {
      evalDoRef,
      assembledArgs: {
        runId,
        code: runArgs.code,
        path: runArgs.path,
        sourcePath: runArgs.sourcePath,
        reset: runArgs.reset,
        syntax: runArgs.syntax,
        imports: runArgs.imports,
        contextId: owner.contextId,
        gatewayToken: mintGatewayToken(objectKey),
        causalParent: ctx.causalParent,
        agentInvocationId: ctx.causalParent?.invocationId,
        parent,
        timeoutMs,
        readOnly: runArgs.readOnly,
        ...chatBinding,
      },
      agentRef: isAgentDo ? ownerId : undefined,
      channelId: isAgentDo ? agentBinding.channelId : undefined,
    };
  }

  return {
    name: "eval",
    description: "Owner-scoped sandbox eval backed by a per-owner internal EvalDO",
    authority: { principals: ["code", "user", "host"] },
    methods: evalMethods,
    handler: defineServiceHandler("eval", evalMethods, {
      run: async (ctx, [runArgs]) => {
        // Held synchronous run for connection-holding callers (panels over WS, CLI). The EvalDO
        // runs in a held handler; the caller holds its own leg. One request, one result.
        const runId = randomUUID();
        const { evalDoRef, assembledArgs } = await prepareRun(ctx, runArgs, runId);
        const activityId = `eval:held:${runId}`;
        deps.activity?.begin(activityId);
        try {
          return await deps.doDispatch.dispatchHeld(evalDoRef, "run", assembledArgs);
        } finally {
          deps.executionSessions.close(evalDoEntityId(evalDoRef.objectKey), runId);
          deps.activity?.end(activityId);
        }
      },
      startRun: async (ctx, [runArgs]) => {
        // Async agent run: the EvalDO persists and schedules it under its own lifetime, then returns
        // immediately. Its terminal row is canonical and its own owner-scoped callback settles the
        // agent. The host keeps no execution request open.
        const runId = runArgs.runId ?? randomUUID();
        const { evalDoRef, assembledArgs } = await prepareRun(ctx, runArgs, runId);
        const startArgs = {
          ...assembledArgs,
          runId,
        };
        const evalRuntimeId = evalDoEntityId(evalDoRef.objectKey);
        try {
          await deps.doDispatch.dispatch(evalDoRef, "startRun", startArgs);
        } catch (error) {
          // startRun is idempotent on runId. A transport rejection is
          // ambiguous: the EvalDO may already have durably accepted the run.
          // Keep its admission live and retry the same start until the durable
          // owner acknowledges it, then monitor the canonical terminal.
          void reconcileAmbiguousStart(deps.doDispatch, evalDoRef, runId, startArgs)
            .catch((reconcileError) => {
              console.warn(
                `[eval] admission reconciliation ${runId} stopped:`,
                reconcileError instanceof Error ? reconcileError.message : reconcileError
              );
            })
            .finally(() => {
              deps.executionSessions.close(evalRuntimeId, runId);
            });
          throw error;
        }
        void closeAdmissionWhenRunEnds(deps.doDispatch, evalDoRef, runId)
          .catch((error) => {
            console.warn(
              `[eval] admission monitor ${runId} stopped:`,
              error instanceof Error ? error.message : error
            );
          })
          .finally(() => {
            deps.executionSessions.close(evalRuntimeId, runId);
          });
        const timeoutMs = assembledArgs["timeoutMs"];
        if (typeof timeoutMs === "number" && deps.recoverUnresponsiveSandbox) {
          const activityId = `eval-watchdog:${runId}`;
          deps.activity?.begin(activityId);
          void watchTimedRun(
            deps.doDispatch,
            evalDoRef,
            runId,
            timeoutMs,
            deps.recoverUnresponsiveSandbox,
            deps.watchdogGraceMs ?? DEFAULT_EVAL_WATCHDOG_GRACE_MS
          )
            .catch((error) => {
              console.warn(
                `[eval] timed run watchdog ${runId} completed through recovery:`,
                error instanceof Error ? error.message : error
              );
            })
            .finally(() => {
              deps.activity?.end(activityId);
            });
        }
        return { runId };
      },
      getRun: async (ctx, [getArgs]) =>
        deps.doDispatch.dispatch(await evalDoRefFor(ctx, getArgs), "getRun", getArgs.runId),
      readScopeTextPage: async (ctx, [pageArgs]) =>
        deps.doDispatch.dispatch(
          await evalDoRefFor(ctx, pageArgs),
          "readScopeTextPage",
          pageArgs.key,
          pageArgs.offset,
          pageArgs.limit
        ),
      deleteScopeValue: async (ctx, [deleteArgs]) =>
        deps.doDispatch.dispatch(
          await evalDoRefFor(ctx, deleteArgs),
          "deleteScopeValue",
          deleteArgs.key
        ),
      reset: async (ctx, [resetArgs = {}]) =>
        deps.doDispatch.dispatch(await evalDoRefFor(ctx, resetArgs), "reset"),
      cancel: async (ctx, [cancelArgs]) =>
        deps.doDispatch.dispatch(await evalDoRefFor(ctx, cancelArgs), "cancel", cancelArgs.runId),
    }),
  };
}

async function reconcileAmbiguousStart(
  dispatch: HeldDoDispatcher,
  ref: { source: string; className: string; objectKey: string },
  runId: string,
  startArgs: Record<string, unknown>
): Promise<void> {
  for (;;) {
    try {
      await dispatch.dispatch(ref, "startRun", startArgs);
      return closeAdmissionWhenRunEnds(dispatch, ref, runId);
    } catch {
      await admissionRetryDelay();
    }
  }
}

async function closeAdmissionWhenRunEnds(
  dispatch: HeldDoDispatcher,
  ref: { source: string; className: string; objectKey: string },
  runId: string
): Promise<void> {
  for (;;) {
    try {
      const run = (await dispatch.dispatch(ref, "getRun", runId)) as { status?: unknown };
      const status = typeof run.status === "string" ? run.status : "unknown";
      if (status === "done" || status === "cancelled" || status === "unknown") return;
    } catch {
      // Admission is a semantic lifetime, not the lifetime of one monitoring
      // request. A transient workerd/gateway reset must not de-authorize a run
      // that the EvalDO still owns; only its durable terminal state may close
      // the execution session.
    }
    await admissionRetryDelay();
  }
}

function admissionRetryDelay(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 250);
    timer.unref?.();
  });
}
