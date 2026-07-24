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
} from "@vibestudio/service-schemas/runtime";
import type { ContextEdge, ContextEdgeKind } from "@vibestudio/shared/runtime/contextEdges";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import type {
  LifecyclePrepareInput,
  LifecyclePrepareResult,
} from "@vibestudio/shared/doDispatcher";
import { serializeByKey } from "@vibestudio/shared/keyedSerializer";
import {
  buildWorkspaceContext,
  canonicalEntityId,
  type EntityRecord,
  type RuntimeAgentBinding,
  type RuntimeAgentBindingInput,
  type RuntimeEntityCreateSpec,
  type RuntimeEntityHandle,
  type RuntimePanelEntityCreateSpec,
  type WorkspaceContext,
} from "@vibestudio/shared/runtime/entitySpec";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import { isAuthorizedChrome } from "./chromeTrust.js";
import {
  prepareContextBoundarySelection,
  type ContextBoundaryAction,
  type ContextBoundaryDeps,
} from "./contextBoundary.js";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { requireActiveExecutionIdentity } from "../runtimeExecutionIdentity.js";

export interface RuntimeEntityHooks {
  /** Immutable authority facts sealed into the selected build artifact. */

  /** Prepare runtime resources for a "do" entity. Returns targetId + effectiveVersion. */
  prepareDurableObject: (args: {
    source: string;
    ref: string | undefined;
    className: string;
    key: string;
    contextId: string;
    stateArgs?: unknown;
  }) => Promise<PreparedRuntimeExecution & { targetId: string }>;

  /** Prepare runtime resources for a "worker" entity. */
  prepareWorker: (args: {
    source: string;
    ref: string | undefined;
    key: string;
    contextId: string;
    stateArgs?: unknown;
    env?: Record<string, string>;
    /** Launch parent (the verified caller) → worker `PARENT_*` env, so the
     *  worker's `parent` resolves from the same source as `EntityRecord.parentId`. */
    parent?: { parentId: string; parentEntityId: string; parentKind?: "panel" | "worker" | "do" };
  }) => Promise<PreparedRuntimeExecution & { targetId: string }>;

  /** Start the lazy runtime image for a panel entity and resolve its EV. */
  preparePanel: (args: {
    source: string;
    ref: string | undefined;
    /** Reattach an existing incarnation to its already-selected immutable artifact. */
    buildKey?: string;
  }) => Promise<PreparedRuntimeExecution>;

  /** Resolve the exact immutable build for an app entity (no runtime prep). */
  resolveAppExecution: (args: {
    source: string;
    ref: string | undefined;
  }) => Promise<PreparedRuntimeExecution>;

  /** Cleanup hooks invoked on retire — closed at bootstrap. */
  onRetire: (record: EntityRecord) => Promise<void>;

  /**
   * Release resources owned inside an entity before its durable row is retired.
   * A failed or rejected receipt leaves the entity active; post-retire host
   * cleanup is deliberately a separate, retryable phase.
   */
  releaseEntity: (
    record: EntityRecord,
    input: LifecyclePrepareInput
  ) => Promise<LifecyclePrepareResult>;

  /** Seal external RPC admission and drain calls accepted before retirement. */
  sealAndDrainEntityRelays?: (entityId: string) => Promise<void>;
  /** Release the process-local retirement seal after retire commits or aborts. */
  releaseEntityRelaySeal?: (entityId: string) => void;

  /**
   * Clone a DO's durable SQLite storage to a new instance key (server-internal
   * `workerdManager.cloneDO`). Used by `cloneContext`; never exposed to userland.
   */
  cloneDurableStorage?: (args: {
    source: string;
    className: string;
    fromKey: string;
    toKey: string;
  }) => Promise<void>;

  /**
   * Delete a DO's durable SQLite storage (server-internal
   * `workerdManager.destroyDO`). Used by `cloneContext` rollback + `destroyContext`;
   * never exposed to userland. (Plain `retireEntity` deliberately leaves storage
   * intact for re-attach — only a full context destroy reclaims it.)
   */
  destroyDurableStorage?: (args: {
    source: string;
    className: string;
    key: string;
  }) => Promise<void>;
}

export interface RuntimeServiceInternal {
  createEntity(caller: VerifiedCaller, spec: RuntimeEntityCreateSpec): Promise<RuntimeEntityHandle>;
  createContext(
    ctx: Pick<ServiceContext, "caller" | "chainCaller">,
    args: {
      contextId?: string;
      testPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicySpec;
    }
  ): Promise<WorkspaceContext>;
  resolveContext(id: string): Promise<string | null>;
}

