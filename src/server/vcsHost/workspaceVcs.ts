import { ByteArraySchema } from "@vibestudio/shared/binary";
import { intrinsicContentDescriptor } from "@vibestudio/content-addressing";
import { blobUploadPrincipal, hasBlobUploads, markPrivateWorkspaceBlobs } from "../storage/blobUploads.js";
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

import { canonicalEntityId } from "@vibestudio/shared/runtime/entitySpec";
import type { HistoryIngressInput, HistoryIngressMethod } from "../chronolog/historyIngress.js";
import type {
  VcsCommitInput,
  VcsCommitResult,
  VcsDiscardInput,
  VcsDiscardResult,
  VcsImportSnapshotInput,
  VcsImportSnapshotResult,
  VcsExternalDeltaResult,
  VcsExternalDeltaLifecycleInput,
  VcsRegisterExternalDeltaInput,
  VcsPushInput,
  VcsPushResult,
  VcsQueryInput,
  VcsQueryResult,
  VcsReadFileResult,
  VcsReadFilesInput,
  VcsReadMemoryInput,
  VcsReadMemoryResult,
  VcsSearchInput,
  VcsStateNodeRef,
  VcsWalkInput,
  VcsWalkResult,
} from "@vibestudio/service-schemas/vcs";
import { z } from "zod";
import { vcsQueryResultSchema, vcsReadMemoryResultSchema, vcsTrajectoryInvocationRefSchema } from "@vibestudio/service-schemas/vcs";
import { vcsCommitResultSchema, vcsDiscardResultSchema, vcsExternalDeltaResultSchema, vcsImportSnapshotResultSchema, vcsMethods, type VcsMethodName } from "@vibestudio/service-schemas/vcs";
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
  contextMaterializationCommand,
  ContextMaterializationCommandSchema,
  type ContextMaterializationCommand,
  type WorkspaceMaterializationBlob,
  WorkspaceMaterializationRepositorySchema,
  type WorkspaceMaterializationRepository,
} from "@vibestudio/shared/vcs/workspaceProjection";
import { hostRefBasisDigest } from "@vibestudio/shared/vcs/publication";
import {
  collectTreeReachableDigests,
  collectTreeReachableDigestsBatch,
  diffTrees,
  getBytes,
  hasTreeObject,
  materializeTree,
  putBytes,
  readFileAtTree,
  readTreeDirectory,
  resolveTreePath,
  statBlob,
  sweepUnreachableBlobs,
  type TreeReachabilityOutcome,
  type TreeDiff,
} from "../services/blobstoreService.js";
import {
  assertExecutionSourceContentRoot,
  type ExecutionSourceContentRoot,
} from "../services/executionSourceRoots.js";
import {
  RefEventConflictError,
  type AppliedPublication,
  type CanonicalRefPublication,
  type ProtectedRefPublication,
  type ProtectedRefStore,
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
import type {
  WorkspaceSemanticPort,
  WorkspaceSourceSemanticDispatchResult,
  WorkspaceSourceSemanticEffect,
  WorkspaceSourceHostReadRequest,
  WorkspaceSourceHostContentRequest,
  WorkspaceSourceProviderRef,
} from "../workspaceSourceProvider.js";
import type { DODispatch } from "../doDispatch.js";
import type { FsVcsBridge } from "../services/fsService.js";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { RpcCausalParent } from "@vibestudio/rpc";
import {
  GadJsonRecordSchema,
  gadWireMethods,
  workspaceHistoryInitializationInputSchema,
  HISTORY_QUERY_CAUSE_LIMIT,
  HISTORY_SEARCH_CAUSE_LIMIT,
  HistoryQueryBasisSchema,
  HistoryRecallBasisSchema,
  type HistoryQueryTrajectory,
  HistorySearchBasisSchema,
  HistorySearchCausePageSchema,
  HistoryWalkPageSchema,
  HistoryWalkPlanSchema,
  type HistorySearchCause,
  type GadJsonRecord,
} from "@vibestudio/service-schemas/workspaceSource";
import { WorkspaceRepositories } from "./workspaceRepositories.js";
import {
  bindWorkspaceParticipantPublication,
  collectWorkspaceHistoryContentRoots,
  editWorkspaceParticipant,
  forkWorkspaceParticipantContext,
  listAppliedWorkspacePublications,
  listWorkspaceHistoryRuntimeContexts,
  mergeWorkspaceParticipantContext,
  observeAppliedWorkspacePublication,
  openWorkspaceParticipantContext,
  workspaceHistoryFileContentVisible,
  workspaceHistoryPlacementInContexts,
  workspaceParticipantIdentity,
  putPreparedWorkspaceContent,
  readWorkspaceCanonicalMain,
  advanceWorkspaceCommitMemoryIndex,
  readWorkspaceHistoryTemplateInstallation,
  readWorkspaceParticipantContentSource,
  readWorkspaceParticipantFileDescriptors,
  readWorkspaceParticipantProjection,
  readWorkspaceParticipantRevision,
  readWorkspaceParticipantStatus,
  readWorkspacePublicationApproval,
  readWorkspacePublishedRevision,
  requireWorkspaceParticipantOwner,
  rememberWorkspaceParticipantContentSource,
  reviewWorkspaceParticipantMerge,
  retireWorkspaceParticipantContext,
  transferWorkspaceParticipant,
  revertWorkspaceParticipant,
  workspaceMainStateReachable,
  workspaceParticipantCatalog,
  workspaceParticipantReferencesReachable,
  type WorkspaceHistoryParticipant,
  type WorkspaceHistorySource,
} from "./workspaceHistoryHost.js";
import type { WorkspaceRootTemplateBootstrap } from "../workspaceRootTemplateBootstrap.js";
import { retainedBlobDigests, withBlobContentLock } from "../storage/blobRetentions.js";

/**
 * The semantic wire surface, derived from the port rather than mirrored beside
 * it. A hand-written dispatch switch let `vcs.walk`, `vcs.query`, and
 * `vcs.search` ship with schemas, host authorization, and DO implementations
 * while every call still failed at this hop, because nothing typed the two
 * lists against each other. `satisfies` now makes an undispatched port method
 * a compile error.
 */
export type WorkspaceSemanticMethod = Extract<keyof WorkspaceSemanticPort, `vcs${string}`>;
type VcsApiMethodForWire<M extends WorkspaceSemanticMethod> = M extends `vcs${infer Name}`
  ? Uncapitalize<Name> extends VcsMethodName
    ? Uncapitalize<Name>
    : never
  : never;
export type WorkspaceSemanticInput<M extends WorkspaceSemanticMethod> = ReturnType<
  (typeof vcsMethods)[VcsApiMethodForWire<M>]["args"]["parse"]
>[0];
export type WorkspaceSemanticOutput<M extends WorkspaceSemanticMethod> = ReturnType<
  (typeof vcsMethods)[VcsApiMethodForWire<M>]["returns"]["parse"]
>;
type SemanticResultDecoder<T> = (value: unknown) => T;
function semanticApiMethodForWire(method: WorkspaceSemanticMethod): VcsMethodName {
  const name = method.slice(3);
  const apiMethod = `${name[0]?.toLowerCase() ?? ""}${name.slice(1)}`;
  if (!Object.hasOwn(vcsMethods, apiMethod)) {
    throw new Error(`Semantic VCS wire method ${method} has no canonical result schema`);
  }
  return apiMethod as VcsMethodName;
}

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
  vcsMainState: true,
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
  vcsReadFiles: true,
  vcsListDirectory: true,
  vcsListFiles: true,
} as const satisfies Record<WorkspaceSemanticMethod, true>;

export function isSemanticWireMethod(method: string): method is WorkspaceSemanticMethod {
  return Object.hasOwn(SEMANTIC_WIRE_METHODS, method);
}

const SYSTEM_ACTOR = { id: "system", kind: "system" } as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BUILDS_LOG_ID = "builds:workspace";
const CONTENT_OBSERVATION_CONCURRENCY = 32;
const SLOW_SEMANTIC_EFFECT_MS = 500;

type ParticipantHistoryAttachment = WorkspaceHistorySource & {
  /** Physical allocations inherit this provider lifetime and cannot reenter their creating DO. */
  infrastructureContextId?: string;
  destroyRetiredStorage?: (owner: WorkspaceSourceProviderRef) => Promise<void>;
};

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
    placement?: VcsStateNodeRef;
  };
  planDigest: string;
}

export interface ParticipantRepositoryAccess {
  caller: VerifiedCaller;
  ownerContextId: string;
  signal?: AbortSignal;
}

export interface ExactRepositorySnapshotSelection {
  repositoryId: string;
  requiredFiles: readonly string[];
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
  /** A verified seed origin was loaded before graph discovery starts. */
  seededWorkspace?: boolean;
  /** Exact acquired content used until the first protected semantic publication. */
  initialContentState?: string;
  /** Exact source contexts attested by the admitted runtime creation record. */
  runtimeForkSources?: (caller: VerifiedCaller, contextId: string) => Promise<readonly string[]>;
  /** The only pre-userland template path: acquire one exact root for first publication. */
  rootTemplateBootstrap?: Pick<
    WorkspaceRootTemplateBootstrap,
    "prepareInitialization" | "preparedBuildForContent"
  >;
}

export interface PreparedWorkspaceGc {
  readonly epoch: number;
  commit(): Promise<{ scanned: number; swept: number; bytes: number }>;
}

interface SemanticRequest<M extends WorkspaceSemanticMethod> {
  input: WorkspaceSemanticInput<M>;
  ingress: {
    causalParent: import("@vibestudio/rpc").RpcCausalParent | null;
  };
}

/** Host lifecycle/source operations are not model cognition. */

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
 * operation, not only the final authority wait. An initialization observer
 * owns only its wait; the shared initialization itself has a separate owner.
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

/** Cancellation stops actual publication effects through their gate signal.
 * Keep the context fence until the complete dispatch joins: even a reply that
 * arrives after cancellation can contain a committed working-head receipt. */
async function ownedSemanticCall<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw semanticCallAbortError(signal);
  let cancellation: Error | undefined;
  const onAbort = (): void => {
    cancellation = semanticCallAbortError(signal);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const value = await operation();
    if (cancellation) throw cancellation;
    return value;
  } catch (error) {
    if (cancellation && error !== cancellation) {
      throw new AggregateError(
        [cancellation, error],
        "Cancelled semantic operation failed while joining its owned work",
        { cause: cancellation }
      );
    }
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

const outgoingHistoryGrant = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("applied"), head: z.string() }).strict(),
  z.object({ kind: z.literal("staged"), head: z.string() }).strict(),
  z.object({
    kind: z.literal("grant"),
    id: z.string(),
    ref: z.string(),
    token: z.string(),
    branch: z.string().regex(/^incoming\/[a-f0-9]{64}$/u),
  }).strict(),
]);

const incomingHistory = z.object({
  head: z.string().regex(/^[a-f0-9]{40}$/u),
  state: z.object({ kind: z.literal("event"), eventId: z.string().min(1) }).strict(),
  previousEventId: z.string().min(1),
  repositories: z.array(WorkspaceMaterializationRepositorySchema),
  contentHashes: z.array(z.string().regex(/^[a-f0-9]{64}$/u)),
});
const sharedHistorySeedSchema = z.object({
  sourceNodeId: z.string().regex(/^[a-f0-9]{64}$/u),
  head: incomingHistory.shape.head,
  eventId: z.string().min(1),
}).strict();
const sharedHistorySeedReceipt = z.object({
  seed: sharedHistorySeedSchema,
  originalHead: incomingHistory.shape.head,
  installed: z.boolean(),
}).strict();
const freshHistoryRoot = z.object({
  head: incomingHistory.shape.head,
  originalHead: incomingHistory.shape.head,
  eventId: z.string().min(1),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  pin: z.object({ url: z.string().min(1), ref: z.string().min(1), commit: z.string().min(1) }).strict(),
  installed: z.boolean(),
}).strict();
type SharedHistorySeed = z.infer<typeof sharedHistorySeedSchema>;

function exactWorkspaceSourceRequest(
  prepared: import("../workspaceRootTemplateBootstrap.js").PreparedRootTemplateInitialization,
) {
  return {
    commandId: `workspace-source:${prepared.pin.commit}`,
    pin: {
      url: prepared.pin.url,
      ref: prepared.pin.ref,
      commit: prepared.pin.commit,
    },
    installation: prepared.installation,
    repositories: [...prepared.repositories]
      .sort((left, right) => compareUtf16CodeUnits(left.repoPath, right.repoPath))
      .map((repository) => ({
        repoPath: repository.repoPath,
        subdir: repository.subdir,
        snapshot: repository.snapshot,
        contentRoot: repository.contentRoot,
        files: repository.files.map(
          ({
            path: filePath,
            contentHash,
            mode,
            contentKind,
            byteLength,
            coordinateExtent,
          }) => ({
            path: filePath,
            contentHash,
            mode,
            contentKind,
            byteLength,
            coordinateExtent,
          })
        ),
      })),
  } satisfies import("@vibestudio/workspace-contracts/workspaceSource").InitializeExactWorkspaceSnapshotInput;
}

export type CallerPublicationGateContext = {
  kind: "caller";
  caller: VerifiedCaller;
  signal?: AbortSignal;
  via?: string;
  epochTransition?: true;
};

type PublicationGateContext =
  | CallerPublicationGateContext
  | { kind: "workspace-initialization" }
  | { kind: "chronolog" };

type SemanticEffect = Pick<
  WorkspaceSourceSemanticEffect,
  "effectId" | "scopeKind" | "scopeId" | "commandId" | "kind" | "payloadDigest"
