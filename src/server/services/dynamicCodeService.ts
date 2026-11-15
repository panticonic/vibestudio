import {
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import type { VerifiedCaller, VerifiedCodeIdentity } from "@vibestudio/shared/serviceDispatcher";
import type { RuntimeEntityCreateSpec } from "@vibestudio/shared/runtime/entitySpec";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { ServiceError, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  normalizeEvalAuthorityIntent,
  type EvalStartInput,
} from "@vibestudio/service-schemas/eval";
import type { HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { resolveOwningPanelSlot } from "@vibestudio/shared/panel/owningPanelSlot";
import { asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { createHash } from "node:crypto";
import {
  dynamicCodeMethods,
  type DynamicCodeAdmission,
} from "@vibestudio/service-schemas/dynamicCode";
import {
  EVAL_HOST_CLASS,
  EVAL_HOST_SOURCE,
  evalHostObjectKey,
  isEvalHostRecord,
  legacyEvalDoRuntimeId,
} from "@vibestudio/shared/evalRuntimeIdentity";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import type { RuntimeAgentBinding } from "@vibestudio/shared/runtime/entitySpec";
import type { AgentExecutionSessionRegistry } from "./agentExecutionSessionRegistry.js";
import { codePrincipal } from "@vibestudio/shared/authority/codePrincipal";
import type { TaskAuthorityRegistry } from "./taskAuthorityRegistry.js";
import { assertAgentCausalParent, createDynamicCodeAdmission } from "./dynamicCodeAdmission.js";
import { resolveCodeIdentity } from "./principalIdentity.js";
import { entityHostRef } from "@vibestudio/shared/evalRuntimeIdentity";

type SessionRef = { source: string; className: string; objectKey: string };

/**
 * The calls this service makes on the session entity that hosts a kernel (docs/dolt-redesign.md
 * §7.5.1): the host does not reach a kernel itself, only its hosting entity can. Run-scoped calls
 * carry no nonce here; the session holds the nonce each run was admitted under and presents it.
 */
function hostedEntityClient(dispatch: HeldDoDispatcher, ref: SessionRef) {
  const call = (method: string, ...args: unknown[]) => dispatch.dispatch(ref, method, ...args);
  return {
    /** The run's status; `ENOTFOUND` when the entity never heard of it. */
    getRun: (runId: string) => call("get", runId) as Promise<{ status: string }>,
    cancel: (runId: string) => call("cancel", runId),
    reset: () => call("reset") as Promise<{ ok: boolean }>,
  };
}

export type EvalShutdown = () => Promise<void>;

interface ActiveEvalRun {
  evalDoRef: SessionRef;
  runId: string;
  closeAdmission: () => void;
  /** The caller that admitted the run; only it (or the host) releases it. */
  initiatorId: string;
  admittedAt: number;
}

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
 * The host service `dynamicCode` (docs/dolt-redesign.md §7.3, §7.5.2): the one admission step for
 * dynamic code, and the two lifecycle controls that need host authority. Any entity-principal
 * (panel/app/worker/do/shell) admits runs; the owner is the verified `ctx.caller` unless a
 * privileged shell/server caller selects a live session owner. The session entity that hosts the
 * owner's kernel is keyed (hashed) by owner id + scope key, so unprivileged callers can only
 * address their own. It is created through `runtime.createEntity` with the owner as its parent
 * (the lineage `resolveParentPanel` walks) and registered with the owner's context so the
 * kernel's own fs/git/vcs resolve the owner's workspace (§7.2). The run itself is started,
 * pulled and cancelled by the caller on that entity, never through the host.
 */
export function createDynamicCodeService(deps: {
  /** Generic DO dispatcher: reaches the session entity that hosts the owner's kernel. */
  doDispatch: HeldDoDispatcher;
  /** Hot-cache and durable reads of entity state. */
  entityStore: WorkspaceEntityStore;
  /**
   * `runtime.internal.createEntity`: creates the session entity, with the
   * lifecycle caller as its parent and owner.
   */
  createEntity: (
    caller: VerifiedCaller,
    spec: RuntimeEntityCreateSpec,
    trusted?: { agentBinding?: RuntimeAgentBinding }
  ) => Promise<{ id: string }>;
  /** Host lifecycle owner used to retire a disposed session through the normal
   * release, relay-drain, cleanup, and durable-reaper path. */
  retireEntity: (id: string) => Promise<void>;
  workspaceId: string;
  /**
   * Whether a class declares (in its manifest) that it hosts the eval kernel in its own cell. An
   * owner of such a class hosts its own runs (§6.11.6): its runtime id is the executor and no session
   * entity is created.
   */
  hostsEvalKernel?: (source: string, className: string) => boolean;
  /** Resolve the actual sealed artifact, including source provenance, for a live code identity. */
  resolveExecutionArtifact: (
    code: VerifiedCodeIdentity
  ) => ExecutionArtifactRefV1 | null | Promise<ExecutionArtifactRefV1 | null>;
  executionSessions: AgentExecutionSessionRegistry;
  taskAuthorities: TaskAuthorityRegistry;
  isSystemTestHarness?: (caller: ServiceContext["caller"], runId: string) => boolean;
  /**
   * Host-wide background-work registry (idle-exit monitor). Every admitted run
   * holds a lease until its trusted terminal event.
   */
  activity?: import("./activityRegistry.js").ActivityRegistry;
  /** Receives the shared eval admission drain used by ordered server shutdown. */
  onShutdown?: (shutdown: EvalShutdown) => void;
  /** Canonical dispatcher authorization-only path for exact prospective calls. */
  preauthorize?: (
    ctx: ServiceContext,
    operation: { service: string; method: string; args: unknown[] }
  ) => Promise<void>;
  resolveContextSource?: (
    contextId: string,
    path: string
  ) => Promise<{
    code: string;
    sourceDigest: string;
    sourceState: import("@vibestudio/service-schemas/vcs").VcsStateNodeRef;
    contentStateHash: string;
  }>;
}): ServiceDefinition {
  const store = deps.entityStore;
  // The one admission step every run of dynamic code goes through (§7.3).
  const admission = createDynamicCodeAdmission({
    executionSessions: deps.executionSessions,
    taskAuthorities: deps.taskAuthorities,
    entityCache: store.cache,
    workspaceId: deps.workspaceId,
    ...(deps.isSystemTestHarness ? { isSystemTestHarness: deps.isSystemTestHarness } : {}),
    hasActiveEntity: async (runtimeId) =>
      (store.cache.resolveActive(runtimeId) ?? (await store.resolveRecord(runtimeId)))?.status ===
      "active",
    ...(deps.preauthorize ? { preauthorize: deps.preauthorize } : {}),
  });
  const activeRuns = new Map<string, ActiveEvalRun>();
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;

  const sessionObjectKey = (ownerId: string, subKey: string): string =>
    evalHostObjectKey(ownerId, subKey);

  /** The session entity's identity and object-key derivation share one canonical helper. */
  const sessionEntityId = (objectKey: string): string =>
    `do:${EVAL_HOST_SOURCE}:${EVAL_HOST_CLASS}:${objectKey}`;

  const entityIdOfRef = (ref: SessionRef): string =>
    `do:${ref.source}:${ref.className}:${ref.objectKey}`;

  /**
   * The owner itself, when its class declares that it hosts the kernel: the kernel acts as the owner
   * and its runs are the owner's own, so no session entity stands between them.
   */
  async function selfHostOf(
    ownerId: string,
    callerId: string
  ): Promise<{ ref: SessionRef; contextId: string } | null> {
    // Only the owner itself: a shell, the server or a test runner that selects the owner as the target of its
    // own run (an `owner-session` target) is another principal with its own scope, and gets a session entity.
    if (!deps.hostsEvalKernel || ownerId !== callerId) return null;
    const record = store.cache.resolveActive(ownerId) ?? (await store.resolveRecord(ownerId));
    if (!record || record.kind !== "do" || record.status !== "active" || !record.className)
      return null;
    if (!deps.hostsEvalKernel(record.source.repoPath, record.className)) return null;
    const ref = entityHostRef(record);
    return ref ? { ref, contextId: record.contextId } : null;
  }

  const sessionRef = (objectKey: string): SessionRef => ({
    source: EVAL_HOST_SOURCE,
    className: EVAL_HOST_CLASS,
    objectKey,
  });

  const activeRunKey = (evalRuntimeId: string, runId: string): string =>
    `${evalRuntimeId}\0${runId}`;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownRequested = true;
    shutdownPromise = (async () => {
      const entries = [...activeRuns.values()];
      if (entries.length === 0) return;

      const cancellations = await Promise.allSettled(
        entries.map(async (entry) => {
          try {
            await hostedEntityClient(deps.doDispatch, entry.evalDoRef).cancel(entry.runId);
          } catch (error) {
            // A pull caller that was admitted but never started its run has nothing to cancel.
            if ((error as { code?: unknown }).code !== "ENOTFOUND") throw error;
          } finally {
            // The hosted kernel owns terminal truth. Once cancellation has
            // either completed or failed, remove the host admission so a
            // disappearing workerd cannot leave authority/activity state live.
            entry.closeAdmission();
          }
        })
      );
      const failures = cancellations
        .filter((item): item is PromiseRejectedResult => item.status === "rejected")
        .map((item) => item.reason);
      if (failures.length > 0) {
        throw new AggregateError(failures, "eval shutdown cancellation failed", {
          cause: failures[0],
        });
      }
    })();
    return shutdownPromise;
  };
  deps.onShutdown?.(shutdown);

  async function resolveRegisteredContext(ownerId: string): Promise<string | null> {
    return store.resolveContext(ownerId);
  }

  /**
   * Resolve the nearest panel ancestor-or-self of `callerId` from the entity
   * store (cache-first) — the panel that "owns" this eval. Walks `parentId` up
   * the launch chain: a panel caller resolves to itself; an agent/worker caller
   * resolves to its owning panel (recorded at `runtime.createEntity` from the
   * verified caller). If an orchestrator owns the lifecycle lineage, one exact
   * host-validated panel-slot resource binding supplies the structural parent;
   * zero or multiple bindings remain unparented. Server-authoritative — never
   * eval user input. Becomes `RunArgs.parent`, from which the kernel derives the
   * portable `parent`/`getParent`.
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
    let resolvedSlotId = slotId;
    if (!resolvedSlotId) {
      // A resource-bound agent (Quickfire is the canonical example) is not
      // launched by the panel entity itself: its lifecycle parent is the
      // orchestrating service. The exact panel-slot binding is nevertheless a
      // durable host-validated ownership fact. When there is exactly one such
      // binding, use it as the agent's structural panel parent so implicit
      // openPanel() calls cannot escape to the workspace root.
      const boundPanels = (await store.resourceBindingsForEntity(callerId))
        .filter((binding) => binding.resource.kind === "panel-slot")
        .map((binding) => asPanelSlotId(binding.resource.id));
      const uniqueBoundPanels = [...new Set(boundPanels)];
      if (uniqueBoundPanels.length === 1) resolvedSlotId = uniqueBoundPanels[0];
    }
    if (!resolvedSlotId) return null;
    // parentEntityId is only consumed for worker/do parent kinds (createRuntimeParentHandle); a panel
    // parent resolves via getPanelHandle(slotId), so the slot id is the operative identity.
    return {
      parentId: resolvedSlotId,
      parentEntityId: resolvedSlotId,
      parentKind: "panel",
    };
  }

  async function resolveOwner(
    callerKind: string,
    callerId: string,
    target: EvalRoute["target"],
    agentBinding?: { entityId: string; contextId: string }
  ): Promise<EvalOwner> {
    // Agent callers (plan §6.4): the host-verified entity binding IS the owner
    // and context the kernel trusts. Client-supplied ownerId/contextId are never
    // honored as overrides for an autonomous agent — if present they must match
    // the binding, else the call is rejected (no cross-entity escalation).
    if (callerKind === "agent") {
      if (!agentBinding) {
        throw new Error("eval: agent caller has no entity binding");
      }
      if (target?.kind === "owner-session" && target.sessionId !== agentBinding.entityId)
        throw new Error("eval: agent target must match the connection's entity binding");
      return { ownerId: agentBinding.entityId, contextId: agentBinding.contextId };
    }
    if (target?.kind === "owner-session") {
      if (callerKind !== "shell" && callerKind !== "server") {
        throw new Error("eval: owner-session targets are restricted to shell/server callers");
      }
      const registeredContext = await resolveRegisteredContext(target.sessionId);
      if (registeredContext == null) {
        throw new Error(`eval: no context registered for owner session ${target.sessionId}`);
      }
      return { ownerId: target.sessionId, contextId: registeredContext };
    }

    const contextId = await resolveRegisteredContext(callerId);
    if (contextId == null) {
      throw new Error(`eval: no context registered for caller ${callerId}`);
    }
    return { ownerId: callerId, contextId };
  }

  /**
   * The caller that owns the session entity's lifecycle and is its parent: the
   * owner. When the verified caller is the owner it is passed as it is; an agent
   * relay or a shell selecting a live session owner acts for an owner that is
   * another entity, whose record gives the runtime coordinates.
   */
  async function ownerCaller(caller: VerifiedCaller, ownerId: string): Promise<VerifiedCaller> {
    if (caller.runtime.id === ownerId) return caller;
    const record = store.cache.resolveActive(ownerId) ?? (await store.resolveRecord(ownerId));
    if (!record) throw new Error(`eval: owner ${ownerId} is not a known entity`);
    return {
      ...caller,
      runtime: { id: ownerId, kind: record.kind as VerifiedCaller["runtime"]["kind"] },
    };
  }

  async function ensureSession(
    ctx: ServiceContext,
    owner: EvalOwner,
    subKey: string,
    requestedLifecycle: "finite" | "persistent",
    agentBinding: RuntimeAgentBinding | undefined
  ): Promise<{ ref: SessionRef }> {
    const { ownerId, contextId } = owner;
    const selfHost = await selfHostOf(ownerId, ctx.caller.runtime.id);
    if (selfHost) {
      if (selfHost.contextId !== contextId)
        throw new ServiceError(
          "dynamicCode",
          "admit",
          "A self-hosting owner's kernel cannot change the owner's context",
          "EACCES",
          undefined,
          "access"
        );
      if (requestedLifecycle === "finite")
        throw new ServiceError(
          "dynamicCode",
          "admit",
          "An entity that hosts its own kernel keeps it for its own life: a finite scope is a session entity's",
          "EINVAL",
          undefined,
          "application"
        );
      return { ref: selfHost.ref };
    }
    const objectKey = sessionObjectKey(ownerId, subKey);
    // Eviction preserves a scope; retirement closes it. A cache miss must read
    // durable ownership before deciding that these coordinates are unused.
    const current =
      store.cache.resolveActive(sessionEntityId(objectKey)) ??
      (await store.resolveRecord(sessionEntityId(objectKey)));
    if (current?.status === "retired") {
      throw new ServiceError(
        "dynamicCode",
        "admit",
        `Eval scope ${subKey} is retired; use a new scope for new work`,
        "ECLOSED",
        undefined,
        "application"
      );
    }
    const active = current;
    const activeStateArgs =
      active?.stateArgs && typeof active.stateArgs === "object" && !Array.isArray(active.stateArgs)
        ? (active.stateArgs as Record<string, unknown>)
        : null;
    const activeLifecycle = active
      ? activeStateArgs?.["lifecycle"] === "finite"
        ? "finite"
        : "persistent"
      : undefined;
    if (active && requestedLifecycle && activeLifecycle !== requestedLifecycle) {
      throw new ServiceError(
        "dynamicCode",
        "admit",
        `Eval scope ${subKey} was created as ${activeLifecycle} and cannot be reclassified as ${requestedLifecycle}`,
        "EINVAL",
        undefined,
        "application"
      );
    }
    if (
      active &&
      active.contextId === contextId &&
      isEvalHostRecord(active) &&
      JSON.stringify(active.agentBinding ?? null) === JSON.stringify(agentBinding ?? null) &&
      activeStateArgs?.["ownerPrincipalId"] === ownerId &&
      typeof activeStateArgs["agentExecutionAdmission"] === "object"
    ) {
      return { ref: sessionRef(objectKey) };
    }
    // Create the session entity through the ordinary path, with the owner as its
    // parent and its context as the owner's, so the kernel's own fs/git/vcs
    // resolve the owner's workspace. An entity spawned FROM an eval (a headless
    // sub-agent the orchestrator's eval creates via runtime.createEntity) records
    // THIS session as its parentId: the lineage continues owner -> owner's panel,
    // so the sub-agent's panels nest under the owner's panel.
    // The session carries the agent relationship the host verified for this run: the
    // execution admission is checked against it on every call the kernel makes.
    await deps.createEntity(
      await ownerCaller(ctx.caller, ownerId),
      {
        kind: "do",
        key: objectKey,
        contextId,
        className: EVAL_HOST_CLASS,
        execution: { surface: "code", source: EVAL_HOST_SOURCE },
        stateArgs: {
          principalId: ownerId,
          ownerPrincipalId: ownerId,
          subKey,
          agentExecutionAdmission: { v: 1, ownerId },
          ...(requestedLifecycle === "finite" ? { lifecycle: "finite" as const } : {}),
        },
      },
      agentBinding ? { agentBinding } : undefined
    );
    return { ref: sessionRef(objectKey) };
  }

  /**
   * Register an admitted run: its admission is closed once, by `closeAdmission`, whoever
   * ends it (a release, a reconciliation, a failed admission, shutdown).
   */
  function trackAdmission(input: {
    evalDoRef: SessionRef;
    runId: string;
    ctx: ServiceContext;
    activityId: string | undefined;
  }): () => void {
    const evalRuntimeId = entityIdOfRef(input.evalDoRef);
    const activeKey = activeRunKey(evalRuntimeId, input.runId);
    let admissionClosed = false;
    const closeAdmission = () => {
      if (admissionClosed) return;
      admissionClosed = true;
      if (activeRuns.get(activeKey)?.runId === input.runId) activeRuns.delete(activeKey);
      deps.executionSessions.close(evalRuntimeId, input.runId);
      if (input.activityId) deps.activity?.end(input.activityId);
    };
    activeRuns.set(activeKey, {
      evalDoRef: input.evalDoRef,
      runId: input.runId,
      closeAdmission,
      initiatorId: input.ctx.caller.runtime.id,
      admittedAt: Date.now(),
    });
    return closeAdmission;
  }

  const TERMINAL_STATUSES = new Set(["done", "cancelled", "approval-route-lost", "unknown"]);
  /** A pull caller that was admitted but never started the run has until this to do so. */
  const UNSTARTED_ADMISSION_GRACE_MS = 30_000;

  /**
   * A pull caller releases its admission itself, but a caller that dies between `admit` and
   * `release` must not hold the hosting entity's one live admission for the rest of the
   * session's life. So admission asks the hosting entity (a pull of its own) whether the run
   * that holds the slot has ended, and releases it when it has, or when it was never started.
   */
  async function reconcileHolder(
    runtimeId: string,
    ref: SessionRef,
    requestingRunId: string
  ): Promise<void> {
    const holder = deps.executionSessions.activeRunId(runtimeId);
    if (!holder || holder === requestingRunId) return;
    const tracked = activeRuns.get(activeRunKey(runtimeId, holder));
    if (!tracked) return;
    try {
      const snapshot = await hostedEntityClient(deps.doDispatch, ref).getRun(holder);
      if (TERMINAL_STATUSES.has(snapshot.status)) tracked.closeAdmission();
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOTFOUND" && Date.now() - tracked.admittedAt > UNSTARTED_ADMISSION_GRACE_MS)
        tracked.closeAdmission();
    }
  }

  /** Reconcile on an interval while an admission waits for the entity's slot; returns the stop. */
  function reconcileWhileWaiting(runtimeId: string, ref: SessionRef, runId: string): () => void {
    const timer = setInterval(() => {
      void reconcileHolder(runtimeId, ref, runId).catch(() => undefined);
    }, 2_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  type EvalRoute = {
    target?: { kind: "caller" } | { kind: "owner-session"; sessionId: string };
    scopeKey?: string;
  };

  async function resolveOwnerForCaller(
    ctx: ServiceContext,
    requested: EvalRoute
  ): Promise<EvalOwner> {
    return await resolveOwner(
      ctx.caller.runtime.kind,
      ctx.caller.runtime.id,
      requested.target,
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

  async function findSessionRefFor(
    ctx: ServiceContext,
    route: EvalRoute,
    method: string
  ): Promise<{ source: string; className: string; objectKey: string } | null> {
    const owner = await resolveOwnerForCaller(ctx, route);
    const scopeKey = route.scopeKey ?? "default";
    const selfHost = await selfHostOf(owner.ownerId, ctx.caller.runtime.id);
    if (selfHost) return selfHost.ref;
    const objectKey = sessionObjectKey(owner.ownerId, scopeKey);
    const entityId = sessionEntityId(objectKey);
    const existing = store.cache.resolveActive(entityId) ?? (await store.resolveRecord(entityId));
    if (!existing) return null;
    if (existing.status !== "active") {
      throw new ServiceError(
        "dynamicCode",
        method,
        `Eval scope ${scopeKey} is retired; use a new scope for new work`,
        "ECLOSED",
        undefined,
        "application"
      );
    }
    if (existing.contextId !== owner.contextId) {
      throw new ServiceError(
        "dynamicCode",
        method,
        "Eval control cannot change the admitted scope's context",
        "EACCES",
        undefined,
        "access"
      );
    }
    return { source: EVAL_HOST_SOURCE, className: EVAL_HOST_CLASS, objectKey };
  }

  async function prepareRun(
    ctx: ServiceContext,
    runArgs: EvalStartInput,
    runId: string
  ): Promise<{
    evalDoRef: { source: string; className: string; objectKey: string };
    /** The exact input of the hosting entity's `start(input, nonce)`. */
    assembledArgs: { runId: string; executionSessionNonce: string } & Record<string, unknown>;
    agentRef: string | undefined;
    channelId: string | undefined;
    runDigest: string;
    authorityManifestDigest: string;
    activityId: string | undefined;
  }> {
    const owner = await resolveOwnerForCaller(ctx, runArgs);
    const ownerId = owner.ownerId;
    const exactSource =
      runArgs.source.kind === "inline"
        ? {
            code: runArgs.source.code,
            sourceDigest: createHash("sha256").update(runArgs.source.code).digest("hex"),
            sourceState: undefined,
            contentStateHash: undefined,
          }
        : deps.resolveContextSource
          ? await deps.resolveContextSource(owner.contextId, runArgs.source.path)
          : (() => {
              throw new ServiceError(
                "dynamicCode",
                "admit",
                "Exact semantic context-file resolution is unavailable",
                "EUNAVAILABLE",
                undefined,
                "service"
              );
            })();
    const agentBinding = trustedAgentRelay(ctx);
    assertAgentCausalParent(ctx, agentBinding);
    // Refuse an unscoped or trajectory-drifting agent relay before creating
    // a session or exposing any presenter authority ceiling.
    const { ref: hostRef } = await ensureSession(
      ctx,
      owner,
      runArgs.scope?.key ?? "default",
      runArgs.scope?.lifecycle ?? "persistent",
      agentBinding
    );
    const isAgentDo = ctx.caller.runtime.kind === "do" && agentBinding !== undefined;
    const timeoutMs = runArgs.timeoutMs;
    const chatBinding = isAgentDo ? { channelId: agentBinding.channelId, agentRef: ownerId } : {};
    const parent = (await resolveParentPanel(ownerId)) ?? undefined;
    const evalRuntimeId = entityIdOfRef(hostRef);
    // The harness is the owner's own sealed code when it has one; an owner with
    // none (a user or CLI session) is mediated by the session entity's sealed image.
    const ownerHarness = resolveCodeIdentity(store.cache, ownerId);
    const harnessIdentity = ownerHarness ?? resolveCodeIdentity(store.cache, evalRuntimeId);
    const harnessCandidate = harnessIdentity
      ? await deps.resolveExecutionArtifact(harnessIdentity)
      : null;
    if (
      !harnessIdentity ||
      !harnessCandidate ||
      harnessCandidate.executionDigest !== harnessIdentity.executionDigest ||
      harnessCandidate.sourceState.effectiveVersion !== harnessIdentity.effectiveVersion
    ) {
      throw new ServiceError(
        "dynamicCode",
        "admit",
        "The live harness has no matching sealed execution artifact" +
          ` (${!harnessIdentity ? `no code identity for ${ownerHarness ? ownerId : evalRuntimeId}` : !harnessCandidate ? `no build recorded for ${harnessIdentity.callerId} at ${harnessIdentity.executionDigest.slice(0, 12)}` : "the artifact's version differs from the live entity's"})`,
        "EEXECUTION_IDENTITY",
        undefined,
        "service"
      );
    }
    const harnessArtifact = verifyExecutionArtifactRef(harnessCandidate);
    const harness = {
      repoPath: harnessIdentity.repoPath,
      effectiveVersion: harnessArtifact.sourceState.effectiveVersion,
      executionDigest: harnessArtifact.executionDigest,
    };
    const sourceRoot = harnessArtifact.sourceState.contentRoots.find(
      (root) =>
        root.repoPath === harness.repoPath ||
        (harnessArtifact.sourceState.kind === "product-seed" && root.repoPath === null)
    );
    if (!sourceRoot) {
      throw new ServiceError(
        "dynamicCode",
        "admit",
        "The sealed harness artifact has no source root for its unit",
        "EEXECUTION_IDENTITY",
        undefined,
        "service"
      );
    }

    const stopReconcile = reconcileWhileWaiting(evalRuntimeId, hostRef, runId);
    let admitted: Awaited<ReturnType<typeof admission.admit>>;
    try {
      admitted = await admission.admit(ctx, {
        runId,
        hostRuntimeId: evalRuntimeId,
        ownerId,
        contextId: owner.contextId,
        authority: runArgs.authority,
        executionImage: {
          repoPath: harness.repoPath,
          effectiveVersion: harness.effectiveVersion,
          executionDigest: harness.executionDigest,
          stateHash: sourceRoot.stateHash as `state:${string}`,
          requested: ownerHarness?.requested ?? [],
        },
        ...(agentBinding ? { agentBinding } : {}),
        admissionKey: `eval:${evalRuntimeId}:${runId}`,
        taskRefFallback: `eval:${ownerId}:${runId}`,
        legacyHostRuntimeId: legacyEvalDoRuntimeId(ownerId, runArgs.scope?.key ?? "default"),
      });
    } finally {
      stopReconcile();
    }
    const { executionSession } = admitted;
    const activityId = deps.activity ? `eval:${evalRuntimeId}:${runId}` : undefined;
    const discardPreparedAdmission = () => {
      admitted.discard();
      if (activityId) deps.activity?.end(activityId);
    };
    // Every resource acquired after admission belongs to one preparation transaction.
    try {
      const evalExecutor = executionSession.executor;
      if (activityId) deps.activity?.begin(activityId);
      const authorityManifestDigest = admitted.authorityManifestDigest;
      const runDigest = sha256Canonical({
        runId,
        ownerRuntimeId: ownerId,
        contextId: owner.contextId,
        source:
          runArgs.source.kind === "inline"
            ? {
                kind: "inline",
                digest: exactSource.sourceDigest,
                pathHint: runArgs.source.pathHint ?? null,
                syntax: runArgs.source.syntax ?? null,
              }
            : {
                kind: "context-file",
                path: runArgs.source.path,
                digest: exactSource.sourceDigest,
                sourceState: exactSource.sourceState,
                contentStateHash: exactSource.contentStateHash,
                syntax: runArgs.source.syntax ?? null,
              },
        scope: {
          key: runArgs.scope?.key ?? "default",
          lifecycle: runArgs.scope?.lifecycle ?? "persistent",
        },
        reset: runArgs.reset === true,
        imports: runArgs.imports ?? {},
        timeoutMs: runArgs.timeoutMs ?? null,
        authorityManifestDigest,
        attachedHost: ctx.attachedHost
          ? {
              sessionId: ctx.attachedHost.sessionId,
              childGenerationId: ctx.attachedHost.childGenerationId,
              developmentRunId: ctx.attachedHost.developmentRunId,
              authorityCeilingDigest: ctx.attachedHost.authorityCeilingDigest,
            }
          : null,
        preauthorize: normalizeEvalAuthorityIntent(runArgs.authority).preauthorize ?? [],
        initiatorChain: [
          ctx.caller.subject ? `user:${ctx.caller.subject.userId}` : null,
          ctx.caller.runtime.id,
          ctx.caller.code?.executionDigest ? codePrincipal(ctx.caller.code) : null,
        ].filter((value): value is string => value !== null),
      });
      return {
        evalDoRef: hostRef,
        assembledArgs: {
          runId,
          code: exactSource.code,
          path: undefined,
          sourcePath:
            runArgs.source.kind === "inline" ? runArgs.source.pathHint : runArgs.source.path,
          sourceDigest: exactSource.sourceDigest,
          sourceState: exactSource.sourceState,
          contentStateHash: exactSource.contentStateHash,
          reset: runArgs.reset,
          syntax: runArgs.source.syntax,
          imports: runArgs.imports,
          contextId: owner.contextId,
          executionSessionNonce: executionSession.nonce,
          causalParent: ctx.causalParent,
          agentInvocationId: ctx.causalParent?.invocationId,
          parent,
          timeoutMs,
          readOnly: evalExecutor.authorityManifest.effects === "read-only",
          authorityManifestDigest,
          intentDigest: runDigest,
          ...(admitted.legacyNotebookDropped ? { legacyNotebookDropped: true } : {}),
          ...chatBinding,
        },
        agentRef: isAgentDo ? ownerId : undefined,
        channelId: isAgentDo ? agentBinding.channelId : undefined,
        runDigest,
        authorityManifestDigest,
        activityId,
      };
    } catch (error) {
      discardPreparedAdmission();
      throw error;
    }
  }

  async function resetScope(ctx: ServiceContext, resetArgs: EvalRoute): Promise<{ ok: boolean }> {
    const ref = await findSessionRefFor(ctx, resetArgs, "reset");
    // An absent notebook is already empty; clearing it admits no execution.
    return ref ? hostedEntityClient(deps.doDispatch, ref).reset() : { ok: true };
  }

  async function disposeScope(
    ctx: ServiceContext,
    disposeArgs: EvalRoute
  ): Promise<{ ok: boolean }> {
    const owner = await resolveOwnerForCaller(ctx, disposeArgs);
    const objectKey = sessionObjectKey(owner.ownerId, disposeArgs.scopeKey ?? "default");
    const entityId = sessionEntityId(objectKey);
    const active = await store.resolveRecord(entityId);
    if (!active || active.status !== "active") return { ok: true };
    const stateArgs =
      active.stateArgs && typeof active.stateArgs === "object" && !Array.isArray(active.stateArgs)
        ? (active.stateArgs as Record<string, unknown>)
        : null;
    if (stateArgs?.["lifecycle"] !== "finite") {
      throw new ServiceError(
        "dynamicCode",
        "dispose",
        "Only an eval scope declared finite at creation may be disposed",
        "EACCES",
        undefined,
        "access"
      );
    }
    await deps.retireEntity(entityId);
    return { ok: true };
  }

  return {
    name: "dynamicCode",
    description:
      "Admission of dynamic code: runs of a class an entity hosts, and the host-authority controls of its scope",
    authority: { principals: ["code", "user", "host", "website"] },
    methods: dynamicCodeMethods,
    handler: defineServiceHandler("dynamicCode", dynamicCodeMethods, {
      admit: async (ctx, [input]): Promise<DynamicCodeAdmission> => {
        if (shutdownRequested) {
          throw new ServiceError(
            "dynamicCode",
            "admit",
            "Admission is closed because the server is shutting down",
            "ESHUTDOWN",
            undefined,
            "service"
          );
        }
        const prepared = await prepareRun(ctx, input, input.runId);
        const evalRuntimeId = entityIdOfRef(prepared.evalDoRef);
        trackAdmission({
          evalDoRef: prepared.evalDoRef,
          runId: input.runId,
          ctx,
          activityId: prepared.activityId,
        });
        return {
          runId: input.runId,
          runDigest: prepared.runDigest,
          authorityManifestDigest: prepared.authorityManifestDigest,
          host: prepared.evalDoRef,
          hostId: evalRuntimeId,
          nonce: String(prepared.assembledArgs.executionSessionNonce),
          start: { ...prepared.assembledArgs, runId: input.runId } as Record<string, unknown>,
        };
      },
      release: async (ctx, [{ runId, hostId }]) => {
        const tracked = activeRuns.get(activeRunKey(hostId, runId));
        if (!tracked) return { released: false };
        if (tracked.initiatorId !== ctx.caller.runtime.id && ctx.caller.runtime.kind !== "server") {
          throw new ServiceError(
            "dynamicCode",
            "release",
            "Only the caller that admitted a run releases it",
            "EACCES",
            undefined,
            "access"
          );
        }
        tracked.closeAdmission();
        return { released: true };
      },
      reset: async (ctx, [resetArgs = {}]) => resetScope(ctx, resetArgs),
      dispose: async (ctx, [disposeArgs = {}]) => disposeScope(ctx, disposeArgs),
    }),
  };
}
