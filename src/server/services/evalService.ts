import { evalEngineMethods } from "@vibestudio/service-schemas/evalEngine";
import type { TypedServiceClient } from "@vibestudio/shared/typedServiceClient";
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
  evalMethods,
  normalizeEvalAuthorityIntent,
  type EvalStartInput,
} from "@vibestudio/service-schemas/eval";
import { AmbiguousDoDispatchError, type HeldDoDispatcher } from "@vibestudio/shared/doDispatcher";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { resolveOwningPanelSlot } from "@vibestudio/shared/panel/owningPanelSlot";
import { asPanelSlotId } from "@vibestudio/shared/panel/ids";
import { createHash, randomUUID } from "node:crypto";
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

type EvalEngineSchemaClient = TypedServiceClient<typeof evalEngineMethods>;

type SessionRef = { source: string; className: string; objectKey: string };

/**
 * The calls this service makes on an eval kernel, through the session entity that
 * hosts it (docs/dolt-redesign.md §7.5.1). The host does not reach a kernel
 * itself: only its hosting entity can, so every call is a call on the session.
 * Run-scoped calls carry no nonce here; the session holds the nonce each run was
 * admitted under and presents it to the kernel.
 */
type EvalStartArgs = Omit<
  Parameters<EvalEngineSchemaClient["startRun"]>[0],
  "gatewayToken" | "resultReceiverRef"
>;

interface EvalEngineClient {
  startRun(args: EvalStartArgs): ReturnType<EvalEngineSchemaClient["startRun"]>;
  getRun(runId: string): ReturnType<EvalEngineSchemaClient["getRun"]>;
  getRunReceipt(runId: string): ReturnType<EvalEngineSchemaClient["getRunReceipt"]>;
  acknowledgeRunResult(
    runId: string,
    identity: Parameters<EvalEngineSchemaClient["acknowledgeRunResult"]>[1]
  ): ReturnType<EvalEngineSchemaClient["acknowledgeRunResult"]>;
  getRunEvents(
    runId: string,
    after: number,
    limit: number
  ): ReturnType<EvalEngineSchemaClient["getRunEvents"]>;
  readScopeTextPage(
    key: string,
    offset: number,
    limit: number
  ): ReturnType<EvalEngineSchemaClient["readScopeTextPage"]>;
  deleteScopeValue(key: string): ReturnType<EvalEngineSchemaClient["deleteScopeValue"]>;
  reset(): ReturnType<EvalEngineSchemaClient["reset"]>;
  cancel(runId: string): ReturnType<EvalEngineSchemaClient["cancel"]>;
  /** Blocks (a held request) until the run is terminal or `waitMs` passes. */
  await(runId: string, waitMs: number): Promise<{ status: string }>;
}

function evalEngineClient(dispatch: HeldDoDispatcher, ref: SessionRef): EvalEngineClient {
  const call = (method: string, ...args: unknown[]) => dispatch.dispatch(ref, method, ...args);
  const typed = <T>(value: Promise<unknown>) => value as Promise<T>;
  return {
    startRun: (args) =>
      typed(call("start", args, args.executionSessionNonce)) as ReturnType<
        EvalEngineClient["startRun"]
      >,
    getRun: (runId) => typed(call("get", runId)),
    getRunReceipt: (runId) => typed(call("receipt", runId)),
    acknowledgeRunResult: (runId, identity) =>
      typed(call("settle", "acknowledgeRunResult", [runId, identity])),
    getRunEvents: (runId, after, limit) => typed(call("events", runId, { after, limit })),
    readScopeTextPage: (key, offset, limit) => typed(call("readScopeTextPage", key, offset, limit)),
    deleteScopeValue: (key) => typed(call("deleteScopeValue", key)),
    reset: () => typed(call("reset")),
    cancel: (runId) => typed(call("cancel", runId)),
    await: (runId, waitMs) =>
      typed(dispatch.dispatchHeld(ref, "await", runId, { waitMs })) as Promise<{ status: string }>,
  };
}

export type EvalShutdown = () => Promise<void>;

export const evalServiceDocumentation = {
  name: "eval",
  description: "Owner-scoped sandbox eval backed by a kernel hosted in a per-owner session entity",
  authority: { principals: ["code", "user", "host", "website"] },
  methods: evalMethods,
} satisfies Omit<ServiceDefinition, "handler">;

