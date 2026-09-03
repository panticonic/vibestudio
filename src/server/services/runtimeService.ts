/**
 * runtime.* — the only path through which entity identities are created or retired.
 *
 * Two-phase: prepare runtime resources (workerd class build, worker spawn, etc.)
 * before committing the durable entity row. A phase-4 failure leaves no row;
 * a phase-5 failure (DO write after runtime up) is reconciled by the next-boot
 * startup sweep.
 *
 * Retirement is server-mediated because cleanup hooks live in Node (egress
 * proxy, approval queue, etc.) and WorkspaceDO is workerd-resident.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  PreparedAuthoritySelection,
  ServiceDefinition,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  runtimeMethods,
  type ClonedEntity,
  type CloneContextResult,
  type RuntimeExecutionRecoveryRequest,
  type RuntimeExecutionRecoveryResult,
} from "@vibestudio/service-schemas/runtime";
import type { ContextEdge, ContextEdgeKind } from "@vibestudio/shared/runtime/contextEdges";
import {
  verifiedInitiator,
  type ServiceContext,
  type VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type {
  LifecyclePrepareInput,
  LifecyclePrepareResult,
} from "@vibestudio/shared/doDispatcher";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import {
  buildWorkspaceContext,
  canonicalEntityId,
  IdentityCollisionError,
  runtimeEntitySource,
  type CodeExecution,
  type EntityRecord,
  type ExternalDocumentExecution,
  type InertExecution,
  type RuntimeAgentBinding,
  type RuntimeAgentBindingInput,
  type RuntimeEntityCreateSpec,
  type RuntimeEntityHandle,
  type RuntimeResourceBindingInput,
  type RuntimeCodeEntityCreateSpec,
  type WorkspaceContext,
} from "@vibestudio/shared/runtime/entitySpec";
import { isOpenPanelBrowserUrl } from "@vibestudio/shared/panelChrome";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { isAuthorizedChrome, isInteractiveChrome } from "./chromeTrust.js";
import {
  prepareContextBoundarySelection,
  type ContextBoundaryAction,
  type ContextBoundaryDeps,
} from "./contextBoundary.js";
import { callerControlsContextTransition } from "./lifecycleContextControl.js";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import type { VcsStateNodeRef } from "@vibestudio/service-schemas/vcs";
import type { UnitSupervisor } from "./unitSupervisor.js";
import { requireActiveExecutionIdentity } from "../runtimeExecutionIdentity.js";

export interface RuntimeEntityHooks {
  /**
   * Prepare exactly one incarnation through a surface-correlated contract.
   * Kind-specific launch coordinates remain in `spec`; the lifecycle consumer
   * only observes the closed prepared union.
   */
  prepare: <S extends RuntimeEntityCreateSpec>(
    args: RuntimePreparationInput<S>
  ) => Promise<PreparedFor<S["execution"]>>;

  /** Called after the entity row is active but before activation is returned
   * to its creator, so durable-work capability registration precedes work. */
  onDurableObjectActivated?: (record: EntityRecord) => Promise<void>;

  /** Cleanup hooks invoked on retire — closed at bootstrap. */
  onRetire: (record: EntityRecord) => Promise<void>;

  /** Reattach only the immutable execution already sealed into this row. */
  recoverExactExecution: (record: EntityRecord) => Promise<void>;

  /** Restart a facet after exact recovery or an explicit incarnation advance. */
  restartDurableObjectIncarnation: (record: EntityRecord) => Promise<void>;

  /** Release resources owned inside an entity before its durable row is retired. */
  releaseEntity: (
    record: EntityRecord,
    input: LifecyclePrepareInput
  ) => Promise<LifecyclePrepareResult>;

  /** Seal external RPC admission and drain calls accepted before retirement. */
  sealAndDrainEntityRelays?: (entityId: string) => Promise<void>;
  /** Release the process-local retirement seal after retire commits or aborts. */
  releaseEntityRelaySeal?: (entityId: string) => void;

  cloneDurableStorage?: (args: {
    source: string;
    className: string;
    fromKey: string;
    toKey: string;
    /**
     * True only when the verified clone caller is this exact source object.
     * Its actor turn is serialized and paused on the host call, so storage can
     * be snapshotted online without trying to retire the caller mid-invocation.
     */
    cooperativelyPaused?: boolean;
  }) => Promise<void>;

  destroyDurableStorage?: (args: {
    source: string;
    className: string;
    key: string;
  }) => Promise<void>;
}

export interface RuntimePreparationInput<S extends RuntimeEntityCreateSpec> {
  spec: S;
  key: string;
  contextId: string;
  existingBuildKey?: string;
  parent?: {
    parentId: string;
    parentEntityId: string;
    parentKind?: "panel" | "worker" | "do";
  };
}

export interface PreparedCodeIncarnation {
  surface: "code";
  target: { id: string };
  effectiveVersion: string;
  buildKey: string;
  executionDigest: string;
  authority: UnitAuthorityManifest;
}

export interface PreparedExternalIncarnation {
  surface: "external";
  target: { id: string };
  document: {
    requestedUrl: string;
  };
}

export interface PreparedInertIncarnation {
  surface: "inert";
  target: { id: string };
}

export type PreparedIncarnation =
  | PreparedCodeIncarnation
  | PreparedExternalIncarnation
  | PreparedInertIncarnation;

export type PreparedFor<E> = E extends CodeExecution
  ? PreparedCodeIncarnation
  : E extends ExternalDocumentExecution
    ? PreparedExternalIncarnation
    : E extends InertExecution
      ? PreparedInertIncarnation
      : never;

export interface RuntimeServiceInternal {
  createEntity(caller: VerifiedCaller, spec: RuntimeEntityCreateSpec): Promise<RuntimeEntityHandle>;
  /** Complete a durable code reservation from the server-owned reconciler. */
  activateReservedEntity(spec: RuntimeCodeEntityCreateSpec): Promise<RuntimeEntityHandle>;
  /** Preparing panel reservations that must be resumed after server startup. */
  listPreparingPanels(): Promise<EntityRecord[]>;
  retireEntity(id: string): Promise<void>;
  createContext(
    ctx: Pick<ServiceContext, "caller" | "chainCaller">,
    args: {
      contextId?: string;
      testPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicySpec;
    }
  ): Promise<WorkspaceContext>;
  resolveContext(id: string): Promise<string | null>;
  /**
   * Create a deterministic semantic-only child context for a development
   * session. It intentionally does not create entities, clone DO storage, or
   * materialize a host projection.
   */
  forkSemanticContext(input: {
    ownerRuntimeId: string;
    parentContextId: string;
    targetContextId: string;
  }): Promise<{
    contextId: string;
    parentContextId: string;
    parentWorkingHead: VcsStateNodeRef;
    childBaseState: VcsStateNodeRef;
  }>;
  /** Undo a never-executed development-session context after admission fails. */
  dropSemanticContext(contextId: string): Promise<void>;
}

export interface RuntimeServiceResult {
  definition: ServiceDefinition;
  internal: RuntimeServiceInternal;
}

interface RuntimeCreationActors {
  /** Authenticated principal that owns and controls the new runtime lifecycle. */
  lifecycleCaller: VerifiedCaller;
  /** Host-verified root initiator whose human subject owns the new runtime. */
  initiatingCaller: VerifiedCaller;
}

export interface PreparedRuntimeExecution {
  effectiveVersion: string;
  buildKey?: string;
  executionDigest?: string;
  authorityRequests?: readonly import("@vibestudio/shared/authorityManifest").UnitAuthorityRequest[];
}

/** Disposable host projection directories for semantic contexts. */
export interface RuntimeContextFolders {
  ensureContextFolder(contextId: string): Promise<string>;
  removeContext(contextId: string): Promise<void>;
}

/** Lifecycle hooks for GAD-owned semantic workspace contexts. */
export interface RuntimeSemanticContexts {
  /** Ensure the durable semantic context exists. Idempotent. */
  ensureContext(contextId: string): Promise<void>;
  /** Drop the semantic context and its disposable host projection. */
  dropContext(contextId: string): Promise<void>;
  /**
   * Fork the source context's exact working frontier into an independent target
   * semantic context. Used by clone/subagent lifecycle orchestration.
   */
  forkContext(sourceContextId: string, targetContextId: string): Promise<void>;
  /** Exact semantic state pointer without materializing a native projection. */
  resolveWorkingState(contextId: string): Promise<VcsStateNodeRef>;
  /** Enumerate durable semantic contexts, optionally restricted by exact prefix. */
  listContexts(prefix?: string): Promise<string[]>;
}

export interface RuntimeServiceDeps {
  /**
   * The single owner of WorkspaceDO entity state. The runtime service never
   * dispatches `entityActivate`/`entityRetire` or touches the cache mirror
   * directly — the store pairs the durable write with the cache update so they
   * can't drift.
   */
  entityStore: WorkspaceEntityStore;
  /** Host-only task closure membership, snapshotted at runtime creation. */
  taskAuthorities: import("./taskAuthorityRegistry.js").TaskAuthorityRegistry;
  /** Resolve host-owned resources before activation, then bind the exact active identity. */
  prepareResourceBindings?: (input: {
    bindings: RuntimeResourceBindingInput[];
    lifecycleCaller: VerifiedCaller;
    initiatingCaller: VerifiedCaller;
  }) => Promise<{
    contextId: string;
    bind(record: EntityRecord): Promise<void>;
  }>;
  releaseResourceBindings?: (record: EntityRecord) => Promise<void>;
  hooks: RuntimeEntityHooks;
  contextBoundary: ContextBoundaryDeps;
  contextFolders: RuntimeContextFolders;
  /** Required semantic-context lifecycle owned by the semantic workspace. */
  semanticContexts: RuntimeSemanticContexts;
  onContextCreated?: (input: {
    contextId: string;
    ownerContextId: string | null;
    /**
     * A resident host-attested policy carried by the verified creator. This is
     * required when a trusted deputy creates a context for a runtime id that
     * has no entity row of its own (for example an EvalDO opening a root
     * panel), so semantic ownership alone cannot recover the creator context.
     */
    inheritedTestPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicy;
    /** A new case policy requested by the system-test orchestrator. */
    casePolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicySpec;
  }) => void | Promise<void>;
  /** Remove host-only policy state after a disposable context is discarded. */
  onContextRemoved?: (input: { contextId: string }) => void | Promise<void>;
  /**
   * Publish the exact transition from a durable preparing panel entity to an
   * executable incarnation. Presentation hosts derive renderer creation from
   * this state transition; a preparing entity is never a connectable panel
   * principal.
   */
  onPanelExecutionActivated?: (
    input: import("@vibestudio/shared/events").EventPayloads["panel:executionActivated"]
  ) => void | Promise<void>;
  /**
   * Server-controlled display-title registry. Workers (and DOs / panels)
   * call `runtime.setTitle(title)` to populate the title that approval UIs
   * surface in place of the opaque entity id.
   */
  setEntityTitle?: (
    entityId: string,
    title: string | undefined,
    options?: { explicit?: boolean }
  ) => void | Promise<void>;
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
  /**
   * Revoke every entity-scoped agent credential + the live agent TokenManager
   * token for a retired entity. Called
   * at the end of `retireEntity` so agent credentials never outlive their
   * entity. Wired in src/server/index.ts to deviceAuthStore + tokenManager.
   */
  revokeAgentCredentials?: (entityId: string) => void | Promise<void>;
  /**
   * Hidden system-test fault seam. The host callback must authenticate the
   * attested system-test harness before aborting this exact active DO facet.
   */
  faultAbortAgentVessel?: (caller: VerifiedCaller, record: EntityRecord) => void | Promise<void>;
  onExecutionRecovery?: (event: {
    entityId: string;
    expectedExecutionDigest: string;
    strategy: RuntimeExecutionRecoveryRequest["strategy"];
    state: "started" | "succeeded" | "failed";
    attemptCount: number;
    result?: RuntimeExecutionRecoveryResult;
    error?: string;
  }) => void;
  unitSupervisor: UnitSupervisor;
}