> & { payload: GadJsonRecord };
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
  private seededWorkspace: boolean;
  private readonly outgoingHistoryPackets = new Map<string, {
    senderId: string;
    send(bytes: Uint8Array): Promise<Uint8Array>;
  }>();

  private participantHistorySource: ParticipantHistoryAttachment | null = null;
  private readonly protectedPublicationListeners = new Set<
    (event: ProtectedPublicationEvent) => void | Promise<void>
  >();
  private readonly projector: DiskProjector;
  private readonly materializer: ContextMaterializer;
  private readonly locks = new Map<string, Promise<unknown>>();
  private protectedMainMutationTail: Promise<void> = Promise.resolve();
  private readonly protectedMainMutationScope = new AsyncLocalStorage<boolean>();
  /** Exact working-head receipts owned by this host's context mutation fence.
   * A null receipt records explicit deletion; a missing receipt needs recovery. */
  private readonly contextHeads = new Map<string, VcsStateNodeRef | null>();
  private readonly semanticStateByContent = new Map<string, VcsStateNodeRef>();
  /**
   * Exact immutable build-source entries established during this host
   * generation. Build roots are private derived data and never editable;
   * repeatedly walking the same local-package closure made unrelated extension
   * builds dominate cold panel startup. Missing entries are always
   * re-projected, and process restart forgets every receipt so disk state is
   * verified again.
   */
  private readonly verifiedBuildTrees = new Map<string, string>();
  private semanticInitialization: Promise<void> | null = null;
  private ensureFreshInFlight: Promise<{ stateHash: string }> | null = null;

  constructor(private readonly deps: WorkspaceVcsDeps) {
    this.seededWorkspace = deps.seededWorkspace ?? false;
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
    await this.whenSemanticReady();
    const reachable = await this.collectGcReachableDigests(options.executionSourceRoots);
    let committed = false;
    return {
      epoch: options.epoch,
      commit: () =>
        withBlobContentLock(this.deps.blobsDir, async () => {
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
        }),
    };
  }

  private async collectGcReachableDigests(
    executionSourceRoots: readonly ExecutionSourceContentRoot[]
  ): Promise<Set<string>> {
    const source = this.participantHistorySource;
    if (!source) throw new Error("Participant workspace history is unavailable");
    const mainRoots = new Set(this.deps.refs.listMains().map(({ contentRoot }) => contentRoot));
    const roots = new Set(mainRoots);
    const executionRootPaths = new Map<string, Set<string>>();
    for (const executionRoot of executionSourceRoots) {
      const { stateHash, repoPath } = assertExecutionSourceContentRoot(executionRoot);
      roots.add(stateHash);
      const paths = executionRootPaths.get(stateHash) ?? new Set<string>();
      paths.add(repoPath ?? "<workspace>");
      executionRootPaths.set(stateHash, paths);
    }
    const reachable = await collectWorkspaceHistoryContentRoots(source);
    for (const digest of retainedBlobDigests(this.deps.blobsDir)) reachable.add(digest);
    const cachedViewRoots = this.repositories.cachedViewRoots();
    const allRoots = [
      ...new Set([...roots, ...cachedViewRoots.map(({ stateHash }) => stateHash)]),
    ].sort(compareUtf16CodeUnits);
    const outcomes = await collectTreeReachableDigestsBatch(this.deps.blobsDir, allRoots, {
      verifyContent: true,
    });
    const outcomesByRoot = new Map<string, TreeReachabilityOutcome>();
    for (let index = 0; index < allRoots.length; index += 1) {
      const root = allRoots[index]!;
      const outcome = outcomes[index];
      if (!outcome) throw new Error(`GC batch proof omitted root ${root}`);
      outcomesByRoot.set(root, outcome);
    }

    // Cached workspace compositions are disposable. Preserve the existing
    // policy of evicting a broken cached root. Protected main and retained
    // execution roots remain strict inputs.
    const cachedReachable = this.repositories.collectCachedReachableDigests(
      cachedViewRoots,
      outcomesByRoot
    );
    for (const digest of cachedReachable.treeDigests) reachable.add(digest);
    for (const digest of cachedReachable.contentDigests) reachable.add(digest);

    const failures: Array<{ root: string; reason: unknown }> = [];
    for (const root of [...roots].sort(compareUtf16CodeUnits)) {
      const outcome = outcomesByRoot.get(root);
      if (!outcome) throw new Error(`GC batch proof omitted strict root ${root}`);
      if (outcome.status === "rejected") {
        failures.push({ root, reason: outcome.reason });
        continue;
      }
      const tree = outcome.value;
      if (!tree) {
        const provenance = mainRoots.has(root)
          ? "protected main"
          : `retained execution source (${[...(executionRootPaths.get(root) ?? [])].join(", ")})`;
        failures.push({
          root,
          reason: new Error(
            `GC root ${root} is missing from the content store (provenance: ${provenance})`
          ),
        });
        continue;
      }
      for (const digest of tree.treeDigests) reachable.add(digest);
      for (const digest of tree.contentDigests) reachable.add(digest);
    }
    if (failures.length === 1) throw failures[0]!.reason;
    if (failures.length > 1) {
      const failedRoots = failures.map(({ root }) => root).join(", ");
      throw new AggregateError(
        failures.map(({ reason }) => reason),
        `GC reachability validation failed for ${failures.length} roots: ${failedRoots}`,
        { cause: failures[0]!.reason }
      );
    }
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

  async listSemanticContexts(prefix?: string): Promise<string[]> {
    await this.whenSemanticReady();
    const source = this.participantHistorySource;
    if (!source) throw new Error("Participant workspace history is unavailable");
    return listWorkspaceHistoryRuntimeContexts(source, prefix);
  }

  /** The attachment owns one initialization flight. Content reads keep using
   * the prepared snapshot; semantic operations await its publication. */
  startSemanticInitialization(operation: () => Promise<void>): Promise<void> {
    if (this.semanticInitialization) return this.semanticInitialization;
    const initialization = Promise.resolve().then(operation);
    this.semanticInitialization = initialization;
    // The managed semanticWorkspace service observes failure; retain the same
    // rejected promise for every editing caller, including later requests.
    void initialization.catch(() => {});
    return initialization;
  }

  whenSemanticReady(signal?: AbortSignal): Promise<void> {
    const initialized = this.semanticInitialization ?? Promise.resolve();
    return signal ? abortableSemanticCall(() => initialized, signal) : initialized;
  }

  async attachGad(gad: WorkspaceSemanticPort): Promise<void> {
    if (this.gadCaller) throw new Error("semantic workspace is already attached");
    this.gadCaller = gad;
  }

  async readTemplateInstallation(eventId: string) {
    await this.whenSemanticReady();
    if (!this.participantHistorySource) throw new Error("Native workspace history has not been attached");
    return readWorkspaceHistoryTemplateInstallation(this.participantHistorySource, eventId);
  }

  async attachParticipantHistory(source: ParticipantHistoryAttachment): Promise<void> {
    return this.mutateProtectedMain(async () => {
      if (this.participantHistorySource) {
        throw new Error("Participant workspace history is already attached");
      }
      await this.recoverParticipantPublications(source);
      const main = await readWorkspaceCanonicalMain(source);
      const protectedEventId = this.deps.refs.readMainSemanticState()?.eventId ?? null;
      if (main.eventId !== protectedEventId) {
        throw new RefEventConflictError(
          main.eventId,
          protectedEventId,
          this.deps.refs.readHeadPublication()?.publicationId ?? null
        );
      }
      this.participantHistorySource = source;
      await this.indexPublishedCommitMemory(main.eventId);
    });
  }

  async initializeFreshHistory(source: WorkspaceHistorySource): Promise<boolean> {
    const { dispatch, canonical } = source;
    const read = async () => freshHistoryRoot.nullable().parse(
      await dispatch.dispatch(canonical, "readFreshHistoryRoot"),
    );
    const rootTemplate = this.deps.rootTemplateBootstrap;
    return this.mutateProtectedMain(async () => {
      const recorded = await read();
      const published = this.deps.refs.readMainSemanticState();
      if (published) return recorded?.installed === true;
      if (!rootTemplate) return false;
      const prepared = await rootTemplate.prepareInitialization();
      if (!prepared) return false;
      const request = workspaceHistoryInitializationInputSchema.parse(exactWorkspaceSourceRequest(prepared));
      const staged = freshHistoryRoot.extend({ repositories: incomingHistory.shape.repositories }).parse(
        await dispatch.dispatch(canonical, "stageFreshHistoryRoot", request),
      );
      if (staged.requestDigest !== sha256HexSyncText(canonicalJson(request)))
        throw new Error("Workspace history staged a different root template");
      const roots = new Map(prepared.repositories.map(({ repoPath, contentRoot }) => [repoPath, contentRoot]));
      const planned = await this.materializer.planContentRoots(staged.repositories);
      if (planned.length !== roots.size ||
          planned.some(({ repoPath, contentRoot }) => roots.get(repoPath) !== contentRoot))
        throw new Error("Workspace history staged different template files");
      const { eventId, head, requestDigest } = staged;
      const publicationId = `workspace-root:${requestDigest}`;
      await this.publishMain({
        effectId: publicationId,
        payload: GadJsonRecordSchema.parse({
          previousEventId: `${publicationId}:empty`,
          publishedEventId: eventId,
          repositories: staged.repositories,
        }),
      }, { kind: "workspace-initialization" }, {
        approved: async () => {
          const receipt = await read();
          return receipt?.installed === true && receipt.head === head &&
            receipt.eventId === eventId && receipt.requestDigest === requestDigest;
        },
        authorize: async () => undefined,
        publish: async () => {
          z.object({ head: z.literal(head), eventId: z.literal(eventId) }).strict().parse(
            await dispatch.dispatch(canonical, "installFreshHistoryRoot", { head, eventId, requestDigest }),
          );
        },
        acknowledge: async () => undefined,
      });
      this.deps.refs.acknowledgePublication(publicationId);
      return true;
    });
  }

  /** Resolve a host-approved transfer to its exact native sender. */
  async forwardHistoryPacket(
    caller: VerifiedCaller,
    input: { transferId: string; bytes: Uint8Array }
  ): Promise<Uint8Array> {
    const transfer = this.outgoingHistoryPackets.get(input.transferId);
    if (!transfer || caller.runtime.kind !== "do" || caller.runtime.id !== transfer.senderId) {
      throw new Error("Workspace history transport requires its active canonical sender");
    }
    return transfer.send(input.bytes);
  }

  private async withHistoryPacketTransfer<T>(
    canonical: WorkspaceSourceProviderRef,
    send: (bytes: Uint8Array) => Promise<Uint8Array>,
    transfer: (transferId: string) => Promise<T>
  ): Promise<T> {
    const transferId = crypto.randomUUID();
    this.outgoingHistoryPackets.set(transferId, {
      senderId: canonicalEntityId({
        kind: "do", source: canonical.source, className: canonical.className, key: canonical.objectKey,
      }),
      send,
    });
    try {
      return await transfer(transferId);
    } finally {
      this.outgoingHistoryPackets.delete(transferId);
    }
  }

  /** The workspace creation owner has verified this source and destination. */
  async initializeSharedHistory(input: WorkspaceHistorySource & {
    seed: SharedHistorySeed;
    offer: { destinationNodeId: string; branch: string; token: string };
    fetchPack(bytes: Uint8Array): Promise<Uint8Array>;
    fetchFile(digest: string): Promise<Uint8Array>;
    confirmSource(): Promise<void>;
  }): Promise<void> {
    const { canonical, dispatch, offer } = input;
    const seed = sharedHistorySeedSchema.parse(input.seed);
    this.seededWorkspace = true;
    const publicationId = `workspace-seed:${sha256HexSyncText(canonicalJson(seed))}`;
    const readReceipt = async () => sharedHistorySeedReceipt.nullable().parse(
      await dispatch.dispatch(canonical, "readSharedHistorySeedReceipt")
    );
    // Seeding establishes semantic readiness. Take the publication lease
    // directly so startup never waits for its own initialization to finish.
    await this.mutateProtectedMain(async () => {
      const prior = this.deps.refs.readAppliedPublication(publicationId);
      if (prior) {
        await this.replayPublicationObservers(prior);
        this.deps.refs.acknowledgePublication(publicationId);
        return;
      }
      if (this.deps.refs.readMainSemanticState() || this.deps.refs.listMains().length > 0) {
        const receipt = await readReceipt();
        if (receipt?.installed === true && canonicalJson(receipt.seed) === canonicalJson(seed)) return;
        throw new Error("A workspace seed can only initialize empty protected history");
      }
      const received = await this.withHistoryPacketTransfer(canonical, input.fetchPack, (transferId) =>
        dispatch.dispatch(canonical, "stageSharedHistorySeed", { ...seed, ...offer, transferId })
      );
      const candidate = incomingHistory.pick({ state: true, repositories: true, contentHashes: true }).parse(received);
      if (candidate.state.eventId !== seed.eventId) throw new Error("Workspace seed returned a different event");
      for (const digest of candidate.contentHashes) {
        if (await statBlob(this.deps.blobsDir, digest)) continue;
        const bytes = await input.fetchFile(digest);
        if (crypto.createHash("sha256").update(bytes).digest("hex") !== digest) {
          throw new Error("Workspace seed file bytes do not match their digest");
        }
        await withBlobContentLock(this.deps.blobsDir, async () => {
          if (await statBlob(this.deps.blobsDir, digest)) return;
          markPrivateWorkspaceBlobs(this.deps.blobsDir, [digest]);
          await putBytes(this.deps.blobsDir, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
        });
      }
      await this.publishMain({ effectId: publicationId, payload: GadJsonRecordSchema.parse({
        previousEventId: `${publicationId}:empty`,
        publishedEventId: seed.eventId,
        repositories: candidate.repositories,
      }) }, { kind: "workspace-initialization" }, {
        approved: async () => {
          const receipt = await readReceipt();
          return receipt?.installed === true && canonicalJson(receipt.seed) === canonicalJson(seed);
        },
        authorize: input.confirmSource,
        publish: async () => {
          const installed = sharedHistorySeedSchema.parse(await dispatch.dispatch(canonical, "installSharedHistorySeed", seed));
          if (canonicalJson(installed) !== canonicalJson(seed)) throw new Error("Workspace installed a different seed");
        },
        acknowledge: async () => undefined,
      });
      this.deps.refs.acknowledgePublication(publicationId);
    });
  }

  currentPublishedHistory() {
    const source = this.participantHistorySource;
    if (!source) throw new Error("Workspace history is not ready for synchronization");
    return readWorkspaceCanonicalMain(source);
  }

  async copyPublishedHistory(input: {
    eventId: string;
    head: string;
    request(request:
      | { kind: "grant" | "missing" | "publish" }
      | { kind: "push"; bytes: Uint8Array }
      | { kind: "blob"; digest: string; bytes: Uint8Array }
    ): Promise<unknown>;
  }): Promise<string> {
    const source = this.participantHistorySource;
    if (!source) throw new Error("Workspace history is not ready for synchronization");
    const { canonical, dispatch } = source;
    const published = await readWorkspacePublishedRevision({ dispatch, canonical, eventId: input.eventId });
    if (published.head !== input.head) throw new Error("The approved shared history revision changed");
    const permit = outgoingHistoryGrant.parse(await input.request({ kind: "grant" }));
    if (permit.kind !== "grant" && permit.head !== input.head)
      throw new Error("Peer reported a different shared history revision");
    if (permit.kind === "applied") return permit.head;
    if (permit.kind === "grant") {
      const result = await this.withHistoryPacketTransfer(
        canonical,
        async (bytes) => ByteArraySchema.parse(await input.request({ kind: "push", bytes })),
        (transferId) => dispatch.dispatch(canonical, "pushOutgoingHistory", {
          transferId, eventId: input.eventId, head: input.head,
          origin: { ref: permit.ref, token: permit.token },
          branch: permit.branch,
        })
      );
      z.object({ hash: z.literal(input.head) }).parse(result);
    }
    const missing = z.array(z.string().regex(/^[a-f0-9]{64}$/u)).parse(
      await input.request({ kind: "missing" })
    );
    for (const digest of missing) {
      const allowed = await dispatch.dispatch(canonical, "hasOutgoingHistoryContent", {
        eventId: input.eventId, head: input.head, digest,
      });
      if (allowed !== true) throw new Error("The peer requested bytes outside the published history");
      const bytes = await getBytes(this.deps.blobsDir, digest);
      if (!bytes) throw new Error("Published history is missing a referenced file");
      await input.request({ kind: "blob", digest, bytes });
    }
    return z.literal(input.head).parse(await input.request({ kind: "publish" }));
  }

  async dispatchIncomingHistory(
    method: HistoryIngressMethod,
    publication: HistoryIngressInput,
    verifyPublication: (publication: HistoryIngressInput) => Promise<void>
  ): Promise<unknown> {
    const source = this.participantHistorySource;
    if (!source) throw new Error("Workspace history is not ready for synchronization");
    const blobsDir = this.deps.blobsDir;
    if (method === "stageIncomingHistory") {
      const receipt = await readWorkspacePublicationApproval({
        ...source,
        publicationId: `chronolog-publication:${publication.publicationId}`,
      });
      if (receipt?.applied) await this.recoverParticipantPublications(source);
    }
    if (method === "missingHistoryContent") {
      const received = await source.dispatch.dispatch(source.canonical, "readIncomingHistory", publication);
      const hashes = incomingHistory.parse(received).contentHashes;
      const missing: string[] = [];
      for (const hash of hashes) {
        if (!(await statBlob(blobsDir, hash))) missing.push(hash);
      }
      return missing;
    }
    if (method === "checkHistoryContent" || method === "storeHistoryContent") {
      const { digest, bytes, ...transition } = publication;
      if (!digest || await source.dispatch.dispatch(source.canonical, "hasIncomingHistoryContent", {
        ...transition,
        digest,
      }) !== true) {
        throw new Error("This content is outside the staged workspace history");
      }
      if (method === "checkHistoryContent") return;
      if (!bytes || crypto.createHash("sha256").update(bytes).digest("hex") !== digest) {
        throw new Error("Incoming workspace file bytes do not match their digest");
      }
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      await withBlobContentLock(blobsDir, async () => {
        if (!(await statBlob(blobsDir, digest))) {
          markPrivateWorkspaceBlobs(blobsDir, [digest]);
          await putBytes(blobsDir, buffer);
        }
      });
      return;
    }
    if (method === "publishIncomingHistory")
      return this.publishIncomingHistory(source, publication, () => verifyPublication(publication));
    return source.dispatch.dispatch(source.canonical, method, publication);
  }

  private async publishIncomingHistory(
    source: WorkspaceHistorySource,
    publication: HistoryIngressInput,
    verifyPublication: () => Promise<void>
  ) {
    const { group, publisher, publicationId: transferId, sourceNodeId, previousHead, proposedHead } = publication;
    const transition = { publicationId: transferId, sourceNodeId, previousHead, proposedHead };
    if (!group || !publisher) throw new Error("Incoming history has no verified Chronolog signer");
    const payload = { ...transition, group, publisher };
    const publicationId = `chronolog-publication:${transition.publicationId}`;
    const { canonical, dispatch } = source;
    const approval = () => readWorkspacePublicationApproval({ dispatch, canonical, publicationId });
    const existing = async () => {
      const receipt = await approval();
      if (receipt && (
        receipt.approval.participantId !== `chronolog:${group}:${publisher}` ||
        receipt.approval.publication.previousHead !== transition.previousHead ||
        receipt.approval.publication.proposedHead !== transition.proposedHead
      )) throw new Error("Incoming history receipt names a different publication");
      return receipt;
    };
    return this.withProtectedMainMutation(async () => {
      const receipt = await existing();
      const prior = this.deps.refs.readAppliedPublication(publicationId);
      if (prior) {
        await this.replayPublicationObservers(prior);
        if (receipt) await dispatch.dispatch(canonical, "acknowledgeHistoryPublication", { publicationId });
        this.deps.refs.acknowledgePublication(publicationId);
        return transition.proposedHead;
      }
      if (receipt?.applied) {
        await this.recoverParticipantPublications(source);
        if (!this.deps.refs.readAppliedPublication(publicationId))
          throw new Error("Incoming history publication could not be recovered");
        return transition.proposedHead;
      }
      const candidate = incomingHistory.parse(await dispatch.dispatch(canonical, "readIncomingHistory", transition));
      if (candidate.head !== transition.proposedHead) throw new Error("Incoming history head differs from the proof");
      for (const hash of candidate.contentHashes) {
        if (!(await statBlob(this.deps.blobsDir, hash))) {
          throw new Error("Incoming history is missing a referenced file");
        }
      }
      const canonicalPublication: CanonicalRefPublication = {
        approved: async () => {
          const recorded = await existing();
          return recorded !== null && (recorded.applied || recorded.expiresAt > Date.now());
        },
        authorize: async () => {
          await dispatch.dispatch(canonical, "authorizeIncomingHistory", payload);
        },
        publish: async () => {
          await verifyPublication();
          try {
            z.object({ head: z.literal(transition.proposedHead) }).parse(
              await dispatch.dispatch(canonical, "publishIncomingHistory", payload)
            );
          } catch (error) {
            if (!(await existing())?.applied) throw error;
          }
        },
        acknowledge: async () => {
          await dispatch.dispatch(canonical, "acknowledgeHistoryPublication", { publicationId });
        },
      };
      await this.publishMain({ effectId: publicationId, payload: GadJsonRecordSchema.parse({
        previousEventId: candidate.previousEventId,
        publishedEventId: candidate.state.eventId,
        repositories: candidate.repositories,
      }) }, { kind: "chronolog" }, canonicalPublication);
      this.deps.refs.acknowledgePublication(publicationId);
      return transition.proposedHead;
    });
  }

  get participantHistoryAttached(): boolean {
    return this.participantHistorySource !== null;
  }

  async canReadPrivateWorkspaceBlob(input: ({
    contentHash: string;
  } | {
    placement: VcsStateNodeRef;
  }) & {
    context?: ServiceContext;
    ownerContextId?: string | null;
    readOwnedContextIds?: () => Promise<readonly string[]>;
    isActive: (owner: WorkspaceSourceProviderRef) => Promise<boolean>;
  }): Promise<boolean> {
    const { context, ownerContextId } = input;
    if ("contentHash" in input && context &&
        hasBlobUploads(this.deps.blobsDir, blobUploadPrincipal(context), [input.contentHash])) {
      return true;
    }
    const source = this.participantHistorySource;
    if (!source) return false;
    const published = this.deps.refs.readMainSemanticState();
    if (published) {
      const visible = "placement" in input
        ? await workspaceMainStateReachable(source, input.placement, published.eventId)
        : await workspaceHistoryFileContentVisible(source, source.canonical, input.contentHash, {
            kind: "published", expectedEventId: published.eventId,
          });
      if (visible) return true;
    }
    if (!context || !ownerContextId) return false;
    const participantId = workspaceParticipantIdentity(context.caller, ownerContextId);
    const owner = { ...source.canonical, objectKey: `work-${sha256HexSyncText(participantId)}` };
    if (!await input.isActive(owner)) return false;
    if ("placement" in input) {
      const contextIds = await input.readOwnedContextIds?.() ?? [];
      return workspaceHistoryPlacementInContexts(
        source, owner, [ownerContextId, ...contextIds], input.placement,
      );
    }
    const { contentHash } = input;
    const visibleIn = (contextId: string) =>
      workspaceHistoryFileContentVisible(source, owner, contentHash, { kind: "context", contextId });
    if (await visibleIn(ownerContextId)) return true;
    for (const contextId of await input.readOwnedContextIds?.() ?? []) {
      if (await visibleIn(contextId)) return true;
    }
    return false;
  }

  async readParticipantMain() {
    const source = this.participantHistorySource;
    if (!source) throw new Error("Participant workspace history is unavailable");
    const main = await readWorkspaceCanonicalMain(source);
    return { kind: "event" as const, eventId: main.eventId };
  }

  async participantRecallCauses(
    caller: VerifiedCaller, args: readonly unknown[], signal?: AbortSignal,
  ): Promise<HistorySearchCause[]> {
    const [{ kinds }] = gadWireMethods.recallMemory.args.parse(args);
    const contextId = caller.agentBinding?.contextId;
    if (!contextId || (kinds?.length && !kinds.includes("message"))) return [];
    const { dispatch, owner } = await this.requireParticipantContentScope(contextId, caller, signal);
    const protectedEventId = this.deps.refs.readMainSemanticState()?.eventId;
    if (!protectedEventId) throw new Error("Workspace recall needs a protected main event");
    const revisions = HistoryRecallBasisSchema.parse(
      await dispatch.dispatch(owner, "readHistoryRecallBasis", { contextId, protectedEventId }),
    );
    const causes = new Map<string, HistorySearchCause>();
    for await (const page of this.participantHistoryCausePages({ dispatch, owner }, revisions, signal)) {
      for (const cause of page) causes.set(canonicalJson(cause), cause);
    }
    signal?.throwIfAborted();
    return [...causes.values()];
  }

  private async *participantHistoryCausePages(
    { dispatch, owner }: Pick<WorkspaceHistoryParticipant, "dispatch" | "owner">,
    revisions: readonly string[],
    signal?: AbortSignal,
  ) {
    for (const revision of new Set(revisions)) {
      let after: HistorySearchCause | null = null;
      for (;;) {
        signal?.throwIfAborted();
        const page = HistorySearchCausePageSchema.parse(
          await dispatch.dispatch(owner, "readHistorySearchCauses", { revision, after }),
        );
        signal?.throwIfAborted();
        if (page.length === 0) break;
        const next = page.at(-1)!;
        if (canonicalJson(after) === canonicalJson(next))
          throw new Error("Workspace history causal page did not advance");
        yield page;
        if (page.length < HISTORY_SEARCH_CAUSE_LIMIT) break;
        after = next;
      }
    }
  }

  async queryParticipantHistory(input: WorkspaceHistoryParticipant & {
    query: VcsQueryInput;
    signal?: AbortSignal;
  }): Promise<VcsQueryResult> {
    requireWorkspaceParticipantOwner(input);
    const { query, dispatch, owner, signal } = input;
    const protectedEventId = this.deps.refs.readMainSemanticState()?.eventId;
    if (!protectedEventId) throw new Error("Workspace query needs a protected main event");
    const basis = HistoryQueryBasisSchema.parse(await dispatch.dispatch(owner, "readHistoryQueryBasis", {
      query, protectedEventId,
    }));
    let trajectory: HistoryQueryTrajectory = { invocations: [], turns: [], messages: [], truncated: false };
    if (basis.needsTrajectory) {
      const causes = new Map<string, HistorySearchCause>();
      pages: for await (const page of this.participantHistoryCausePages({ dispatch, owner }, basis.revisions, signal)) {
        for (const cause of page) {
          causes.set(canonicalJson(cause), cause);
          if (causes.size > HISTORY_QUERY_CAUSE_LIMIT) {
            trajectory.truncated = true;
            break pages;
          }
        }
      }
      if (causes.size && !trajectory.truncated)
        trajectory = await this.gad().readHistoryQueryTrajectory([...causes.values()]);
    }
    signal?.throwIfAborted();
    const result = vcsQueryResultSchema.parse(await dispatch.dispatch(owner, "readHistoryQuery", {
      query, basis, trajectory,
    }));
    if (canonicalJson(result.state) !== canonicalJson(basis.state) ||
        result.rows.length > query.limit ||
        result.rows.some((row) => row.length !== result.columns.length)) {
      throw new Error("Workspace history returned a different query result");
    }
    return result;
  }

  async walkParticipantHistory(input: WorkspaceHistoryParticipant & { walk: VcsWalkInput }): Promise<VcsWalkResult> {
    requireWorkspaceParticipantOwner(input);
    const { walk, dispatch, owner } = input;
    const protectedEventId = this.deps.refs.readMainSemanticState()?.eventId;
    if (!protectedEventId) throw new Error("Workspace walk needs a protected main event");
    const plan = HistoryWalkPlanSchema.parse(await dispatch.dispatch(owner, "readHistoryWalk", {
      walk, protectedEventId,
    }));
    let page;
    if (plan.kind === "cohort") {
      if (walk.walk !== "cohort") throw new Error("Workspace walk returned a different scope");
      const invocations = await this.gad().readHistoryWalkCohortInvocations(plan.seed);
      page = HistoryWalkPageSchema.parse(await dispatch.dispatch(owner, "readHistoryWalkCohort", {
        walk, revisions: plan.revisions, seed: plan.seed, invocations,
      }));
    } else {
      page = plan.page;
      if (plan.invocation) {
        if (walk.walk !== "cause") throw new Error("Workspace walk returned a different scope");
        const trail = await this.gad().readHistoryWalkInvocation(plan.invocation);
        const first = trail.entries[0];
        if (first && canonicalJson(first.node) !== canonicalJson(plan.invocation))
          throw new Error("Workspace trajectory mirror returned a different invocation");
        const depth = page.entries.length;
        page = {
          entries: [...page.entries, ...trail.entries.map((entry) => ({ ...entry, depth: entry.depth + depth }))],
          notes: [...page.notes, ...trail.notes],
        };
      }
    }
    const basis = sha256HexSyncText(canonicalJson({
      contextId: walk.contextId, walk: walk.walk, scope: walk.scope, subject: walk.subject,
      revisions: plan.revisions, page,
    }));
    const position = walk.cursor?.length && /^native-walk:([a-f0-9]{64}):([0-9]{1,4})$/u.exec(walk.cursor);
    if (walk.cursor && (!position || position[1] !== basis || Number(position[2]) >= page.entries.length))
      throw new Error("InvalidReference: walk cursor does not match the admitted history");
    const offset = position ? Number(position[2]) : 0;
    const next = offset + walk.limit;
    return {
      walk: walk.walk, scope: walk.walk === "cohort" ? walk.scope : null, subject: walk.subject,
      entries: page.entries.slice(offset, next), omitted: [], notes: page.notes,
      nextCursor: next < page.entries.length ? `native-walk:${basis}:${next}` : null,
    };
  }

  async readParticipantMemory(input: WorkspaceHistoryParticipant & {
    memory: VcsReadMemoryInput;
  }): Promise<VcsReadMemoryResult> {
    requireWorkspaceParticipantOwner(input);
    const { dispatch, owner, memory } = input;
    const packet = z.object({
      memory: vcsReadMemoryResultSchema,
      invocations: z.array(vcsTrajectoryInvocationRefSchema.nullable()).max(12),
    }).strict().parse(await dispatch.dispatch(owner, "readHistoryMemory", memory));
    const result = packet.memory;
    if (result.path !== memory.path ||
        (result.status === "stale" && result.expectedContentHash !== memory.expectedContentHash)) {
      throw new Error("Workspace history returned memory for different content");
    }
    if (result.status !== "attached") return result;
    if (result.contentHash !== memory.expectedContentHash ||
        result.range.start !== memory.range.start || result.range.end !== memory.range.end ||
        result.history.length > memory.historyLimit || result.episodes.length > memory.episodeLimit ||
        result.episodes.length !== packet.invocations.length) {
      throw new Error("Workspace history returned memory for different content");
    }
    const causes = new Map<string, ReturnType<WorkspaceSemanticPort["readHistoryMemoryCause"]>>();
    const episodes = await Promise.all(result.episodes.map(async (episode, index) => {
      const invocation = packet.invocations[index];
      if (episode.stop === "snapshot-boundary" || !invocation) return episode;
      const key = canonicalJson(invocation);
      const pending = causes.get(key) ?? this.gad().readHistoryMemoryCause(invocation);
      causes.set(key, pending);
      const cause = await pending;
      if (cause && canonicalJson(cause.invocation) !== key)
        throw new Error("Workspace trajectory mirror returned a different invocation");
      return { ...episode, cause };
    }));
    return { ...result, episodes };
  }

  async searchParticipantHistory(input: WorkspaceHistoryParticipant & {
    search: VcsSearchInput;
    signal?: AbortSignal;
  }): Promise<WorkspaceSemanticOutput<"vcsSearch">> {
    requireWorkspaceParticipantOwner(input);
    const { search, dispatch, owner, signal } = input;
    const protectedEventId = this.deps.refs.readMainSemanticState()?.eventId;
    if (!protectedEventId) throw new Error("Workspace search needs a protected main event");
    const basis = HistorySearchBasisSchema.parse(
      await dispatch.dispatch(owner, "searchHistory", { search, protectedEventId }),
    );
    if (basis.hits.length > search.limit ||
        basis.hits.some((hit) => hit.subjectKind === "trajectory-message" || hit.subjectKind !== hit.node.kind)) {
      throw new Error("Workspace history returned different search subjects");
    }
    const hits = new Map(basis.hits.map((hit) => [canonicalJson(hit.node), hit]));
    if (!basis.truncated) {
      // The history owner captured these exact revisions under its read
      // boundary. The separate trajectory mirror receives only bounded
      // pages of the recorded invocation coordinates from those revisions.
      pages: for await (const causes of this.participantHistoryCausePages({ dispatch, owner }, basis.revisions, signal)) {
        const found = await this.gad().searchHistoryTrajectory({
          text: search.text, limit: search.limit, causes,
        });
        if (found.length > search.limit + 1 ||
            found.some((hit) => hit.subjectKind !== "trajectory-message" || hit.node.kind !== "trajectory-message")) {
          throw new Error("Workspace trajectory mirror returned different search subjects");
        }
        for (const hit of found) {
          hits.set(canonicalJson(hit.node), hit);
          if (hits.size > search.limit) break pages;
        }
      }
    }
    return {
      text: search.text, indexMode: "scan",
      hits: [...hits.values()].slice(0, search.limit),
      truncated: basis.truncated || hits.size > search.limit,
    };
  }

  async participantExecutionVisible(
    artifact: import("@vibestudio/shared/execution/retention").ExecutionArtifactRefV1,
    caller: VerifiedCaller,
    contextId: string | null,
    signal?: AbortSignal,
    readableContextIds: readonly string[] = []
  ): Promise<boolean> {
    const source = artifact.sourceState;
    return source.kind === "product-seed" ||
      (source.workspaceId === this.workspaceId &&
        await this.participantBuildStateReachable(source.state, caller, contextId, signal, readableContextIds));
  }

  async participantBuildStateReachable(
    state: import("@vibestudio/shared/execution/retention").ExecutionSourceStateRef | null | undefined,
    caller: VerifiedCaller,
    contextId: string | null,
    signal?: AbortSignal,
    readableContextIds: readonly string[] = []
  ): Promise<boolean> {
    if (!state) return false;
    if (state.kind === "bootstrap-snapshot") {
      return state.snapshotHash === this.deps.initialContentState;
    }
    if (!this.participantHistorySource) await this.whenSemanticReady(signal);
    const source = this.participantHistorySource;
    if (!source) return false;
    if (await workspaceMainStateReachable(source, state)) return true;
    if (!contextId) return false;
    const scope = await this.openParticipantScope({
      caller, contextId, ownerContextId: contextId, ...(signal ? { signal } : {}),
    });
    return Boolean(scope && await workspaceParticipantReferencesReachable({
      ...scope, contextIds: [contextId, ...readableContextIds], references: [{ kind: "state-node", value: state }],
    }));
  }

  async openParticipantScope(input: {
    caller: VerifiedCaller;
    contextId: string;
    ownerContextId: string;
    signal?: AbortSignal;
  }) {
    const source = this.participantHistorySource;
    if (!source) return null;
    return this.lockParticipantContexts(input.ownerContextId, input.contextId, () =>
      this.openAdmittedParticipantScope(source, input)
    );
  }

  private lockParticipantContexts<T>(left: string, right: string, operation: () => Promise<T>): Promise<T> {
    if (left === right) return this.locked(`context-lifecycle:${left}`, operation);
    const [first, second] = [left, right].sort();
    return this.locked(`context-lifecycle:${first}`, () =>
      this.locked(`context-lifecycle:${second}`, operation)
    );
  }

  private async openAdmittedParticipantScope(
    source: NonNullable<WorkspaceVcs["participantHistorySource"]>,
    input: { caller: VerifiedCaller; contextId: string; ownerContextId: string; signal?: AbortSignal }
  ) {
    if (this.contextHeads.get(input.ownerContextId) === null || this.contextHeads.get(input.contextId) === null) {
      throw new Error("Workspace participant context has retired");
    }
    const forkSources = input.contextId === input.ownerContextId
      ? await this.deps.runtimeForkSources?.(input.caller, input.contextId) : undefined;
    const reservation = await openWorkspaceParticipantContext({
      ...source, ...input,
      ...(forkSources?.length ? { runtimeFork: { sourceContextIds: forkSources, blobsDir: this.deps.blobsDir } } : {}),
    });
    return {
      dispatch: source.dispatch, canonical: source.canonical, ...reservation,
      caller: input.caller, contextId: input.contextId, ownerContextId: input.ownerContextId,
    };
  }

  /** Both scopes are resolved from admitted runtime lifetimes before this call. */
  async forkParticipantContext(input: {
    parent: { caller: VerifiedCaller; contextId: string; ownerContextId?: string };
    child: { caller: VerifiedCaller; contextId: string; ownerContextId: string };
    retainForRuntime?: boolean;
  }): Promise<VcsStateNodeRef> {
    const { parent, child } = input;
    if (parent.contextId === child.contextId) {
      throw new Error("Workspace fork requires distinct admitted lifetimes");
    }
    const source = this.participantHistorySource;
    if (!source) throw new Error("Participant workspace history is unavailable");
    const ownerContextId = parent.ownerContextId ?? parent.contextId;
    if (child.ownerContextId !== child.contextId && child.ownerContextId !== ownerContextId) {
      throw new Error("Workspace fork target must belong to one of its admitted lifetimes");
    }
    return this.lockParticipantContexts(parent.contextId, child.contextId, async () => {
      if (this.contextHeads.get(child.contextId) === null) {
        throw new Error("Workspace participant context has retired");
      }
      const scope = await this.openAdmittedParticipantScope(source, { ...parent, ownerContextId });
      return forkWorkspaceParticipantContext({
        ...scope, child, blobsDir: this.deps.blobsDir,
        ...(input.retainForRuntime ? { retainForRuntime: true } : {}),
      });
    });
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
  async semanticCall<M extends WorkspaceSemanticMethod>(
    method: M,
    request: SemanticRequest<M>,
    publicationGateContext?: CallerPublicationGateContext
  ): Promise<WorkspaceSemanticOutput<M>> {
    await this.whenSemanticReady(
      publicationGateContext?.kind === "caller" ? publicationGateContext.signal : undefined
    );
    return this.dispatchSemanticCall(method, request, publicationGateContext);
  }

  private async dispatchSemanticCall<M extends WorkspaceSemanticMethod>(
    method: M,
    request: SemanticRequest<M>,
    publicationGateContext?: PublicationGateContext
  ): Promise<WorkspaceSemanticOutput<M>> {
    const dispatch = async (): Promise<WorkspaceSemanticOutput<M>> => {
      const contextId = semanticRequestContextId(request);
      const operationClass = vcsMethods[semanticApiMethodForWire(method)].operationClass;
      if (contextId && operationClass !== "read") this.contextHeads.delete(contextId);
      const owner = this.gad();
      const next = await this.dispatchSemanticWire(owner, method, request);
      const result = await this.drainSemanticResult(
        owner,
        next,
        (value) =>
          vcsMethods[semanticApiMethodForWire(method)].returns.parse(
            value
          ) as WorkspaceSemanticOutput<M>,
        publicationGateContext
      );
      if (contextId && operationClass === "context-write") {
        // Public mutation results were decoded above. Publish only the exact
        // resulting working coordinate, never the request's expected basis.
        const receipt = result as Record<string, unknown>;
        if (receipt["workingHead"]) {
          this.publishContextHead(contextId, receipt["workingHead"] as VcsStateNodeRef);
        } else if (method === "vcsCommit") {
          this.publishContextHead(contextId, receipt["event"] as VcsStateNodeRef);
        } else if (method === "vcsImportSnapshot") {
          this.publishContextHead(contextId, {
            kind: "event",
            eventId: receipt["eventId"] as string,
          });
        }
      }
      return result;
    };
    const operation = (): Promise<WorkspaceSemanticOutput<M>> => {
      const signal =
        publicationGateContext?.kind === "caller" ? publicationGateContext.signal : undefined;
      return signal ? ownedSemanticCall(dispatch, signal) : dispatch();
    };
    const contextId = semanticRequestContextId(request);
    return contextId ? this.locked(`context-lifecycle:${contextId}`, operation) : operation();
  }

  private dispatchSemanticWire<M extends WorkspaceSemanticMethod>(
    owner: WorkspaceSemanticPort,
    method: M,
    request: SemanticRequest<M>
  ): Promise<WorkspaceSourceSemanticDispatchResult> {
    if (!isSemanticWireMethod(method)) {
      throw new Error(`Invalid semantic VCS method ${JSON.stringify(method)}`);
    }
    return owner[method](request);
  }

  semanticDirectCall<M extends WorkspaceSemanticMethod>(
    method: M,
    input: WorkspaceSemanticInput<M>
  ): Promise<WorkspaceSemanticOutput<M>> {
    return this.semanticCall(method, {
      input,
      ingress: { causalParent: null },
    });
  }

  /** Record the one upstream causal edge carried by a trusted host adapter. */
  semanticCausalCall<M extends WorkspaceSemanticMethod>(
    method: M,
    input: WorkspaceSemanticInput<M>,
    causalParent: RpcCausalParent | null
  ): Promise<WorkspaceSemanticOutput<M>> {
    return this.semanticCall(method, {
      input,
      ingress: { causalParent },
    });
  }

  /** Publish through the ordinary semantic request while keeping authorization
   * at the protected-ref gate, separate from causal provenance. */
  semanticPublishCall(
    input: WorkspaceSemanticInput<"vcsPush">,
    causalParent: RpcCausalParent | null,
    caller: VerifiedCaller,
    signal?: AbortSignal
  ): Promise<WorkspaceSemanticOutput<"vcsPush">> {
    return this.withProtectedMainMutation(
      () =>
        this.semanticCall(
          "vcsPush",
          {
            input,
            ingress: { causalParent },
          },
          { kind: "caller", caller, ...(signal ? { signal } : {}) }
        ),
      signal
    );
  }

  semanticEpochTransitionPublishCall(
    input: WorkspaceSemanticInput<"vcsPush">,
    causalParent: RpcCausalParent | null,
    caller: VerifiedCaller,
    signal?: AbortSignal
  ): Promise<WorkspaceSemanticOutput<"vcsPush">> {
    return this.withProtectedMainMutation(
      () =>
        this.semanticCall(
          "vcsPush",
          {
            input,
            ingress: { causalParent },
          },
          { kind: "caller", caller, epochTransition: true, ...(signal ? { signal } : {}) }
        ),
      signal
    );
  }

  /** Advance the participant's exact saved revision through the protected gate. */
  async publishParticipantContext(input: Omit<WorkspaceHistoryParticipant, "caller"> & {
    push: VcsPushInput;
    gateContext: CallerPublicationGateContext;
    /** Host-authored work can use an isolated copy while the original caller authorizes main. */
    storageCaller?: VerifiedCaller;
  }): Promise<VcsPushResult> {
    const { push, gateContext, dispatch, canonical, owner, ownerContextId } = input;
    if (input.storageCaller && !input.storageCaller.hostOriginated) {
      throw new Error("Only the host can author a publication for an approving caller");
    }
    const caller = input.storageCaller ?? gateContext.caller;
    requireWorkspaceParticipantOwner({ canonical, owner, caller, ownerContextId });
    if (push.epochTransition) {
      throw new Error("This publication requires the workspace installation lifecycle");
    }
    const publicationId = `participant-publication:${sha256HexSyncText(
      canonicalJson({ owner, contextId: push.contextId, commandId: push.commandId,
        ...(gateContext.epochTransition ? { epochTransition: true } : {}),
        ...(push.templateInstallation ? { templateInstallation: push.templateInstallation } : {}),
      })
    )}`;
    return this.mutateProtectedMain(async () => {
      const recorded = await readWorkspacePublicationApproval({ dispatch, canonical, publicationId });
      const participant = (previousHead: string, proposedHead: string) =>
        bindWorkspaceParticipantPublication({
          dispatch,
          canonical,
          owner,
          caller,
          ownerContextId,
          contextId: push.contextId,
          ...(push.templateInstallation ? { installation: push.templateInstallation } : {}),
          target: {
            publicationId,
            previousEventId: push.expectedMainEventId,
            proposedEventId: push.expectedCommittedEventId,
            publication: { previousHead, proposedHead },
          },
        });
      const finish = (publication: AppliedPublication): VcsPushResult => ({
        contextId: push.contextId,
        eventId: publication.publishedEventId,
        mainEventId: publication.publishedEventId,
        effectId: publicationId,
        appliedAt: new Date(publication.appliedAt).toISOString(),
      });
      const prior = this.deps.refs.readAppliedPublication(publicationId);
      if (prior) {
        if (prior.previousEventId !== push.expectedMainEventId ||
            prior.publishedEventId !== push.expectedCommittedEventId) {
          throw new Error("Workspace publication command names different events");
        }
        if (gateContext.epochTransition && this.deps.refs.readMainSemanticState()?.eventId !== prior.publishedEventId) {
          throw new Error("The epoch transition is no longer the current workspace revision");
        }
        const canonicalPublication = recorded
          ? participant(recorded.approval.publication.previousHead, recorded.approval.publication.proposedHead)
          : null;
        if (canonicalPublication && !await canonicalPublication.approved()) {
          throw new Error("Workspace publication lost its native approval receipt");
        }
        await this.replayPublicationObservers(prior);
        await canonicalPublication?.acknowledge();
        this.deps.refs.acknowledgePublication(publicationId);
        return finish(prior);
      }

      const candidate = recorded?.applied
        ? await readWorkspacePublishedRevision({ dispatch, canonical, eventId: push.expectedCommittedEventId })
        : await readWorkspaceParticipantProjection({ dispatch, owner, contextId: push.contextId });
      if (candidate.state.kind !== "event" || candidate.state.eventId !== push.expectedCommittedEventId) {
        throw new Error("Workspace publication requires the exact saved revision");
      }
      const main = recorded
        ? { head: recorded.approval.publication.previousHead, eventId: recorded.approval.previousEventId }
        : await readWorkspaceCanonicalMain({ dispatch, canonical });
      if (main.eventId !== push.expectedMainEventId) {
        throw new RefEventConflictError(push.expectedMainEventId, main.eventId, null);
      }
      if (!recorded?.applied && push.templateInstallation) {
        await dispatch.dispatch(owner, "verifyHistoryTemplatePublication", {
          contextId: push.contextId,
          previousHead: main.head,
          proposedHead: candidate.head,
          eventId: push.expectedCommittedEventId,
          installation: push.templateInstallation,
        });
      }
      await this.publishMain({
        effectId: publicationId,
        payload: GadJsonRecordSchema.parse({
          previousEventId: push.expectedMainEventId,
          publishedEventId: push.expectedCommittedEventId,
          repositories: candidate.repositories,
        }),
      }, gateContext, participant(main.head, candidate.head));
      const publication = this.deps.refs.readAppliedPublication(publicationId);
      if (!publication) throw new Error("Workspace publication has no host receipt");
      this.deps.refs.acknowledgePublication(publicationId);
      return finish(publication);
    });
  }

  /** Project already-authorized native advances after interrupted host publication. */
  async recoverParticipantPublications(input: {
    dispatch: Pick<DODispatch, "dispatch">;
    canonical: WorkspaceSourceProviderRef;
  }): Promise<number> {
    return this.mutateProtectedMain(async () => {
      const pending = await listAppliedWorkspacePublications(input);
      let recovered = 0;
      for (let cursor = pending.length - 1; cursor >= 0; cursor--) {
        const { approval } = pending[cursor]!;
        const prior = this.deps.refs.readAppliedPublication(approval.publicationId);
        if (!prior) continue;
        if (prior.previousEventId !== approval.previousEventId ||
            prior.publishedEventId !== approval.proposedEventId) {
          throw new Error("Host publication and canonical receipt name different events");
        }
        await this.replayPublicationObservers(prior);
        await observeAppliedWorkspacePublication({ ...input, approval }).acknowledge();
        this.deps.refs.acknowledgePublication(approval.publicationId);
        pending.splice(cursor, 1);
        recovered += 1;
      }
      while (pending.length > 0) {
        const currentEventId = this.deps.refs.readMainSemanticState()?.eventId;
        const next = pending.filter(({ approval }) => approval.previousEventId === currentEventId);
        if (next.length !== 1) {
          throw new Error("Approved publications cannot be reconciled with the current host history");
        }
        const record = next[0]!;
        const { approval } = record;
        const revision = await readWorkspacePublishedRevision({
          ...input,
          eventId: approval.proposedEventId,
        });
        if (revision.head !== approval.publication.proposedHead ||
            revision.state.kind !== "event" || revision.state.eventId !== approval.proposedEventId) {
          throw new Error("Canonical history cannot prove the approved publication");
        }
        await this.publishMain({
          effectId: approval.publicationId,
          payload: GadJsonRecordSchema.parse({
            previousEventId: approval.previousEventId,
            publishedEventId: approval.proposedEventId,
            repositories: revision.repositories,
          }),
        }, undefined, observeAppliedWorkspacePublication({ ...input, approval }));
        this.deps.refs.acknowledgePublication(approval.publicationId);
        pending.splice(pending.indexOf(record), 1);
        recovered += 1;
      }
      return recovered;
    });
  }

  /** Read admitted selectors from one exact revision in the caller's participant history. */
  async readParticipantFiles(input: WorkspaceHistoryParticipant & {
    contextId: string;
    read: VcsReadFilesInput;
  }): Promise<VcsReadFileResult[]> {
    const files = await readWorkspaceParticipantFileDescriptors(input);
    const result = await this.executeHostRead({ kind: "read-semantic-blobs", files });
    return vcsMethods.readFiles.returns.parse(result);
  }

  /** Restore the selected saved state, then realize the participant's current files. */
  async discardParticipantContext(input: WorkspaceHistoryParticipant & {
    head: string;
    discard: VcsDiscardInput;
    cause: { parent: RpcCausalParent | null };
  }): Promise<VcsDiscardResult> {
    requireWorkspaceParticipantOwner(input);
    const { dispatch, owner, discard, cause, head } = input;
    const receipt = GadJsonRecordSchema.parse(
      await dispatch.dispatch(owner, "discardHistoryContext", { head, discard, cause })
    );
    const result = vcsDiscardResultSchema.parse(receipt["discard"]);
    if (result.contextId !== discard.contextId || result.workingHead.kind !== "event" ||
        typeof receipt["head"] !== "string" || !receipt["head"]) {
      throw new Error("Workspace discard returned a different saved context");
    }
    await this.materializeParticipantContext({ dispatch, owner, contextId: discard.contextId });
    return result;
  }

  async mergeParticipantContext(input: Omit<Parameters<typeof mergeWorkspaceParticipantContext>[0], "blobsDir">) {
    const result = await mergeWorkspaceParticipantContext({ ...input, blobsDir: this.deps.blobsDir });
    await this.materializeParticipantContext({
      dispatch: input.dispatch,
      owner: input.owner,
      contextId: input.merge.contextId,
    });
    return result;
  }

  reviewParticipantMerge(input: Omit<Parameters<typeof reviewWorkspaceParticipantMerge>[0], "blobsDir">) {
    return reviewWorkspaceParticipantMerge({ ...input, blobsDir: this.deps.blobsDir });
  }

  async editParticipantContext(input: WorkspaceHistoryParticipant &
    Omit<Parameters<typeof editWorkspaceParticipant>[0], "blobsDir">) {
    requireWorkspaceParticipantOwner(input);
    const result = await editWorkspaceParticipant({ ...input, blobsDir: this.deps.blobsDir });
    await this.materializeParticipantContext({
      dispatch: input.dispatch,
      owner: input.owner,
      contextId: input.edit.contextId,
    });
    return result;
  }

  async transferParticipantContext(input: WorkspaceHistoryParticipant &
    Omit<Parameters<typeof transferWorkspaceParticipant>[0], "blobsDir">) {
    requireWorkspaceParticipantOwner(input);
    const result = await transferWorkspaceParticipant({ ...input, blobsDir: this.deps.blobsDir });
    await this.materializeParticipantContext({
      dispatch: input.dispatch,
      owner: input.owner,
      contextId: input.transfer.value.contextId,
    });
    return result;
  }

  async revertParticipantContext(input: WorkspaceHistoryParticipant &
    Omit<Parameters<typeof revertWorkspaceParticipant>[0], "blobsDir">) {
    requireWorkspaceParticipantOwner(input);
    const result = await revertWorkspaceParticipant({ ...input, blobsDir: this.deps.blobsDir });
    await this.materializeParticipantContext({
      dispatch: input.dispatch,
      owner: input.owner,
      contextId: input.revert.contextId,
    });
    return result;
  }

  async importParticipantSnapshot(input: WorkspaceHistoryParticipant & {
    head: string;
    snapshot: VcsImportSnapshotInput;
    cause: { parent: RpcCausalParent | null };
    uploadPrincipal: string;
  }): Promise<VcsImportSnapshotResult> {
    requireWorkspaceParticipantOwner(input);
    const { dispatch, owner, head, snapshot, cause, uploadPrincipal } = input;
    const digests = [...new Set(
      snapshot.repositories.flatMap(({ files }) => files.map(({ contentHash }) => contentHash))
    )].sort(compareUtf16CodeUnits);
    const result = await withBlobContentLock(this.deps.blobsDir, async () => {
      if (!hasBlobUploads(this.deps.blobsDir, uploadPrincipal, digests)) {
        throw new Error("Import requires bytes supplied by the authenticated caller");
      }
      const observation = await this.observeContentHashes(digests, "descriptor");
      const receipt = GadJsonRecordSchema.parse(
        await dispatch.dispatch(owner, "importHistorySnapshot", { head, snapshot, observation, cause })
      );
      const imported = vcsImportSnapshotResultSchema.parse(receipt["result"]);
      if (imported.contextId !== snapshot.contextId || typeof receipt["head"] !== "string" || !receipt["head"]) {
        throw new Error("Workspace snapshot import returned a different context");
      }
      return imported;
    });
    await this.materializeParticipantContext({ dispatch, owner, contextId: snapshot.contextId });
    return result;
  }

  async importParticipantSnapshotFromContext(input: {
    snapshot: VcsImportSnapshotInput;
    access: ParticipantRepositoryAccess;
    cause: { parent: RpcCausalParent | null };
    uploadPrincipal: string;
  }): Promise<VcsImportSnapshotResult> {
    const { snapshot, access, cause, uploadPrincipal } = input;
    const scope = await this.requireParticipantContentScope(
      snapshot.contextId, access.caller, access.signal, access.ownerContextId,
    );
    return this.importParticipantSnapshot({ ...scope, head: scope.workingHead, snapshot, cause, uploadPrincipal });
  }

  async registerParticipantExternalDelta(input: WorkspaceHistoryParticipant & {
    head: string;
    delta: VcsRegisterExternalDeltaInput;
    cause: { parent: RpcCausalParent | null };
    uploadPrincipal: string;
  }): Promise<VcsExternalDeltaResult> {
    requireWorkspaceParticipantOwner(input);
    const { dispatch, owner, head, delta, cause, uploadPrincipal } = input;
    const digests = [...new Set([...delta.oldFiles, ...delta.newFiles].map(({ contentHash }) => contentHash))]
      .sort(compareUtf16CodeUnits);
    return withBlobContentLock(this.deps.blobsDir, async () => {
      if (!hasBlobUploads(this.deps.blobsDir, uploadPrincipal, digests)) {
        throw new Error("External delta requires bytes supplied by the authenticated caller");
      }
      const observation = await this.observeContentHashes(digests, "descriptor");
      const result = vcsExternalDeltaResultSchema.parse(
        await dispatch.dispatch(owner, "registerHistoryExternalDelta", { head, delta, observation, cause })
      );
      if (result.repositoryId !== delta.repositoryId || result.repoPath !== delta.repoPath ||
          result.oldSnapshot !== delta.oldSource.snapshot || result.newSnapshot !== delta.newSource.snapshot) {
        throw new Error("Workspace history registered different external evidence");
      }
      return result;
    });
  }

  async setParticipantExternalDeltaStatus(input: WorkspaceHistoryParticipant & {
    head: string;
    delta: VcsExternalDeltaLifecycleInput;
    cause: { parent: RpcCausalParent | null };
    status: "superseded" | "finalized";
  }): Promise<VcsExternalDeltaResult> {
    requireWorkspaceParticipantOwner(input);
    const { dispatch, owner, head, delta, cause, status } = input;
    const result = vcsExternalDeltaResultSchema.parse(
      await dispatch.dispatch(owner, "setHistoryExternalDeltaStatus", { head, delta, cause, status })
    );
    if (result.deltaId !== delta.deltaId || result.status !== status) {
      throw new Error("Workspace history returned a different external delta lifecycle receipt");
    }
    return result;
  }

  async saveParticipantContext(input: WorkspaceHistoryParticipant & {
    head: string;
    commit: VcsCommitInput;
    cause: { parent: RpcCausalParent | null };
  }): Promise<VcsCommitResult> {
    requireWorkspaceParticipantOwner(input);
    const { dispatch, owner, head, commit, cause } = input;
    const receipt = GadJsonRecordSchema.parse(
      await dispatch.dispatch(owner, "saveHistoryContext", { head, commit, cause })
    );
    const result = vcsCommitResultSchema.parse(receipt["result"]);
    if (result.contextId !== commit.contextId || typeof receipt["head"] !== "string" || !receipt["head"]) {
      throw new Error("Workspace save returned a different context");
    }
    await this.materializeParticipantContext({ dispatch, owner, contextId: commit.contextId });
    return result;
  }

  /** Bind one verified filesystem request to a participant's branch and projection directory. */
  async bindParticipantFilesystem(input: {
    caller: VerifiedCaller;
    contextId: string;
    isTracked: FsVcsBridge["isTracked"];
    signal?: AbortSignal;
  }): Promise<{ bridge: FsVcsBridge; sourceRoot: string }> {
    const { caller, contextId, isTracked } = input;
    if (!this.participantHistorySource) await this.whenSemanticReady(input.signal);
    const scope = await this.openParticipantScope({
      caller,
      contextId,
      ownerContextId: contextId,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if (!scope) throw new Error("Participant workspace history is unavailable");
    const { owner, dispatch } = scope;
    const catalog = workspaceParticipantCatalog(scope);
    const { disk, materializer } = this.participantProjection(owner);
    const assertContext = (requested: string) => {
      if (requested !== contextId) throw new Error("Filesystem request names a different context");
    };
    const workingHead = async () => {
      const receipt = GadJsonRecordSchema.parse(
        await dispatch.dispatch(owner, "readHistoryHeads", { contextId }),
      );
      if (typeof receipt["workingHead"] !== "string" || !receipt["workingHead"])
        throw new Error("Participant context has no working revision");
      return receipt["workingHead"];
    };
    const readFiles = (read: VcsReadFilesInput) => this.readParticipantFiles({ ...scope, read });
    return {
      sourceRoot: disk.contextDir(contextId),
      bridge: {
        isTracked,
        ...catalog,
        status: ({ contextId: requested }) => {
          assertContext(requested);
          return readWorkspaceParticipantStatus(scope);
        },
        readFile: async ({ state, ...file }) => (await readFiles({ state, files: [file] }))[0] ?? null,
        readFiles,
        edit: async (edit, parent) => {
          assertContext(edit.contextId);
          return this.editParticipantContext({ ...scope, head: await workingHead(), edit, cause: { parent } });
        },
        move: async (value, parent) => {
          assertContext(value.contextId);
          return this.transferParticipantContext({
            ...scope, head: await workingHead(), transfer: { method: "move", value }, cause: { parent },
          });
        },
        copy: async (value, parent) => {
          assertContext(value.contextId);
          return this.transferParticipantContext({
            ...scope, head: await workingHead(), transfer: { method: "copy", value }, cause: { parent },
          });
        },
        ensureMaterialized: async (requested) => {
          assertContext(requested);
          await this.materializeParticipantContext(scope);
        },
        isMaterialized: async (requested, repoPath) => {
          assertContext(requested);
          const normalized = normalizeRepositoryPath(repoPath);
          const receipt = await materializer.materializationState(contextId);
          return receipt?.repositories.some((repository) => repository.repoPath === normalized) ?? false;
        },
      },
    };
  }

  /**
   * One workspace-wide protected-main authoring lease. Callers that must read
   * main, author a candidate, journal its publication intent, and publish may
   * hold this across the whole sequence. Ordinary pushes enter the same lease
   * through `semanticPublishCall`, so no second serialization domain can move
   * main between preparation and publication.
   */
  async withProtectedMainMutation<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    await this.whenSemanticReady(signal);
    return this.mutateProtectedMain(operation);
  }

  private async mutateProtectedMain<T>(operation: () => Promise<T>): Promise<T> {
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
    owner: WorkspaceSemanticPort,
    initial: SemanticDispatchResult,
    decode: SemanticResultDecoder<T>,
    publicationGateContext?: PublicationGateContext
  ): Promise<T> {
    let result = initial;
    for (let step = 0; step < 1_000; step += 1) {
      if (result.kind === "complete") {
        return decode(result.result);
      }
      if (result.kind === "host-read") {
        if (result.request["kind"] === "read-merge-content") {
          result = await this.executeMergeContentHostRead(owner, result.request);
          continue;
        }
        return decode(await this.executeHostRead(result.request));
      }
      if (result.kind === "host-content") {
        const request = result.request;
        result = await withBlobContentLock(this.deps.blobsDir, () =>
          this.prepareSemanticContent(owner, request)
        );
        continue;
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
      result = await owner.semanticEffectAck({
        acknowledgement: {
          effectId: effect.effectId,
          payloadDigest: effect.payloadDigest,
          receipt: GadJsonRecordSchema.parse(receipt),
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
    // Ref commit, host observers, and semantic acknowledgement are separate
    // durable phases. Older/interrupted hosts may already have acknowledged a
    // committed head before its observers finished; recover that exact head
    // even when its semantic outbox is empty.
    await this.mutateProtectedMain(async () => {
      const head = this.deps.refs.readHeadPublication();
      if (head) await this.replayPublicationObservers(head);
    });
    const owner = this.gad();
    let recovered = 0;
    for (let step = 0; step < 1_000; step += 1) {
      const effects = await owner.pendingSemanticEffects();
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
        const pending = await owner.pendingSemanticEffects();
        if (
          !pending.some(
            (candidate) =>
              candidate.effectId === effect.effectId &&
              candidate.payloadDigest === effect.payloadDigest
          )
        ) {
          return false;
        }
        // An acknowledgement can finish the authored context transition.
        // Recovery owns the same fence but may not have its original public
        // mutation result, so the next read must acquire an exact receipt.
        if (effect.scopeKind === "context") this.contextHeads.delete(effect.scopeId);
        if (publication) {
          await this.mutateProtectedMain(() => this.replayPublicationObservers(publication));
        }
        const receipt: Record<string, unknown> = publication
          ? {
              applied: true,
              appliedAt: new Date(publication.appliedAt).toISOString(),
            }
          : await this.executeSemanticEffect(effect);
        if (publication) this.deps.refs.acknowledgePublication(effect.effectId);
        await owner.semanticEffectAck({
          acknowledgement: {
            effectId: effect.effectId,
            payloadDigest: effect.payloadDigest,
            receipt: GadJsonRecordSchema.parse(receipt),
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

  private async replayPublicationObservers(publication: AppliedPublication): Promise<void> {
    if (publication.observersAppliedAt !== null) return;
    // Re-enter the existing exact-evidence replay admission. It checks the
    // committed identity and current ref basis, never grants publication
    // authority, and joins the original host observers before returning.
    await this.deps.refs.updateMains({
      entries: publication.entries,
      evidence: {
        publicationId: publication.publicationId,
        previousEventId: publication.previousEventId,
        publishedEventId: publication.publishedEventId,
        hostRefsBasisDigest: publication.hostRefsBasisDigest,
      },
    });
  }

  private async executeSemanticEffect(
    effect: SemanticEffect,
    publicationGateContext?: PublicationGateContext
  ): Promise<GadJsonRecord> {
    switch (effect.kind) {
      case "observe-content":
        return this.observeContent(effect);
      case "materialize-context": {
        const command = ContextMaterializationCommandSchema.parse(effect.payload);
        const receipt = await this.materializer.materialize(command);
        return GadJsonRecordSchema.parse(receipt);
      }
      case "publish-main":
        if (!publicationGateContext) {
          throw new Error("protected publication has no verified gate context");
        }
        return this.publishMain(effect, publicationGateContext);
    }
  }

  private async observeContent(effect: SemanticEffect): Promise<GadJsonRecord> {
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
    return this.observeContentHashes(contentHashes, representation);
  }

  private async observeContentHashes(
    contentHashes: string[],
    representation: "bytes" | "descriptor"
  ): Promise<GadJsonRecord> {
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
    return GadJsonRecordSchema.parse({ files: observed });
  }

  /** Prepared bytes remain transient until the source commits their content identities. */
  private async prepareSemanticContent(
    owner: WorkspaceSemanticPort,
    request: WorkspaceSourceHostContentRequest
  ): Promise<SemanticDispatchResult> {
    // Validate the full request before writing, then await every store before
    // allowing the source to commit references. The GC lease spans the ack.
    const contentHashes = await putPreparedWorkspaceContent(this.deps.blobsDir, request.blobs);
    return owner.semanticContentAck({ acknowledgement: { request, contentHashes } });
  }

  private async executeHostRead(
    request: Exclude<WorkspaceSourceHostReadRequest, { kind: "read-merge-content" }>
  ): Promise<unknown> {
    if (request.kind === "read-semantic-blobs") {
      return Promise.all(
        request.files.map(async (file) => {
          if (file === null) return null;
          return this.executeSingleSemanticBlobRead(file);
        })
      );
    }
    return this.executeSingleSemanticBlobRead(request);
  }

  private async executeSingleSemanticBlobRead(
    request: Extract<WorkspaceSourceHostReadRequest, { kind: "read-semantic-blob" }>
  ): Promise<NonNullable<VcsReadFileResult>> {
    const bytes = await getBytes(this.deps.blobsDir, request.contentHash);
    if (!bytes) throw new Error(`semantic content blob ${request.contentHash} is missing`);
    if (crypto.createHash("sha256").update(bytes).digest("hex") !== request.contentHash) {
      throw new Error(`semantic content blob ${request.contentHash} does not match its digest`);
    }
    return {
      repositoryId: request.repositoryId,
      fileId: request.fileId,
      repoPath: request.repoPath,
      path: request.path,
      contentHash: request.contentHash,
      authoredChangeId: request.authoredChangeId,
      authoredByWorkUnitId: request.authoredByWorkUnitId,
      contentClass: request.contentClass,
      externalKeys: [...request.externalKeys],
      mode: request.mode,
      content: this.fileContent(bytes, request),
    };
  }

  private async executeMergeContentHostRead(
    owner: WorkspaceSemanticPort,
    request: Extract<WorkspaceSourceHostReadRequest, { kind: "read-merge-content" }>
  ): Promise<SemanticDispatchResult> {
    const files = await Promise.all(
      request.contentHashes.map(async (contentHash) => {
        const bytes = await getBytes(this.deps.blobsDir, contentHash);
        if (!bytes) throw new Error(`semantic content blob ${contentHash} is missing`);
        let text: string;
        try {
          text = UTF8_DECODER.decode(bytes);
        } catch (error) {
          throw new Error(`semantic merge content ${contentHash} is not UTF-8 text`, {
            cause: error,
          });
        }
        return { contentHash, text };
      })
    );
    return owner.semanticHostReadAck({ acknowledgement: { request, files } });
  }

  private fileContent(
    bytes: Uint8Array,
    descriptor: Extract<WorkspaceSourceHostReadRequest, { kind: "read-semantic-blob" }>
  ): NonNullable<VcsReadFileResult>["content"] {
    if (descriptor["byteLength"] !== bytes.byteLength) {
      throw new Error("semantic file byte length does not match its stored content");
    }
    if (descriptor["contentKind"] === "bytes") {
      if (descriptor["coordinateExtent"] !== bytes.byteLength) {
        throw new Error("semantic byte coordinate extent does not match its stored content");
      }
      return { kind: "bytes", base64: Buffer.from(bytes).toString("base64") };
    }
    if (descriptor["contentKind"] !== "text")
      throw new Error("semantic file lacks its content kind");
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    if (descriptor["coordinateExtent"] !== text.length) {
      throw new Error("semantic text coordinate extent does not match its stored content");
    }
    return { kind: "text", text };
  }

  private async publishMain(
    effect: Pick<SemanticEffect, "effectId" | "payload">,
    gateContext: PublicationGateContext | undefined,
    canonical?: CanonicalRefPublication
  ): Promise<GadJsonRecord> {
    if (!gateContext && !canonical) throw new Error("Protected publication has no authority source");
    const profileStartedAt = performance.now();
    const repositories = effect.payload["repositories"];
    if (!Array.isArray(repositories)) {
      throw new Error("publication effect lacks exact repository manifests");
    }
    const publishedEventId = String(effect.payload["publishedEventId"] ?? "");
    if (!publishedEventId) throw new Error("publication effect lacks its published event identity");
    const placement = canonical ? { kind: "event" as const, eventId: publishedEventId } : undefined;
    const roots = await this.materializer.contentRoots(
      repositories as WorkspaceMaterializationRepository[], placement,
    );
    const contentRootsCompletedAt = performance.now();
    const current = this.deps.refs.listMains();
    const currentByPath = new Map(current.map((entry) => [entry.repoPath, entry.contentRoot]));
    const targetByPath = new Map(roots.map((entry) => [entry.repoPath, entry.contentRoot]));
    const changedPaths = [...new Set([...currentByPath.keys(), ...targetByPath.keys()])]
      .filter((repoPath) => currentByPath.get(repoPath) !== targetByPath.get(repoPath))
      .sort(compareUtf16CodeUnits);
    let candidateWorkspaceState: Promise<string> | undefined;
    let candidateStateMs = 0;
    // BuildV2 seals execution identity while the ref gate validates this
    // candidate. Register the already-committed semantic event before the gate
    // asks for a build, rather than teaching the build store to accept an
    // anonymous content hash.
    const getCandidateWorkspaceState = (): Promise<string> => {
      candidateWorkspaceState ??= (async () => {
        const candidateStartedAt = performance.now();
        try {
          const stateHash = await this.repositories.workspaceViewWithReposAt(
            changedPaths.map((repoPath) => ({
              repoPath,
              stateHash: targetByPath.get(repoPath) ?? null,
            })),
            placement,
          );
          this.semanticStateByContent.set(stateHash, {
            kind: "event",
            eventId: publishedEventId,
          });
          return stateHash;
        } finally {
          candidateStateMs = performance.now() - candidateStartedAt;
        }
      })();
      return candidateWorkspaceState;
    };
    const hostRefsBasisDigest = hostRefBasisDigest(
      current.map(({ repoPath, contentRoot }) => ({ repoPath, contentRoot }))
    );
    const update = {
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
      ...(gateContext ? { gateContext: { ...gateContext, getCandidateWorkspaceState } } : {}),
    };
    if (canonical) await this.deps.refs.updateMains(update, canonical);
    else await this.deps.refs.updateMains(update);
    const refsCompletedAt = performance.now();
    const publication = this.deps.refs.readAppliedPublication(effect.effectId);
    if (!publication) throw new Error(`protected publication ${effect.effectId} was not recorded`);
    const profileCompletedAt = performance.now();
    if (profileCompletedAt - profileStartedAt >= 100) {
      console.info("[VcsProfile] protected main publication", {
        repositories: repositories.length,
        changedRepositories: changedPaths.length,
        contentRootsMs: contentRootsCompletedAt - profileStartedAt,
        candidateStateMs,
        updateRefsMs: refsCompletedAt - contentRootsCompletedAt - candidateStateMs,
        receiptMs: profileCompletedAt - refsCompletedAt,
        totalMs: profileCompletedAt - profileStartedAt,
      });
    }
    return GadJsonRecordSchema.parse({
      applied: true,
      appliedAt: new Date(publication.appliedAt).toISOString(),
    });
  }

  private gad(): WorkspaceSemanticPort {
    if (!this.gadCaller) throw new Error("semantic workspace is not attached");
    return this.gadCaller;
  }

  // -----------------------------------------------------------------------
  // Context lifecycle
  // -----------------------------------------------------------------------

  async ensureRuntimeContext(contextId: string): Promise<void> {
    await this.whenSemanticReady();
    const source = this.participantHistorySource;
    if (!source) throw new Error("Participant workspace history is unavailable");
    if (contextId === source.infrastructureContextId) return;
    await this.locked(`context-lifecycle:${contextId}`, async () => {
      if (this.contextHeads.get(contextId) === null)
        throw new Error("Workspace participant context has retired");
      await source.dispatch.dispatch(source.canonical, "ensureHistoryRuntimeContext", { contextId });
    });
  }

  private publishContextHead(contextId: string, head: VcsStateNodeRef): void {
    this.contextHeads.set(contextId, Object.freeze({ ...head }));
  }

  async activateNativeWorkspace(): Promise<{ stateHash: string }> {
    if (!this.participantHistoryAttached || !this.deps.refs.readMainSemanticState()) {
      throw new Error("Native workspace history has no attached protected main");
    }
    return this.ensureFresh();
  }

  async dropContext(contextId: string): Promise<void> {
    await this.whenSemanticReady();
    const source = this.participantHistorySource;
    if (!source) throw new Error("Participant workspace history is unavailable");
    await this.locked(`context-lifecycle:${contextId}`, async () => {
      this.contextHeads.set(contextId, null);
      const retired = await retireWorkspaceParticipantContext({ ...source, contextId });
      for (const owner of retired.owners) {
        await source.destroyRetiredStorage?.(owner);
        await fsp.rm(this.participantProjection(owner).root, { recursive: true, force: true });
      }
      for (const owner of retired.branchOwners) {
        const { ownerKey, materializer } = this.participantProjection(owner);
        await this.locked(canonicalJson(["participant-projection", ownerKey, contextId]), () =>
          materializer.drop(contextId)
        );
      }
      await this.materializer.drop(contextId);
    });
  }

  async resolveWorkingState(contextId: string): Promise<VcsStateNodeRef> {
    await this.whenSemanticReady();
    return this.locked(`context-lifecycle:${contextId}`, async () => {
      const head = this.contextHeads.get(contextId);
      if (head === null) throw new Error(`Semantic context ${contextId} was deleted`);
      if (head) return { ...head };
      const command = await this.contextContentCommand(contextId);
      this.publishContextHead(contextId, command.targetState);
      return { ...command.targetState };
    });
  }

  private async contextContentCommand(
    contextId: string
  ): Promise<ContextMaterializationCommand> {
    await this.whenSemanticReady();
    return this.gad().contextMaterializationCommand({ contextId, materializedState: null });
  }

  /** One semantic snapshot owns both the working head and its exact content.
   * CAS trees are build inputs; editable context checkouts are a separate consumer. */
  private readonly contextContentSnapshots = new Map<
    string,
    { semanticState: VcsStateNodeRef; repositories: Array<{ repoPath: string; stateHash: string }> }
  >();

  private async exactContextContent(contextId: string) {
    await this.whenSemanticReady();
    return this.locked(`context-lifecycle:${contextId}`, () =>
      this.readFencedContextContent(contextId)
    );
  }

  private async readFencedContextContent(contextId: string) {
    const head = this.contextHeads.get(contextId);
    if (head === null) throw new Error(`Semantic context ${contextId} was deleted`);
    const cached = head ? await this.cachedContextContent(canonicalJson(head)) : undefined;
    if (cached) return cached;
    const snapshot = await this.readExactContextContent(contextId);
    this.rememberContextContent(snapshot);
    return snapshot;
  }

  private async cachedContextContent(key: string) {
    const cached = this.contextContentSnapshots.get(key);
    if (
      cached &&
      (
        await Promise.all(
          cached.repositories.map((repository) =>
            hasTreeObject(this.deps.blobsDir, repository.stateHash)
          )
        )
      ).every(Boolean)
    )
      return cached;
    return undefined;
  }

  private rememberContextContent(snapshot: {
    semanticState: VcsStateNodeRef;
    repositories: Array<{ repoPath: string; stateHash: string }>;
  }, key = canonicalJson(snapshot.semanticState)): void {
    if (this.contextContentSnapshots.size >= 128) {
      this.contextContentSnapshots.delete(this.contextContentSnapshots.keys().next().value!);
    }
    this.contextContentSnapshots.set(key, snapshot);
  }

  private async readExactContextContent(contextId: string) {
    const command = await this.contextContentCommand(contextId);
    this.publishContextHead(contextId, command.targetState);
    return this.realizeContextContent(command);
  }

  private async realizeContextContent(
    command: Pick<ContextMaterializationCommand, "targetState" | "repositories" | "blobs">,
    placement?: VcsStateNodeRef,
  ) {
    const roots = await this.materializer.planContentRoots(command.repositories);
    const realized = await Promise.allSettled(
      roots.map(async (root) => {
        if (!placement && await hasTreeObject(this.deps.blobsDir, root.contentRoot)) return;
        const source = command.repositories.find(
          (
            repository
          ): repository is Extract<WorkspaceMaterializationRepository, { presence: "present" }> =>
            repository.presence === "present" && repository.repositoryId === root.repositoryId
        );
        if (!source)
          throw new Error(`Exact context content has no source for ${root.repositoryId}`);
        await this.materializer.realizePlannedRepository(source, command.blobs, root.contentRoot, placement);
      })
    );
    const failures = realized.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length)
      throw new AggregateError(failures, "Exact context content realization failed");
    return {
      semanticState: command.targetState,
      repositories: roots.map(({ repoPath, contentRoot }) => ({
        repoPath,
        stateHash: contentRoot,
      })),
    };
  }

  private async requireParticipantContentScope(
    contextId: string,
    caller: VerifiedCaller,
    signal?: AbortSignal,
    ownerContextId = contextId
  ) {
    if (!this.participantHistorySource) await this.whenSemanticReady(signal);
    const scope = await this.openParticipantScope({
      caller, contextId, ownerContextId, ...(signal ? { signal } : {}),
    });
    if (!scope) throw new Error("Participant workspace history is unavailable");
    return scope;
  }

  private async participantContextContent(scope: WorkspaceHistoryParticipant & { contextId: string; workingHead: string }) {
    const key = (head: string) => canonicalJson(["participant", head]);
    const cached = await this.cachedContextContent(key(scope.workingHead));
    if (cached) return cached;
    const projection = await readWorkspaceParticipantProjection(scope);
    const snapshot = await this.realizeContextContent({
      targetState: projection.state, repositories: projection.repositories, blobs: [],
    }, projection.state);
    this.rememberContextContent(snapshot, key(projection.head));
    return snapshot;
  }

  async contextRepoTargets(
    contextId: string, caller?: VerifiedCaller, signal?: AbortSignal
  ): Promise<Array<{ repoPath: string; stateHash: string }>> {
    if (!caller) throw new Error("A verified caller is required to mirror a participant's working copy");
    const scope = await this.requireParticipantContentScope(contextId, caller, signal);
    const snapshot = await this.participantContextContent(scope);
    return snapshot.repositories.map((repository) => ({ ...repository }));
  }

  /** Recover an editable directory from the verified participant's current history. */
  async materializeParticipantContext(input: {
    dispatch: Pick<DODispatch, "dispatch">;
    owner: WorkspaceSourceProviderRef;
    contextId: string;
  }): Promise<{ head: string; state: VcsStateNodeRef; folder: string }> {
    const { contextId, owner } = input;
    const { ownerKey, disk, materializer } = this.participantProjection(owner);
    return this.locked(canonicalJson(["participant-projection", ownerKey, contextId]), async () => {
      const { head, state, repositories } = await readWorkspaceParticipantProjection(input);
      const folder = disk.contextDir(contextId);
      const prior = await materializer.materializationState(contextId);
      const intact = prior !== null && await materializer.projectionMatches(prior);
      if (intact && canonicalJson(prior.targetState) === canonicalJson(state)) {
        await materializer.ensureContextBinding(contextId);
        return { head, state, folder };
      }
      let selected: WorkspaceMaterializationRepository[] = repositories;
      const mode = !prior ? "initialize" : intact ? "patch" : "replace";
      if (prior && mode === "patch") {
        const roots = new Map((await materializer.planContentRoots(repositories)).map(
          (repo) => [repo.repositoryId, repo]
        ));
        const previous = new Map(prior.repositories.map((repo) => [repo.repositoryId, repo]));
        selected = repositories.filter((repo) => {
          if (repo.presence !== "present") return false;
          const before = previous.get(repo.repositoryId);
          return !before || before.repoPath !== repo.repoPath ||
            before.contentRoot !== roots.get(repo.repositoryId)?.contentRoot;
        });
        for (const repo of prior.repositories) {
          if (!roots.has(repo.repositoryId)) {
            selected.push({
              repositoryId: repo.repositoryId,
              repoPath: repo.repoPath,
              presence: "deleted",
            });
          }
        }
      }
      await materializer.materialize(contextMaterializationCommand({
        contextId,
        commandId: `participant-projection:${ownerKey}:${head}`,
        mode,
        previousState: prior?.targetState ?? null,
        targetState: state,
        repositories: selected,
        blobs: [],
      }), state);
      return { head, state, folder };
    });
  }

  private participantProjection(owner: WorkspaceSourceProviderRef) {
    const ownerKey = sha256HexSyncText(canonicalJson(owner));
    const root = path.join(this.deps.contextProjectionsRoot, ".participants", ownerKey);
    const disk = new DiskProjector({
      contentProjection: this.contentProjection,
      workspaceRoot: this.deps.workspaceRoot,
      contextProjectionsRoot: root,
    });
    const materializer = new ContextMaterializer({ blobsDir: this.deps.blobsDir, workspaceId: this.deps.workspaceId, disk });
    return { ownerKey, root, disk, materializer };
  }

  /**
   * Resolve one exact semantic repository without writing a projection, CAS
   * object, or checkout. The returned plan is JSON and may be sealed directly
   * into a dispatcher prepared-authority payload.
   */
  async planExactContextRepository(
    input: ExactRepositorySnapshotSelection & { contextId: string },
    access?: ParticipantRepositoryAccess
  ): Promise<ExactRepositorySnapshotPlan> {
    const { contextId, ...selection } = input;
    const [plan] = await this.planExactContextRepositories({ contextId, repositories: [selection] }, access);
    return plan!;
  }

  async planExactContextRepositories(input: {
    contextId: string;
    repositories: readonly ExactRepositorySnapshotSelection[];
  }, access?: ParticipantRepositoryAccess): Promise<ExactRepositorySnapshotPlan[]> {
    const command = access
      ? await this.readParticipantRepositoryProjection(input.contextId, access)
      : await this.gad().contextMaterializationCommand({
          contextId: input.contextId, materializedState: null,
        });
    return Promise.all(input.repositories.map((selection) =>
      this.planExactRepository(input.contextId, selection, command, access ? command.targetState : undefined)
    ));
  }

  private async planExactRepository(
    contextId: string,
    input: ExactRepositorySnapshotSelection,
    command: Pick<ContextMaterializationCommand, "targetState" | "repositories" | "blobs">,
    placement?: VcsStateNodeRef
  ): Promise<ExactRepositorySnapshotPlan> {
    const repositoryCommand = command.repositories.find(
      (
        candidate
      ): candidate is Extract<WorkspaceMaterializationRepository, { presence: "present" }> =>
        candidate.presence === "present" && candidate.repositoryId === input.repositoryId
    );
    if (!repositoryCommand) {
      throw Object.assign(new Error(`Unknown repository ${input.repositoryId}`), {
        code: "ENOENT",
      });
    }
    const [repository] = await this.materializer.planContentRoots([repositoryCommand]);
    if (!repository) throw new Error("Could not plan content for the selected repository");
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
      contextId,
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
        ...(placement ? { placement } : {}),
      },
    };
    return {
      ...base,
      planDigest: sha256HexSyncText(canonicalJson(base)),
    };
  }

  async resolveAdoptedParticipantRepository(
    input: { contextId: string; repositoryId: string },
    access: ParticipantRepositoryAccess
  ): Promise<{ repoPath: string; workingHead: VcsStateNodeRef } | null> {
    const projection = await this.readParticipantRepositoryProjection(input.contextId, access);
    const repository = projection.repositories.find((entry) =>
      entry.presence === "present" && entry.repositoryId === input.repositoryId
    );
    return repository ? { repoPath: repository.repoPath, workingHead: projection.targetState } : null;
  }

  private async readParticipantRepositoryProjection(contextId: string, access: ParticipantRepositoryAccess) {
    await this.whenSemanticReady(access.signal);
    const scope = await this.requireParticipantContentScope(
      contextId, access.caller, access.signal, access.ownerContextId,
    );
    const projection = await readWorkspaceParticipantProjection(scope);
    return { targetState: projection.state, repositories: projection.repositories, blobs: [] };
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
      plan.contentRoot,
      plan.realization.placement
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
    const semanticState = this.deps.refs.readMainSemanticState();
    if (!semanticState && this.deps.initialContentState) {
      return { stateHash: this.deps.initialContentState };
    }
    const view = await this.repositories.workspaceView();
    if (semanticState) this.semanticStateByContent.set(view.stateHash, semanticState);
    return view;
  }

  private async resolveContentSelector(selector: string): Promise<string | null> {
    if (selector === "main") return (await this.ensureFresh()).stateHash;
    if (selector.startsWith("ctx:")) return this.resolveContextState(selector.slice(4));
    return null;
  }

  async resolveContextState(contextId: string): Promise<string> {
    const { semanticState, repositories } = await this.exactContextContent(contextId);
    const stateHash = (await this.repositories.contentView(repositories)).stateHash;
    this.semanticStateByContent.set(stateHash, semanticState);
    return stateHash;
  }

  /** Keep exact content and semantic identity together even when two revisions have identical bytes. */
  async resolveCallerContextState(
    contextId: string,
    caller: VerifiedCaller,
    signal?: AbortSignal,
    ownerContextId = contextId
  ) {
    const scope = await this.requireParticipantContentScope(contextId, caller, signal, ownerContextId);
    return this.recordParticipantContextSource(scope);
  }

  async resolveParticipantRevisionSource(
    contextId: string,
    caller: VerifiedCaller,
    ownerContextId: string,
    state: VcsStateNodeRef
  ) {
    const scope = await this.requireParticipantContentScope(contextId, caller, undefined, ownerContextId);
    const repositories = await readWorkspaceParticipantRevision({ ...scope, state });
    const snapshot = await this.realizeContextContent({ targetState: state, repositories, blobs: [] }, state);
    const { stateHash } = await this.repositories.contentView(snapshot.repositories, state);
    await rememberWorkspaceParticipantContentSource({ ...scope, stateHash, state });
    return { stateHash, semanticState: state };
  }

  private async recordParticipantContextSource(scope: WorkspaceHistoryParticipant & {
    contextId: string; workingHead: string;
  }, requestedHash?: string) {
    const { semanticState, repositories } = await this.participantContextContent(scope);
    const { stateHash } = await this.repositories.contentView(repositories, semanticState);
    if (requestedHash === undefined || requestedHash === stateHash) {
      await rememberWorkspaceParticipantContentSource({ ...scope, stateHash, state: semanticState });
    }
    return { semanticState, stateHash };
  }

  async resolveParticipantBuildSource(
    stateHash: string,
    caller: VerifiedCaller,
    contextId: string | null,
    signal?: AbortSignal,
    readableContextIds: readonly string[] = []
  ) {
    if (!this.participantHistorySource) await this.whenSemanticReady(signal);
    if (!this.participantHistorySource) throw new Error("Participant workspace history is unavailable");
    if (/^state:[0-9a-f]{64}$/u.test(stateHash)) {
      const scope = contextId && (caller.nativeInvocation || caller.taskAuthority || caller.subject?.userId)
        ? await this.requireParticipantContentScope(contextId, caller, signal)
        : null;
      if (scope) {
        const retained = await readWorkspaceParticipantContentSource({ ...scope, stateHash, readableContextIds });
        if (retained) {
          const snapshot = await this.realizeContextContent({
            targetState: retained.state, repositories: retained.repositories, blobs: [],
          }, retained.state);
          const content = await this.repositories.contentView(snapshot.repositories, retained.state);
          if (content.stateHash !== stateHash) throw new Error("Workspace build source proof has different content");
          return { stateHash, semanticState: retained.state };
        }
      }

      await this.ensureFresh();
      const remembered = this.executionStateForContent(stateHash);
      if (remembered && await this.participantBuildStateReachable(
        remembered, caller, scope ? contextId : null, signal, readableContextIds
      ))
        return { stateHash, semanticState: remembered };
      if (scope) {
        const current = await this.recordParticipantContextSource(scope, stateHash);
        if (current.stateHash === stateHash) return current;
      }
    }
    throw Object.assign(new Error("Build content is outside the caller's visible workspace history"), { code: "EACCES" });
  }

  executionStateForContent(
    stateHash: string
  ): import("@vibestudio/shared/execution/retention").ExecutionSourceStateRef | null {
    const semantic = this.semanticStateByContent.get(stateHash);
    if (semantic) return semantic;
    return stateHash === this.deps.initialContentState
      ? { kind: "bootstrap-snapshot", snapshotHash: stateHash }
      : null;
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

  preparedBuildForContent(stateHash: string, unitPath: string) {
    return this.deps.rootTemplateBootstrap?.preparedBuildForContent?.(stateHash, unitPath) ?? null;
  }

  async discoverGraph(stateHash: string): Promise<PackageGraph> {
    // Some startup consumers read files at the discovered node's path.
    // A seed's exact graph can contain units absent from the local bootstrap
    // template. Use the immutable projection for those reads.
    if (this.seededWorkspace) {
      const graphRoot = await this.materializeStateForGraphDiscovery(stateHash);
      return discoverPackageGraphAtTree(this.deps.blobsDir, stateHash, graphRoot);
    }
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

  /** Read the published repository directly from the protected host refs.
   * Publication validation must not re-enter the source owner awaiting it. */
  async readProtectedRepositoryText(repoPath: string, relativePath: string): Promise<string | null> {
    const root = this.deps.refs.readMain(repoPath)?.contentRoot;
    if (!root || root === EMPTY_STATE_HASH) return null;
    const file = await readFileAtTree(this.deps.blobsDir, root, relativePath);
    if (!file) return null;
    const bytes = await getBytes(this.deps.blobsDir, file.contentHash);
    if (!bytes) throw new Error(`content blob ${file.contentHash} is missing`);
    return UTF8_DECODER.decode(bytes);
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
    if (!this.attached) return;
    const profileStartedAt = performance.now();
    const profile = {
      ensureFreshMs: 0,
      repositoryDiffsMs: 0,
      listenersMs: 0,
      sourceMirrorMs: 0,
      repositoryCount: publication.changes.length,
      listenerCount: this.protectedPublicationListeners.size,
      mirroredRepositoryCount: this.deps.extractMainToSource ? publication.changes.length : 0,
    };
    try {
      let phaseStartedAt = performance.now();
      let workspaceStateHash: string;
      try {
        workspaceStateHash = (await this.ensureFresh()).stateHash;
      } finally {
        profile.ensureFreshMs = performance.now() - phaseStartedAt;
      }
      const repositories: ProtectedPublicationEvent["repositories"] = new Array(
        publication.changes.length
      );
      const failures: Array<{ error: unknown } | undefined> = new Array(publication.changes.length);
      let nextChange = 0;
      // Each repository diff reads immutable CAS trees and writes only its own
      // result slot. Join a bounded set of independent diffs before exposing the
      // publication, keeping event order equal to the store's canonical order.
      const workers = Array.from(
        { length: Math.min(CONTENT_OBSERVATION_CONCURRENCY, publication.changes.length) },
        async () => {
          while (nextChange < publication.changes.length) {
            const index = nextChange++;
            const change = publication.changes[index]!;
            try {
              const repoPath = normalizeRepositoryPath(change.repoPath);
              const fileChanges = await this.diffFileChanges(
                change.previousContentRoot,
                change.nextContentRoot
              );
              const reroot = (relativePath: string) => joinRepoPrefix(repoPath, relativePath);
              repositories[index] = {
                repoPath,
                previousStateHash: change.previousContentRoot,
                nextStateHash: change.nextContentRoot,
                fileChanges: fileChanges.map((file) => ({ ...file, path: reroot(file.path) })),
              };
            } catch (error) {
              failures[index] = { error };
            }
          }
        }
      );
      phaseStartedAt = performance.now();
      try {
        await Promise.all(workers);
      } finally {
        profile.repositoryDiffsMs = performance.now() - phaseStartedAt;
      }
      const diffFailures = failures.flatMap((failure) => (failure ? [failure.error] : []));
      if (diffFailures.length === 1) throw diffFailures[0];
      if (diffFailures.length > 1) {
        throw new AggregateError(diffFailures, "Protected publication repository diffs failed", {
          cause: diffFailures[0],
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
      phaseStartedAt = performance.now();
      try {
        for (const listener of this.protectedPublicationListeners) {
          await listener(event);
        }
        await this.indexPublishedCommitMemory(publication.publishedEventId);
      } finally {
        profile.listenersMs = performance.now() - phaseStartedAt;
      }

      // Source checkout mirroring is an observer, never part of publication
      // authority. Its failure must not suppress the CAS-derived notification.
      if (this.deps.extractMainToSource) {
        phaseStartedAt = performance.now();
        try {
          for (const change of publication.changes) {
            const repoPath = normalizeRepositoryPath(change.repoPath);
            try {
              if (change.nextContentRoot === null) await this.projector.removeRepo(repoPath);
              else await this.projector.exportMainToSource(repoPath, change.nextContentRoot);
            } catch (error) {
              console.error(
                `[Vcs] protected publication source mirror failed for ${repoPath}:`,
                error
              );
            }
          }
        } finally {
          profile.sourceMirrorMs = performance.now() - phaseStartedAt;
        }
      }
    } finally {
      const totalMs = performance.now() - profileStartedAt;
      if (totalMs >= 100) {
        console.info("[VcsProfile] protected refs observer", { ...profile, totalMs });
      }
    }
  }

  private async indexPublishedCommitMemory(eventId: string): Promise<void> {
    const source = this.participantHistorySource;
    const index = this.gadCaller;
    if (!source || !index) return;
    try {
      await advanceWorkspaceCommitMemoryIndex({ ...source, index, eventId });
    } catch (error) {
      // Recall is a disposable projection. Reopening resumes indexing without
      // making a committed publication fail.
      console.warn("[Vcs] Could not index published commit memory", error);
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
