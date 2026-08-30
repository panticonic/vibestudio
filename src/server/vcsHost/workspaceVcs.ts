/**
 * Host boundary for the semantic workspace history.
 *
 * The semantic control plane owns meaning and history. This server boundary:
 *
 * - dispatches one semantic command;
 * - drains its exact journaled host effects;
 * - owns content bytes, context materialization, and protected-ref CAS;
 * - provides content-addressed reads and immutable build inputs; and
 * - exact host receipts for materialization and publication.
 *
 * There are no host commits, branches, merges, pending states, conflict
 * stores, staging areas, ancestry helpers, or provenance reconstructions.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import * as crypto from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";

import type {
  VcsImportSnapshotResult,
  VcsInspectResult,
  VcsPushResult,
  VcsReadFileResult,
  VcsStateNodeRef,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import type {
  ProtectedPublicationEvent,
  ProtectedPublicationFileChange,
} from "@vibestudio/shared/protectedPublicationEvents";
import {
  canonicalJson,
  compareUtf16CodeUnits,
  EMPTY_STATE_HASH,
  sha256HexSyncText,
} from "@vibestudio/content-addressing";
import {
  type ContextMaterializationCommand,
  type WorkspaceMaterializationBlob,
  type WorkspaceMaterializationRepository,
} from "@vibestudio/shared/vcs/workspaceProjection";
import { hostRefBasisDigest } from "@vibestudio/shared/vcs/publication";
import {
  collectTreeReachableDigests,
  diffTrees,
  getBytes,
  materializeTree,
  putBytes,
  readFileAtTree,
  readTreeDirectory,
  resolveTreePath,
  sweepUnreachableBlobs,
  type TreeDiff,
} from "../services/blobstoreService.js";
import {
  assertExecutionSourceContentRoot,
  type ExecutionSourceContentRoot,
} from "../services/executionSourceRoots.js";
import type {
  AppliedPublication,
  ProtectedRefPublication,
  ProtectedRefStore,
} from "../services/protectedRefStore.js";
import type {
  BuildRecord,
  WorkspaceStateFile,
  WorkspaceStateSource,
} from "../buildV2/stateTrigger.js";
import type { BuildSourceProvider } from "../buildV2/buildSource.js";
import { type GraphNode, type PackageGraph } from "../buildV2/packageGraph.js";
import { discoverPackageGraphAtTree } from "../buildV2/packageGraphTree.js";
import { joinRepoPrefix, normalizeRepositoryPath } from "./paths.js";
import { ContentProjectionStore } from "./contentProjectionStore.js";
import { DiskProjector } from "./diskProjector.js";
import { ContextMaterializer } from "./contextMaterializer.js";
import { discoverRepos } from "./repoDiscovery.js";
import type {
  WorkspaceSemanticPort,
  WorkspaceSourceProviderV1,
  WorkspaceSourceSemanticDispatchResult,
  WorkspaceSourceSemanticEffect,
} from "../workspaceSourceProvider.js";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { RpcCausalParent } from "@vibestudio/rpc";
import { WorkspaceRepositories } from "./workspaceRepositories.js";
import type { WorkspaceRootTemplateBootstrap } from "../workspaceRootTemplateBootstrap.js";

/**
 * The semantic wire surface, derived from the port rather than mirrored beside
 * it. A hand-written dispatch switch let `vcs.walk`, `vcs.query`, and
 * `vcs.search` ship with schemas, host authorization, and DO implementations
 * while every call still failed at this hop, because nothing typed the two
 * lists against each other. `satisfies` now makes an undispatched port method
 * a compile error.
 */
type SemanticWireMethod = Extract<keyof WorkspaceSemanticPort, `vcs${string}`>;

const SEMANTIC_WIRE_METHODS = {
  vcsEdit: true,
  vcsMove: true,
  vcsCopy: true,
  vcsMerge: true,
  vcsRevert: true,
  vcsCommit: true,
  vcsDiscard: true,
  vcsImportSnapshot: true,
  vcsRegisterExternalDelta: true,
  vcsSupersedeExternalDelta: true,
  vcsFinalizeExternalDelta: true,
  vcsPush: true,
  vcsStatus: true,
  vcsCompare: true,
  vcsInspect: true,
  vcsNeighbors: true,
  vcsHistory: true,
  vcsBlame: true,
  vcsWalk: true,
  vcsQuery: true,
  vcsSearch: true,
  vcsReadMemory: true,
  vcsResolveRepository: true,
  vcsReadFile: true,
  vcsListDirectory: true,
  vcsListFiles: true,
} as const satisfies Record<SemanticWireMethod, true>;

export function isSemanticWireMethod(method: string): method is SemanticWireMethod {
  return Object.hasOwn(SEMANTIC_WIRE_METHODS, method);
}

const SYSTEM_ACTOR = { id: "system", kind: "system" } as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const BUILDS_LOG_ID = "builds:workspace";
const CONTENT_OBSERVATION_CONCURRENCY = 32;
const SLOW_SEMANTIC_EFFECT_MS = 500;

export interface ExactRepositorySnapshotPlan {
  version: 1;
  contextId: string;
  repositoryId: string;
  repoPath: string;
  sourceState: VcsStateNodeRef;
  contentRoot: string;
  repositoryManifestDigest: string;
  materializedTreeDigest: string;
  requiredFiles: Array<{ path: string; contentHash: string; byteLength: number }>;
  realization: {
    repository: Extract<WorkspaceMaterializationRepository, { presence: "present" }>;
    blobs: WorkspaceMaterializationBlob[];
  };
  planDigest: string;
}

function intrinsicContentDescriptor(bytes: Uint8Array): {
  contentKind: "text" | "bytes";
  byteLength: number;
  coordinateExtent: number;
} {
  const byteLength = bytes.byteLength;
  try {
    const text = UTF8_DECODER.decode(bytes);
    return { contentKind: "text", byteLength, coordinateExtent: text.length };
  } catch {
    return { contentKind: "bytes", byteLength, coordinateExtent: byteLength };
  }
}

export interface WorkspaceVcsDeps {
  blobsDir: string;
  workspaceRoot: string;
  extractMainToSource?: boolean;
  /** Exact current-epoch context-projection root supplied by state topology. */
  contextProjectionsRoot: string;
  workspaceId: string;
  buildSourcesRoot: string;
  refs: ProtectedRefStore;
  /** The only pre-userland template path: acquire one exact root for first publication. */
  rootTemplateBootstrap?: Pick<
    WorkspaceRootTemplateBootstrap,
    "prepareSource" | "prepareInitialization"
  >;
}

export interface WorkspaceActivationTimings {
  ensureContextAndMaterializationMs: number;
  inspectMs: number;
  sourceScanMs: number;
  sourceHashAndBlobIngestMs: number;
  casTreeMirrorMs: number;
  importSnapshotMs: number;
  initializationPushMs: number;
  ensureFreshMs: number;
  totalMs: number;
}

export interface PreparedWorkspaceGc {
  readonly epoch: number;
  commit(): Promise<{ scanned: number; swept: number; bytes: number }>;
}

interface SemanticRequest {
  input: unknown;
  ingress: {
    causalParent: import("@vibestudio/rpc").RpcCausalParent | null;
    contextIntegrity: {
      class: "internal" | "external";
      externalKeys: readonly string[];
    };
  };
}

/** Host lifecycle/source operations are not model cognition. */
const HOST_SEMANTIC_INTEGRITY = Object.freeze({
  class: "internal" as const,
  externalKeys: Object.freeze([]) as readonly string[],
});

function semanticRequestContextId(request: unknown): string | null {
  if (!request || typeof request !== "object") return null;
  const input = (request as Record<string, unknown>)["input"];
  if (!input || typeof input !== "object") return null;
  const contextId = (input as Record<string, unknown>)["contextId"];
  return typeof contextId === "string" && contextId.length > 0 ? contextId : null;
}

function semanticCallAbortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error(
    typeof signal.reason === "string" ? signal.reason : "Semantic VCS call aborted"
  );
  error.name = "AbortError";
  return error;
}

/**
 * Caller-driven publication includes review, authority acquisition, protected
 * ref mutation, and semantic acknowledgement. Cancellation owns that complete
 * operation, not only the final authority wait. Racing at the per-context lock
 * boundary releases later status/recovery calls immediately; any detached
 * publication continuation still carries the already-aborted gate signal, so
 * it cannot newly acquire authority. If protected refs were already applied,
 * their durable publication receipt makes the caller's exact retry safe.
 */
function abortableSemanticCall<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(semanticCallAbortError(signal));
  const pending = operation();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(semanticCallAbortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    pending.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      }
    );
  });
}

export type CallerPublicationGateContext = {
  kind: "caller";
  caller: VerifiedCaller;
  signal?: AbortSignal;
  via?: string;
  /** Host-composed exact candidate view, added by publishMain before gating. */
  candidateWorkspaceState?: string;
  epochTransition?: true;
};

type PublicationGateContext = CallerPublicationGateContext | { kind: "workspace-initialization" };

type SemanticEffect = WorkspaceSourceSemanticEffect;
type SemanticDispatchResult = WorkspaceSourceSemanticDispatchResult;

const VERIFIED_BUILD_TREE_LIMIT = 10_000;

export type ContentFile = WorkspaceStateFile;

export class WorkspaceVcs implements WorkspaceStateSource, BuildSourceProvider {
  readonly contentProjection: ContentProjectionStore;
  readonly repositories: WorkspaceRepositories;