function describeFailure(cause: unknown): string {
  if (cause instanceof AggregateError) {
    const nested = cause.errors.map(describeFailure).join("; ");
    return nested ? `${cause.message} (${nested})` : cause.message;
  }
  if (cause instanceof Error) {
    const nested = cause.cause === undefined ? "" : ` (${describeFailure(cause.cause)})`;
    return `${cause.message}${nested}`;
  }
  return String(cause);
}

function aggregateFailureMessage(summary: string, failures: unknown[]): string {
  return `${summary}: ${failures.map(describeFailure).join("; ")}`;
}

/**
 * Deterministic context id from an idempotency `targetKey` (§A3 crash-test): a
 * pure function of the key so a re-invoked (crashed) clone/subagent-create
 * resolves to the SAME child context. Formatted as a valid context slug
 * (lowercase alphanumeric + hyphen, ≤63 chars — see ContextFolderManager).
 */
function deriveContextId(targetKey: string): string {
  const h = createHash("sha256").update(targetKey).digest("hex").slice(0, 32);
  return `ctx-${h}`;
}

/**
 * Deterministic entity clone key: a pure function of the idempotency key AND the
 * source entity id (so distinct source entities never collide across a recursive
 * clone tree). `entityActivate` upserts by canonical id, so re-running with the
 * same derived key returns the existing clone.
 */
function deriveEntityKey(srcKey: string, targetKey: string, srcId: string): string {
  const h = createHash("sha256").update(`${targetKey}${srcId}`).digest("hex").slice(0, 12);
  return `${srcKey}~fork~${h}`;
}