export interface RuntimeServiceResult {
  definition: ServiceDefinition;
  internal: RuntimeServiceInternal;
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
}

export interface RuntimeServiceDeps {
  /**
   * The single owner of WorkspaceDO entity state. The runtime service never
   * dispatches `entityActivate`/`entityRetire` or touches the cache mirror
   * directly — the store pairs the durable write with the cache update so they
   * can't drift.
   */
  entityStore: WorkspaceEntityStore;
  hooks: RuntimeEntityHooks;
  contextBoundary: ContextBoundaryDeps;
  contextFolders: RuntimeContextFolders;
  /** Required semantic-context lifecycle owned by the semantic workspace. */
  semanticContexts: RuntimeSemanticContexts;
  onContextCreated?: (input: {
    contextId: string;
    ownerContextId: string | null;
    testPolicy?: import("@vibestudio/rpc").AgentExecutionTestPolicySpec;
  }) => void | Promise<void>;
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
  const retirementChains = new Map<string, Promise<unknown>>();

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
    if (!originContextId) return false;
    const edges = await store.listContextEdgesByOwner({
      ownerContextId: originContextId,
      kind: "lifecycle",
    });
    const edge = edges.find((candidate) => candidate.contextId === targetContextId);
    if (!edge?.ownerEntityId) return false;
    if (edge.ownerEntityId === caller.runtime.id) return true;
    const owner = await store.resolveRecord(edge.ownerEntityId);
    return owner ? callerOwnsEntity(caller, owner) : false;
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
    caller: VerifiedCaller,
    rawSpec: RuntimeEntityCreateSpec
  ): Promise<RuntimeEntityHandle> {
    const spec = rawSpec;
    assertCreateEntityAllowed(caller, spec);
    const canonicalId = spec.key
      ? canonicalEntityId({
          kind: spec.kind,
          source: "source" in spec ? spec.source : undefined,
          className: spec.kind === "do" ? spec.className : undefined,
          key: spec.key,
        })
      : null;
    const create = async (): Promise<RuntimeEntityHandle> => {
      const requestedContextId =
        spec.contextId == null || spec.contextId === "" ? undefined : spec.contextId;
      const agentBinding = await resolveAgentBinding(
        caller,
        "createEntity",
        requestedContextId,
        bindingFromSpec(spec)
      );
      const contextId = await resolveTargetContext(caller, spec.contextId, agentBinding);
      return activateEntity(caller, spec, contextId, agentBinding, selfAgentChannelFromSpec(spec));
    };
    return canonicalId ? serializeByKey(creationChains, canonicalId, create) : create();
  }

  const panelHandle = (record: EntityRecord): RuntimeEntityHandle => ({
    id: record.id,
    kind: "panel",
    source: record.source,
    ...(record.activeBuildKey ? { buildKey: record.activeBuildKey } : {}),
    ...(record.activeExecutionDigest ? { executionDigest: record.activeExecutionDigest } : {}),
    ...(record.activeAuthority
      ? {
          authorityRequests: record.activeAuthority.requests,
        }
      : {}),
    contextId: record.contextId,
    targetId: record.id,
  });

  /**
   * Commit only the panel's durable coordinates. The preparing record is not an
   * executable principal, so a host may safely attach a native view while build
   * preparation continues.
   */
  async function reservePanelEntity(
    caller: VerifiedCaller,
    spec: RuntimePanelEntityCreateSpec
  ): Promise<RuntimeEntityHandle> {
    if (!isTrustedRuntimeHost(caller)) {
      throw new Error("Deferred panel runtime entities are host-managed");
    }
    const contextId = await resolveTargetContext(caller, spec.contextId, undefined);
    const key = spec.key ?? randomUUID();
    const record = await store.reservePanel({
      kind: "panel",
      source: { repoPath: spec.source, effectiveVersion: "" },
      contextId,
      key,
      stateArgs: spec.stateArgs,
      parentId: caller.runtime.id,
      ownerUserId: caller.subject?.userId,
    });
    return panelHandle(record);
  }

  /**
   * Complete one reserved panel incarnation in place. Build preparation and
   * semantic-context materialization are independent and therefore run
   * concurrently; the single durable advance is the activation boundary.
   */
  async function activatePanelEntity(
    caller: VerifiedCaller,
    spec: RuntimePanelEntityCreateSpec
  ): Promise<RuntimeEntityHandle> {
    if (!isTrustedRuntimeHost(caller)) {
      throw new Error("Deferred panel runtime entities are host-managed");
    }
    if (!spec.key) {
      throw new Error("activatePanelEntity requires the reserved panel key");
    }
    const canonicalId = canonicalEntityId({ kind: "panel", key: spec.key });
    const existing = await store.resolveRecord(canonicalId);
    if (!existing || existing.kind !== "panel") {
      throw new Error(`Unknown reserved panel entity ${canonicalId}`);
    }
    if (existing.source.repoPath !== spec.source) {
      throw new Error(
        `Reserved panel ${canonicalId} belongs to ${existing.source.repoPath}, not ${spec.source}`
      );
    }
    if (
      existing.status === "active" &&
      existing.activeBuildKey &&
      existing.activeExecutionDigest &&
      existing.activeAuthority
    ) {
      return panelHandle(existing);
    }
    if (existing.status !== "preparing") {
      throw new Error(`Reserved panel ${canonicalId} is ${existing.status}`);
    }

    const [prepared] = await Promise.all([
      deps.hooks.preparePanel({ source: spec.source, ref: spec.ref }),
      setUpContext(existing.contextId),
    ]);
    if (!prepared.buildKey || !/^[0-9a-f]{64}$/.test(prepared.buildKey)) {
      throw new Error(
        `Panel ${canonicalId} preparation did not select an immutable BuildV2 artifact`
      );
    }
    const { activeExecutionDigest, activeAuthority } = requireActiveExecutionIdentity(
      prepared,
      `panel ${canonicalId}`
    );
    const record = await store.advanceExecution({
      kind: "panel",
      source: { repoPath: spec.source, effectiveVersion: prepared.effectiveVersion },
      activeBuildKey: prepared.buildKey,
      activeExecutionDigest,
      activeAuthority,
      contextId: existing.contextId,
      key: existing.key,
      stateArgs: existing.stateArgs,
      parentId: existing.parentId,
      ownerUserId: existing.ownerUserId,
    });
    return panelHandle(record);
  }

  /**
   * Prepare runtime resources for an entity and commit its durable row — WITHOUT
   * context-boundary resolution. `createEntity` calls this after dispatcher enforcement;
   * `cloneContext` calls it per clone after one prepared source-context leaf. `parentId` is the
   * caller, so a cloneContext caller owns (and may freely destroy) the clones.
   */
  async function activateEntity(
    caller: VerifiedCaller,
    spec: RuntimeEntityCreateSpec,
    initialContextId: string,
    externalAgentBinding?: RuntimeAgentBinding,
    selfAgentChannelId?: string
  ): Promise<RuntimeEntityHandle> {
    let contextId = initialContextId;
    const key = spec.key ?? randomUUID();

    let canonicalId: string;
    let effectiveVersion: string;
    let buildKey: string | undefined;
    let executionDigest: string | undefined;
    let activeAuthority: UnitAuthorityManifest | undefined;
    let targetId: string;
    let existing: EntityRecord | null = null;

    if (spec.kind === "do") {
      canonicalId = canonicalEntityId({
        kind: "do",
        source: spec.source,
        className: spec.className,
        key,
      });
      existing = await store.resolveRecord(canonicalId);
      const prepared = await deps.hooks.prepareDurableObject({
        source: spec.source,
        ref: spec.ref,
        className: spec.className,
        key,
        contextId,
        stateArgs: spec.stateArgs,
      });
      effectiveVersion =
        existing?.status === "retired"
          ? existing.source.effectiveVersion
          : prepared.effectiveVersion;
      buildKey = prepared.buildKey;
      ({ activeExecutionDigest: executionDigest, activeAuthority } = requireActiveExecutionIdentity(
        prepared,
        `Durable Object ${canonicalId}`
      ));
      targetId = prepared.targetId;
    } else if (spec.kind === "worker") {
      canonicalId = canonicalEntityId({ kind: "worker", source: spec.source, key });
      existing = await store.resolveRecord(canonicalId);
      const parentKind = caller.runtime.kind;
      const prepared = await deps.hooks.prepareWorker({
        source: spec.source,
        ref: spec.ref,
        key,
        contextId,
        stateArgs: spec.stateArgs,
        env: spec.env,
        // Same launch parent recorded on the entity (parentId below), threaded to
        // the worker's PARENT_* env so its `parent` runtime API resolves.
        parent: {
          parentId: caller.runtime.id,
          parentEntityId: caller.runtime.id,
          parentKind:
            parentKind === "panel" || parentKind === "worker" || parentKind === "do"
              ? parentKind
              : undefined,
        },
      });
      effectiveVersion =
        existing?.status === "retired"
          ? existing.source.effectiveVersion
          : prepared.effectiveVersion;
      buildKey = prepared.buildKey;
      ({ activeExecutionDigest: executionDigest, activeAuthority } = requireActiveExecutionIdentity(
        prepared,
        `worker ${canonicalId}`
      ));
      targetId = prepared.targetId;
    } else if (spec.kind === "app") {
      canonicalId = canonicalEntityId({ kind: "app", source: spec.source, key });
      existing = await store.resolveRecord(canonicalId);
      const prepared = await deps.hooks.resolveAppExecution({
        source: spec.source,
        ref: spec.ref,
      });
      effectiveVersion =
        existing?.status === "retired"
          ? existing.source.effectiveVersion
          : prepared.effectiveVersion;
      buildKey = prepared.buildKey;
      ({ activeExecutionDigest: executionDigest, activeAuthority } = requireActiveExecutionIdentity(
        prepared,
        `app ${canonicalId}`
      ));
      targetId = canonicalId;
    } else if (spec.kind === "session") {
      canonicalId = canonicalEntityId({ kind: "session", key });
      existing = await store.resolveRecord(canonicalId);
      // Entity identity columns are write-once, so re-attaching to an
      // existing session key must reuse its contextId — a freshly minted one
      // would throw IDENTITY_COLLISION even against a retired row. The
      // context folder is re-materialized below if it was removed.
      if ((spec.contextId == null || spec.contextId === "") && existing) {
        contextId = existing.contextId;
      }
      // Inert kind: no workerd/panel runtime. The only phase-4 prep is
      // eagerly materializing the context folder so host callers (e.g.
      // agent CLIs) get a working tree immediately.
      await deps.contextFolders.ensureContextFolder(contextId);
      effectiveVersion = existing?.status === "retired" ? existing.source.effectiveVersion : "";
      targetId = canonicalId;
    } else {
      canonicalId = canonicalEntityId({ kind: "panel", key });
      existing = await store.resolveRecord(canonicalId);
      const prepared = await deps.hooks.preparePanel({
        source: spec.source,
        ref: spec.ref,
        ...(existing?.activeBuildKey ? { buildKey: existing.activeBuildKey } : {}),
      });
      if (
        existing &&
        !existing.activeBuildKey &&
        prepared.effectiveVersion !== existing.source.effectiveVersion
      ) {
        throw new Error(
          `Cannot reactivate legacy panel ${canonicalId}: its immutable build key is unknown and current source resolves to a different effective version`
        );
      }
      effectiveVersion =
        existing?.status === "retired"
          ? existing.source.effectiveVersion
          : prepared.effectiveVersion;
      if (!prepared.buildKey || !/^[0-9a-f]{64}$/.test(prepared.buildKey)) {
        throw new Error(
          `Panel ${canonicalId} preparation did not select an immutable BuildV2 artifact`
        );
      }
      buildKey = prepared.buildKey;
      ({ activeExecutionDigest: executionDigest, activeAuthority } = requireActiveExecutionIdentity(
        prepared,
        `panel ${canonicalId}`
      ));
      targetId = canonicalId;
    }

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
      source: { repoPath: spec.source, effectiveVersion },
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
      ownerUserId: caller.subject?.userId,
    };
    const record = await store.activate(activateInput);
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
    await deps.contextFolders.ensureContextFolder(contextId);
    // An extension call is delegated work: the upstream verified code context
    // owns any lifecycle context created for that request, while the extension
    // runtime remains the exact creating entity. Without this edge an
    // extension that has no context of its own creates an orphan context that
    // neither side can subsequently read or mutate.
    const ownerContextId =
      delegatedOwnerContextId === undefined
        ? await store.resolveContext(caller.runtime.id)
        : delegatedOwnerContextId;
    if (ownerContextId && ownerContextId !== contextId) {
      await store.recordContextEdge({
        contextId,
        ownerContextId,
        kind: "lifecycle",
        ownerEntityId: caller.runtime.id,
      });
    }
    await deps.onContextCreated?.({
      contextId,
      ownerContextId: ownerContextId ?? null,
      ...(args.testPolicy ? { testPolicy: args.testPolicy } : {}),
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
      if (current.status === "active") {
        const released = await deps.hooks.releaseEntity(current, {
          epoch: `retire:${randomUUID()}`,
          mode: "retire",
          reason: "entity_retire",
          deadlineMs: 0,
        });
        if (released.status === "failed") {
          throw new Error(`Entity ${id} refused terminal lifecycle release`);
        }
      }

      let record: EntityRecord | null;
      try {
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
      } catch {
        // Leave cleanup_complete=0; cleanupReaper will retry.
      }
      return record;
    });
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
        await deps.semanticContexts.dropContext(record.contextId).catch(() => undefined);
        await deps.contextFolders.removeContext(record.contextId);
      }
    }
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
        source: src.source.repoPath,
        className: src.className,
        key: newKey,
        contextId,
        stateArgs: src.stateArgs,
      };
    }
    return {
      kind: "worker",
      source: src.source.repoPath,
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
    caller: VerifiedCaller,
    args: {
      sourceContextId: string;
      include?: string[];
      recursive?: boolean;
      targetKey?: string;
    }
  ): Promise<CloneContextResult> {
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
            });
            clonedStorage.push({ source: src.source.repoPath, className, key: newKey });
          }
          const handle = await activateEntity(
            caller,
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
      await store.recordContextEdge({
        contextId: newContextIdOf.get(sourceContextId) as string,
        ownerContextId: sourceContextId,
        kind: "lineage",
      });
    } catch (err) {
      // Best-effort rollback: retire clones, delete cloned storage, drop every
      // context created in this call (edges + VCS + folder).
      for (const h of created) await retireRecord(h.id).catch(() => undefined);
      for (const s of clonedStorage)
        await deps.hooks.destroyDurableStorage?.(s).catch(() => undefined);
      for (const c of createdContexts) {
        await store.deleteContextEdges(c).catch(() => undefined);
        await deps.semanticContexts.dropContext(c).catch(() => undefined);
        await deps.contextFolders.removeContext(c).catch(() => undefined);
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
  /**
   * Tear down ONE context: retire its entities, reclaim each DO's storage, drop
   * its edge rows + VCS state + folder. `gate` is true only for the destroy
   * ROOT — lifecycle descendants reached via cascade are owned by construction.
   */
  async function destroyOneContext(contextId: string): Promise<void> {
    const entities = (await store.listActive()).filter((e) => e.contextId === contextId);
    for (const e of entities) {
      const rec = await retireRecord(e.id);
      // DO storage is NOT reclaimed by retire (kept for re-attach) — a full context
      // destroy is the one path that deletes it.
      if (rec && rec.kind === "do" && rec.className) {
        await deps.hooks
          .destroyDurableStorage?.({
            source: rec.source.repoPath,
            className: rec.className,
            key: rec.key,
          })
          .catch(() => undefined);
      }
    }
    // Drop this context's own inbound edges so the registry doesn't accumulate
    // danglers, then the VCS state + folder.
    await store.deleteContextEdges(contextId).catch(() => undefined);
    await deps.semanticContexts.dropContext(contextId).catch(() => undefined);
    await deps.contextFolders.removeContext(contextId).catch(() => undefined);
  }

  /**
   * Tear a whole context down. `recursive` (the default when lifecycle children
   * exist) does a POST-ORDER teardown of the LIFECYCLE subtree only — subagent
   * worlds die with their owner (§B7). Lineage (fork) edges are NEVER crossed:
   * destroying a conversation never destroys its forks. `recursive:false`
   * destroys only this context (any lifecycle children are left for the TTL sweep).
   */
  async function destroyContext(args: { contextId: string; recursive?: boolean }): Promise<void> {
    const recursive = args.recursive ?? true;
    const seen = new Set<string>();
    const teardown = async (contextId: string): Promise<void> => {
      if (seen.has(contextId)) return;
      seen.add(contextId);
      if (recursive) {
        const children = await store.listContextEdgesByOwner({
          ownerContextId: contextId,
          kind: "lifecycle",
        });
        // Post-order: leaves first, then the parent.
        for (const child of children) await teardown(child.contextId);
      }
      await destroyOneContext(contextId);
    };
    await teardown(args.contextId);
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
    return { contextId };
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

  const definition: ServiceDefinition = {
    name: "runtime",
    description: "Runtime entity creation and retirement",
    authority: { principals: ["code", "user", "host"] },
    methods: runtimeMethods,
    authorityPreparation: {
      "runtime.createEntity.contextBoundary": async (ctx, [rawSpec]) => {
        const spec = rawSpec as RuntimeEntityCreateSpec;
        assertCreateEntityAllowed(ctx.caller, spec);
        if (
          spec.contextId == null ||
          spec.contextId === "" ||
          isExtensionOrchestratedCreate(ctx.caller, spec)
        ) {
          return [];
        }
        return prepareContextBoundary(ctx.caller, spec.contextId, {
          kind: "runtime",
          verb: `Create ${spec.kind}`,
          targetLabel: spec.source,
          targetLabelName: "Source",
          groupKey: `context-boundary:${spec.contextId}:${spec.source}`,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      },
      "runtime.retireEntity.contextBoundary": async (ctx, [rawArgs]) => {
        const { id, removeContext } = rawArgs as { id: string; removeContext?: boolean };
        const target = await store.resolveRecord(id);
        if (!target || target.status !== "active" || callerOwnsEntity(ctx.caller, target))
          return [];
        return prepareContextBoundary(ctx.caller, target.contextId, {
          kind: "runtime",
          verb: removeContext ? "Retire entity and remove context" : "Retire entity",
          targetLabel: id,
          targetLabelName: "Runtime entity",
          ...(removeContext ? { severity: "severe" as const } : {}),
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      },
      "runtime.createContext.contextBoundary": async (ctx, [rawArgs]) => {
        const { contextId } = rawArgs as { contextId?: string };
        if (contextId == null || contextId === "") return [];
        const delegatedOwnerContextId =
          ctx.caller.runtime.kind === "extension" && ctx.chainCaller
            ? await store.resolveContext(ctx.chainCaller.callerId)
            : undefined;
        return prepareContextBoundary(
          ctx.caller,
          contextId,
          {
            kind: "runtime",
            verb: "Set up context",
            ...(ctx.signal ? { signal: ctx.signal } : {}),
          },
          delegatedOwnerContextId
        );
      },
      "runtime.cloneContext.contextBoundary": async (ctx, [rawArgs]) => {
        const { sourceContextId } = rawArgs as { sourceContextId: string };
        return prepareContextBoundary(ctx.caller, sourceContextId, {
          kind: "runtime",
          verb: "Clone context",
          targetLabel: sourceContextId,
          targetLabelName: "Source context",
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
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
        if (owned) return [];
        return prepareContextBoundary(ctx.caller, contextId, {
          kind: "runtime",
          verb: "Destroy context",
          targetLabel: contextId,
          targetLabelName: "Context",
          severity: "severe",
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      },
      "runtime.createSubagentContext.contextBoundary": async (ctx, [rawArgs]) => {
        const args = rawArgs as {
          parentContextId: string;
          ownerEntityId: string;
          targetKey: string;
        };
        await assertSubagentOwnerAllowed(ctx.caller, args);
        return prepareContextBoundary(ctx.caller, args.parentContextId, {
          kind: "runtime",
          verb: "Create subagent context",
          targetLabel: args.ownerEntityId,
          targetLabelName: "Owner entity",
          groupKey: `context-boundary:subagent:${args.parentContextId}:${args.ownerEntityId}`,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
        });
      },
    },
    handler: defineServiceHandler("runtime", runtimeMethods, {
      createEntity: (ctx, [spec]) => createEntity(ctx.caller, spec),
      reservePanelEntity: (ctx, [spec]) => reservePanelEntity(ctx.caller, spec),
      activatePanelEntity: (ctx, [spec]) => activatePanelEntity(ctx.caller, spec),
      retireEntity: async (ctx, [{ id, removeContext }]) => {
        await retireEntity(id, removeContext);
      },
      listEntities: (_ctx, [input]) => listEntities(input?.kind),
      resolveContext: (_ctx, [id]) => resolveContext(id),
      createContext: (ctx, [{ contextId, testPolicy }]) =>
        createContext(ctx, { contextId, testPolicy }),
      cloneContext: (ctx, [cloneArgs]) => cloneContext(ctx.caller, cloneArgs),
      destroyContext: async (ctx, [{ contextId, recursive }]) => {
        await destroyContext({ contextId, recursive });
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
    }),
  };
  return {
    definition,
    internal: {
      createEntity,
      createContext,
      resolveContext,
    },
  };
}
