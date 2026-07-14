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
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  runtimeMethods,
  type ClonedEntity,
  type CloneContextResult,
} from "@vibestudio/service-schemas/runtime";
import type { ContextEdge, ContextEdgeKind } from "@vibestudio/shared/runtime/contextEdges";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  buildWorkspaceContext,
  canonicalEntityId,
  type EntityRecord,
  type RuntimeAgentBinding,
  type RuntimeAgentBindingInput,
  type RuntimeEntityCreateSpec,
  type RuntimeEntityHandle,
  type RuntimeEntitySummary,
  type WorkspaceContext,
} from "@vibestudio/shared/runtime/entitySpec";
import type { WorkspaceEntityStore } from "../workspaceEntityStore.js";
import type { ResolvedExecutionBinding } from "../buildV2/index.js";
import {
  requireContextBoundaryPermission,
  type ContextBoundaryAction,
  type ContextBoundaryDeps,
} from "./contextBoundary.js";
import { isOpenPanelBrowserUrl } from "@vibestudio/shared/panelChrome";

export interface RuntimeEntityHooks {
  /** Prepare runtime resources for a "do" entity and return its exact code identity. */
  prepareDurableObject: (args: {
    source: string;
    execution: ResolvedExecutionBinding;
    className: string;
    key: string;
    contextId: string;
    stateArgs?: unknown;
  }) => Promise<{ targetId: string }>;

  /** Prepare runtime resources for a "worker" entity. */
  prepareWorker: (args: {
    source: string;
    execution: ResolvedExecutionBinding;
    key: string;
    contextId: string;
    stateArgs?: unknown;
    env?: Record<string, string>;
    /** Launch parent (the verified caller) → worker `PARENT_*` env, so the
     *  worker's `parent` resolves from the same source as `EntityRecord.parentId`. */
    parent?: { parentId: string; parentEntityId: string; parentKind?: "panel" | "worker" | "do" };
  }) => Promise<{ targetId: string }>;

  /** Resolve and verify the exact panel artifact before activation. */
  preparePanel: (args: { source: string; execution: ResolvedExecutionBinding }) => Promise<void>;

  /** Resolve and verify the exact app artifact before activation. */
  prepareApp: (args: { source: string; execution: ResolvedExecutionBinding }) => Promise<void>;