export function createRuntimeService(deps: RuntimeServiceDeps): RuntimeServiceResult {
  const store = deps.entityStore;
  const creationChains = new Map<string, Promise<unknown>>();
  const activationChains = new Map<string, Promise<RuntimeEntityHandle>>();
  const retirementChains = new Map<string, Promise<unknown>>();
  const recoveryChains = new Map<string, Promise<RuntimeExecutionRecoveryResult>>();
  let recoveryAttemptCount = 0;

  function inheritTaskAuthority(
    runtimeId: string,
    actors: RuntimeCreationActors
  ): import("@vibestudio/rpc").TaskGrantPrincipal | null {
    return (
      deps.taskAuthorities.inheritRuntime(runtimeId, actors.lifecycleCaller, store.cache) ??
      deps.taskAuthorities.inheritRuntime(runtimeId, actors.initiatingCaller, store.cache)
    );
  }

  function isTrustedRuntimeHost(caller: VerifiedCaller): boolean {
    return caller.runtime.kind === "shell" || caller.runtime.kind === "server";
  }

  function requireTrustedRuntimeHost(caller: VerifiedCaller, method: string): void {
    if (isTrustedRuntimeHost(caller)) return;
    throw new Error(`runtime.${method} is restricted to trusted host callers`);
  }

  function callerOwnsEntity(caller: VerifiedCaller, entity: EntityRecord): boolean {
    return caller.runtime.id === entity.id || entity.parentId === caller.runtime.id;
  }

  function bindingFromSpec(spec: RuntimeEntityCreateSpec): RuntimeAgentBindingInput | undefined {
    return spec.kind === "do" || spec.kind === "worker" ? spec.agentBinding : undefined;
  }

  function selfAgentChannelFromSpec(spec: RuntimeEntityCreateSpec): string | undefined {
    return spec.kind === "do" || spec.kind === "worker" || spec.kind === "session"
      ? spec.agentChannelId
      : undefined;
  }

  function applyTestAgentPolicy(
    caller: VerifiedCaller,
    spec: RuntimeEntityCreateSpec
  ): RuntimeEntityCreateSpec {
    const agentPolicy =
      caller.testPolicy?.kind === "case" ? caller.testPolicy.case.agent : undefined;
    if (!agentPolicy || !selfAgentChannelFromSpec(spec) || spec.kind === "session") return spec;

    const stateArgs =
      spec.stateArgs && typeof spec.stateArgs === "object" && !Array.isArray(spec.stateArgs)
        ? { ...(spec.stateArgs as Record<string, unknown>) }
        : {};
    const currentConfig =
      stateArgs["agentConfig"] &&
      typeof stateArgs["agentConfig"] === "object" &&
      !Array.isArray(stateArgs["agentConfig"])
        ? { ...(stateArgs["agentConfig"] as Record<string, unknown>) }
        : {};
    delete currentConfig["fallbackModel"];
    delete currentConfig["fallbackThinkingLevel"];
    delete currentConfig["fallbackOn"];
    delete currentConfig["fallbackScope"];
    const requestedChildModel =
      caller.runtime.kind === "do" && typeof currentConfig["model"] === "string"
        ? currentConfig["model"]
        : agentPolicy.model;
    stateArgs["agentConfig"] = {
      ...currentConfig,
      model: requestedChildModel,
      approvalLevel: agentPolicy.approvalLevel,
      ...(agentPolicy.fallback === "disabled"
        ? {}
        : {
            fallbackModel: agentPolicy.fallback.model,
            fallbackThinkingLevel: agentPolicy.fallback.thinkingLevel,
            fallbackOn: [...agentPolicy.fallback.on],
            fallbackScope: agentPolicy.fallback.scope,
          }),
    };
    return { ...spec, stateArgs };
  }

  function isExtensionOrchestratedCreate(
    caller: VerifiedCaller,
    spec: RuntimeEntityCreateSpec
  ): boolean {
    if (caller.runtime.kind !== "extension") return false;
    return spec.kind === "session" || bindingFromSpec(spec) !== undefined;
  }

  async function resolveAgentBinding(
    caller: VerifiedCaller,
    method: string,
    requestedContextId: string | undefined,
    binding: RuntimeAgentBindingInput | undefined
  ): Promise<RuntimeAgentBinding | undefined> {
    if (!binding) return undefined;
    if (
      caller.runtime.kind !== "shell" &&
      caller.runtime.kind !== "server" &&
      caller.runtime.kind !== "extension"
    ) {
      throw new Error(
        `runtime.${method} agentBinding is restricted to host callers and extensions`
      );
    }
    const bound = await store.resolveRecord(binding.entityId);
    if (!bound || bound.status !== "active") {
      throw new Error(
        `runtime.createEntity agentBinding references an inactive entity: ${binding.entityId}`
      );
    }
    if (requestedContextId !== undefined && bound.contextId !== requestedContextId) {
      throw new Error("runtime.createEntity agentBinding context does not match the bound entity");
    }
    if (!isTrustedRuntimeHost(caller) && !callerOwnsEntity(caller, bound)) {
      throw new Error(`runtime.createEntity caller does not own bound entity ${binding.entityId}`);
    }
    return {
      entityId: bound.id,
      contextId: bound.contextId,
      channelId: binding.channelId,
    };
  }

  async function callerOwnsLifecycleContext(
    caller: VerifiedCaller,
    originContextId: string | null,
    targetContextId: string
  ): Promise<boolean> {
    return callerControlsContextTransition(
      store,
      caller.runtime.id,
      originContextId,
      targetContextId
    );
  }

  /** Resolve one current host-derived context leaf without prompting or mutating. */
  async function prepareContextBoundary(
    caller: VerifiedCaller,
    targetContextId: string,
    action: ContextBoundaryAction,
    originContextIdOverride?: string | null
  ): Promise<PreparedAuthoritySelection[]> {
    // Panel-tree bridge calls retain the initiating entity id for durable
    // lineage while using the server caller kind. They are already gated at
    // the panel-tree boundary and retain trusted-host authority here.
    if (
      caller.runtime.kind === "server" ||
      isAuthorizedChrome(caller, { hasAppCapability: deps.hasAppCapability })
    ) {
      return [];
    }
    const originContextId =
      originContextIdOverride === undefined
        ? await store.resolveContext(caller.runtime.id)
        : originContextIdOverride;
    if (await callerOwnsLifecycleContext(caller, originContextId, targetContextId)) return [];
    const selection = prepareContextBoundarySelection(deps.contextBoundary, {
      subjectCaller: caller,
      originContextId,
      targetContextId,
      action,
    });
    return selection ? [selection] : [];
  }

  async function resolveTargetContext(
    caller: VerifiedCaller,
    requested: string | null | undefined,
    agentBinding: RuntimeAgentBinding | undefined
  ): Promise<string> {
    if (requested != null && requested !== "") return requested;
    // An external agent relay belongs to the bound entity's verified context;
    // the caller never has to repeat that authority-bearing coordinate.
    if (agentBinding) return agentBinding.contextId;
    // Child runtimes inherit their verified caller's semantic workspace. This
    // is what makes context-local authored code immediately launchable through
    // workers.create()/runtime.createEntity without a second, forgeable context
    // argument. Root host callers have no runtime context and therefore mint an
    // isolated root, preserving the explicit session/bootstrap use case.
    return (await store.resolveContext(caller.runtime.id)) ?? randomUUID();
  }

  /** Ensure one durable semantic workspace context before attaching an entity. */
  async function setUpContext(contextId: string): Promise<WorkspaceContext> {
    await deps.semanticContexts.ensureContext(contextId);
    return buildWorkspaceContext(contextId);
  }

  function assertCreateEntityAllowed(caller: VerifiedCaller, spec: RuntimeEntityCreateSpec): void {
    if (spec.kind === "app" && !isTrustedRuntimeHost(caller)) {
      throw new Error("App runtime entities are host-managed");
    }
    if (spec.kind === "session") {
      const orchestratorExtension = caller.runtime.kind === "extension" && Boolean(spec.source);
      if (!isTrustedRuntimeHost(caller) && !orchestratorExtension) {
        throw new Error("Session runtime entities are host-managed");
      }
    }
    if (bindingFromSpec(spec) && selfAgentChannelFromSpec(spec)) {
      throw new Error(
        "runtime.createEntity cannot combine an external agent relay binding with a self-agent channel"
      );
    }
  }

  async function createEntity(
    actors: RuntimeCreationActors,
    rawSpec: RuntimeEntityCreateSpec
  ): Promise<RuntimeEntityHandle> {
    const caller = actors.lifecycleCaller;
    const spec = applyTestAgentPolicy(caller, rawSpec);
    assertCreateEntityAllowed(caller, spec);
    const canonicalId = spec.key
      ? canonicalEntityId({
          kind: spec.kind,
          source: runtimeEntitySource(spec),
          className: spec.kind === "do" ? spec.className : undefined,
          key: spec.key,
        })
      : null;
    const create = async (): Promise<RuntimeEntityHandle> => {
      const preparedResourceBindings = spec.resourceBindings?.length
        ? await deps.prepareResourceBindings?.({
            bindings: spec.resourceBindings,
            lifecycleCaller: actors.lifecycleCaller,
            initiatingCaller: actors.initiatingCaller,
          })
        : undefined;
      if (spec.resourceBindings?.length && !preparedResourceBindings) {
        throw new Error("Runtime resource bindings are unavailable");
      }
      const requestedContextId =
        spec.contextId == null || spec.contextId === "" ? undefined : spec.contextId;
      const agentBinding = await resolveAgentBinding(
        caller,
        "createEntity",
        requestedContextId,
        bindingFromSpec(spec)
      );
      if (
        preparedResourceBindings &&
        requestedContextId !== undefined &&
        requestedContextId !== preparedResourceBindings.contextId
      ) {
        throw new Error("Runtime resource context does not match the requested context");
      }
      if (
        preparedResourceBindings &&
        agentBinding &&
        agentBinding.contextId !== preparedResourceBindings.contextId
      ) {
        throw new Error("Runtime resource context does not match the agent binding context");
      }
      const contextId =
        preparedResourceBindings?.contextId ??
        (await resolveTargetContext(caller, spec.contextId, agentBinding));
      const handle = await activateEntity(
        actors,
        spec,
        contextId,
        agentBinding,
        selfAgentChannelFromSpec(spec)
      );
      if (preparedResourceBindings) {
        const record = await store.resolveRecord(handle.id);
        if (!record || record.status !== "active") {
          throw new Error(`Runtime resource binding target is not active: ${handle.id}`);
        }
        try {
          await preparedResourceBindings.bind(record);
        } catch (error) {
          await retireEntity(record.id, false).catch(() => undefined);
          throw error;
        }
      }
      return handle;
    };
    return canonicalId ? serializeByKey(creationChains, canonicalId, create) : create();
  }

  async function releaseResourceBindings(caller: VerifiedCaller, id: string): Promise<void> {
    const record = await store.resolveRecord(id);
    if (!record || record.status !== "active") return;
    if (!isTrustedRuntimeHost(caller) && !callerOwnsEntity(caller, record)) {
      throw new Error(`runtime.releaseResourceBindings caller does not own ${id}`);
    }
    if (!deps.releaseResourceBindings) {
      throw new Error("Runtime resource bindings are unavailable");
    }
    await deps.releaseResourceBindings(record);
  }

  async function replaceResourceBindings(
    actors: RuntimeCreationActors,
    input: { id: string; bindings: RuntimeResourceBindingInput[] }
  ): Promise<void> {
    const record = await store.resolveActiveRecord(input.id);
    if (!record) {
      throw new Error(`runtime.replaceResourceBindings target is not active: ${input.id}`);
    }
    if (
      !isTrustedRuntimeHost(actors.lifecycleCaller) &&
      !callerOwnsEntity(actors.lifecycleCaller, record)
    ) {
      throw new Error(`runtime.replaceResourceBindings caller does not own ${input.id}`);
    }
    const prepared = await deps.prepareResourceBindings?.({
      bindings: input.bindings,
      lifecycleCaller: actors.lifecycleCaller,
      initiatingCaller: actors.initiatingCaller,
    });
    if (!prepared) throw new Error("Runtime resource bindings are unavailable");
    if (prepared.contextId !== record.contextId) {
      throw new Error("Runtime resource context does not match the target entity context");
    }
    await prepared.bind(record);
  }

  async function rebindAgentChannel(
    caller: VerifiedCaller,
    input: { entityId: string; channelId: string }
  ): Promise<void> {
    const record = await store.resolveActiveRecord(input.entityId);
    if (!record) {
      throw new Error(`runtime.rebindAgentChannel target is not active: ${input.entityId}`);
    }
    if (!isTrustedRuntimeHost(caller) && !callerOwnsEntity(caller, record)) {
      throw new Error(`runtime.rebindAgentChannel caller does not own ${input.entityId}`);
    }
    await store.rebindAgentChannel(record.id, input.channelId);
  }

  const entityHandle = (record: EntityRecord, targetId = record.id): RuntimeEntityHandle => ({
    id: record.id,
    kind: record.kind as RuntimeEntityHandle["kind"],
    source: record.source,
    ...(record.activeBuildKey ? { buildKey: record.activeBuildKey } : {}),
    ...(record.activeExecutionDigest ? { executionDigest: record.activeExecutionDigest } : {}),
    ...(record.activeAuthority
      ? {
          authorityRequests: record.activeAuthority.requests,
        }
      : {}),
    contextId: record.contextId,
    targetId,
  });

  /**
   * Commit only a code-backed entity's durable coordinates. A preparing record
   * is not an executable principal.
   */
  async function reserveEntity(
    actors: RuntimeCreationActors,
    spec: RuntimeCodeEntityCreateSpec
  ): Promise<RuntimeEntityHandle> {
    const caller = actors.lifecycleCaller;
    assertCreateEntityAllowed(caller, spec);
    const key = spec.key ?? randomUUID();
    const canonicalId = canonicalEntityId({
      kind: spec.kind,
      source: spec.execution.source,
      className: spec.kind === "do" ? spec.className : undefined,
      key,
    });
    // Reservations with a stable key are idempotent-by-identity; serialize them
    // so the created-vs-existing report below cannot race a concurrent retry.
    return serializeByKey(creationChains, canonicalId, () =>
      reserveEntityOnce(actors, spec, key, canonicalId)
    ) as Promise<RuntimeEntityHandle>;
  }

  async function reserveEntityOnce(
    actors: RuntimeCreationActors,
    spec: RuntimeCodeEntityCreateSpec,
    key: string,
    canonicalId: string
  ): Promise<RuntimeEntityHandle> {
    const caller = actors.lifecycleCaller;
    const explicitContextId = spec.contextId;
    const requestedContextId =
      explicitContextId == null || explicitContextId === "" ? undefined : explicitContextId;
    // Identity check before the durable upsert: an existing reservation is
    // resumable only when the full logical identity matches. A mismatched
    // reuse of the same key (different source or context) is a typed
    // collision, never a silent merge onto someone else's live entity.
    const preexisting = await store.resolveRecord(canonicalId);
    if (preexisting && preexisting.status !== "retired") {
      if (preexisting.source.repoPath !== spec.execution.source) {
        throw new IdentityCollisionError(canonicalId, {
          field: "source.repoPath",
          existing: preexisting.source.repoPath,
          attempted: spec.execution.source,
        });
      }
      if (requestedContextId !== undefined && preexisting.contextId !== requestedContextId) {
        throw new IdentityCollisionError(canonicalId, {
          field: "contextId",
          existing: preexisting.contextId,
          attempted: requestedContextId,
        });
      }
      if (!isTrustedRuntimeHost(caller) && !callerOwnsEntity(caller, preexisting)) {
        throw new Error(`runtime.reserveEntity caller does not own reservation ${canonicalId}`);
      }
      // A stable operation may be resumed after its reserved entity has already
      // activated. Its durable coordinates are the reservation result; do not
      // feed the deliberately unresolved reservation source (effectiveVersion
      // "") back through the store after activation sealed that field.
      if (preexisting.status === "active") {
        return { ...entityHandle(preexisting), created: false };
      }
    }
    const created = !preexisting || preexisting.status === "retired";
    const externalAgentBinding = await resolveAgentBinding(
      caller,
      "reserveEntity",
      requestedContextId,
      bindingFromSpec(spec)
    );
    const contextId =
      externalAgentBinding?.contextId ??
      requestedContextId ??
      deriveContextId(`entity-reservation:${canonicalId}`);
    const hasExplicitContext = explicitContextId != null && explicitContextId !== "";
    const contextOwner = actors.initiatingCaller;
    const ownerContextId = hasExplicitContext
      ? null
      : await store.resolveContext(contextOwner.runtime.id);
    const selfAgentChannelId = selfAgentChannelFromSpec(spec);
    const agentBinding = selfAgentChannelId
      ? { entityId: canonicalId, contextId, channelId: selfAgentChannelId }
      : externalAgentBinding;
    const record = await store.reserve({
      kind: spec.kind,
      source: { repoPath: spec.execution.source, effectiveVersion: "" },
      contextId,
      className: spec.kind === "do" ? spec.className : undefined,
      key,
      stateArgs: "stateArgs" in spec ? spec.stateArgs : undefined,
      agentBinding,
      parentId: caller.runtime.id,
      ownerUserId: contextOwner.subject?.userId,
      ...(ownerContextId && ownerContextId !== contextId
        ? {
            lifecycleOwner: {
              contextId: ownerContextId,
              entityId: contextOwner.runtime.id,
            },
          }
        : {}),
    });
    inheritTaskAuthority(record.id, actors);
    // An implicit reservation is the semantic creation boundary for its
    // derived lifecycle context. Register it immediately, before activation
    // can boot panel code that creates descendants. Deferring this until the
    // executable incarnation is active leaves a race where child agents lose
    // their host-resident system-test policy and fall back to workspace model
    // defaults. The hook is intentionally idempotent: retrying the same stable
    // reservation must reassert the same parentage.
    if (!hasExplicitContext) {
      await deps.onContextCreated?.({
        contextId,
        ownerContextId: ownerContextId ?? null,
        ...(contextOwner.testPolicy ? { inheritedTestPolicy: contextOwner.testPolicy } : {}),
      });
    }
    return { ...entityHandle(record), created };
  }

  /**
   * Complete one reserved code-backed incarnation in place.
   */
  async function activateReservedEntityOnce(
    caller: VerifiedCaller | null,
    spec: RuntimeCodeEntityCreateSpec
  ): Promise<RuntimeEntityHandle> {
    if (!spec.key) {
      throw new Error("activateReservedEntity requires the reserved entity key");
    }
    const canonicalId = canonicalEntityId({
      kind: spec.kind,
      source: spec.execution.source,
      className: spec.kind === "do" ? spec.className : undefined,
      key: spec.key,
    });
    const existing = await store.resolveCurrentRecord(canonicalId);
    if (!existing || existing.kind !== spec.kind) {
      throw new Error(`Unknown reserved entity ${canonicalId}`);
    }
    if (caller && !isTrustedRuntimeHost(caller) && !callerOwnsEntity(caller, existing)) {
      throw new Error(`runtime.activateReservedEntity caller does not own ${canonicalId}`);
    }
    // A reused reservation key with a different context is a different logical
    // operation — reject it as a typed collision before any ownership logic.
    if (spec.contextId != null && spec.contextId !== "" && existing.contextId !== spec.contextId) {
      throw new IdentityCollisionError(canonicalId, {
        field: "contextId",
        existing: existing.contextId,
        attempted: spec.contextId,
      });
    }
    if (existing.source.repoPath !== spec.execution.source) {
      throw new Error(
        `Reserved entity ${canonicalId} belongs to ${existing.source.repoPath}, not ${spec.execution.source}`
      );
    }
    if (spec.kind === "do" && existing.className !== spec.className) {
      throw new Error(
        `Reserved entity ${canonicalId} belongs to class ${existing.className}, not ${spec.className}`
      );
    }
    if (existing.status === "active") {
      // A successful activation may lose its response. Retrying the same
      // reservation is therefore a read of the committed result, never a new
      // preparation driven by mutable request fields such as ref, env, or
      // stateArgs.
      return entityHandle(existing);
    }
    if (existing.status !== "preparing") {
      throw new Error(`Reserved entity ${canonicalId} is ${existing.status}`);
    }

    const [prepared] = await Promise.all([
      deps.hooks.prepare({
        spec,
        key: spec.key,
        contextId: existing.contextId,
      }),
      setUpContext(existing.contextId),
    ]);
    if (prepared.surface !== "code") {
      throw new Error(`Reserved entity ${canonicalId} did not prepare a code incarnation`);
    }
    if (!/^[0-9a-f]{64}$/.test(prepared.buildKey)) {
      throw new Error(
        `${spec.kind} ${canonicalId} preparation did not select an immutable BuildV2 artifact`
      );
    }
    if (!/^[0-9a-f]{64}$/.test(prepared.executionDigest)) {
      throw new Error(`${spec.kind} ${canonicalId} is missing a canonical execution digest`);
    }
    const activeAuthority = parseUnitAuthorityManifest(
      prepared.authority,
      `${spec.kind} ${canonicalId} authority`
    );
    const record = await store.advanceExecution({
      kind: spec.kind,
      source: { repoPath: spec.execution.source, effectiveVersion: prepared.effectiveVersion },
      activeBuildKey: prepared.buildKey,
      activeExecutionDigest: prepared.executionDigest,
      activeAuthority,
      contextId: existing.contextId,
      className: existing.className,
      key: existing.key,
      stateArgs: existing.stateArgs,
      agentBinding: existing.agentBinding,
      parentId: existing.parentId,
      ownerUserId: existing.ownerUserId,
    });
    if (
      record.kind === "panel" &&
      record.activeBuildKey &&
      record.activeExecutionDigest &&
      record.activeAuthority
    ) {
      const panelId = await store.resolveSlotByEntity(record.id);
      if (panelId) {
        await deps.onPanelExecutionActivated?.({
          panelId,
          runtimeEntityId: record.id,
          effectiveVersion: record.source.effectiveVersion,
          buildKey: record.activeBuildKey,
          executionDigest: record.activeExecutionDigest,
          authorityRequests: record.activeAuthority.requests,
        });
      }
    }
    if (record.kind === "do") await deps.hooks.onDurableObjectActivated?.(record);
    return entityHandle(record, prepared.target.id);
  }

  async function activateReservedEntity(
    caller: VerifiedCaller | null,
    spec: RuntimeCodeEntityCreateSpec
  ): Promise<RuntimeEntityHandle> {
    if (!spec.key) {
      return Promise.reject(new Error("activateReservedEntity requires the reserved entity key"));
    }
    const canonicalId = canonicalEntityId({
      kind: spec.kind,
      source: spec.execution.source,
      className: spec.kind === "do" ? spec.className : undefined,
      key: spec.key,
    });

    // Authorization is caller-specific, whereas activation is shared work.
    // Check every caller before allowing it to observe an existing activation
    // promise; otherwise a caller that knows the reservation id can join the
    // owner's in-flight activation without ever passing the ownership gate in
    // activateReservedEntityOnce.
    const reserved = await store.resolveCurrentRecord(canonicalId);
    if (!reserved || reserved.kind !== spec.kind) {
      throw new Error(`Unknown reserved entity ${canonicalId}`);
    }
    if (caller && !isTrustedRuntimeHost(caller) && !callerOwnsEntity(caller, reserved)) {
      throw new Error(`runtime.activateReservedEntity caller does not own ${canonicalId}`);
    }
    const existing = activationChains.get(canonicalId);
    if (existing) return existing;
    const activation = activateReservedEntityOnce(caller, spec).finally(() => {
      if (activationChains.get(canonicalId) === activation) activationChains.delete(canonicalId);
    });
    activationChains.set(canonicalId, activation);
    return activation;
  }

  /**
   * Prepare runtime resources for an entity and commit its durable row — WITHOUT
   * context-boundary resolution. `createEntity` calls this after dispatcher enforcement;
   * `cloneContext` calls it per clone after one prepared source-context leaf. `parentId` is the
   * caller, so a cloneContext caller owns (and may freely destroy) the clones.
   */
  async function activateEntity(
    actors: RuntimeCreationActors,
    spec: RuntimeEntityCreateSpec,
    initialContextId: string,
    externalAgentBinding?: RuntimeAgentBinding,
    selfAgentChannelId?: string
  ): Promise<RuntimeEntityHandle> {
    const caller = actors.lifecycleCaller;
    let contextId = initialContextId;
    const key = spec.key ?? randomUUID();
    const source = runtimeEntitySource(spec);
    const canonicalId = canonicalEntityId({
      kind: spec.kind,
      source,
      className: spec.kind === "do" ? spec.className : undefined,
      key,
    });
    // Runtime preparation may activate the canonical entity through a trusted
    // server supervisor before this caller resumes. Snapshot the authenticated
    // task now, at the creation boundary, so that asynchronous activation
    // cannot replace the initiating task with the server principal.
    inheritTaskAuthority(canonicalId, actors);
    if (spec.execution.surface === "external" && !isOpenPanelBrowserUrl(spec.execution.url)) {
      throw new Error(`Invalid external browser panel URL: ${spec.execution.url}`);
    }
    const existing = await store.resolveRecord(canonicalId);

    // Entity identity columns are write-once, so re-attaching an inert session
    // without an explicit context must reuse its original context coordinate.
    if (spec.kind === "session" && (spec.contextId == null || spec.contextId === "") && existing) {
      contextId = existing.contextId;
    }

    const parentKind = caller.runtime.kind;
    const prepared = (await deps.hooks.prepare({
      spec,
      key,
      contextId,
      ...(existing?.activeBuildKey ? { existingBuildKey: existing.activeBuildKey } : {}),
      parent: {
        parentId: caller.runtime.id,
        parentEntityId: caller.runtime.id,
        parentKind:
          parentKind === "panel" || parentKind === "worker" || parentKind === "do"
            ? parentKind
            : undefined,
      },
    })) as PreparedIncarnation;
    if (prepared.surface !== spec.execution.surface) {
      throw new Error(
        `Runtime preparation surface mismatch for ${canonicalId}: requested ${spec.execution.surface}, prepared ${prepared.surface}`
      );
    }

    let effectiveVersion = existing?.status === "retired" ? existing.source.effectiveVersion : "";
    let buildKey: string | undefined;
    let executionDigest: string | undefined;
    let activeAuthority: UnitAuthorityManifest | undefined;
    if (prepared.surface === "code") {
      if (!/^[0-9a-f]{64}$/.test(prepared.buildKey)) {
        throw new Error(`${spec.kind} ${canonicalId} did not select an immutable BuildV2 artifact`);
      }
      if (!/^[0-9a-f]{64}$/.test(prepared.executionDigest)) {
        throw new Error(`${spec.kind} ${canonicalId} is missing a canonical execution digest`);
      }
      if (existing?.status !== "retired") effectiveVersion = prepared.effectiveVersion;
      buildKey = prepared.buildKey;
      executionDigest = prepared.executionDigest;
      activeAuthority = parseUnitAuthorityManifest(
        prepared.authority,
        `${spec.kind} ${canonicalId} authority`
      );
    } else if (prepared.surface === "external") {
      if (spec.execution.surface !== "external") {
        throw new Error(`External preparation did not match ${canonicalId}'s execution surface`);
      }
      if (prepared.document.requestedUrl !== spec.execution.url) {
        throw new Error(`External preparation changed the requested document for ${canonicalId}`);
      }
    }
    const targetId = prepared.target.id;

    // A context is a GAD-owned semantic workspace frontier shared by every
    // runtime entity attached to the same context id.
    await setUpContext(contextId);

    const agentBinding = selfAgentChannelId
      ? {
          entityId: canonicalId,
          contextId,
          channelId: selfAgentChannelId,
        }
      : externalAgentBinding;
    const activateInput = {
      kind: spec.kind,
      source: { repoPath: source, effectiveVersion },
      activeBuildKey: buildKey,
      activeExecutionDigest: executionDigest,
      activeAuthority,
      contextId,
      className: spec.kind === "do" ? spec.className : undefined,
      key,
      stateArgs:
        spec.kind === "session"
          ? spec.title !== undefined
            ? { title: spec.title }
            : undefined
          : "stateArgs" in spec
            ? spec.stateArgs
            : undefined,
      agentBinding,
      // Record the verified caller as this entity's launch parent (server-
      // authoritative) so a runtime can later resolve its nearest panel ancestor
      // (e.g. eval launched by an agent inherits the agent's owning panel).
      parentId: caller.runtime.id,
      // Attribute the entity to the human whose subject launched it (WP0 §6).
      // For an agent/worker spawning a child, the caller's subject already
      // carries the inherited userId, so lineage propagates. Undefined for a
      // bootstrap caller with no subject.
      ownerUserId: actors.initiatingCaller.subject?.userId,
    };
    const record = await store.activate(activateInput);
    inheritTaskAuthority(record.id, actors);
    if (record.kind === "do") {
      await deps.hooks.onDurableObjectActivated?.(record);
    }
    if (spec.kind === "session" && spec.title) {
      await deps.setEntityTitle?.(record.id, spec.title, { explicit: true });
    }

    return {
      id: record.id,
      kind: spec.kind,
      source: record.source,
      ...(record.activeBuildKey ? { buildKey: record.activeBuildKey } : {}),
      ...(record.activeExecutionDigest ? { executionDigest: record.activeExecutionDigest } : {}),
      ...(record.activeAuthority
        ? {
            authorityRequests: record.activeAuthority.requests,
          }
        : {}),
      contextId: record.contextId,
      targetId,
    };
  }

  /**
   * Establish a semantic workspace context without attaching an entity yet.
   * Useful when an orchestrator wants several entities to share one working
   * frontier and provenance timeline.
   */
  async function createContext(
    ctx: Pick<ServiceContext, "caller" | "chainCaller">,
    args: {
      contextId?: string;
      testPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicySpec;
    }
  ): Promise<WorkspaceContext> {
    const caller = ctx.caller;
    const delegatedOwnerContextId =
      caller.runtime.kind === "extension" && ctx.chainCaller
        ? await store.resolveContext(ctx.chainCaller.callerId)
        : undefined;
    const contextId = args.contextId ?? randomUUID();
    const context = await setUpContext(contextId);
    // An extension call is delegated work: the upstream verified code context
    // and entity own any lifecycle context created for that request. The
    // extension is the executing deputy, not the authority principal that may
    // later review or mutate the retained child. Without this exact upstream
    // ownership, the context is visible beneath the initiator while VCS
    // correctly refuses the initiator's writes because the lifecycle edge
    // names an unrelated owner entity.
    const ownerContextId =
      delegatedOwnerContextId === undefined
        ? await store.resolveContext(caller.runtime.id)
        : delegatedOwnerContextId;
    if (ownerContextId && ownerContextId !== contextId) {
      await store.recordContextEdge({
        contextId,
        ownerContextId,
        kind: "lifecycle",
        ownerEntityId:
          delegatedOwnerContextId === undefined ? caller.runtime.id : ctx.chainCaller!.callerId,
      });
    }
    await deps.onContextCreated?.({
      contextId,
      ownerContextId: ownerContextId ?? null,
      ...(caller.testPolicy ? { inheritedTestPolicy: caller.testPolicy } : {}),
      ...(args.testPolicy ? { casePolicy: args.testPolicy } : {}),
    });
    return context;
  }

  /**
   * Durable retire + cleanup hooks for ONE entity, WITHOUT the context-boundary
   * boundary resolution. `retireEntity` calls this after dispatcher enforcement;
   * `cloneContext` rollback and `destroyContext` call it directly after their whole-context leaf.
   */
  async function retireRecord(id: string): Promise<EntityRecord | null> {
    return serializeByKey(retirementChains, id, async () => {
      const current = await store.resolveRecord(id);
      if (!current || current.status === "retired") return null;
      await prepareRecordForRetirement(current);

      let record: EntityRecord | null;
      try {
        await deps.hooks.sealAndDrainEntityRelays?.(id);
        record = await store.retire(id);
      } finally {
        // On success, the cache is already inactive before the seal is
        // released. On failure, the durable row remains active and relays must
        // be admitted again so retirement can be retried.
        deps.hooks.releaseEntityRelaySeal?.(id);
      }
      if (!record) return null;
      try {
        await deps.hooks.onRetire(record);
        await store.cleanupComplete(id);
      } catch (cause) {
        // The durable row intentionally remains cleanup_complete=0 so the
        // cleanup reaper can retry, but the initiating operation must retain
        // the failure instead of reporting a false success.
        throw new Error(`Runtime entity cleanup failed for ${id}: ${describeFailure(cause)}`, {
          cause,
        });
      }
      return record;
    });
  }

  async function prepareRecordForRetirement(record: EntityRecord): Promise<void> {
    if (record.status !== "active") return;
    const released = await deps.hooks.releaseEntity(record, {
      epoch: `retire:${randomUUID()}`,
      mode: "retire",
      reason: "entity_retire",
      deadlineMs: 0,
    });
    if (released.status === "failed") {
      throw new Error(`Entity ${record.id} refused terminal lifecycle release`);
    }
  }

  function withRetirementLocks<T>(ids: string[], operation: () => Promise<T>): Promise<T> {
    const ordered = [...new Set(ids)].sort();
    const acquire = (index: number): Promise<T> =>
      index >= ordered.length
        ? operation()
        : serializeByKey(retirementChains, ordered[index]!, () => acquire(index + 1));
    return acquire(0);
  }

  /**
   * Retire a mutually-dependent context as one lifecycle unit. Every entity
   * first releases its peer-facing resources while all peers remain reachable;
   * only then are relays sealed and durable rows retired. This is what lets an
   * agent leave its channel during context teardown without service resolution
   * racing a channel that was retired earlier in list order.
   */
  async function retireContextRecords(
    records: EntityRecord[]
  ): Promise<{ retired: EntityRecord[]; cleanupFailures: unknown[] }> {
    return withRetirementLocks(
      records.map((record) => record.id),
      async () => {
        const current = (
          await Promise.all(records.map((record) => store.resolveRecord(record.id)))
        ).filter((record): record is EntityRecord =>
          Boolean(record && record.status !== "retired")
        );
        for (const record of current) await prepareRecordForRetirement(record);

        const sealed: string[] = [];
        const retired: EntityRecord[] = [];
        try {
          for (const record of current) {
            await deps.hooks.sealAndDrainEntityRelays?.(record.id);
            sealed.push(record.id);
          }
          for (const record of current) {
            const result = await store.retire(record.id);
            if (result) retired.push(result);
          }
        } finally {
          for (const id of sealed.reverse()) deps.hooks.releaseEntityRelaySeal?.(id);
        }

        const cleanupFailures: unknown[] = [];
        for (const record of retired) {
          try {
            await deps.hooks.onRetire(record);
            await store.cleanupComplete(record.id);
            await deps.revokeAgentCredentials?.(record.id);
          } catch (cause) {
            cleanupFailures.push(
              new Error(
                `Runtime entity cleanup failed for ${record.id}: ${describeFailure(cause)}`,
                { cause }
              )
            );
          }
        }
        return { retired, cleanupFailures };
      }
    );
  }

  async function retireEntity(id: string, removeContext?: boolean): Promise<void> {
    const record = await retireRecord(id);
    if (!record) return;
    // Agent credentials follow the entity: revoke outstanding credentials + the
    // live agent token so a retired entity's bound agent sessions can't
    // re-authenticate (§3.2).
    await deps.revokeAgentCredentials?.(id);
    if (removeContext) {
      const live = await store.listActive();
      if (!live.some((e) => e.contextId === record.contextId)) {
        await deps.semanticContexts.dropContext(record.contextId);
        await deps.contextFolders.removeContext(record.contextId);
      }
    }
  }

  async function recoverExecution(
    caller: VerifiedCaller,
    input: RuntimeExecutionRecoveryRequest
  ): Promise<RuntimeExecutionRecoveryResult> {
    if (!isInteractiveChrome(caller, { hasAppCapability: deps.hasAppCapability })) {
      throw new Error("runtime.recoverExecution is restricted to interactive trusted chrome");
    }
    const previous = recoveryChains.get(input.entityId);
    const run = () => {
      const attemptCount = ++recoveryAttemptCount;
      deps.onExecutionRecovery?.({
        entityId: input.entityId,
        expectedExecutionDigest: input.expectedExecutionDigest,
        strategy: input.strategy,
        state: "started",
        attemptCount,
      });
      return recoverExecutionOnce(input)
        .then((result) => {
          deps.onExecutionRecovery?.({
            entityId: input.entityId,
            expectedExecutionDigest: input.expectedExecutionDigest,
            strategy: input.strategy,
            state: "succeeded",
            attemptCount,
            result,
          });
          return result;
        })
        .catch((error) => {
          deps.onExecutionRecovery?.({
            entityId: input.entityId,
            expectedExecutionDigest: input.expectedExecutionDigest,
            strategy: input.strategy,
            state: "failed",
            attemptCount,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        });
    };
    // Recovery requests for one entity are ordered, not coalesced. Each request
    // must re-read the active identity after its predecessor settles so its own
    // expected digest and strategy retain their meaning.
    const recovery = (previous ? previous.catch(() => undefined).then(run) : run()).finally(() => {
      if (recoveryChains.get(input.entityId) === recovery) recoveryChains.delete(input.entityId);
    });
    recoveryChains.set(input.entityId, recovery);
    return recovery;
  }

  async function recoverExecutionOnce(
    input: RuntimeExecutionRecoveryRequest
  ): Promise<RuntimeExecutionRecoveryResult> {
    const record = await store.resolveActiveRecord(input.entityId);
    if (!record || record.kind !== "do" || !record.className) {
      throw new Error(`Durable Object execution is not active: ${input.entityId}`);
    }
    if (!record.activeBuildKey || !record.activeExecutionDigest || !record.activeAuthority) {
      throw new Error(`Durable Object ${record.id} has no sealed active execution identity`);
    }
    if (record.activeExecutionDigest !== input.expectedExecutionDigest) {
      throw new Error(
        `Durable Object ${record.id} advanced from execution ${input.expectedExecutionDigest} ` +
          `to ${record.activeExecutionDigest}; recovery action is stale`
      );
    }
    const previousExecutionDigest = record.activeExecutionDigest;

    if (input.strategy === "restore-exact") {
      await deps.hooks.recoverExactExecution(record);
      await deps.hooks.restartDurableObjectIncarnation(record);
      return {
        entityId: record.id,
        strategy: input.strategy,
        previousExecutionDigest,
        buildKey: record.activeBuildKey,
        executionDigest: record.activeExecutionDigest,
      };
    }

    const spec: Extract<RuntimeEntityCreateSpec, { kind: "do" }> = {
      kind: "do",
      execution: {
        surface: "code",
        source: record.source.repoPath,
        ref: `ctx:${record.contextId}`,
      },
      className: record.className,
      key: record.key,
      contextId: record.contextId,
      stateArgs: record.stateArgs,
      ...(record.agentBinding
        ? {
            agentBinding: {
              entityId: record.agentBinding.entityId,
              channelId: record.agentBinding.channelId,
            },
          }
        : {}),
    };
    const prepared = await deps.hooks.prepare({
      spec,
      key: record.key,
      contextId: record.contextId,
      ...(record.parentId
        ? {
            parent: {
              parentId: record.parentId,
              parentEntityId: record.parentId,
            },
          }
        : {}),
    });
    if (prepared.surface !== "code") {
      throw new Error(`Durable Object ${record.id} replacement did not prepare code`);
    }
    const activeIdentity = requireActiveExecutionIdentity(
      prepared,
      `Durable Object ${record.id} replacement`
    );
    const latest = await store.resolveActiveRecord(record.id);
    if (latest?.activeExecutionDigest !== previousExecutionDigest) {
      throw new Error(`Durable Object ${record.id} advanced while recovery was preparing`);
    }
    const advanced = await store.advanceExecution({
      kind: "do",
      source: {
        repoPath: record.source.repoPath,
        effectiveVersion: prepared.effectiveVersion,
      },
      activeBuildKey: prepared.buildKey,
      ...activeIdentity,
      contextId: record.contextId,
      className: record.className,
      key: record.key,
      stateArgs: record.stateArgs,
      agentBinding: record.agentBinding,
      parentId: record.parentId,
      ownerUserId: record.ownerUserId,
    });
    await deps.hooks.onDurableObjectActivated?.(advanced);
    await deps.hooks.restartDurableObjectIncarnation(advanced);
    return {
      entityId: advanced.id,
      strategy: input.strategy,
      previousExecutionDigest,
      buildKey: prepared.buildKey,
      executionDigest: activeIdentity.activeExecutionDigest,
    };
  }

  /** Build a clone spec from a source record: same source + class, new key/context.
   * `ref` is omitted so the clone follows the cloned semantic context's exact
   * working head. Code and cloned durable state therefore share one boundary. */
  function buildCloneSpec(
    src: EntityRecord,
    contextId: string,
    newKey: string
  ): RuntimeEntityCreateSpec {
    if (src.kind === "do") {
      if (!src.className) {
        throw new Error(`cloneContext: DO entity ${src.id} has no className`);
      }
      return {
        kind: "do",
        execution: { surface: "code", source: src.source.repoPath },
        className: src.className,
        key: newKey,
        contextId,
        stateArgs: src.stateArgs,
      };
    }
    return {
      kind: "worker",
      execution: { surface: "code", source: src.source.repoPath },
      key: newKey,
      contextId,
      stateArgs: src.stateArgs,
    };
  }

  /**
   * Clone a whole context's durable substrate into a fresh, isolated context:
   * every worker/DO's storage (server-internal cloneDO) + a VCS snapshot of the
   * source's working files. Returns the new contextId + source→clone map. Does NOT
   * invoke the cloned DOs — server→DO calls are out of band; a caller that needs to
   * "activate" clones (re-root logs, rebind the channel) drives that via the clones'
   * own methods (the fork's `postClone`). Gated on the SOURCE: cloning your own
   * context is free; cloning a foreign existing one prompts.
   */
  async function cloneContext(
    actors: RuntimeCreationActors,
    args: {
      sourceContextId: string;
      include?: string[];
      recursive?: boolean;
      targetKey?: string;
    }
  ): Promise<CloneContextResult> {
    const caller = actors.lifecycleCaller;
    const { sourceContextId, targetKey } = args;
    const recursive = args.recursive === true;
    // `include` scopes the ROOT context only; recursive descendants clone in full.
    const rootInclude = args.include ? new Set(args.include) : null;
    // Resolve the source contexts to clone: the root, plus (recursive) its
    // transitive LIFECYCLE subtree. Lineage (fork) edges are NEVER followed — a
    // forked conversation is provenance, not a subordinate world.
    const subtree: Array<{
      sourceContextId: string;
      ownerSourceContextId: string;
      ownerEntityId: string | null;
    }> = [];
    {
      const seen = new Set<string>([sourceContextId]);
      const queue: string[] = [sourceContextId];
      while (queue.length > 0) {
        const cur = queue.shift() as string;
        const children = await store.listContextEdgesByOwner({
          ownerContextId: cur,
          kind: "lifecycle",
        });
        if (children.length > 0 && !recursive) {
          // Intentional clone/destroy asymmetry (§B7): clone of a context WITH
          // lifecycle children errors; destroy default-cascades.
          throw new Error(
            `cloneContext: context ${cur} has lifecycle (subagent) children; pass recursive:true to clone the subtree`
          );
        }
        for (const child of children) {
          if (seen.has(child.contextId)) continue;
          seen.add(child.contextId);
          subtree.push({
            sourceContextId: child.contextId,
            ownerSourceContextId: cur,
            ownerEntityId: child.ownerEntityId,
          });
          queue.push(child.contextId);
        }
      }
    }

    const sourceContexts = [sourceContextId, ...subtree.map((s) => s.sourceContextId)];
    // Deterministic (targetKey) OR fresh (random) clone id per source context.
    // The ROOT derives directly from targetKey (so createSubagentContext / the
    // fork op resolve the same child); descendants fold in their source id.
    const newContextIdOf = new Map<string, string>();
    for (const srcCtx of sourceContexts) {
      const isRoot = srcCtx === sourceContextId;
      newContextIdOf.set(
        srcCtx,
        targetKey
          ? isRoot
            ? deriveContextId(targetKey)
            : deriveContextId(`${targetKey} ${srcCtx}`)
          : randomUUID()
      );
    }

    // Only durable kinds carry cloneable state. Panels/apps are UI/host-managed;
    // sessions are inert identity — not reproduced in the clone. Denial for an
    // empty root is non-destructive (thrown before any side effect).
    const allActive = await store.listActive();
    const clonableIn = (srcCtx: string, include: Set<string> | null): EntityRecord[] =>
      allActive.filter(
        (e) =>
          e.contextId === srcCtx &&
          (e.kind === "do" || e.kind === "worker") &&
          (include ? include.has(e.id) : true)
      );
    if (clonableIn(sourceContextId, rootInclude).length === 0) {
      throw new Error(
        `cloneContext: source context ${sourceContextId} has no clonable (worker/DO) entities`
      );
    }

    const createdContexts: string[] = [];
    const created: RuntimeEntityHandle[] = [];
    const clonedStorage: Array<{ source: string; className: string; key: string }> = [];
    const entities: ClonedEntity[] = [];
    const entityIdMap = new Map<string, string>();
    try {
      for (const srcCtx of sourceContexts) {
        const isRoot = srcCtx === sourceContextId;
        const targetCtx = newContextIdOf.get(srcCtx) as string;
        // Fork semantic state first so every cloned runtime observes the exact
        // source working frontier and can then diverge independently.
        await deps.semanticContexts.forkContext(srcCtx, targetCtx);
        await deps.contextFolders.ensureContextFolder(targetCtx);
        createdContexts.push(targetCtx);

        for (const src of clonableIn(srcCtx, isRoot ? rootInclude : null)) {
          const newKey = targetKey
            ? deriveEntityKey(src.key, targetKey, src.id)
            : `${src.key}~clone~${randomUUID().slice(0, 8)}`;
          if (src.kind === "do") {
            const className = src.className;
            if (className == null) {
              throw new Error(`cloneContext: DO entity ${src.id} has no className`);
            }
            // Storage clone must precede activation so the DO reads cloned state on
            // first access. Upsert-safe (skip-if-exists) for targetKey retries.
            await deps.hooks.cloneDurableStorage?.({
              source: src.source.repoPath,
              className,
              fromKey: src.key,
              toKey: newKey,
              ...(src.id === caller.runtime.id ? { cooperativelyPaused: true } : {}),
            });
            clonedStorage.push({ source: src.source.repoPath, className, key: newKey });
          }
          const handle = await activateEntity(
            { lifecycleCaller: caller, initiatingCaller: caller },
            buildCloneSpec(src, targetCtx, newKey),
            targetCtx
          );
          created.push(handle);
          entityIdMap.set(src.id, handle.id);
          entities.push({
            sourceId: src.id,
            newId: handle.id,
            kind: src.kind as "do" | "worker",
            source: src.source.repoPath,
            ...(src.className ? { className: src.className } : {}),
            sourceKey: src.key,
            newKey,
            targetId: handle.targetId,
          });
        }
      }

      // Re-parent cloned lifecycle children onto their cloned owner, remapping the
      // spawning entity id through the clone map.
      for (const node of subtree) {
        const mappedOwnerEntity = node.ownerEntityId
          ? entityIdMap.get(node.ownerEntityId)
          : undefined;
        await store.recordContextEdge({
          contextId: newContextIdOf.get(node.sourceContextId) as string,
          ownerContextId: newContextIdOf.get(node.ownerSourceContextId) as string,
          kind: "lifecycle",
          ...(mappedOwnerEntity ? { ownerEntityId: mappedOwnerEntity } : {}),
        });
      }
      // Record the top-level fork's LINEAGE edge (provenance to the source root).
      const initiatingEntity = await store.resolveRecord(actors.initiatingCaller.runtime.id);
      await store.recordContextEdge({
        contextId: newContextIdOf.get(sourceContextId) as string,
        ownerContextId: sourceContextId,
        kind: "lineage",
        ...(initiatingEntity?.contextId === sourceContextId
          ? { ownerEntityId: initiatingEntity.id }
          : {}),
      });
      // Runtime context topology and execution-policy topology must advance
      // together. A cloned context created inside a system test inherits the
      // source context's exact case policy, so any subsequently activated agent
      // remains unattended and unexpected prompts still fail closed.
      for (const srcCtx of sourceContexts) {
        await deps.onContextCreated?.({
          contextId: newContextIdOf.get(srcCtx) as string,
          ownerContextId: srcCtx,
        });
      }
    } catch (err) {
      // Roll back every completed clone step, but retain every cleanup failure
      // alongside the initiating error. A failed rollback is material state,
      // not a reason to report only the first exception.
      const rollbackFailures: unknown[] = [];
      const retainFailure = async (operation: () => Promise<unknown>): Promise<void> => {
        try {
          await operation();
        } catch (cause) {
          rollbackFailures.push(cause);
        }
      };
      for (const h of created) await retainFailure(() => retireRecord(h.id));
      const destroyClonedStorage = deps.hooks.destroyDurableStorage;
      for (const s of clonedStorage) {
        if (destroyClonedStorage) {
          await retainFailure(() => destroyClonedStorage(s));
        }
      }
      for (const c of createdContexts) {
        await retainFailure(() => store.deleteContextEdges(c));
        await retainFailure(() => deps.semanticContexts.dropContext(c));
        await retainFailure(() => deps.contextFolders.removeContext(c));
      }
      if (rollbackFailures.length > 0) {
        throw new AggregateError(
          [err, ...rollbackFailures],
          aggregateFailureMessage(
            `cloneContext failed and ${rollbackFailures.length} rollback operation(s) also failed`,
            [err, ...rollbackFailures]
          )
        );
      }
      throw err instanceof Error ? err : new Error(String(err));
    }

    const rootNewContextId = newContextIdOf.get(sourceContextId) as string;
    const contexts = sourceContexts.map((srcCtx) => {
      const node = subtree.find((s) => s.sourceContextId === srcCtx);
      return {
        sourceContextId: srcCtx,
        newContextId: newContextIdOf.get(srcCtx) as string,
        ownerNewContextId: node ? (newContextIdOf.get(node.ownerSourceContextId) as string) : null,
      };
    });
    // Runtime is channel-agnostic: it fills entity ids only. The caller (WS-5/6)
    // fills sourceChannelId/newChannelId and settles unhomeable pending calls
    // (`aborted-by-fork`).
    const rewired = entities.map((e) => ({ sourceEntityId: e.sourceId, newEntityId: e.newId }));

    return { contextId: rootNewContextId, entities, contexts, rewired };
  }

  /**
   * Tear a whole context down: retire every entity, reclaim each DO's SQLite
   * storage, then drop the VCS state + folder. Free for your own context or one you
   * fully own (every active entity launched by you — e.g. a context you just cloned);
   * gated (severe) when destroying another agent or panel's existing context.
   */
  /** Reclaim one already-retired context's storage and semantic substrate. */
  async function cleanRetiredContext(
    contextId: string,
    retired: EntityRecord[]
  ): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (const rec of retired) {
      // DO storage is NOT reclaimed by retire (kept for re-attach) — a full context
      // destroy is the one path that deletes it.
      if (rec.kind === "do" && rec.className) {
        try {
          await deps.hooks.destroyDurableStorage?.({
            source: rec.source.repoPath,
            className: rec.className,
            key: rec.key,
          });
        } catch (cause) {
          failures.push(new Error(`Durable storage cleanup failed for ${rec.id}`, { cause }));
        }
      }
    }
    // Drop this context's own inbound edges so the registry doesn't accumulate
    // danglers, then the VCS state + folder.
    for (const [label, cleanup] of [
      ["context edges", () => store.deleteContextEdges(contextId)],
      ["semantic context", () => deps.semanticContexts.dropContext(contextId)],
      ["context folder", () => deps.contextFolders.removeContext(contextId)],
    ] as const) {
      try {
        await cleanup();
      } catch (cause) {
        failures.push(new Error(`Failed to remove ${label} for ${contextId}`, { cause }));
      }
    }
    return failures;
  }

  /**
   * Tear a whole context down. Lifecycle preparation is parent-first across the
   * complete subtree while every peer remains reachable: a parent agent must be
   * able to fence and settle its live subagents before their contexts disappear.
   * Only after every entity accepts release do we retire them as one unit and
   * reclaim contexts post-order. Lineage (fork) edges are NEVER crossed.
   * `recursive:false` destroys only this context (any lifecycle children are left
   * for the TTL sweep).
   */
  async function destroyContext(args: { contextId: string; recursive?: boolean }): Promise<void> {
    const recursive = args.recursive ?? true;
    const seen = new Set<string>();
    const contexts: string[] = [];
    const collect = async (contextId: string): Promise<void> => {
      if (seen.has(contextId)) return;
      seen.add(contextId);
      contexts.push(contextId);
      if (recursive) {
        const children = await store.listContextEdgesByOwner({
          ownerContextId: contextId,
          kind: "lifecycle",
        });
        for (const child of children) await collect(child.contextId);
      }
    };
    await collect(args.contextId);

    const contextOrder = new Map(contexts.map((contextId, index) => [contextId, index]));
    const entities = (await store.listActive())
      .filter((entity) => contextOrder.has(entity.contextId))
      .sort(
        (left, right) => contextOrder.get(left.contextId)! - contextOrder.get(right.contextId)!
      );
    const retirement = await retireContextRecords(entities);
    const failures: unknown[] = [...retirement.cleanupFailures];
    const retiredByContext = new Map<string, EntityRecord[]>();
    for (const record of retirement.retired) {
      const records = retiredByContext.get(record.contextId) ?? [];
      records.push(record);
      retiredByContext.set(record.contextId, records);
    }

    for (const contextId of [...contexts].reverse()) {
      failures.push(
        ...(await cleanRetiredContext(contextId, retiredByContext.get(contextId) ?? []))
      );
    }
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        aggregateFailureMessage(`Context cleanup failed for ${args.contextId}`, failures)
      );
    }
  }

  /**
   * List the contexts owned by a context via the relationship registry.
   * Object-wrapped (`{ contexts }`) per §E1. `kind` scopes to lifecycle/lineage.
   */
  async function listOwnedContexts(args: {
    contextId: string;
    kind?: ContextEdgeKind;
  }): Promise<{ contexts: ContextEdge[] }> {
    const contexts = await store.listContextEdgesByOwner({
      ownerContextId: args.contextId,
      kind: args.kind,
    });
    return { contexts };
  }

  /** Idempotently record a context-relationship edge (provenance/authz metadata). */
  async function recordContextEdge(
    caller: VerifiedCaller,
    args: {
      contextId: string;
      ownerContextId: string;
      kind: ContextEdgeKind;
      ownerEntityId?: string;
    }
  ): Promise<void> {
    requireTrustedRuntimeHost(caller, "recordContextEdge");
    await store.recordContextEdge(args);
  }

  async function assertSubagentOwnerAllowed(
    caller: VerifiedCaller,
    args: {
      parentContextId: string;
      ownerEntityId: string;
    }
  ): Promise<void> {
    const owner = await store.resolveRecord(args.ownerEntityId);
    if (!owner || owner.status !== "active") {
      console.warn("[runtime.createSubagentContext] owner not active", {
        callerId: caller.runtime.id,
        callerKind: caller.runtime.kind,
        ownerEntityId: args.ownerEntityId,
        parentContextId: args.parentContextId,
        ownerStatus: owner?.status ?? null,
        ownerContextId: owner?.contextId ?? null,
      });
      throw new Error(`createSubagentContext: owner entity ${args.ownerEntityId} is not active`);
    }
    if (owner.contextId !== args.parentContextId) {
      console.warn("[runtime.createSubagentContext] owner context mismatch", {
        callerId: caller.runtime.id,
        callerKind: caller.runtime.kind,
        ownerEntityId: args.ownerEntityId,
        ownerContextId: owner.contextId,
        requestedParentContextId: args.parentContextId,
      });
      throw new Error(
        `createSubagentContext: owner entity ${args.ownerEntityId} is not in parent context ${args.parentContextId}`
      );
    }
    if (isTrustedRuntimeHost(caller)) return;
    if (caller.runtime.id === owner.id || owner.parentId === caller.runtime.id) return;
    console.warn("[runtime.createSubagentContext] caller cannot create for owner", {
      callerId: caller.runtime.id,
      callerKind: caller.runtime.kind,
      ownerEntityId: owner.id,
      ownerParentId: owner.parentId,
      parentContextId: args.parentContextId,
    });
    throw new Error(
      `createSubagentContext: caller ${caller.runtime.id} cannot create subagent contexts for owner ${owner.id}`
    );
  }

  async function createSubagentContext(
    caller: VerifiedCaller,
    args: {
      parentContextId: string;
      ownerEntityId: string;
      targetKey: string;
    }
  ): Promise<{ contextId: string }> {
    await assertSubagentOwnerAllowed(caller, args);

    const contextId = deriveContextId(args.targetKey);
    // Order mirrors cloneContext: fork semantic state, then materialize its projection.
    await deps.semanticContexts.forkContext(args.parentContextId, contextId);
    await deps.contextFolders.ensureContextFolder(contextId);
    await store.recordContextEdge({
      contextId,
      ownerContextId: args.parentContextId,
      kind: "lifecycle",
      ownerEntityId: args.ownerEntityId,
    });
    // Subagents are part of the same test case, not independent interactive
    // sessions. Propagate the resident case policy before the child entity is
    // created, otherwise its first credential/tool gate silently waits for a
    // human and defeats unattended orchestration.
    await deps.onContextCreated?.({
      contextId,
      ownerContextId: args.parentContextId,
    });
    return { contextId };
  }

  async function forkSemanticContext(input: {
    ownerRuntimeId: string;
    parentContextId: string;
    targetContextId: string;
  }): Promise<{
    contextId: string;
    parentContextId: string;
    parentWorkingHead: VcsStateNodeRef;
    childBaseState: VcsStateNodeRef;
  }> {
    const ownedContextId = await store.resolveContext(input.ownerRuntimeId);
    if (ownedContextId !== input.parentContextId) {
      throw Object.assign(
        new Error(
          `Development session owner ${input.ownerRuntimeId} does not own semantic context ${input.parentContextId}`
        ),
        { code: "EIDENTITYDRIFT" }
      );
    }
    const parentContextId = input.parentContextId;
    const contextId = input.targetContextId;
    const parentWorkingHead = await deps.semanticContexts.resolveWorkingState(parentContextId);
    // Semantic state only: do not create a projection folder and do not touch
    // entity/DO state. forkContext is valid even when the parent is empty.
    await deps.semanticContexts.forkContext(parentContextId, contextId);
    await store.recordContextEdge({
      contextId,
      ownerContextId: parentContextId,
      kind: "lifecycle",
      ownerEntityId: input.ownerRuntimeId,
    });
    await deps.onContextCreated?.({ contextId, ownerContextId: parentContextId });
    const childBaseState = await deps.semanticContexts.resolveWorkingState(contextId);
    return { contextId, parentContextId, parentWorkingHead, childBaseState };
  }

  async function dropSemanticContext(contextId: string): Promise<void> {
    // Development contexts reach this path only before an executor exists, so
    // semantic state and its registry edge are the entire resource set.
    await deps.semanticContexts.dropContext(contextId);
    await store.deleteContextEdges(contextId);
    await deps.onContextRemoved?.({ contextId });
  }

  interface EntitySummary {
    id: string;
    kind: string;
    source: string;
    key: string;
    contextId: string;
    title?: string;
    createdAt: number;
  }

  async function listEntities(kind?: string): Promise<EntitySummary[]> {
    const live = await store.listActive(kind);
    return live.map((record) => {
      const stateArgs = record.stateArgs;
      const title =
        stateArgs != null &&
        typeof stateArgs === "object" &&
        typeof (stateArgs as { title?: unknown }).title === "string"
          ? ((stateArgs as { title: string }).title as string)
          : undefined;
      return {
        id: record.id,
        kind: record.kind,
        source: record.source.repoPath,
        key: record.key,
        contextId: record.contextId,
        title,
        createdAt: record.createdAt,
      };
    });
  }

  async function resolveContext(id: string): Promise<string | null> {
    return await store.resolveContext(id);
  }

  async function listContexts(prefix?: string): Promise<{ contexts: string[] }> {
    return { contexts: await deps.semanticContexts.listContexts(prefix) };
  }

  const prepareEntityContextBoundary = async (
    ctx: ServiceContext,
    rawSpec: unknown
  ): Promise<import("@vibestudio/shared/serviceDefinition").PreparedAuthorityState> => {
    const spec = rawSpec as RuntimeEntityCreateSpec;
    assertCreateEntityAllowed(ctx.caller, spec);
    if (
      spec.contextId == null ||
      spec.contextId === "" ||
      spec.resourceBindings?.length ||
      isExtensionOrchestratedCreate(ctx.caller, spec)
    ) {
      return { selections: [], payload: null };
    }
    const boundaryCaller =
      ctx.caller.runtime.kind === "extension" ? verifiedInitiator(ctx) : ctx.caller;
    return {
      selections: await prepareContextBoundary(boundaryCaller, spec.contextId, {
        kind: "runtime",
        verb: `Create ${spec.kind}`,
        targetLabel: runtimeEntitySource(spec),
        targetLabelName: "Source",
        groupKey: `context-boundary:${spec.contextId}:${runtimeEntitySource(spec)}`,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      }),
      payload: null,
    };
  };

  const definition: ServiceDefinition = {
    name: "runtime",
    description: "Runtime entity creation and retirement",
    authority: { principals: ["code", "user", "host"] },
    methods: runtimeMethods,
    authorityPreparation: {
      "runtime.createEntity.contextBoundary": (ctx, [rawSpec]) =>
        prepareEntityContextBoundary(ctx, rawSpec),
      "runtime.reserveEntity.contextBoundary": (ctx, [rawSpec]) =>
        prepareEntityContextBoundary(ctx, rawSpec),
      "runtime.retireEntity.contextBoundary": async (ctx, [rawArgs]) => {
        const { id, removeContext } = rawArgs as { id: string; removeContext?: boolean };
        const target = await store.resolveRecord(id);
        if (!target || target.status !== "active" || callerOwnsEntity(ctx.caller, target))
          return { selections: [], payload: null };
        return {
          selections: await prepareContextBoundary(ctx.caller, target.contextId, {
            kind: "runtime",
            verb: removeContext ? "Retire entity and remove context" : "Retire entity",
            targetLabel: id,
            targetLabelName: "Runtime entity",
            ...(removeContext ? { severity: "severe" as const } : {}),
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
          payload: null,
        };
      },
      "runtime.createContext.contextBoundary": async (ctx, [rawArgs]) => {
        const { contextId } = rawArgs as { contextId?: string };
        if (contextId == null || contextId === "") return { selections: [], payload: null };
        const delegatedOwnerContextId =
          ctx.caller.runtime.kind === "extension" && ctx.chainCaller
            ? await store.resolveContext(ctx.chainCaller.callerId)
            : undefined;
        return {
          selections: await prepareContextBoundary(
            ctx.caller,
            contextId,
            {
              kind: "runtime",
              verb: "Set up context",
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            },
            delegatedOwnerContextId
          ),
          payload: null,
        };
      },
      "runtime.cloneContext.contextBoundary": async (ctx, [rawArgs]) => {
        const { sourceContextId } = rawArgs as { sourceContextId: string };
        return {
          selections: await prepareContextBoundary(ctx.caller, sourceContextId, {
            kind: "runtime",
            verb: "Clone context",
            targetLabel: sourceContextId,
            targetLabelName: "Source context",
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
          payload: null,
        };
      },
      "runtime.destroyContext.contextBoundary": async (ctx, [rawArgs]) => {
        const { contextId } = rawArgs as { contextId: string };
        // Ownership is durable context provenance, not a property of the live
        // roster. Headless cleanup unsubscribes/retires its last entity before
        // deleting the context; active-only inference would misclassify that
        // creator-owned empty context as foreign and leak it fail-closed.
        const entities = await store.listByContext(contextId);
        const byId = new Map(entities.map((entity) => [entity.id, entity]));
        const owned =
          entities.length > 0 &&
          entities.every((entity) => {
            const visited = new Set<string>([entity.id]);
            let parentId = entity.parentId;
            while (parentId && byId.has(parentId)) {
              if (visited.has(parentId)) return false;
              visited.add(parentId);
              parentId = byId.get(parentId)?.parentId;
            }
            return parentId === ctx.caller.runtime.id;
          });
        if (owned) return { selections: [], payload: null };
        return {
          selections: await prepareContextBoundary(ctx.caller, contextId, {
            kind: "runtime",
            verb: "Destroy context",
            targetLabel: contextId,
            targetLabelName: "Context",
            severity: "severe",
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
          payload: null,
        };
      },
      "runtime.createSubagentContext.contextBoundary": async (ctx, [rawArgs]) => {
        const args = rawArgs as {
          parentContextId: string;
          ownerEntityId: string;
          targetKey: string;
        };
        await assertSubagentOwnerAllowed(ctx.caller, args);
        return {
          selections: await prepareContextBoundary(ctx.caller, args.parentContextId, {
            kind: "runtime",
            verb: "Create subagent context",
            targetLabel: args.ownerEntityId,
            targetLabelName: "Owner entity",
            groupKey: `context-boundary:subagent:${args.parentContextId}:${args.ownerEntityId}`,
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          }),
          payload: null,
        };
      },
    },
    handler: defineServiceHandler("runtime", runtimeMethods, {
      createEntity: (ctx, [spec]) =>
        createEntity(
          {
            lifecycleCaller: ctx.caller,
            initiatingCaller: verifiedInitiator(ctx),
          },
          spec
        ),
      reserveEntity: (ctx, [spec]) =>
        reserveEntity(
          {
            lifecycleCaller: ctx.caller,
            initiatingCaller: verifiedInitiator(ctx),
          },
          spec as RuntimeCodeEntityCreateSpec
        ),
      activateReservedEntity: (ctx, [spec]) =>
        activateReservedEntity(ctx.caller, spec as RuntimeCodeEntityCreateSpec),
      faultAbortAgentVessel: async (ctx, [{ targetId }]) => {
        if (!deps.faultAbortAgentVessel) {
          throw new Error("Agent vessel fault injection is unavailable");
        }
        const target = await store.resolveRecord(targetId);
        if (!target || target.status !== "active" || target.kind !== "do") {
          throw new Error("Agent vessel fault target is not an active Durable Object");
        }
        await deps.faultAbortAgentVessel(ctx.caller, target);
        return { aborted: true as const };
      },
      retireEntity: async (_ctx, [{ id, removeContext }]) => {
        await retireEntity(id, removeContext);
      },
      releaseResourceBindings: async (ctx, [{ id }]) => {
        await releaseResourceBindings(ctx.caller, id);
      },
      replaceResourceBindings: async (ctx, [input]) => {
        await replaceResourceBindings(
          {
            lifecycleCaller: ctx.caller,
            initiatingCaller: verifiedInitiator(ctx),
          },
          input
        );
      },
      recoverExecution: (ctx, [input]) => recoverExecution(ctx.caller, input),
      listEntities: (_ctx, [input]) => listEntities(input?.kind),
      resolveContext: (_ctx, [id]) => resolveContext(id),
      listContexts: (_ctx, [input]) => listContexts(input?.prefix),
      createContext: (ctx, [{ contextId, testPolicy }]) =>
        createContext(ctx, { contextId, testPolicy }),
      cloneContext: (ctx, [cloneArgs]) =>
        cloneContext(
          {
            lifecycleCaller: ctx.caller,
            initiatingCaller: verifiedInitiator(ctx),
          },
          cloneArgs
        ),
      rebindAgentChannel: async (ctx, [input]) => {
        await rebindAgentChannel(ctx.caller, input);
      },
      destroyContext: async (_ctx, [{ contextId, recursive }]) => {
        await destroyContext({ contextId, recursive });
      },
      forkSemanticContext: (_ctx, [input]) => forkSemanticContext(input),
      dropSemanticContext: async (_ctx, [{ contextId }]) => {
        await dropSemanticContext(contextId);
      },
      listOwnedContexts: (_ctx, [listArgs]) => listOwnedContexts(listArgs),
      recordContextEdge: async (ctx, [edgeArgs]) => {
        await recordContextEdge(ctx.caller, edgeArgs);
      },
      createSubagentContext: (ctx, [subArgs]) => createSubagentContext(ctx.caller, subArgs),
      setTitle: async (ctx, [title, options]) => {
        // The method's code-principal authority declaration is the single gate:
        // view/worker code may title its own runtime, while host callers cannot.
        // The handler deliberately does not duplicate that authority decision.
        await deps.setEntityTitle?.(ctx.caller.runtime.id, title == null ? undefined : title, {
          explicit: options?.explicit === true,
        });
      },
      "supervision.list": (_ctx, [input]) => deps.unitSupervisor.list(input?.kind),
      "supervision.describe": (_ctx, [key]) => deps.unitSupervisor.describe(key),
      "supervision.health": (_ctx, [key, query]) => deps.unitSupervisor.health(key, query),
      "supervision.logs": (_ctx, [key, query]) => deps.unitSupervisor.logs(key, query),
      "supervision.reportReady": async (ctx, [report]) => {
        await deps.unitSupervisor.reportReady(ctx, report);
        return null;
      },
      "supervision.reportHealth": async (ctx, [report]) => {
        await deps.unitSupervisor.reportHealth(ctx, report);
        return null;
      },
      "supervision.appendLog": async (ctx, [report]) => {
        await deps.unitSupervisor.appendLog(ctx, report);
        return null;
      },
      "supervision.restart": (ctx, [key]) => deps.unitSupervisor.restart(ctx, key),
      "supervision.activate": (ctx, [key]) => deps.unitSupervisor.activate(ctx, key),
      "supervision.prepare": (ctx, [key, selector]) =>
        deps.unitSupervisor.prepare(ctx, key, selector.ref),
      "supervision.retire": (ctx, [key]) => deps.unitSupervisor.retire(ctx, key),
      "supervision.versions": (_ctx, [key]) => deps.unitSupervisor.versions(key),
      "supervision.rollback": (ctx, [key, options]) =>
        deps.unitSupervisor.rollback(ctx, key, options?.buildKey),
    }),
  };
  return {
    definition,
    internal: {
      createEntity: (caller, spec) =>
        createEntity({ lifecycleCaller: caller, initiatingCaller: caller }, spec),
      activateReservedEntity: (spec) => activateReservedEntity(null, spec),
      listPreparingPanels: () => store.listPreparing("panel"),
      retireEntity: (id) => retireEntity(id),
      createContext,
      resolveContext,
      forkSemanticContext,
      dropSemanticContext,
    },
  };
}