  get workspaceId(): string {
    return this.deps.workspaceId;
  }

  private gadCaller: WorkspaceSemanticPort | null = null;
  private sourceProviderCaller: WorkspaceSourceProviderV1 | null = null;
  private readonly protectedPublicationListeners = new Set<
    (event: ProtectedPublicationEvent) => void | Promise<void>
  >();
  private readonly projector: DiskProjector;
  private readonly materializer: ContextMaterializer;
  private readonly locks = new Map<string, Promise<unknown>>();
  private protectedMainMutationTail: Promise<void> = Promise.resolve();
  private readonly protectedMainMutationScope = new AsyncLocalStorage<boolean>();
  private readonly semanticContextInitializations = new Map<string, Promise<VcsStateNodeRef>>();
  private readonly contextInitializations = new Map<string, Promise<VcsStateNodeRef>>();
  private readonly semanticStateByContent = new Map<string, VcsStateNodeRef>();
  /** Exact materialization receipt verified during this host generation. An
   * absent entry (including after restart) requires one disk integrity scan. */
  private readonly verifiedProjectionStates = new Map<string, string>();
  /**
   * Exact immutable build-source entries established during this host
   * generation. Build roots are private derived data and never editable;
   * repeatedly walking the same local-package closure made unrelated extension
   * builds dominate cold panel startup. Missing entries are always
   * re-projected, and process restart forgets every receipt so disk state is
   * verified again.
   */
  private readonly verifiedBuildTrees = new Map<string, string>();
  private ensureFreshInFlight: Promise<{ stateHash: string }> | null = null;

  constructor(private readonly deps: WorkspaceVcsDeps) {
    this.contentProjection = new ContentProjectionStore({ blobsDir: deps.blobsDir });
    this.projector = new DiskProjector({
      contentProjection: this.contentProjection,
      workspaceRoot: deps.workspaceRoot,
      contextProjectionsRoot: deps.contextProjectionsRoot,
    });
    this.materializer = new ContextMaterializer({
      blobsDir: deps.blobsDir,
      workspaceId: deps.workspaceId,
      disk: this.projector,
    });
    this.repositories = new WorkspaceRepositories({
      blobsDir: deps.blobsDir,
      refs: deps.refs,
      contentProjection: this.contentProjection,
      discoverGraph: (stateHash) => this.discoverGraph(stateHash),
    });
    this.deps.refs.onRefsChanged((publication) => this.onProtectedRefsPublished(publication));
  }

  get attached(): boolean {
    return this.gadCaller !== null;
  }

  async prepareGc(options: {
    minAgeMs: number;
    epoch: number;
    executionSourceRoots: readonly ExecutionSourceContentRoot[];
  }): Promise<PreparedWorkspaceGc> {
    const reachable = await this.collectGcReachableDigests(options.executionSourceRoots);
    let committed = false;
    return {
      epoch: options.epoch,
      commit: async () => {
        if (committed) throw new Error(`Content GC epoch ${options.epoch} was already committed`);
        committed = true;
        // A materialization may finish after the initial read-only preflight
        // and before the shared epoch commits. Re-read all durable and cached
        // roots at the destructive boundary so a newly published state cannot
        // be mistaken for garbage. Keeping the first snapshot as well is
        // intentional: roots retired during the epoch remain protected until
        // the normal age grace period expires.
        const finalReachable = await this.collectGcReachableDigests(options.executionSourceRoots);
        for (const digest of reachable) finalReachable.add(digest);
        return sweepUnreachableBlobs(this.deps.blobsDir, finalReachable, options.minAgeMs);
      },
    };
  }

  private async collectGcReachableDigests(
    executionSourceRoots: readonly ExecutionSourceContentRoot[]
  ): Promise<Set<string>> {
    const semantic = await this.gad().contentGcRoots();
    const roots = new Set(semantic.contentRoots);
    const mainRoots = new Set<string>();
    for (const main of this.deps.refs.listMains()) {
      mainRoots.add(main.contentRoot);
      roots.add(main.contentRoot);
    }
    const executionRoots = new Set<string>();
    const executionRootPaths = new Map<string, Set<string>>();
    for (const executionRoot of executionSourceRoots) {
      const validated = assertExecutionSourceContentRoot(executionRoot);
      const stateHash = validated.stateHash;
      executionRoots.add(stateHash);
      roots.add(stateHash);
      const paths = executionRootPaths.get(stateHash) ?? new Set<string>();
      paths.add(validated.repoPath ?? "<workspace>");
      executionRootPaths.set(stateHash, paths);
    }
    const reachable = new Set(semantic.contentHashes);
    for (const root of roots) {
      const tree = await collectTreeReachableDigests(this.deps.blobsDir, root, {
        verifyContent: true,
      });
      if (!tree) {
        const provenance = semantic.contentRoots.includes(root)
          ? "semantic materialization/pending effect"
          : mainRoots.has(root)
            ? "protected main"
            : executionRoots.has(root)
              ? `retained execution source (${[...(executionRootPaths.get(root) ?? [])].join(
                  ", "
                )})`
              : "unknown";
        throw new Error(
          `GC root ${root} is missing from the content store (provenance: ${provenance})`
        );
      }
      for (const digest of tree.treeDigests) reachable.add(digest);
      for (const digest of tree.contentDigests) reachable.add(digest);
    }
    // Workspace/context views are immutable CAS compositions, not semantic
    // history nodes. They are nevertheless live build inputs while retained
    // by WorkspaceRepositories, so their scaffold nodes must participate in
    // the same reachability snapshot as semantic repository roots. Omitting
    // them leaves a cached state pointer whose interior directory manifests
    // have been swept, and the next exact build fails while walking the tree.
    const cachedViews = await this.repositories.collectCachedReachableDigests();
    for (const digest of cachedViews.treeDigests) reachable.add(digest);
    for (const digest of cachedViews.contentDigests) reachable.add(digest);
    return reachable;
  }

  async runGc(options: {
    minAgeMs: number;
    epoch: number;
    executionSourceRoots: readonly ExecutionSourceContentRoot[];
  }): Promise<{
    scanned: number;
    swept: number;
    bytes: number;
  }> {
    return (await this.prepareGc(options)).commit();
  }