interface ActiveEvalRun {
  evalDoRef: SessionRef;
  runId: string;
  closeAdmission: () => void;
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
 * Owner-scoped sandbox eval service — replaces the `scope` service. Any entity-principal
 * (panel/app/worker/do/shell) calls `eval.start`/`eval.reset`; the owner is the verified
 * `ctx.caller` unless a privileged shell/server caller selects a live session owner. The
 * session entity that hosts the owner's kernel is keyed (hashed) by owner id + subKey, so
 * unprivileged callers can only address their own. It is created through
 * `runtime.createEntity` with the owner as its parent (the lineage `resolveParentPanel`
 * walks) and registered with the owner's context so the kernel's own fs/git/vcs resolve
 * the owner's workspace (docs/dolt-redesign.md §7.2, §7.3).
 */
export function createEvalService(deps: {
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
  eventSinks?: {
    register(route: {
      nonce: string;
      runtimeId: string;
      runId: string;
      contextId: string;
      ownerCallerId: string;
      initiatorCallerId: string;
      subKey: string;
      onTerminal?: () => void;
    }): void;
    close(nonce: string): void;
  };
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

  const evalDoKey = (ownerId: string, subKey: string): string => evalHostObjectKey(ownerId, subKey);

  /** The session entity's identity and object-key derivation share one canonical helper. */
  const evalDoEntityId = (objectKey: string): string =>
    `do:${EVAL_HOST_SOURCE}:${EVAL_HOST_CLASS}:${objectKey}`;

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
            await evalEngineClient(deps.doDispatch, entry.evalDoRef).cancel(entry.runId);
          } finally {
            // The durable EvalDO owns terminal truth. Once cancellation has
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
   * eval user input. Becomes `RunArgs.parent`, from which the EvalDO derives the
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
    // and context the EvalDO trusts. Client-supplied ownerId/contextId are never
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
  ): Promise<{ objectKey: string }> {
    const { ownerId, contextId } = owner;
    const objectKey = evalDoKey(ownerId, subKey);
    // Eviction preserves a scope; retirement closes it. A cache miss must read
    // durable ownership before deciding that these coordinates are unused.
    const current =
      store.cache.resolveActive(evalDoEntityId(objectKey)) ??
      (await store.resolveRecord(evalDoEntityId(objectKey)));
    if (current?.status === "retired") {
      throw new ServiceError(
        "eval",
        "start",
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
        "eval",
        "start",
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
      return { objectKey };
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
    return { objectKey };
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

  async function findEvalDoRefFor(
    ctx: ServiceContext,
    route: EvalRoute,
    method: string
  ): Promise<{ source: string; className: string; objectKey: string } | null> {
    const owner = await resolveOwnerForCaller(ctx, route);
    const scopeKey = route.scopeKey ?? "default";
    const objectKey = evalDoKey(owner.ownerId, scopeKey);
    const entityId = evalDoEntityId(objectKey);
    const existing = store.cache.resolveActive(entityId) ?? (await store.resolveRecord(entityId));
    if (!existing) return null;
    if (existing.status !== "active") {
      throw new ServiceError(
        "eval",
        method,
        `Eval scope ${scopeKey} is retired; use a new scope for new work`,
        "ECLOSED",
        undefined,
        "application"
      );
    }
    if (existing.contextId !== owner.contextId) {
      throw new ServiceError(
        "eval",
        method,
        "Eval control cannot change the admitted scope's context",
        "EACCES",
        undefined,
        "access"
      );
    }
    return { source: EVAL_HOST_SOURCE, className: EVAL_HOST_CLASS, objectKey };
  }

  async function evalDoRefFor(ctx: ServiceContext, route: EvalRoute, method: string) {
    const ref = await findEvalDoRefFor(ctx, route, method);
    if (ref) return ref;
    throw new ServiceError(
      "eval",
      method,
      `Eval scope ${route.scopeKey ?? "default"} has not been admitted`,
      "ENOTFOUND",
      undefined,
      "application"
    );
  }

  async function prepareRun(
    ctx: ServiceContext,
    runArgs: EvalStartInput,
    runId: string
  ): Promise<{
    evalDoRef: { source: string; className: string; objectKey: string };
    assembledArgs: Parameters<EvalEngineClient["startRun"]>[0];
    agentRef: string | undefined;
    channelId: string | undefined;
    runDigest: string;
    authorityManifestDigest: string;
    eventSinkNonce: string;
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
                "eval",
                "start",
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
    const { objectKey } = await ensureSession(
      ctx,
      owner,
      runArgs.scope?.key ?? "default",
      runArgs.scope?.lifecycle ?? "persistent",
      agentBinding
    );
    const isAgentDo = ctx.caller.runtime.kind === "do" && agentBinding !== undefined;
    if (runArgs.resultReceiver && !isAgentDo) {
      throw new ServiceError(
        "eval",
        "start",
        "This caller does not expose the eval terminal receiver contract",
        "EINVAL",
        undefined,
        "application"
      );
    }
    const timeoutMs = runArgs.timeoutMs;
    const chatBinding = isAgentDo ? { channelId: agentBinding.channelId, agentRef: ownerId } : {};
    const parent = (await resolveParentPanel(ownerId)) ?? undefined;
    const evalRuntimeId = evalDoEntityId(objectKey);
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
        "eval",
        "start",
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
        "eval",
        "start",
        "The sealed harness artifact has no source root for its unit",
        "EEXECUTION_IDENTITY",
        undefined,
        "service"
      );
    }

    const eventSinkNonce = randomUUID();
    const admitted = await admission.admit(ctx, {
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
      eventSinkNonce,
      legacyHostRuntimeId: legacyEvalDoRuntimeId(ownerId, runArgs.scope?.key ?? "default"),
    });
    const { executionSession } = admitted;
    const activityId =
      deps.activity && deps.eventSinks ? `eval:${evalRuntimeId}:${runId}` : undefined;
    const discardPreparedAdmission = () => {
      admitted.discard();
      deps.eventSinks?.close(eventSinkNonce);
      if (activityId) deps.activity?.end(activityId);
    };
    // Every resource acquired after admission belongs to one preparation transaction.
    try {
      const evalExecutor = executionSession.executor;
      deps.eventSinks?.register({
        nonce: eventSinkNonce,
        runtimeId: evalRuntimeId,
        runId,
        contextId: owner.contextId,
        ownerCallerId: ownerId,
        initiatorCallerId: ctx.caller.runtime.id,
        subKey: runArgs.scope?.key ?? "default",
        onTerminal: () => {
          deps.executionSessions.close(evalRuntimeId, runId);
          if (activityId) deps.activity?.end(activityId);
          activeRuns.get(activeRunKey(evalRuntimeId, runId))?.closeAdmission();
        },
      });
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
      const evalDoRef = { source: EVAL_HOST_SOURCE, className: EVAL_HOST_CLASS, objectKey };
      return {
        evalDoRef,
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
          eventSinkNonce,
          ...(admitted.legacyNotebookDropped ? { legacyNotebookDropped: true } : {}),
          ...chatBinding,
        },
        agentRef: isAgentDo ? ownerId : undefined,
        channelId: isAgentDo ? agentBinding.channelId : undefined,
        runDigest,
        authorityManifestDigest,
        eventSinkNonce,
        activityId,
      };
    } catch (error) {
      discardPreparedAdmission();
      throw error;
    }
  }

  /**
   * Compatibility with the push model, until pull replaces it per consumer
   * (docs/dolt-redesign.md §7.12 step 5). The kernel keeps no redelivery index;
   * the host pulls the terminal row with `await`, tells the receiver, and repeats
   * with backoff until the receiver's exact acknowledgement is recorded. Nothing
   * here survives a restart of the host: that gap is the one this step accepts.
   */
  function deliverTerminalToReceiver(ref: SessionRef, runId: string, receiverId: string): void {
    const client = evalEngineClient(deps.doDispatch, ref);
    const receiver = doRefOfEntityId(receiverId);
    if (!receiver) return;
    void (async () => {
      let delay = RESULT_REDELIVERY_BASE_DELAY_MS;
      let terminal = false;
      while (!shutdownRequested) {
        try {
          if (!terminal) {
            const snapshot = await client.await(runId, 30_000);
            terminal = ["done", "cancelled", "approval-route-lost", "unknown"].includes(
              snapshot.status
            );
            if (!terminal) continue;
          }
          const receipt = await client.getRunReceipt(runId);
          if (!receipt || receipt.acknowledged) return;
          await deps.doDispatch.dispatch(receiver, "onEvalComplete", { runId });
        } catch (error) {
          console.warn(
            `[eval] terminal hint for ${runId} not delivered yet:`,
            error instanceof Error ? error.message : error
          );
        }
        await sleep(delay);
        delay = Math.min(delay * 2, RESULT_REDELIVERY_MAX_DELAY_MS);
      }
    })();
  }

  return {
    ...evalServiceDocumentation,
    handler: defineServiceHandler("eval", evalMethods, {
      start: async (ctx, [runArgs]) => {
        if (shutdownRequested) {
          throw new ServiceError(
            "eval",
            "start",
            "Eval admission is closed because the server is shutting down",
            "ESHUTDOWN",
            undefined,
            "service"
          );
        }
        // Every caller uses the same durable lifecycle. The caller-owned run id
        // is known before transport, so an ambiguous response or process loss
        // never makes the accepted run unaddressable.
        const runId = runArgs.runId;
        const { evalDoRef, assembledArgs, authorityManifestDigest, eventSinkNonce, activityId } =
          await prepareRun(ctx, runArgs, runId);
        const startArgs = {
          ...assembledArgs,
          runId,
        };
        const evalRuntimeId = evalDoEntityId(evalDoRef.objectKey);
        const activeKey = activeRunKey(evalRuntimeId, runId);
        let admissionClosed = false;
        const closeAdmission = () => {
          if (admissionClosed) return;
          admissionClosed = true;
          if (activeRuns.get(activeKey)?.runId === runId) activeRuns.delete(activeKey);
          deps.executionSessions.close(evalRuntimeId, runId);
          deps.eventSinks?.close(eventSinkNonce);
          if (activityId) deps.activity?.end(activityId);
        };
        activeRuns.set(activeKey, { evalDoRef, runId, closeAdmission });
        if (shutdownRequested) {
          closeAdmission();
          throw new ServiceError(
            "eval",
            "start",
            "Eval admission closed while this run was being prepared",
            "ESHUTDOWN",
            undefined,
            "service"
          );
        }
        let accepted: Awaited<ReturnType<EvalEngineClient["startRun"]>>;
        try {
          accepted = await evalEngineClient(deps.doDispatch, evalDoRef).startRun(startArgs);
        } catch (error) {
          if (!(error instanceof AmbiguousDoDispatchError)) {
            closeAdmission();
            throw error;
          }
          // startRun is idempotent on runId. Only an explicitly ambiguous
          // acknowledgement keeps admission alive: the EvalDO may already have
          // durably accepted the run. Structured remote rejections are
          // definitive and were unwound above.
          void reconcileAmbiguousStart(deps.doDispatch, evalDoRef, startArgs).catch(
            (reconcileError) => {
              closeAdmission();
              console.warn(
                `[eval] admission reconciliation ${runId} stopped:`,
                reconcileError instanceof Error ? reconcileError.message : reconcileError
              );
            }
          );
          throw error;
        }
        const acceptedRunDigest = accepted.runDigest;
        if (
          accepted.status === "done" ||
          accepted.status === "cancelled" ||
          accepted.status === "approval-route-lost"
        ) {
          const snapshot = await evalEngineClient(deps.doDispatch, evalDoRef).getRun(runId);
          closeAdmission();
          if (runArgs.resultReceiver) {
            deliverTerminalToReceiver(evalDoRef, runId, ctx.caller.runtime.id);
          }
          return {
            runId,
            runDigest: acceptedRunDigest,
            authorityManifestDigest,
            status: "terminal" as const,
            snapshot,
          };
        }
        // A caller that asked for the terminal hint (an agent) is told when the
        // run ends. The kernel does not push it: the host pulls the committed
        // row and delivers (docs/dolt-redesign.md §7.5; deleted with step 5).
        if (runArgs.resultReceiver) {
          deliverTerminalToReceiver(evalDoRef, runId, ctx.caller.runtime.id);
        }
        return {
          runId,
          runDigest: acceptedRunDigest,
          authorityManifestDigest,
          status: accepted.existing ? ("already-running" as const) : ("accepted" as const),
        };
      },
      get: async (ctx, [getArgs]) =>
        evalEngineClient(deps.doDispatch, await evalDoRefFor(ctx, getArgs, "get")).getRun(
          getArgs.runId
        ),
      receipt: async (ctx, [receiptArgs]) =>
        evalEngineClient(
          deps.doDispatch,
          await evalDoRefFor(ctx, receiptArgs, "receipt")
        ).getRunReceipt(receiptArgs.runId),
      acknowledge: async (ctx, [acknowledgeArgs]) =>
        evalEngineClient(
          deps.doDispatch,
          await evalDoRefFor(ctx, acknowledgeArgs, "acknowledge")
        ).acknowledgeRunResult(acknowledgeArgs.runId, acknowledgeArgs.receipt),
      events: async (ctx, [eventArgs]) =>
        evalEngineClient(
          deps.doDispatch,
          await evalDoRefFor(ctx, eventArgs, "events")
        ).getRunEvents(eventArgs.runId, eventArgs.after ?? 0, eventArgs.limit ?? 100),
      readScopeTextPage: async (ctx, [pageArgs]) =>
        evalEngineClient(
          deps.doDispatch,
          await evalDoRefFor(ctx, pageArgs, "readScopeTextPage")
        ).readScopeTextPage(pageArgs.key, pageArgs.offset, pageArgs.limit),
      deleteScopeValue: async (ctx, [deleteArgs]) =>
        evalEngineClient(
          deps.doDispatch,
          await evalDoRefFor(ctx, deleteArgs, "deleteScopeValue")
        ).deleteScopeValue(deleteArgs.key),
      reset: async (ctx, [resetArgs = {}]) => {
        const ref = await findEvalDoRefFor(ctx, resetArgs, "reset");
        // An absent notebook is already empty; clearing it admits no execution.
        return ref ? evalEngineClient(deps.doDispatch, ref).reset() : { ok: true };
      },
      dispose: async (ctx, [disposeArgs = {}]) => {
        const owner = await resolveOwnerForCaller(ctx, disposeArgs);
        const objectKey = evalDoKey(owner.ownerId, disposeArgs.scopeKey ?? "default");
        const entityId = evalDoEntityId(objectKey);
        const active = await store.resolveRecord(entityId);
        if (!active || active.status !== "active") return { ok: true };
        const stateArgs =
          active.stateArgs &&
          typeof active.stateArgs === "object" &&
          !Array.isArray(active.stateArgs)
            ? (active.stateArgs as Record<string, unknown>)
            : null;
        if (stateArgs?.["lifecycle"] !== "finite") {
          throw new ServiceError(
            "eval",
            "dispose",
            "Only an eval scope declared finite at creation may be disposed",
            "EACCES",
            undefined,
            "access"
          );
        }
        await deps.retireEntity(entityId);
        return { ok: true };
      },
      cancel: async (ctx, [cancelArgs]) => {
        const ref = await evalDoRefFor(ctx, cancelArgs, "cancel");
        const result = await evalEngineClient(deps.doDispatch, ref).cancel(cancelArgs.runId);
        activeRuns
          .get(activeRunKey(evalDoEntityId(ref.objectKey), cancelArgs.runId))
          ?.closeAdmission();
        return result;
      },
    }),
  };
}

const RESULT_REDELIVERY_BASE_DELAY_MS = 1_000;
const RESULT_REDELIVERY_MAX_DELAY_MS = 5 * 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** `do:<source>:<Class>:<key>` as a dispatch coordinate. */
function doRefOfEntityId(id: string): SessionRef | null {
  const parts = id.split(":");
  if (parts[0] !== "do" || parts.length < 4) return null;
  return { source: parts[1]!, className: parts[2]!, objectKey: parts.slice(3).join(":") };
}

async function reconcileAmbiguousStart(
  dispatch: HeldDoDispatcher,
  ref: SessionRef,
  startArgs: Parameters<EvalEngineClient["startRun"]>[0]
): Promise<void> {
  for (;;) {
    try {
      await evalEngineClient(dispatch, ref).startRun(startArgs);
      return;
    } catch (error) {
      if (!(error instanceof AmbiguousDoDispatchError)) throw error;
      await admissionRetryDelay();
    }
  }
}

function admissionRetryDelay(): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 250);
    timer.unref?.();
  });
}