  /** Cleanup hooks invoked on retire — closed at bootstrap. */
  onRetire: (record: EntityRecord) => Promise<void>;

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

/** Context-folder lifecycle used by inert session entities. */
export interface RuntimeContextFolders {
  ensureContextFolder(contextId: string): Promise<string>;
  removeContext(contextId: string): Promise<void>;
}

/** VCS lifecycle hooks for full-workspace context branches. */
export interface RuntimeVcsContexts {
  /**
   * Pin a context's base view at creation (idempotent — pins the current
   * `workspaceView()` only if not already pinned) so its reads don't drift.
   */
  pinContext?(contextId: string): Promise<string>;
  /**
   * Tear down all VCS state for a context on retire: clear caches + delete its
   * `ctx` heads and pin ref.
   */
  dropContext?(contextId: string): Promise<void>;
  /**
   * Fork a context's file state: snapshot the SOURCE context's full working view
   * (committed ctx heads + uncommitted edits) as the TARGET context's pinned base,
   * so the clone starts as an isolated copy of the source's files and then diverges
   * independently. Used by `cloneContext`.
   */
  forkContext?(sourceContextId: string, targetContextId: string): Promise<void>;
}

export interface RuntimeServiceDeps {
  /**
   * The single owner of WorkspaceDO entity state. The runtime service never
   * dispatches `entityActivate`/`entityRetire` or touches the cache mirror
   * directly — the store pairs the durable write with the cache update so they
   * can't drift.
   */
  entityStore: WorkspaceEntityStore;
  /** The sole selector-to-artifact boundary; hooks launch only this exact result. */
  resolveExecutionArtifact: (source: string, ref?: string) => Promise<ResolvedExecutionBinding>;
  /** Cold exact lookup used by rollback/clone without re-resolving a moving head. */
  resolveExecutionArtifactByDigest: (executionDigest: string) => ResolvedExecutionBinding;
  hooks: RuntimeEntityHooks;
  contextBoundary: ContextBoundaryDeps;
  contextFolders: RuntimeContextFolders;
  /** Optional VCS hooks for pinning and dropping context branches. */
  vcsContexts?: RuntimeVcsContexts;
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

export function createRuntimeService(deps: RuntimeServiceDeps): ServiceDefinition {
  const store = deps.entityStore;

  /**
   * The context-boundary gate for DIRECT (userland) entity launch/destroy/
   * context ops. A genuinely host-originated operation bypasses the user prompt;
   * a runtime kind or caller id never creates that authority. Runs BEFORE any
   * side effect, so denial is non-destructive.
   */
  async function gateContextLaunch(
    caller: VerifiedCaller,
    targetContextId: string,
    action: ContextBoundaryAction
  ): Promise<void> {
    if (caller.hostOriginated === true) return;
    const originContextId = await store.resolveContext(caller.runtime.id);
    if (await callerOwnsLifecycleContext(caller, originContextId, targetContextId)) return;
    const result = await requireContextBoundaryPermission(deps.contextBoundary, {
      subjectCaller: caller,
      originContextId,
      targetContextId,
      action,
    });
    if (!result.allowed) {
      throw new Error(result.reason ?? "Context-boundary denied");
    }
  }

  function isTrustedRuntimeHost(caller: VerifiedCaller): boolean {
    return caller.hostOriginated === true;
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

  function isExtensionOrchestratedCreate(
    caller: VerifiedCaller,
    spec: RuntimeEntityCreateSpec
  ): boolean {
    if (!caller.code?.repoPath.startsWith("extensions/")) return false;
    return spec.kind === "session" || bindingFromSpec(spec) !== undefined;
  }

  async function resolveAgentBinding(
    caller: VerifiedCaller,
    method: string,
    contextId: string,
    binding: RuntimeAgentBindingInput | undefined
  ): Promise<RuntimeAgentBinding | undefined> {
    if (!binding) return undefined;
    if (!isTrustedRuntimeHost(caller) && !caller.code?.repoPath.startsWith("extensions/")) {
      throw new Error(
        `runtime.${method} agentBinding requires the host principal or exact extension code`
      );
    }
    const bound = await store.resolveRecord(binding.entityId);
    if (!bound || bound.status !== "active") {
      throw new Error(
        `runtime.createEntity agentBinding references an inactive entity: ${binding.entityId}`
      );
    }
    if (bound.contextId !== contextId) {
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

  async function resolveContextPolicy(
    caller: VerifiedCaller,
    requested: string | null | undefined,
    spec: RuntimeEntityCreateSpec
  ): Promise<string> {
    // Empty/omitted ⇒ a brand-new context (fresh ⇒ free, no gate).
    if (requested == null || requested === "") {
      return randomUUID();
    }
    if (!isExtensionOrchestratedCreate(caller, spec)) {
      await gateContextLaunch(caller, requested, {
        kind: "runtime",
        verb: `Create ${spec.kind}`,
        targetLabel: spec.source,
        targetLabelName: "Source",
        groupKey: `context-boundary:${requested}:${spec.source}`,
      });
    }
    return requested;
  }

  /**
   * Set up a full logical workspace context branch. Pinning freezes the base
   * workspace view so reads remain stable until the context explicitly rebases.
   * Per-repo ctx heads are created lazily by the VCS layer when the context edits
   * or commits a repo; repo membership is not part of the runtime contract.
   */
  async function setUpContext(contextId: string): Promise<WorkspaceContext> {
    // Pin the context's base view (a per-context VCS ref) so its reads are a
    // consistent snapshot and never drift as `main` advances under it. Idempotent:
    // a second entity joining the context inherits the existing pin.
    await deps.vcsContexts?.pinContext?.(contextId);
    return buildWorkspaceContext(contextId);
  }

  async function createEntity(
    caller: VerifiedCaller,
    rawSpec: RuntimeEntityCreateSpec
  ): Promise<RuntimeEntityHandle> {
    const spec = rawSpec;
    if (spec.kind === "app") {
      if (!caller.hostOriginated && (!caller.subject || caller.code)) {
        throw new Error("App runtime entities are host-managed");
      }
    }
    if (spec.kind === "session") {
      // Session entities are host/user-device managed, except exact extension
      // code may create a source-tagged session for a launch it owns.
      const orchestratorExtension =
        caller.code?.repoPath.startsWith("extensions/") === true && Boolean(spec.source);
      if (!caller.hostOriginated && (!caller.subject || caller.code) && !orchestratorExtension) {
        throw new Error("Session runtime entities are host-managed");
      }
    }
    // Gate (context-boundary) then prepare+activate. The gate is the ONLY caller
    // of the boundary check on this path; `activateEntity` is gate-free so internal
    // orchestration (cloneContext) can create clones after a single source-gate.
    const contextId = await resolveContextPolicy(caller, spec.contextId, spec);
    const agentBinding = await resolveAgentBinding(
      caller,
      "createEntity",
      contextId,
      bindingFromSpec(spec)
    );
    return activateEntity(caller, spec, contextId, agentBinding);
  }

  /**
   * Prepare runtime resources for an entity and commit its durable row — WITHOUT
   * the context-boundary gate. `createEntity` calls this after gating; `cloneContext`
   * calls it per-clone after a single gate on the source context. `parentId` is the
   * caller, so a cloneContext caller owns (and may freely destroy) the clones.
   */
  async function activateEntity(
    caller: VerifiedCaller,
    spec: RuntimeEntityCreateSpec,
    initialContextId: string,
    agentBinding?: RuntimeAgentBinding,
    exactExecution?: ResolvedExecutionBinding
  ): Promise<RuntimeEntityHandle> {
    let contextId = initialContextId;
    const key = spec.key ?? randomUUID();

    let canonicalId: string;
    let executionDigest: string | undefined;
    let authorityRequests: ResolvedExecutionBinding["requested"] | undefined;
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
      const execution =
        exactExecution ?? (await deps.resolveExecutionArtifact(spec.source, spec.ref));
      const prepared = await deps.hooks.prepareDurableObject({
        source: spec.source,
        execution,
        className: spec.className,
        key,
        contextId,
        stateArgs: spec.stateArgs,
      });
      executionDigest = execution.artifact.executionDigest;
      authorityRequests = execution.requested;
      targetId = prepared.targetId;
    } else if (spec.kind === "worker") {
      canonicalId = canonicalEntityId({ kind: "worker", source: spec.source, key });
      existing = await store.resolveRecord(canonicalId);
      const parentKind = caller.runtime.kind;
      const execution =
        exactExecution ?? (await deps.resolveExecutionArtifact(spec.source, spec.ref));
      const prepared = await deps.hooks.prepareWorker({
        source: spec.source,
        execution,
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
      executionDigest = execution.artifact.executionDigest;
      authorityRequests = execution.requested;
      targetId = prepared.targetId;
    } else if (spec.kind === "app") {
      canonicalId = canonicalEntityId({ kind: "app", source: spec.source, key });
      existing = await store.resolveRecord(canonicalId);
      const execution =
        exactExecution ?? (await deps.resolveExecutionArtifact(spec.source, spec.ref));
      await deps.hooks.prepareApp({
        source: spec.source,
        execution,
      });
      executionDigest = execution.artifact.executionDigest;
      authorityRequests = execution.requested;
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
      targetId = canonicalId;
    } else if (spec.surface === "browser") {
      const externalUrl = spec.source.startsWith("browser:")
        ? spec.source.slice("browser:".length)
        : "";
      if (!externalUrl || !isOpenPanelBrowserUrl(externalUrl)) {
        throw new Error(`Invalid external browser panel source: ${spec.source}`);
      }
      canonicalId = canonicalEntityId({ kind: "panel", key });
      existing = await store.resolveRecord(canonicalId);
      // Browser panels are host-rendered external documents, not workspace
      // code. They receive a durable entity incarnation for slot lineage and
      // leases, but deliberately have no code build or execution digest.
      targetId = canonicalId;
    } else {
      if (spec.source.startsWith("browser:")) {
        throw new Error(`Workspace panel source cannot use the browser: namespace: ${spec.source}`);
      }
      canonicalId = canonicalEntityId({ kind: "panel", key });
      existing = await store.resolveRecord(canonicalId);
      const execution =
        exactExecution ?? (await deps.resolveExecutionArtifact(spec.source, spec.ref));
      await deps.hooks.preparePanel({
        source: spec.source,
        execution,
      });
      executionDigest = execution.artifact.executionDigest;
      authorityRequests = execution.requested;
      targetId = canonicalId;
    }

    // A context is a full logical workspace branch. The VCS layer lazily creates
    // per-repo ctx heads as this branch edits repos.
    await setUpContext(contextId);

    const activateInput = {
      kind: spec.kind,
      source: { repoPath: spec.source },
      activeExecutionDigest: executionDigest,
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
      ...(record.activeExecutionDigest ? { executionDigest: record.activeExecutionDigest } : {}),
      ...(authorityRequests ? { authorityRequests } : {}),
      contextId: record.contextId,
      targetId,
    };
  }

  /**
   * Create a full logical workspace context branch without attaching an entity
   * to it yet. Useful when an orchestrator wants several entities to share a
   * branch. Repo selection remains an operation-level concern on VCS methods.
   */
  async function createContext(
    caller: VerifiedCaller,
    args: { contextId?: string }
  ): Promise<WorkspaceContext> {
    // A named, already-existing foreign context is gated (this re-pins its VCS /
    // re-materializes its folder); a fresh/omitted contextId is free.
    if (args.contextId != null && args.contextId !== "") {
      await gateContextLaunch(caller, args.contextId, { kind: "runtime", verb: "Set up context" });
    }
    const contextId = args.contextId ?? randomUUID();
    const context = await setUpContext(contextId);
    await deps.contextFolders.ensureContextFolder(contextId);
    return context;
  }

  /**
   * Durable retire + cleanup hooks for ONE entity, WITHOUT the context-boundary
   * gate. `retireEntity` calls this after gating; `cloneContext` rollback and
   * `destroyContext` call it directly (their gate is on the context as a whole).
   */
  async function retireRecord(id: string): Promise<EntityRecord | null> {
    const record = await store.retire(id);
    if (!record) return null;
    try {
      await deps.hooks.onRetire(record);
      await store.cleanupComplete(id);
    } catch {
      // Leave cleanup_complete=0; cleanupReaper will retry.
    }
    return record;
  }

  async function retireEntity(
    caller: VerifiedCaller,
    id: string,
    removeContext?: boolean
  ): Promise<void> {
    // Gate BEFORE mutating. Resolve the target's context via the DURABLE store
    // (the active cache may already be evicting it). A null/unknown/already-
    // retired target ⇒ the retire below no-ops ⇒ allow.
    const target = await store.resolveRecord(id);
    if (target?.status === "active" && !callerOwnsEntity(caller, target)) {
      await gateContextLaunch(caller, target.contextId, {
        kind: "runtime",
        verb: removeContext ? "Retire entity and remove context" : "Retire entity",
        targetLabel: id,
        targetLabelName: "Runtime entity",
        ...(removeContext ? { severity: "severe" as const } : {}),
      });
    }
    const record = await retireRecord(id);
    if (!record) return;
    // Agent credentials follow the entity: revoke outstanding credentials + the
    // live agent token so a retired entity's bound agent sessions can't
    // re-authenticate (§3.2).
    await deps.revokeAgentCredentials?.(id);
    if (removeContext) {
      const live = await store.listActive();
      if (!live.some((e) => e.contextId === record.contextId)) {
        // Tear down VCS state (caches + ctx heads + pin ref) before the folder.
        await deps.vcsContexts?.dropContext?.(record.contextId).catch(() => undefined);
        await deps.contextFolders.removeContext(record.contextId);
      }
    }
  }

  /** Build clone identity fields; executable identity is supplied independently
   *  from the source record's exact active incarnation. */
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
    await gateContextLaunch(caller, sourceContextId, {
      kind: "runtime",
      verb: "Clone context",
      targetLabel: sourceContextId,
      targetLabelName: "Source context",
    });

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
        // Fork file state FIRST: pin the new context to the source's working
        // snapshot so clones materialize the source's files, then diverge.
        // Idempotent under retry (gad-store fork + folder guard + upsert storage).
        await deps.vcsContexts?.forkContext?.(srcCtx, targetCtx);
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
          if (!src.activeExecutionDigest) {
            throw new Error(`cloneContext: code-backed entity ${src.id} has no active execution`);
          }
          const exactExecution = deps.resolveExecutionArtifactByDigest(src.activeExecutionDigest);
          const handle = await activateEntity(
            caller,
            buildCloneSpec(src, targetCtx, newKey),
            targetCtx,
            undefined,
            exactExecution
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
        await deps.vcsContexts?.dropContext?.(c).catch(() => undefined);
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
  async function destroyOneContext(
    caller: VerifiedCaller,
    contextId: string,
    gate: boolean
  ): Promise<void> {
    const entities = (await store.listActive()).filter((e) => e.contextId === contextId);
    if (gate) {
      // Ownership bypass: a context whose every active entity you launched is
      // yours to destroy. Otherwise gate (gateContextLaunch still frees your own
      // context + trusted chrome). An empty context falls through to the gate.
      const owned = entities.length > 0 && entities.every((e) => e.parentId === caller.runtime.id);
      if (!owned) {
        await gateContextLaunch(caller, contextId, {
          kind: "runtime",
          verb: "Destroy context",
          targetLabel: contextId,
          targetLabelName: "Context",
          severity: "severe",
        });
      }
    }
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
    await deps.vcsContexts?.dropContext?.(contextId).catch(() => undefined);
    await deps.contextFolders.removeContext(contextId).catch(() => undefined);
  }

  /**
   * Tear a whole context down. `recursive` (the default when lifecycle children
   * exist) does a POST-ORDER teardown of the LIFECYCLE subtree only — subagent
   * worlds die with their owner (§B7). Lineage (fork) edges are NEVER crossed:
   * destroying a conversation never destroys its forks. `recursive:false`
   * destroys only this context (any lifecycle children are left for the TTL sweep).
   */
  async function destroyContext(
    caller: VerifiedCaller,
    args: { contextId: string; recursive?: boolean }
  ): Promise<void> {
    const recursive = args.recursive ?? true;
    const seen = new Set<string>();
    const teardown = async (contextId: string, gate: boolean): Promise<void> => {
      if (seen.has(contextId)) return;
      seen.add(contextId);
      if (recursive) {
        const children = await store.listContextEdgesByOwner({
          ownerContextId: contextId,
          kind: "lifecycle",
        });
        // Post-order: leaves first, then the parent.
        for (const child of children) await teardown(child.contextId, false);
      }
      await destroyOneContext(caller, contextId, gate);
    };
    await teardown(args.contextId, true);
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
    await gateContextLaunch(caller, args.parentContextId, {
      kind: "runtime",
      verb: "Create subagent context",
      targetLabel: args.ownerEntityId,
      targetLabelName: "Owner entity",
      groupKey: `context-boundary:subagent:${args.parentContextId}:${args.ownerEntityId}`,
    });

    const contextId = deriveContextId(args.targetKey);
    // Order mirrors cloneContext: fork file state, then materialize the folder.
    await deps.vcsContexts?.forkContext?.(args.parentContextId, contextId);
    await deps.contextFolders.ensureContextFolder(contextId);
    await store.recordContextEdge({
      contextId,
      ownerContextId: args.parentContextId,
      kind: "lifecycle",
      ownerEntityId: args.ownerEntityId,
    });
    return { contextId };
  }

  async function listEntities(kind?: string): Promise<RuntimeEntitySummary[]> {
    const live = await store.listActive(kind);
    return live.map((record) => {
      const stateArgs = record.stateArgs;
      const title =
        stateArgs != null &&
        typeof stateArgs === "object" &&
        typeof (stateArgs as { title?: unknown }).title === "string"
          ? ((stateArgs as { title: string }).title as string)
          : undefined;
      const execution = record.activeExecutionDigest
        ? deps.resolveExecutionArtifactByDigest(record.activeExecutionDigest)
        : null;
      if (
        execution &&
        (execution.artifact.executionDigest !== record.activeExecutionDigest ||
          execution.artifact.source.repoPath !== record.source.repoPath)
      ) {
        throw new Error(`Active execution identity mismatch for runtime entity ${record.id}`);
      }
      return {
        id: record.id,
        kind: record.kind,
        source: record.source.repoPath,
        contextId: record.contextId,
        title,
        createdAt: record.createdAt,
        ...(execution
          ? {
              executionDigest: execution.artifact.executionDigest,
              authorityRequests: execution.requested,
            }
          : {}),
      };
    });
  }

  async function resolveContext(id: string): Promise<string | null> {
    return await store.resolveContext(id);
  }

  return {
    name: "runtime",
    description: "Runtime entity creation and retirement",
    authority: { principals: ["code", "user", "host"] },
    methods: runtimeMethods,
    handler: defineServiceHandler("runtime", runtimeMethods, {
      createEntity: (ctx, [spec]) => createEntity(ctx.caller, spec),
      retireEntity: async (ctx, [{ id, removeContext }]) => {
        await retireEntity(ctx.caller, id, removeContext);
      },
      listEntities: (_ctx, [input]) => listEntities(input?.kind),
      resolveContext: (_ctx, [id]) => resolveContext(id),
      createContext: (ctx, [{ contextId }]) => createContext(ctx.caller, { contextId }),
      cloneContext: (ctx, [cloneArgs]) => cloneContext(ctx.caller, cloneArgs),
      destroyContext: async (ctx, [{ contextId, recursive }]) => {
        await destroyContext(ctx.caller, { contextId, recursive });
      },
      listOwnedContexts: (_ctx, [listArgs]) => listOwnedContexts(listArgs),
      recordContextEdge: async (ctx, [edgeArgs]) => {
        await recordContextEdge(ctx.caller, edgeArgs);
      },
      createSubagentContext: (ctx, [subArgs]) => createSubagentContext(ctx.caller, subArgs),
      setTitle: async (ctx, [title, options]) => {
        // Access is enforced by the per-method policy on `runtimeMethods.setTitle`
        // (principals: panel/app/worker/do), checked by the dispatcher before this
        // handler runs. We deliberately do NOT re-gate caller kind here — declared
        // policy == enforced, with a single source of truth (no handler-side narrowing).
        await deps.setEntityTitle?.(ctx.caller.runtime.id, title == null ? undefined : title, {
          explicit: options?.explicit === true,
        });
      },
    }),
  };
}