  async inspectContentRoot(
    stateHash: string
  ): Promise<{ reconstructible: boolean; missing: readonly string[] }> {
    try {
      const closure = await collectTreeReachableDigests(this.deps.blobsDir, stateHash, {
        verifyContent: true,
      });
      if (!closure) {
        return {
          reconstructible: false,
          missing: [`source content root ${stateHash}`],
        };
      }
      return { reconstructible: true, missing: [] };
    } catch (error) {
      return {
        reconstructible: false,
        missing: [
          `source content root ${stateHash}: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  async referencesReachable(
    contextIds: readonly string[],
    references: readonly { kind: string; value: unknown }[]
  ): Promise<boolean> {
    return this.gad().referencesReachable({ contextIds, references });
  }

  async listSemanticContexts(prefix?: string): Promise<string[]> {
    return this.gad().listContexts({
      ...(prefix === undefined ? {} : { prefix }),
    });
  }

  async isStateDescendant(
    ancestor: VcsStateNodeRef,
    descendant: VcsStateNodeRef
  ): Promise<boolean> {
    return this.gad().isStateDescendant({
      ancestor,
      descendant,
      maxEdges: 100_000,
    });
  }

  async attachGad(gad: WorkspaceSemanticPort): Promise<void> {
    if (this.gadCaller) throw new Error("semantic workspace is already attached");
    this.gadCaller = gad;
  }

  attachWorkspaceSourceProvider(provider: WorkspaceSourceProviderV1): void {
    if (this.sourceProviderCaller) {
      throw new Error("workspace source provider is already attached");
    }
    this.sourceProviderCaller = provider;
  }

  /**
   * Resolve the workspace source provider's provenance for one durable channel
   * envelope. This is a source-provider read, not a semantic VCS command: routing
   * it through a semantic VCS operation would conflate the GAD's log API with
   * the finite semantic-workspace command vocabulary.
   */
  getChannelEnvelopeIntegrity(input: {
    channelId: string;
    envelopeId: string;
  }): Promise<{ contentClass: "internal" | "external" } | null> {
    return this.gad().getChannelEnvelope(input);
  }

  /** Dispatch meaning, drain exact host commands, acknowledge, and continue. */
  async semanticCall<T>(
    method: string,
    request: SemanticRequest,
    publicationGateContext?: CallerPublicationGateContext
  ): Promise<T> {
    return this.dispatchSemanticCall(method, request, publicationGateContext);
  }

  private async dispatchSemanticCall<T>(
    method: string,
    request: SemanticRequest,
    publicationGateContext?: PublicationGateContext
  ): Promise<T> {
    const dispatch = async (): Promise<T> => {
      const next = await this.dispatchSemanticWire(method, request);
      return this.drainSemanticResult<T>(next, publicationGateContext);
    };
    const operation = (): Promise<T> => {
      const signal =
        publicationGateContext?.kind === "caller" ? publicationGateContext.signal : undefined;
      return signal ? abortableSemanticCall(dispatch, signal) : dispatch();
    };
    const contextId = semanticRequestContextId(request);
    return contextId ? this.locked(`context-lifecycle:${contextId}`, operation) : operation();
  }

  private dispatchSemanticWire(
    method: string,
    request: SemanticRequest
  ): Promise<WorkspaceSourceSemanticDispatchResult> {
    if (!isSemanticWireMethod(method)) {
      throw new Error(`Invalid semantic VCS method ${JSON.stringify(method)}`);
    }
    return this.gad()[method](request);
  }

  semanticDirectCall<T>(method: string, input: unknown): Promise<T> {
    return this.semanticCall<T>(method, {
      input,
      ingress: { causalParent: null, contextIntegrity: HOST_SEMANTIC_INTEGRITY },
    } satisfies SemanticRequest);
  }

  private semanticWorkspaceInitializationPush<T>(input: unknown): Promise<T> {
    return this.withProtectedMainMutation(() =>
      this.dispatchSemanticCall<T>(
        "vcsPush",
        {
          input,
          ingress: { causalParent: null, contextIntegrity: HOST_SEMANTIC_INTEGRITY },
        } satisfies SemanticRequest,
        { kind: "workspace-initialization" }
      )
    );
  }

  /** Record the one upstream causal edge carried by a trusted host adapter. */
  semanticCausalCall<T>(
    method: string,
    input: unknown,
    causalParent: RpcCausalParent | null,
    contextIntegrity: SemanticRequest["ingress"]["contextIntegrity"]
  ): Promise<T> {
    return this.semanticCall<T>(method, {
      input,
      ingress: { causalParent, contextIntegrity },
    } satisfies SemanticRequest);
  }

  /** Publish through the ordinary semantic request while keeping authorization
   * at the protected-ref gate, separate from causal provenance. */
  semanticPublishCall<T>(
    input: unknown,
    causalParent: RpcCausalParent | null,
    caller: VerifiedCaller,
    contextIntegrity: SemanticRequest["ingress"]["contextIntegrity"],
    signal?: AbortSignal
  ): Promise<T> {
    return this.withProtectedMainMutation(() =>
      this.semanticCall<T>(
        "vcsPush",
        {
          input,
          ingress: { causalParent, contextIntegrity },
        } satisfies SemanticRequest,
        { kind: "caller", caller, ...(signal ? { signal } : {}) }
      )
    );
  }

  semanticEpochTransitionPublishCall<T>(
    input: unknown,
    causalParent: RpcCausalParent | null,
    caller: VerifiedCaller,
    contextIntegrity: SemanticRequest["ingress"]["contextIntegrity"],
    signal?: AbortSignal
  ): Promise<T> {
    return this.withProtectedMainMutation(() =>
      this.semanticCall<T>(
        "vcsPush",
        {
          input,
          ingress: { causalParent, contextIntegrity },
        } satisfies SemanticRequest,
        { kind: "caller", caller, epochTransition: true, ...(signal ? { signal } : {}) }
      )
    );
  }

  /**
   * One workspace-wide protected-main authoring lease. Callers that must read
   * main, author a candidate, journal its publication intent, and publish may
   * hold this across the whole sequence. Ordinary pushes enter the same lease
   * through `semanticPublishCall`, so no second serialization domain can move
   * main between preparation and publication.
   */
  async withProtectedMainMutation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.protectedMainMutationScope.getStore()) return operation();
    const previous = this.protectedMainMutationTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.protectedMainMutationTail = previous.catch(() => undefined).then(() => current);
    await previous.catch(() => undefined);
    try {
      return await this.protectedMainMutationScope.run(true, operation);
    } finally {
      release();
    }
  }

  private async drainSemanticResult<T>(
    initial: SemanticDispatchResult,
    publicationGateContext?: PublicationGateContext
  ): Promise<T> {
    let result = initial;
    for (let step = 0; step < 1_000; step += 1) {
      if (result.kind === "complete") return result.result as T;
      if (result.kind === "host-read") {
        if (result.request["kind"] === "read-merge-content") {
          result = await this.executeMergeContentHostRead(result.request);
          continue;
        }
        return (await this.executeHostRead(result.request)) as T;
      }
      const effect = result.effects[0];
      if (!effect) throw new Error("semantic command reported effects-pending without an effect");
      const effectStartedAt = performance.now();
      const receipt = await this.executeSemanticEffect(effect, publicationGateContext);
      const executeMs = performance.now() - effectStartedAt;
      // The applied head remains replay evidence; marking it acknowledged
      // before the semantic ack closes the crash gap that could otherwise
      // leave one uncompactible evidence row per publication.
      if (effect.kind === "publish-main") {
        this.deps.refs.acknowledgePublication(effect.effectId);
      }
      const acknowledgeStartedAt = performance.now();
      result = await this.gad().semanticEffectAck({
        acknowledgement: {
          effectId: effect.effectId,
          payloadDigest: effect.payloadDigest,
          receipt,
        },
      });
      const acknowledgeMs = performance.now() - acknowledgeStartedAt;
      const totalMs = performance.now() - effectStartedAt;
      if (totalMs >= SLOW_SEMANTIC_EFFECT_MS) {
        console.info("[Vcs] slow semantic effect", {
          kind: effect.kind,
          executeMs: Math.round(executeMs),
          acknowledgeMs: Math.round(acknowledgeMs),
          totalMs: Math.round(totalMs),
        });
      }
    }
    throw new Error("semantic command exceeded the host-effect drain limit");
  }

  /** Drain the semantic outbox independently of the request that created it. */
  async recoverPendingSemanticEffects(): Promise<number> {
    let recovered = 0;
    for (let step = 0; step < 1_000; step += 1) {
      const effects = await this.gad().pendingSemanticEffects();
      // Publication authorization belongs to the request that initiated the
      // protected advance. A generic restart has no caller or lifecycle
      // authority and must never manufacture one. It may only finish the
      // semantic acknowledgement after the exact publication is already
      // durably applied. An unapplied publication remains pending until the
      // original caller or trusted lifecycle operation retries it, but it is
      // not a global outbox barrier: later safe host effects and already-
      // applied publications remain independently recoverable.
      let selected:
        | { effect: SemanticEffect; publication: null }
        | {
            effect: SemanticEffect;
            publication: AppliedPublication;
          }
        | null = null;
      for (const effect of effects) {
        if (effect.kind !== "publish-main") {
          selected = { effect, publication: null };
          break;
        }
        const publication = this.deps.refs.readAppliedPublication(effect.effectId);
        if (publication) {
          selected = { effect, publication };
          break;
        }
      }
      if (!selected) return recovered;
      const { effect, publication } = selected;
      const recover = async (): Promise<boolean> => {
        // Selection happens outside the lifecycle lock. Re-check after joining
        // it so an effect cancelled by context deletion cannot recreate the
        // disposable projection from a stale command.
        const pending = await this.gad().pendingSemanticEffects();
        if (
          !pending.some(
            (candidate) =>
              candidate.effectId === effect.effectId &&
              candidate.payloadDigest === effect.payloadDigest
          )
        ) {
          return false;
        }
        const receipt: Record<string, unknown> = publication
          ? {
              applied: true,
              appliedAt: new Date(publication.appliedAt).toISOString(),
            }
          : await this.executeSemanticEffect(effect);
        if (publication) this.deps.refs.acknowledgePublication(effect.effectId);
        await this.gad().semanticEffectAck({
          acknowledgement: {
            effectId: effect.effectId,
            payloadDigest: effect.payloadDigest,
            receipt,
          },
        });
        return true;
      };
      const didRecover =
        effect.scopeKind === "context"
          ? await this.locked(`context-lifecycle:${effect.scopeId}`, recover)
          : await recover();
      if (didRecover) recovered += 1;
    }
    throw new Error("semantic outbox recovery exceeded the host-effect drain limit");
  }

  private async executeSemanticEffect(
    effect: SemanticEffect,
    publicationGateContext?: PublicationGateContext
  ): Promise<Record<string, unknown>> {
    switch (effect.kind) {
      case "observe-content":
        return this.observeContent(effect);
      case "materialize-context": {
        if (effect.payload["mode"] === "content-only") return this.persistContent(effect);
        const command = effect.payload as unknown as ContextMaterializationCommand;
        const receipt = await this.materializer.materialize(command);
        await this.rememberVerifiedProjection(command.contextId);
        return receipt as unknown as Record<string, unknown>;
      }
      case "publish-main":
        if (!publicationGateContext) {
          throw new Error("protected publication has no verified gate context");
        }
        return this.publishMain(effect, publicationGateContext);
    }
  }

  private async observeContent(effect: SemanticEffect): Promise<Record<string, unknown>> {
    const representation = effect.payload["representation"];
    if (representation !== "bytes" && representation !== "descriptor") {
      throw new Error(
        `content observation has unsupported representation ${JSON.stringify(representation)}`
      );
    }
    const files = effect.payload["files"];
    if (!Array.isArray(files)) throw new Error("content observation effect lacks files");
    const contentHashes = files.map((value) => {
      if (!value || typeof value !== "object") {
        throw new Error("content observation contains an invalid file");
      }
      const file = value as Record<string, unknown>;
      const contentHash = String(file["contentHash"] ?? "");
      if (!contentHash) throw new Error("content observation contains an empty content hash");
      return contentHash;
    });
    const observed = new Array<Record<string, unknown>>(contentHashes.length);
    const pending = contentHashes.entries();
    const observeNext = async (): Promise<void> => {
      for (const [index, contentHash] of pending) {
        const bytes = await getBytes(this.deps.blobsDir, contentHash);
        if (!bytes) throw new Error(`content observation cannot read ${contentHash}`);
        observed[index] =
          representation === "bytes"
            ? { contentHash, base64: Buffer.from(bytes).toString("base64") }
            : { contentHash, ...intrinsicContentDescriptor(bytes) };
      }
    };
    await Promise.all(
      Array.from(
        { length: Math.min(CONTENT_OBSERVATION_CONCURRENCY, contentHashes.length) },
        observeNext
      )
    );
    return { files: observed };
  }

  /**
   * Persist authored bytes independently of context projection. Semantic-only
   * contexts deliberately have no filesystem checkout, but their immutable
   * content is still part of workspace history and must be readable after the
   * originating request, process, and extension activation have ended.
   */
  private async persistContent(effect: SemanticEffect): Promise<Record<string, unknown>> {
    const version = effect.payload["version"];
    const blobs = effect.payload["blobs"];
    if (version !== 1 || !Array.isArray(blobs) || blobs.length === 0) {
      throw new Error("content persistence effect has an invalid payload");
    }
    const seen = new Set<string>();
    const contentHashes = await Promise.all(
      blobs.map(async (value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new Error("content persistence effect contains an invalid blob");
        }
        const blob = value as Record<string, unknown>;
        const contentHash = String(blob["contentHash"] ?? "");
        const base64 = String(blob["base64"] ?? "");
        if (!/^[0-9a-f]{64}$/u.test(contentHash) || !base64) {
          throw new Error("content persistence effect contains an invalid content identity");
        }
        if (seen.has(contentHash)) {
          throw new Error(`content persistence effect repeats ${contentHash}`);
        }
        seen.add(contentHash);
        const bytes = Buffer.from(base64, "base64");
        if (bytes.toString("base64") !== base64) {
          throw new Error(`content persistence effect has invalid bytes for ${contentHash}`);
        }
        const stored = await putBytes(this.deps.blobsDir, bytes);
        if (stored.digest !== contentHash) {
          throw new Error(`content persistence effect bytes do not match ${contentHash}`);
        }
        return contentHash;
      })
    );
    contentHashes.sort(compareUtf16CodeUnits);
    return { version: 1, contentHashes };
  }

  private async executeHostRead(request: Record<string, unknown>): Promise<VcsReadFileResult> {
    const kind = request["kind"];
    if (kind === "read-semantic-blob") {
      const contentHash = String(request["contentHash"] ?? "");
      const bytes = await getBytes(this.deps.blobsDir, contentHash);
      if (!bytes) throw new Error(`semantic content blob ${contentHash} is missing`);
      return {
        repositoryId: String(request["repositoryId"] ?? ""),
        fileId: String(request["fileId"] ?? ""),
        repoPath: String(request["repoPath"] ?? ""),
        path: String(request["path"] ?? ""),
        contentHash,
        authoredChangeId: String(request["authoredChangeId"] ?? ""),
        authoredByWorkUnitId: String(request["authoredByWorkUnitId"] ?? ""),
        contentClass: request["contentClass"] === "internal" ? "internal" : "external",
        externalKeys: Array.isArray(request["externalKeys"])
          ? request["externalKeys"].map(String)
          : [],
        mode: Number(request["mode"]),
        content: this.fileContent(bytes),
      };
    }
    throw new Error(`unknown semantic host read ${JSON.stringify(kind)}`);
  }

  private async executeMergeContentHostRead(
    request: Record<string, unknown>
  ): Promise<SemanticDispatchResult> {
    const requested = request["contentHashes"];
    if (!Array.isArray(requested) || requested.length === 0) {
      throw new Error("semantic merge-content read has no content hashes");
    }
    const files = await Promise.all(
      requested.map(async (value) => {
        const contentHash = String(value);
        const bytes = await getBytes(this.deps.blobsDir, contentHash);
        if (!bytes) throw new Error(`semantic content blob ${contentHash} is missing`);
        return { contentHash, text: UTF8_DECODER.decode(bytes) };
      })
    );
    return this.gad().semanticHostReadAck({ acknowledgement: { request, files } });
  }

  private fileContent(
    bytes: Uint8Array
  ): VcsReadFileResult extends infer R
    ? NonNullable<R> extends { content: infer C }
      ? C
      : never
    : never {
    try {
      return { kind: "text", text: UTF8_DECODER.decode(bytes) } as never;
    } catch {
      return { kind: "bytes", base64: Buffer.from(bytes).toString("base64") } as never;
    }
  }

  private async publishMain(
    effect: SemanticEffect,
    gateContext: PublicationGateContext
  ): Promise<Record<string, unknown>> {
    const profileStartedAt = performance.now();
    const repositories = effect.payload["repositories"];
    if (!Array.isArray(repositories)) {
      throw new Error("publication effect lacks exact repository manifests");
    }
    const roots = await this.materializer.contentRoots(
      repositories as WorkspaceMaterializationRepository[]
    );
    const contentRootsCompletedAt = performance.now();
    const current = this.deps.refs.listMains();
    const currentByPath = new Map(current.map((entry) => [entry.repoPath, entry.contentRoot]));
    const targetByPath = new Map(roots.map((entry) => [entry.repoPath, entry.contentRoot]));
    const changedPaths = [...new Set([...currentByPath.keys(), ...targetByPath.keys()])]
      .filter((repoPath) => currentByPath.get(repoPath) !== targetByPath.get(repoPath))
      .sort(compareUtf16CodeUnits);
    const candidateWorkspaceState = await this.repositories.workspaceViewWithReposAt(
      changedPaths.map((repoPath) => ({
        repoPath,
        stateHash: targetByPath.get(repoPath) ?? null,
      }))
    );
    const candidateStateCompletedAt = performance.now();
    const publishedEventId = String(effect.payload["publishedEventId"] ?? "");
    if (!publishedEventId) throw new Error("publication effect lacks its published event identity");
    // BuildV2 seals execution identity while the ref gate validates this
    // candidate. Register the already-committed semantic event before the gate
    // asks for a build, rather than teaching the build store to accept an
    // anonymous content hash.
    this.semanticStateByContent.set(candidateWorkspaceState, {
      kind: "event",
      eventId: publishedEventId,
    });
    const hostRefsBasisDigest = hostRefBasisDigest(
      current.map(({ repoPath, contentRoot }) => ({ repoPath, contentRoot }))
    );
    await this.deps.refs.updateMains({
      entries: changedPaths.map((repoPath) => ({
        repoPath,
        expectedOld: currentByPath.get(repoPath) ?? null,
        next: targetByPath.get(repoPath) ?? null,
      })),
      evidence: {
        publicationId: effect.effectId,
        previousEventId: String(effect.payload["previousEventId"] ?? ""),
        publishedEventId: String(effect.payload["publishedEventId"] ?? ""),
        hostRefsBasisDigest,
      },
      gateContext:
        gateContext.kind === "caller" ? { ...gateContext, candidateWorkspaceState } : gateContext,
    });
    const refsCompletedAt = performance.now();
    const publication = this.deps.refs.readAppliedPublication(effect.effectId);
    if (!publication) throw new Error(`protected publication ${effect.effectId} was not recorded`);
    const profileCompletedAt = performance.now();
    if (profileCompletedAt - profileStartedAt >= 100) {
      console.info("[VcsProfile] protected main publication", {
        repositories: repositories.length,
        changedRepositories: changedPaths.length,
        contentRootsMs: contentRootsCompletedAt - profileStartedAt,
        candidateStateMs: candidateStateCompletedAt - contentRootsCompletedAt,
        updateRefsMs: refsCompletedAt - candidateStateCompletedAt,
        receiptMs: profileCompletedAt - refsCompletedAt,
        totalMs: profileCompletedAt - profileStartedAt,
      });
    }
    return {
      applied: true,
      appliedAt: new Date(publication.appliedAt).toISOString(),
    };
  }

  private gad(): WorkspaceSemanticPort {
    if (!this.gadCaller) throw new Error("semantic workspace is not attached");
    return this.gadCaller;
  }

  private workspaceSourceProvider(): WorkspaceSourceProviderV1 {
    if (!this.sourceProviderCaller) {
      throw new Error("workspace source provider bootstrap ABI is not attached");
    }
    return this.sourceProviderCaller;
  }

  // -----------------------------------------------------------------------
  // Context lifecycle
  // -----------------------------------------------------------------------

  /**
   * Ensure only the durable semantic coordinate exists.
   *
   * Runtime activation needs this authority boundary, but it does not need an
   * editable checkout. Filesystem consumers continue through ensureContext(),
   * which materializes the disposable projection on first use.
   */
  async ensureSemanticContext(contextId: string): Promise<VcsStateNodeRef> {
    const active = this.semanticContextInitializations.get(contextId);
    if (active) return active;
    const initialization = this.locked(`context-lifecycle:${contextId}`, () =>
      this.dispatchEnsureContext(contextId, "deferred")
    ).finally(() => {
      if (this.semanticContextInitializations.get(contextId) === initialization) {
        this.semanticContextInitializations.delete(contextId);
      }
    });
    this.semanticContextInitializations.set(contextId, initialization);
    return initialization;
  }

  async ensureContext(contextId: string): Promise<VcsStateNodeRef> {
    const active = this.contextInitializations.get(contextId);
    if (active) return active;
    const initialization = this.locked(`context-lifecycle:${contextId}`, () =>
      this.ensureContextOnce(contextId)
    ).finally(() => {
      if (this.contextInitializations.get(contextId) === initialization) {
        this.contextInitializations.delete(contextId);
      }
    });
    this.contextInitializations.set(contextId, initialization);
    return initialization;
  }

  private async ensureContextOnce(contextId: string): Promise<VcsStateNodeRef> {
    const working = await this.dispatchEnsureContext(contextId, "required");
    const materialized = await this.materializer.materializationState(contextId);
    const materializedKey = materialized ? canonicalJson(materialized) : null;
    const targetMatches =
      materialized && canonicalJson(materialized.targetState) === canonicalJson(working);
    const alreadyVerified =
      materializedKey !== null && this.verifiedProjectionStates.get(contextId) === materializedKey;
    if (
      !targetMatches ||
      (!alreadyVerified && !(await this.materializer.projectionMatches(materialized)))
    ) {
      await this.repairContextMaterialization(contextId);
    } else if (materializedKey !== null && !alreadyVerified) {
      this.verifiedProjectionStates.set(contextId, materializedKey);
    }
    return working;
  }

  private async dispatchEnsureContext(
    contextId: string,
    projection: "required" | "deferred"
  ): Promise<VcsStateNodeRef> {
    this.projector.contextDir(contextId);
    const operation = projection === "required" ? "ensure-context" : "ensure-context-coordinate";
    const commandId = `${operation}:${sha256HexSyncText(
      canonicalJson({
        workspaceId: this.deps.workspaceId,
        contextId,
      })
    )}`;
    const result = await this.gad().ensureContext({
      contextId,
      commandId,
      ...(projection === "deferred" ? { projection } : {}),
      ingress: { causalParent: null, contextIntegrity: HOST_SEMANTIC_INTEGRITY },
    });
    const context = await this.drainSemanticResult<{
      working: { ref: VcsStateNodeRef };
    }>(result);
    return context.working.ref;
  }

  private async repairContextMaterialization(contextId: string): Promise<void> {
    const current = await this.materializer.materializationState(contextId);
    const command = await this.gad().contextMaterializationCommand({
      contextId,
      materializedState: current?.targetState ?? null,
    });
    await this.materializer.materialize(command);
    await this.rememberVerifiedProjection(contextId);
  }

  private async rememberVerifiedProjection(contextId: string): Promise<void> {
    const state = await this.materializer.materializationState(contextId);
    if (!state) {
      this.verifiedProjectionStates.delete(contextId);
      return;
    }
    this.verifiedProjectionStates.set(contextId, canonicalJson(state));
  }

  async activateWorkspaceFromSource(): Promise<{
    stateHash: string;
    initialized: boolean;
    timings: WorkspaceActivationTimings;
  }> {
    const activationStartedAt = performance.now();
    const timings: WorkspaceActivationTimings = {
      ensureContextAndMaterializationMs: 0,
      inspectMs: 0,
      sourceScanMs: 0,
      sourceHashAndBlobIngestMs: 0,
      casTreeMirrorMs: 0,
      importSnapshotMs: 0,
      initializationPushMs: 0,
      ensureFreshMs: 0,
      totalMs: 0,
    };
    const contextId = `workspace-initialization:${this.deps.workspaceId}`;
    const rootPin = this.deps.rootTemplateBootstrap
      ? await this.deps.rootTemplateBootstrap.prepareSource()
      : null;
    if (rootPin) {
      let spanStartedAt = performance.now();
      const initialization = await this.workspaceSourceProvider().inspectInitialization();
      timings.inspectMs = performance.now() - spanStartedAt;
      if (initialization.state === "ready") {
        if (
          initialization.receipt.pin.url !== rootPin.url ||
          initialization.receipt.pin.ref !== rootPin.ref ||
          initialization.receipt.pin.commit !== rootPin.commit ||
          initialization.receipt.pin.snapshot !== rootPin.snapshot
        ) {
          throw new Error(
            "Workspace source initialization receipt does not match the exact root template"
          );
        }
        spanStartedAt = performance.now();
        const fresh = await this.ensureFresh();
        timings.ensureFreshMs = performance.now() - spanStartedAt;
        timings.totalMs = performance.now() - activationStartedAt;
        return { ...fresh, initialized: false, timings };
      }
      if (initialization.state === "failed") {
        throw new Error(
          `Workspace source initialization failed: ${initialization.failure.message}`
        );
      }
      const preparedRoot = await this.deps.rootTemplateBootstrap!.prepareInitialization();
      if (!preparedRoot) {
        throw new Error("Workspace root template disappeared during source initialization");
      }
      spanStartedAt = performance.now();
      const receipt = await this.initializeExactWorkspaceSource(preparedRoot);
      timings.importSnapshotMs = performance.now() - spanStartedAt;
      spanStartedAt = performance.now();
      const fresh = await this.ensureFresh();
      timings.ensureFreshMs = performance.now() - spanStartedAt;
      timings.totalMs = performance.now() - activationStartedAt;
      const protectedMain = this.deps.refs.readMainSemanticState();
      if (protectedMain?.eventId !== receipt.initializedEventId) {
        throw new Error(
          `Workspace source receipt event ${receipt.initializedEventId} does not match protected main ${protectedMain?.eventId ?? "absent"}`
        );
      }
      return { ...fresh, initialized: true, timings };
    }
    let spanStartedAt = performance.now();
    const state = await this.ensureContext(contextId);
    timings.ensureContextAndMaterializationMs = performance.now() - spanStartedAt;
    spanStartedAt = performance.now();
    const inspected = await this.semanticDirectCall<VcsInspectResult>("vcsInspect", {
      node: state,
      edgeLimit: 1,
    });
    timings.inspectMs = performance.now() - spanStartedAt;
    const existingRefs = this.deps.refs.listMains();
    if (
      (inspected.node.kind !== "event" || inspected.node.value.kind !== "genesis") &&
      existingRefs.length > 0
    ) {
      spanStartedAt = performance.now();
      const fresh = await this.ensureFresh();
      timings.ensureFreshMs = performance.now() - spanStartedAt;
      timings.totalMs = performance.now() - activationStartedAt;
      return { ...fresh, initialized: false, timings };
    }

    const initializationEvidence = await this.initializationEvidence(state);

    const scanned = await this.contentProjection.localState(this.deps.workspaceRoot);
    timings.sourceScanMs = scanned.timings.scanMs;
    timings.sourceHashAndBlobIngestMs = scanned.timings.hashAndBlobIngestMs;
    timings.casTreeMirrorMs = scanned.timings.treeMirrorMs;
    if (scanned.skipped.length > 0) {
      throw new Error(
        `workspace source contains unsupported entries: ${scanned.skipped
          .map((entry) => `${entry.path} (${entry.kind}${entry.reason ? `: ${entry.reason}` : ""})`)
          .join(", ")}`
      );
    }
    if (!scanned.files.some((file) => file.path === "meta/vibestudio.yml")) {
      throw new Error("workspace source is missing meta/vibestudio.yml");
    }

    const sourceFiles = [...scanned.files];
    sourceFiles.sort((left, right) => compareUtf16CodeUnits(left.path, right.path));
    const repositories = [];
    for (const repository of discoverRepos(sourceFiles.map((file) => file.path))) {
      const prefix = `${repository.repoPath}/`;
      const repositoryFiles = sourceFiles.filter((file) => file.path.startsWith(prefix));
      const files = repositoryFiles.map((file) => ({
        path: file.path.slice(prefix.length),
        contentHash: file.contentHash,
        mode: file.mode & 0o777,
      }));
      repositories.push({
        repoPath: repository.repoPath,
        files,
      });
    }

    let workingHead = state;
    spanStartedAt = performance.now();
    const localSnapshotRevision = scanned.stateHash;
    const localAlreadyImported = initializationEvidence.some(
      (evidence) =>
        evidence.sourceKind === "filesystem" &&
        evidence.sourceUri === "vibestudio://workspace/source" &&
        evidence.snapshotRevision === localSnapshotRevision
    );
    if (!localAlreadyImported) {
      const importResult = await this.semanticDirectCall<VcsImportSnapshotResult>(
        "vcsImportSnapshot",
        {
          contextId,
          commandId: `initial-import:${localSnapshotRevision}`,
          expectedWorkingHead: workingHead,
          intentSummary: "Import the initial local workspace snapshot",
          source: {
            kind: "filesystem",
            uri: "vibestudio://workspace/source",
            snapshotRevision: localSnapshotRevision,
          },
          repositories,
          message: "Import initial local workspace snapshot",
        }
      );
      workingHead = { kind: "event", eventId: importResult.eventId };
    }
    timings.importSnapshotMs = performance.now() - spanStartedAt;
    const genesisEventId = await this.initializationGenesisEventId(workingHead);
    if (workingHead.kind !== "event") {
      throw new Error("Workspace initialization did not produce a committed event head");
    }
    spanStartedAt = performance.now();
    await this.semanticWorkspaceInitializationPush<VcsPushResult>({
      contextId,
      commandId: `initial-push:${workingHead.eventId}`,
      expectedCommittedEventId: workingHead.eventId,
      expectedMainEventId: genesisEventId,
    });
    timings.initializationPushMs = performance.now() - spanStartedAt;
    spanStartedAt = performance.now();
    const fresh = await this.ensureFresh();
    timings.ensureFreshMs = performance.now() - spanStartedAt;
    timings.totalMs = performance.now() - activationStartedAt;
    return { ...fresh, initialized: true, timings };
  }

  private initializeExactWorkspaceSource(
    prepared: import("../workspaceRootTemplateBootstrap.js").PreparedRootTemplateInitialization
  ): Promise<
    import("@vibestudio/workspace-contracts/workspaceSource").WorkspaceSourceInitializationReceipt
  > {
    return this.withProtectedMainMutation(async () => {
      const startedAt = performance.now();
      let providerMs = 0;
      let effectMs = 0;
      const effects: Record<string, { count: number; totalMs: number }> = {};
      const providerSteps: Array<{
        step: number;
        elapsedMs: number;
        state: string;
        pendingEffect: string | null;
      }> = [];
      const provider = this.workspaceSourceProvider();
      const request = {
        commandId: `workspace-source:${prepared.pin.commit}:${prepared.pin.snapshot}`,
        pin: {
          url: prepared.pin.url,
          ref: prepared.pin.ref,
          commit: prepared.pin.commit,
          snapshot: prepared.pin.snapshot,
        },
        repositories: [...prepared.repositories]
          .sort((left, right) => compareUtf16CodeUnits(left.repoPath, right.repoPath))
          .map((repository) => ({
            repoPath: repository.repoPath,
            subdir: repository.subdir,
            snapshot: repository.snapshot,
            contentRoot: repository.contentRoot,
            files: repository.files.map(({ path: filePath, contentHash, mode }) => ({
              path: filePath,
              contentHash,
              mode,
            })),
          })),
      } satisfies import("@vibestudio/workspace-contracts/workspaceSource").InitializeExactWorkspaceSnapshotInput;
      let acknowledgement:
        | import("@vibestudio/workspace-contracts/workspaceSource").WorkspaceSourceEffectAcknowledgement
        | undefined;
      for (let step = 0; step < 1_000; step += 1) {
        const providerStartedAt = performance.now();
        const inspection = await provider.initializeExactSnapshot({
          ...request,
          ...(acknowledgement ? { acknowledgement } : {}),
        });
        const providerElapsedMs = performance.now() - providerStartedAt;
        providerMs += providerElapsedMs;
        providerSteps.push({
          step,
          elapsedMs: providerElapsedMs,
          state: inspection.state,
          pendingEffect:
            inspection.state === "initializing" ? (inspection.pendingEffect?.kind ?? null) : null,
        });
        acknowledgement = undefined;
        if (inspection.state === "ready") {
          const totalMs = performance.now() - startedAt;
          if (totalMs >= 100) {
            console.info("[VcsProfile] exact workspace initialization", {
              repositories: prepared.repositories.length,
              files: prepared.repositories.reduce(
                (count, repository) => count + repository.files.length,
                0
              ),
              providerMs,
              providerSteps,
              effectMs,
              effects,
              totalMs,
            });
          }
          return inspection.receipt;
        }
        if (inspection.state === "failed") {
          throw new Error(`Workspace source initialization failed: ${inspection.failure.message}`);
        }
        if (inspection.state === "empty") {
          throw new Error("Workspace source provider did not record initialization");
        }
        const effect = inspection.pendingEffect;
        if (!effect) continue;
        const effectStartedAt = performance.now();
        const receipt = await this.executeSemanticEffect(effect, {
          kind: "workspace-initialization",
        });
        const elapsedMs = performance.now() - effectStartedAt;
        effectMs += elapsedMs;
        const effectProfile = effects[effect.kind] ?? { count: 0, totalMs: 0 };
        effectProfile.count += 1;
        effectProfile.totalMs += elapsedMs;
        effects[effect.kind] = effectProfile;
        if (effect.kind === "publish-main") {
          this.deps.refs.acknowledgePublication(effect.effectId);
        }
        acknowledgement = {
          effectId: effect.effectId,
          payloadDigest: effect.payloadDigest,
          receipt,
        };
      }
      throw new Error("Workspace source initialization exceeded the host-effect limit");
    });
  }

  private async initializationGenesisEventId(state: VcsStateNodeRef): Promise<string> {
    let cursor = state;
    for (;;) {
      if (cursor.kind !== "event") {
        throw new Error("Workspace initialization history contains a non-event state");
      }
      const inspected = await this.semanticDirectCall<VcsInspectResult>("vcsInspect", {
        node: cursor,
        edgeLimit: 1,
      });
      if (inspected.node.kind !== "event") {
        throw new Error(`Workspace initialization event ${cursor.eventId} cannot be inspected`);
      }
      if (inspected.node.value.kind === "genesis") return inspected.node.value.eventId;
      if (inspected.node.value.parentEventIds.length !== 1) {
        throw new Error("Workspace initialization history is not a single import chain");
      }
      cursor = { kind: "event", eventId: inspected.node.value.parentEventIds[0]! };
    }
  }

  private async initializationEvidence(state: VcsStateNodeRef): Promise<
    Array<{
      sourceKind: string;
      sourceUri: string;
      snapshotRevision: string;
      canonicalSnapshot?: string;
      sourceSubdir?: string | null;
      eventId: string;
    }>
  > {
    const evidence: Array<{
      sourceKind: string;
      sourceUri: string;
      snapshotRevision: string;
      canonicalSnapshot?: string;
      sourceSubdir?: string | null;
      eventId: string;
    }> = [];
    let cursor = state;
    for (;;) {
      if (cursor.kind !== "event") break;
      const event = await this.semanticDirectCall<VcsInspectResult>("vcsInspect", {
        node: cursor,
        edgeLimit: 1,
      });
      if (event.node.kind !== "event" || event.node.value.kind === "genesis") break;
      for (const applicationId of event.node.value.applicationIds) {
        const application = await this.semanticDirectCall<VcsInspectResult>("vcsInspect", {
          node: { kind: "application", applicationId },
          edgeLimit: 1,
        });
        if (application.node.kind !== "application") continue;
        const workUnit = await this.semanticDirectCall<VcsInspectResult>("vcsInspect", {
          node: { kind: "work-unit", workUnitId: application.node.value.workUnitId },
          edgeLimit: 1,
        });
        if (workUnit.node.kind !== "work-unit" || !workUnit.node.value.externalSnapshot) continue;
        evidence.push({
          ...workUnit.node.value.externalSnapshot,
          eventId: event.node.value.eventId,
        });
      }
      if (event.node.value.parentEventIds.length !== 1) {
        throw new Error("Workspace initialization history is not a single import chain");
      }
      cursor = { kind: "event", eventId: event.node.value.parentEventIds[0]! };
    }
    return evidence;
  }

  async forkContext(sourceContextId: string, targetContextId: string): Promise<VcsStateNodeRef> {
    this.projector.contextDir(sourceContextId);
    this.projector.contextDir(targetContextId);
    return this.locked(`context-lifecycle:${targetContextId}`, async () => {
      const commandId = `fork-context:${sha256HexSyncText(
        canonicalJson({
          workspaceId: this.deps.workspaceId,
          sourceContextId,
          targetContextId,
        })
      )}`;
      const result = await this.gad().forkContext({
        sourceContextId,
        targetContextId,
        commandId,
        ingress: { causalParent: null, contextIntegrity: HOST_SEMANTIC_INTEGRITY },
      });
      const context = await this.drainSemanticResult<{
        working: { ref: VcsStateNodeRef };
      }>(result);
      return context.working.ref;
    });
  }

  async dropContext(contextId: string): Promise<void> {
    await this.locked(`context-lifecycle:${contextId}`, async () => {
      // Projection bytes are disposable and reconstructible from semantic
      // authority. Remove them first so every interrupted ordering is
      // recoverable: semantic failure can rematerialize, while semantic
      // success can never be followed by a stale projection resurrection.
      await this.materializer.drop(contextId);
      this.verifiedProjectionStates.delete(contextId);
      await this.gad().dropContext({ contextId });
    });
  }

  async ensureContextFolder(contextId: string): Promise<{ dir: string }> {
    await this.ensureContext(contextId);
    return { dir: this.projector.contextDir(contextId) };
  }

  async resolveWorkingState(contextId: string): Promise<VcsStateNodeRef> {
    await this.ensureContext(contextId);
    const status = await this.semanticDirectCall<VcsStatusResult>("vcsStatus", { contextId });
    return status.workingHead;
  }

  async contextRepoTargets(
    contextId: string
  ): Promise<Array<{ repoPath: string; stateHash: string }>> {
    await this.ensureContext(contextId);
    const state = await this.materializer.materializationState(contextId);
    if (!state) throw new Error(`context ${contextId} has no materialized state`);
    return state.repositories.map(({ repoPath, contentRoot }) => ({
      repoPath,
      stateHash: contentRoot,
    }));
  }

  async materializeContextRepos(contextId: string, _scopes: string[] | "all"): Promise<void> {
    await this.ensureContext(contextId);
  }

  async isContextRepoMaterialized(contextId: string, repoPath: string): Promise<boolean> {
    const normalized = normalizeRepositoryPath(repoPath);
    const state = await this.materializer.materializationState(contextId);
    return state?.repositories.some((repository) => repository.repoPath === normalized) ?? false;
  }

  /**
   * Resolve one exact semantic repository without writing a projection, CAS
   * object, or checkout. The returned plan is JSON and may be sealed directly
   * into a dispatcher prepared-authority payload.
   */
  async planExactContextRepository(input: {
    contextId: string;
    repositoryId: string;
    requiredFiles: readonly string[];
  }): Promise<ExactRepositorySnapshotPlan> {
    const command = await this.gad().contextMaterializationCommand({
      contextId: input.contextId,
      materializedState: null,
    });
    const roots = await this.materializer.planContentRoots(command.repositories);
    const repository = roots.find((candidate) => candidate.repositoryId === input.repositoryId);
    if (!repository)
      throw Object.assign(new Error(`Unknown repository ${input.repositoryId}`), {
        code: "ENOENT",
      });
    const repositoryCommand = command.repositories.find(
      (
        candidate
      ): candidate is Extract<WorkspaceMaterializationRepository, { presence: "present" }> =>
        candidate.presence === "present" && candidate.repositoryId === input.repositoryId
    );
    if (!repositoryCommand) {
      throw Object.assign(new Error(`Repository ${input.repositoryId} has no exact source`), {
        code: "ECORRUPT",
      });
    }
    const referencedContent = new Set(
      repositoryCommand.source.kind === "snapshot"
        ? repositoryCommand.source.files.map((file) => file.contentHash)
        : repositoryCommand.source.kind === "delta"
          ? repositoryCommand.source.changes.flatMap((change) =>
              change.result ? [change.result.contentHash] : []
            )
          : []
    );
    const realizationBlobs = command.blobs.filter((blob) =>
      referencedContent.has(blob.contentHash)
    );
    const requiredFiles = await Promise.all(
      [...new Set(input.requiredFiles)].sort(compareUtf16CodeUnits).map(async (requiredPath) => {
        const changed =
          repositoryCommand.source.kind === "delta"
            ? repositoryCommand.source.changes.find((change) => change.path === requiredPath)
            : undefined;
        const file =
          repositoryCommand.source.kind === "snapshot"
            ? repositoryCommand.source.files.find((candidate) => candidate.path === requiredPath)
            : changed
              ? changed.result
              : await readFileAtTree(
                  this.deps.blobsDir,
                  repositoryCommand.source.kind === "content-root"
                    ? repositoryCommand.source.contentRoot
                    : repositoryCommand.source.basisContentRoot,
                  requiredPath
                );
        if (!file)
          throw Object.assign(
            new Error(
              `Required development input ${requiredPath} is absent from ${repository.repoPath}`
            ),
            { code: "EDEVELOPMENT_INPUT" }
          );
        const storedBytes = await getBytes(this.deps.blobsDir, file.contentHash);
        const inline = realizationBlobs.find((blob) => blob.contentHash === file.contentHash);
        const bytes = storedBytes ?? (inline ? Buffer.from(inline.base64, "base64") : null);
        if (!bytes)
          throw Object.assign(
            new Error(`Required development input ${requiredPath} is missing from content storage`),
            { code: "ECORRUPT" }
          );
        return { path: requiredPath, contentHash: file.contentHash, byteLength: bytes.byteLength };
      })
    );
    const base = {
      version: 1 as const,
      contextId: input.contextId,
      repositoryId: input.repositoryId,
      repoPath: repository.repoPath,
      sourceState: command.targetState,
      contentRoot: repository.contentRoot,
      repositoryManifestDigest: sha256HexSyncText(
        canonicalJson({
          repositoryId: input.repositoryId,
          repoPath: repository.repoPath,
          fileManifestId: repository.fileManifestId,
          contentRoot: repository.contentRoot,
        })
      ),
      materializedTreeDigest: sha256HexSyncText(
        canonicalJson({ contentRoot: repository.contentRoot })
      ),
      requiredFiles,
      realization: {
        repository: repositoryCommand,
        blobs: realizationBlobs,
      },
    };
    return {
      ...base,
      planDigest: sha256HexSyncText(canonicalJson(base)),
    };
  }

  /**
   * Write a previously sealed plan into an empty private run root. This method
   * never consults current context state, a shared projection, or a checkout.
   */
  async materializeExactRepositoryPlan(
    plan: ExactRepositorySnapshotPlan,
    destinationInput: string
  ): Promise<void> {
    const { planDigest, ...base } = plan;
    if (sha256HexSyncText(canonicalJson(base)) !== planDigest) {
      throw Object.assign(
        new Error("Development snapshot plan digest does not match its content"),
        {
          code: "ECORRUPT",
        }
      );
    }
    const destination = path.resolve(destinationInput);
    await fsp.mkdir(destination, { recursive: true, mode: 0o700 });
    if ((await fsp.readdir(destination)).length > 0) {
      throw Object.assign(
        new Error(`Development materialization destination is not empty: ${destination}`),
        { code: "ENOTEMPTY" }
      );
    }
    await this.materializer.realizePlannedRepository(
      plan.realization.repository,
      plan.realization.blobs,
      plan.contentRoot
    );
    await materializeTree(this.deps.blobsDir, plan.contentRoot, destination, {
      strategy: "copy-on-write",
    });
  }

  // -----------------------------------------------------------------------
  // Immutable content/build adapter
  // -----------------------------------------------------------------------

  async ensureFresh(): Promise<{ stateHash: string }> {
    if (this.ensureFreshInFlight) return this.ensureFreshInFlight;
    this.ensureFreshInFlight = this.ensureFreshUncoalesced().finally(() => {
      this.ensureFreshInFlight = null;
    });
    return this.ensureFreshInFlight;
  }

  private async ensureFreshUncoalesced(): Promise<{ stateHash: string }> {
    const view = await this.repositories.workspaceView();
    const semanticState = this.deps.refs.readMainSemanticState();
    if (semanticState) this.semanticStateByContent.set(view.stateHash, semanticState);
    return view;
  }

  private async resolveContentSelector(selector: string): Promise<string | null> {
    if (selector === "main") return (await this.ensureFresh()).stateHash;
    if (selector.startsWith("ctx:")) return this.resolveContextState(selector.slice(4));
    return null;
  }

  async resolveContextState(contextId: string): Promise<string> {
    const semanticState = await this.resolveWorkingState(contextId);
    const repositories = await this.contextRepoTargets(contextId);
    const stateHash = (await this.repositories.contentView(repositories)).stateHash;
    this.semanticStateByContent.set(stateHash, semanticState);
    return stateHash;
  }

  executionStateForContent(stateHash: string): VcsStateNodeRef | null {
    return this.semanticStateByContent.get(stateHash) ?? null;
  }

  async unitHashes(stateHash: string, relPaths: string[]): Promise<Record<string, string | null>> {
    await this.contentProjection.ensureStateMirrored(stateHash);
    const result: Record<string, string | null> = {};
    for (const relativePath of relPaths) {
      const resolved = await resolveTreePath(this.deps.blobsDir, stateHash, relativePath);
      result[relativePath] =
        resolved === null
          ? null
          : resolved.kind === "dir"
            ? resolved.treeHash
            : resolved.contentHash;
    }
    return result;
  }

  async discoverGraph(stateHash: string): Promise<PackageGraph> {
    await this.contentProjection.ensureStateMirrored(stateHash);
    return discoverPackageGraphAtTree(this.deps.blobsDir, stateHash, this.deps.workspaceRoot);
  }

  /**
   * Materialize one exact semantic state for source-tree inspection. This is
   * the same content-addressed projection used for graph discovery; callers
   * must not fall back to an operational checkout, which is never semantic
   * workspace source.
   */
  async materializeSourceTree(stateHash: string): Promise<string> {
    return this.materializeStateForGraphDiscovery(stateHash);
  }

  async materializeForBuild(
    units: GraphNode[],
    stateRef: string,
    _workspaceRoot: string
  ): Promise<{ sourceRoot: string }> {
    const stateHash = await this.resolveStateReference(stateRef);
    const key = crypto.createHash("sha256").update(stateHash).digest("hex").slice(0, 24);
    const sourceRoot = path.join(this.deps.buildSourcesRoot, key);
    await this.contentProjection.ensureStateMirrored(stateHash);

    // Workspace-root files are shared build configuration. Their tiny common
    // publication is the only state-wide critical section: disjoint unit trees
    // must never wait behind one another merely because they come from the same
    // immutable workspace snapshot.
    await this.locked(`build-root:${key}`, async () => {
      const rootEntries = await readTreeDirectory(this.deps.blobsDir, stateHash);
      if (!rootEntries) throw new Error(`build source root is missing at ${stateHash}`);
      await fsp.mkdir(sourceRoot, { recursive: true });
      await Promise.all(
        rootEntries
          .filter((entry) => entry.kind === "file")
          .map((entry) => this.ensureBuildSupportFile(stateHash, sourceRoot, entry))
      );
    });

    // A build closure can repeat a package and concurrent builds can ask for
    // the same package. Coalesce by exact tree, while allowing unrelated trees
    // to project concurrently. The destination paths are disjoint, so no
    // broader lock protects a real invariant.
    const requestedPaths = new Set(units.map((unit) => unit.relativePath));
    requestedPaths.add("types");
    await Promise.all(
      [...requestedPaths].map(async (relativePath) => {
        const resolved = await resolveTreePath(this.deps.blobsDir, stateHash, relativePath);
        if (!resolved) return;
        if (resolved.kind !== "dir") {
          const label =
            relativePath === "types" ? "build support types" : `build unit ${relativePath}`;
          throw new Error(`${label} is not a directory at ${stateHash}`);
        }
        await this.locked(`build-tree:${key}:${relativePath}`, () =>
          this.ensureBuildTreeMaterialized(
            stateHash,
            relativePath,
            resolved.treeHash,
            path.join(sourceRoot, ...relativePath.split("/"))
          )
        );
      })
    );
    return { sourceRoot };
  }

  private async ensureBuildSupportFile(
    stateHash: string,
    sourceRoot: string,
    entry: Extract<
      NonNullable<Awaited<ReturnType<typeof readTreeDirectory>>>[number],
      { kind: "file" }
    >
  ): Promise<void> {
    const target = path.join(sourceRoot, entry.name);
    const receiptKey = `${stateHash}\0/${entry.name}`;
    const identity = `${entry.contentHash}:${entry.mode}`;
    if (this.verifiedBuildTrees.get(receiptKey) === identity) {
      const stat = await fsp.lstat(target).catch(() => null);
      if (stat?.isFile()) return;
      this.verifiedBuildTrees.delete(receiptKey);
    }
    const bytes = await getBytes(this.deps.blobsDir, entry.contentHash);
    if (!bytes) {
      throw new Error(`build support file ${entry.name} content is missing at ${stateHash}`);
    }
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      await fsp.writeFile(temporary, bytes, { mode: entry.mode & 0o777 });
      await fsp.rename(temporary, target);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    this.rememberVerifiedBuildEntry(receiptKey, identity);
  }

  private async ensureBuildTreeMaterialized(
    stateHash: string,
    relativePath: string,
    treeHash: string,
    destination: string
  ): Promise<void> {
    const receiptKey = `${stateHash}\0${relativePath}`;
    if (this.verifiedBuildTrees.get(receiptKey) === treeHash) {
      const stat = await fsp.lstat(destination).catch(() => null);
      if (stat?.isDirectory()) return;
      this.verifiedBuildTrees.delete(receiptKey);
    }
    await materializeTree(this.deps.blobsDir, treeHash, destination);
    this.rememberVerifiedBuildEntry(receiptKey, treeHash);
  }

  private rememberVerifiedBuildEntry(receiptKey: string, identity: string): void {
    if (this.verifiedBuildTrees.size >= VERIFIED_BUILD_TREE_LIMIT) {
      this.verifiedBuildTrees.delete(this.verifiedBuildTrees.keys().next().value!);
    }
    this.verifiedBuildTrees.set(receiptKey, identity);
  }

  private async materializeStateForGraphDiscovery(stateHash: string): Promise<string> {
    const key = crypto.createHash("sha256").update(`graph:${stateHash}`).digest("hex").slice(0, 24);
    const root = path.join(this.deps.buildSourcesRoot, `graph-${key}`);
    await this.locked(`graph:${key}`, async () => {
      await this.contentProjection.ensureStateMirrored(stateHash);
      await materializeTree(this.deps.blobsDir, stateHash, root);
    });
    return root;
  }

  private async resolveStateReference(ref: string): Promise<string> {
    if (ref.startsWith("state:")) {
      if (!/^state:[0-9a-f]{64}$/.test(ref)) {
        throw new Error(`content coordinate is not a canonical state hash: ${ref}`);
      }
      return ref;
    }
    const resolved = await this.resolveContentSelector(ref);
    if (!resolved) throw new Error(`Unknown content revision ${JSON.stringify(ref)}`);
    return resolved;
  }

  async readFile(stateRef: string, filePath: string): Promise<ContentFile | null> {
    const stateHash = await this.resolveStateReference(stateRef);
    await this.contentProjection.ensureStateMirrored(stateHash);
    const meta = await readFileAtTree(this.deps.blobsDir, stateHash, filePath);
    if (!meta) return null;
    const bytes = await getBytes(this.deps.blobsDir, meta.contentHash);
    if (!bytes) throw new Error(`content blob ${meta.contentHash} is missing`);
    let content: ContentFile["content"];
    try {
      content = { kind: "text", text: UTF8_DECODER.decode(bytes) };
    } catch {
      content = { kind: "bytes", base64: bytes.toString("base64") };
    }
    return {
      content,
      stateHash,
      contentHash: meta.contentHash,
      mode: meta.mode,
      size: bytes.length,
    };
  }

  async listFiles(
    stateRef: string
  ): Promise<Array<{ path: string; contentHash: string; mode: number }>> {
    const stateHash = await this.resolveStateReference(stateRef);
    return (await this.contentProjection.listStateFiles(stateHash)).map((file) => ({
      path: file.path,
      contentHash: file.content_hash,
      mode: file.mode,
    }));
  }

  async diffStates(leftStateHash: string, rightStateHash: string): Promise<TreeDiff> {
    await Promise.all([
      this.contentProjection.ensureStateMirrored(leftStateHash),
      this.contentProjection.ensureStateMirrored(rightStateHash),
    ]);
    return diffTrees(this.deps.blobsDir, leftStateHash, rightStateHash);
  }

  async recordBuild(record: BuildRecord): Promise<void> {
    if (!this.attached) return;
    await this.gad().appendLogEvent({
      logId: BUILDS_LOG_ID,
      head: "main",
      logKind: "builds",
      events: [
        {
          envelopeId: `build:${record.buildKey}:${record.status}`,
          actor: SYSTEM_ACTOR,
          payloadKind: "build.completed",
          payload: {
            protocol: "agentic.trajectory.v1",
            inputStateHash: record.inputStateHash,
            unitName: record.unitName,
            subtree: record.subtree,
            ev: record.ev,
            buildKey: record.buildKey,
            status: record.status,
            ...(record.error ? { error: record.error } : {}),
          },
        },
      ],
    });
  }

  // -----------------------------------------------------------------------
  // Protected-main effects and build notifications
  // -----------------------------------------------------------------------

  onProtectedPublication(
    callback: (event: ProtectedPublicationEvent) => void | Promise<void>
  ): () => void {
    this.protectedPublicationListeners.add(callback);
    return () => this.protectedPublicationListeners.delete(callback);
  }

  private async onProtectedRefsPublished(publication: ProtectedRefPublication): Promise<void> {
    if (!this.attached || publication.changes.length === 0) return;
    const workspaceStateHash = (await this.repositories.workspaceView()).stateHash;
    const repositories: ProtectedPublicationEvent["repositories"] = [];
    for (const change of publication.changes) {
      const repoPath = normalizeRepositoryPath(change.repoPath);
      const fileChanges = await this.diffFileChanges(
        change.previousContentRoot,
        change.nextContentRoot
      );
      const reroot = (relativePath: string) => joinRepoPrefix(repoPath, relativePath);
      repositories.push({
        repoPath,
        previousStateHash: change.previousContentRoot,
        nextStateHash: change.nextContentRoot,
        fileChanges: fileChanges.map((file) => ({ ...file, path: reroot(file.path) })),
      });
    }
    const changedPaths = [
      ...new Set(repositories.flatMap(({ fileChanges }) => fileChanges.map(({ path }) => path))),
    ].sort(compareUtf16CodeUnits);
    const event = {
      publicationId: publication.publicationId,
      resultHostRefsBasisDigest: publication.resultHostRefsBasisDigest,
      appliedAt: publication.appliedAt,
      workspaceStateHash,
      changedPaths,
      repositories,
    } satisfies ProtectedPublicationEvent;

    // Protected-ref publication is not settled until exact-state consumers have
    // observed it. In particular, BuildV2 must install the new graph/EV state
    // before vcs.push returns so an immediate open/build cannot see stale HEAD.
    // The protected-ref store durably replays this observer phase if a listener
    // is interrupted after the CAS has committed.
    for (const listener of this.protectedPublicationListeners) {
      await listener(event);
    }

    // Source checkout mirroring is an observer, never part of publication
    // authority. Its failure must not suppress the CAS-derived notification.
    if (this.deps.extractMainToSource) {
      for (const change of publication.changes) {
        const repoPath = normalizeRepositoryPath(change.repoPath);
        try {
          if (change.nextContentRoot === null) await this.projector.removeRepo(repoPath);
          else await this.projector.exportMainToSource(repoPath, change.nextContentRoot);
        } catch (error) {
          console.error(`[Vcs] protected publication source mirror failed for ${repoPath}:`, error);
        }
      }
    }
  }

  private async diffFileChanges(
    previous: string | null,
    next: string | null
  ): Promise<ProtectedPublicationFileChange[]> {
    const diff = await this.diffStates(previous ?? EMPTY_STATE_HASH, next ?? EMPTY_STATE_HASH);
    return [
      ...diff.added.map((file) => ({
        kind: "added" as const,
        path: file.path,
        oldContentHash: null,
        newContentHash: file.contentHash,
        oldExecutable: null,
        newExecutable: (file.mode & 0o111) !== 0,
      })),
      ...diff.removed.map((file) => ({
        kind: "removed" as const,
        path: file.path,
        oldContentHash: file.contentHash,
        newContentHash: null,
        oldExecutable: (file.mode & 0o111) !== 0,
        newExecutable: null,
      })),
      ...diff.changed.map((file) => ({
        kind: "changed" as const,
        path: file.path,
        oldContentHash: file.fromContentHash,
        newContentHash: file.toContentHash,
        oldExecutable: (file.fromMode & 0o111) !== 0,
        newExecutable: (file.toMode & 0o111) !== 0,
      })),
    ];
  }

  private locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key);
    const next = previous ? previous.catch(() => {}).then(operation) : operation();
    this.locks.set(key, next);
    return next.finally(() => {
      if (this.locks.get(key) === next) this.locks.delete(key);
    });
  }
}
