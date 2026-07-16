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

import { EventEmitter } from "node:events";
import * as crypto from "node:crypto";
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
  type WorkspaceMaterializationRepository,
} from "@vibestudio/shared/vcs/workspaceProjection";
import { hostRefBasisDigest } from "@vibestudio/shared/vcs/publication";
import {
  collectTreeReachableDigests,
  diffTrees,
  getBytes,
  materializeTree,
  readFileAtTree,
  resolveTreePath,
  sweepUnreachableBlobs,
  type TreeDiff,
} from "../services/blobstoreService.js";
import type {
  AppliedPublication,
  ProtectedRefPublication,
  ProtectedRefStore,
} from "../services/protectedRefStore.js";
import type { BuildRecord, WorkspaceStateSource } from "../buildV2/stateTrigger.js";
import type { BuildSourceProvider } from "../buildV2/buildSource.js";
import {
  discoverPackageGraph,
  type GraphNode,
  type PackageGraph,
} from "../buildV2/packageGraph.js";
import { joinRepoPrefix, normalizeRepositoryPath } from "./paths.js";
import { ContentProjectionStore } from "./contentProjectionStore.js";
import { DiskProjector } from "./diskProjector.js";
import { ContextMaterializer } from "./contextMaterializer.js";
import { discoverRepos } from "./repoDiscovery.js";
import type { SemanticControlPlaneCaller } from "../internalDOs/controlPlane.js";
import type { VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { RpcCausalParent } from "@vibestudio/rpc";
import { WorkspaceRepositories } from "./workspaceRepositories.js";

const SYSTEM_ACTOR = { id: "system", kind: "system" } as const;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const BUILDS_LOG_ID = "builds:workspace";

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
}

interface SemanticRequest {
  input: unknown;
  ingress: {
    causalParent: import("@vibestudio/rpc").RpcCausalParent | null;
  };
}

function semanticRequestContextId(request: unknown): string | null {
  if (!request || typeof request !== "object") return null;
  const input = (request as Record<string, unknown>)["input"];
  if (!input || typeof input !== "object") return null;
  const contextId = (input as Record<string, unknown>)["contextId"];
  return typeof contextId === "string" && contextId.length > 0 ? contextId : null;
}

export type CallerPublicationGateContext = {
  kind: "caller";
  caller: VerifiedCaller;
  via?: string;
};

type PublicationGateContext = CallerPublicationGateContext | { kind: "workspace-initialization" };

interface SemanticEffect {
  effectId: string;
  scopeKind: "context" | "workspace";
  scopeId: string;
  commandId: string;
  kind: "observe-content" | "materialize-context" | "publish-main";
  payload: Record<string, unknown>;
  payloadDigest: string;
  status: "pending";
}

type SemanticDispatchResult =
  | { kind: "complete"; result: unknown }
  | { kind: "effects-pending"; result: unknown; effects: SemanticEffect[] }
  | { kind: "host-read"; request: Record<string, unknown> };

export interface ContentFile {
  content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
  stateHash: string;
  contentHash: string;
  mode: number;
  size: number;
}

export class WorkspaceVcs implements WorkspaceStateSource, BuildSourceProvider {
  readonly contentProjection: ContentProjectionStore;
  readonly repositories: WorkspaceRepositories;

  private gadCaller: SemanticControlPlaneCaller | null = null;
  private readonly emitter = new EventEmitter();
  private readonly projector: DiskProjector;
  private readonly materializer: ContextMaterializer;
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly contextInitializations = new Map<string, Promise<VcsStateNodeRef>>();
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

  async runGc(options: { minAgeMs: number }): Promise<{
    scanned: number;
    swept: number;
    bytes: number;
  }> {
    const semantic = await this.gad().call<{
      contentRoots: string[];
      contentHashes: string[];
    }>("vcsContentGcRoots", {});
    const roots = new Set(semantic.contentRoots);
    for (const main of this.deps.refs.listMains()) roots.add(main.contentRoot);
    const reachable = new Set(semantic.contentHashes);
    for (const root of roots) {
      const tree = await collectTreeReachableDigests(this.deps.blobsDir, root);
      if (!tree) throw new Error(`GC root ${root} is missing from the content store`);
      for (const digest of tree.treeDigests) reachable.add(digest);
      for (const digest of tree.contentDigests) reachable.add(digest);
    }
    return sweepUnreachableBlobs(this.deps.blobsDir, reachable, options.minAgeMs);
  }

  async referencesReachable(
    contextIds: readonly string[],
    references: readonly { kind: string; value: unknown }[]
  ): Promise<boolean> {
    return this.gad().call<boolean>("vcsReferencesReachable", { contextIds, references });
  }

  async attachGad(gad: SemanticControlPlaneCaller): Promise<void> {
    if (this.gadCaller) throw new Error("semantic workspace is already attached");
    this.gadCaller = gad;
  }

  /** Dispatch meaning, drain exact host commands, acknowledge, and continue. */
  async semanticCall<T>(
    method: string,
    request: unknown,
    publicationGateContext?: CallerPublicationGateContext
  ): Promise<T> {
    return this.dispatchSemanticCall(method, request, publicationGateContext);
  }

  private async dispatchSemanticCall<T>(
    method: string,
    request: unknown,
    publicationGateContext?: PublicationGateContext
  ): Promise<T> {
    if (!/^vcs[A-Z][A-Za-z0-9]*$/.test(method)) {
      throw new Error(`Invalid semantic VCS method ${JSON.stringify(method)}`);
    }
    const dispatch = async (): Promise<T> => {
      const next = await this.gad().call<SemanticDispatchResult>("vcsSemanticDispatch", {
        method,
        request,
      });
      return this.drainSemanticResult<T>(next, publicationGateContext);
    };
    const contextId = semanticRequestContextId(request);
    return contextId ? this.locked(`context-lifecycle:${contextId}`, dispatch) : dispatch();
  }

  semanticDirectCall<T>(method: string, input: unknown): Promise<T> {
    return this.semanticCall<T>(method, {
      input,
      ingress: { causalParent: null },
    } satisfies SemanticRequest);
  }

  private semanticWorkspaceInitializationPush<T>(input: unknown): Promise<T> {
    return this.dispatchSemanticCall<T>(
      "vcsPush",
      {
        input,
        ingress: { causalParent: null },
      } satisfies SemanticRequest,
      { kind: "workspace-initialization" }
    );
  }

  /** Record the one upstream causal edge carried by a trusted host adapter. */
  semanticCausalCall<T>(
    method: string,
    input: unknown,
    causalParent: RpcCausalParent | null
  ): Promise<T> {
    return this.semanticCall<T>(method, {
      input,
      ingress: { causalParent },
    } satisfies SemanticRequest);
  }

  /** Publish through the ordinary semantic request while keeping authorization
   * at the protected-ref gate, separate from causal provenance. */
  semanticPublishCall<T>(
    input: unknown,
    causalParent: RpcCausalParent | null,
    caller: VerifiedCaller
  ): Promise<T> {
    return this.semanticCall<T>(
      "vcsPush",
      {
        input,
        ingress: { causalParent },
      } satisfies SemanticRequest,
      { kind: "caller", caller }
    );
  }

  private async drainSemanticResult<T>(
    initial: SemanticDispatchResult,
    publicationGateContext?: PublicationGateContext
  ): Promise<T> {
    let result = initial;
    for (let step = 0; step < 1_000; step += 1) {
      if (result.kind === "complete") return result.result as T;
      if (result.kind === "host-read") return (await this.executeHostRead(result.request)) as T;
      const effect = result.effects[0];
      if (!effect) throw new Error("semantic command reported effects-pending without an effect");
      const receipt = await this.executeSemanticEffect(effect, publicationGateContext);
      // The applied head remains replay evidence; marking it acknowledged
      // before the semantic ack closes the crash gap that could otherwise
      // leave one uncompactible evidence row per publication.
      if (effect.kind === "publish-main") {
        this.deps.refs.acknowledgePublication(effect.effectId);
      }
      result = await this.gad().call<SemanticDispatchResult>("vcsSemanticEffectAck", {
        acknowledgement: {
          effectId: effect.effectId,
          payloadDigest: effect.payloadDigest,
          receipt,
        },
      });
    }
    throw new Error("semantic command exceeded the host-effect drain limit");
  }

  /** Drain the semantic outbox independently of the request that created it. */
  async recoverPendingSemanticEffects(): Promise<number> {
    let recovered = 0;
    for (let step = 0; step < 1_000; step += 1) {
      const effects = await this.gad().call<SemanticEffect[]>("vcsPendingSemanticEffects", {});
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
        const pending = await this.gad().call<SemanticEffect[]>("vcsPendingSemanticEffects", {});
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
        await this.gad().call<SemanticDispatchResult>("vcsSemanticEffectAck", {
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
      case "materialize-context":
        return (await this.materializer.materialize(
          effect.payload as unknown as ContextMaterializationCommand
        )) as unknown as Record<string, unknown>;
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
    const observed = [];
    for (const value of files) {
      if (!value || typeof value !== "object") {
        throw new Error("content observation contains an invalid file");
      }
      const file = value as Record<string, unknown>;
      const contentHash = String(file["contentHash"] ?? "");
      const bytes = await getBytes(this.deps.blobsDir, contentHash);
      if (!contentHash || !bytes) throw new Error(`content observation cannot read ${contentHash}`);
      observed.push(
        representation === "bytes"
          ? { contentHash, base64: Buffer.from(bytes).toString("base64") }
          : { contentHash, ...intrinsicContentDescriptor(bytes) }
      );
    }
    return { files: observed };
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
        mode: Number(request["mode"]),
        content: this.fileContent(bytes),
      };
    }
    throw new Error(`unknown semantic host read ${JSON.stringify(kind)}`);
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
    const repositories = effect.payload["repositories"];
    if (!Array.isArray(repositories)) {
      throw new Error("publication effect lacks exact repository manifests");
    }
    const roots = await this.materializer.contentRoots(
      repositories as WorkspaceMaterializationRepository[]
    );
    const current = this.deps.refs.listMains();
    const currentByPath = new Map(current.map((entry) => [entry.repoPath, entry.contentRoot]));
    const targetByPath = new Map(roots.map((entry) => [entry.repoPath, entry.contentRoot]));
    const changedPaths = [...new Set([...currentByPath.keys(), ...targetByPath.keys()])]
      .filter((repoPath) => currentByPath.get(repoPath) !== targetByPath.get(repoPath))
      .sort(compareUtf16CodeUnits);
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
      gateContext,
    });
    const publication = this.deps.refs.readAppliedPublication(effect.effectId);
    if (!publication) throw new Error(`protected publication ${effect.effectId} was not recorded`);
    return {
      applied: true,
      appliedAt: new Date(publication.appliedAt).toISOString(),
    };
  }

  private gad(): SemanticControlPlaneCaller {
    if (!this.gadCaller) throw new Error("semantic workspace is not attached");
    return this.gadCaller;
  }

  // -----------------------------------------------------------------------
  // Context lifecycle
  // -----------------------------------------------------------------------

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
    this.projector.contextDir(contextId);
    const commandId = `ensure-context:${sha256HexSyncText(
      canonicalJson({
        workspaceId: this.deps.workspaceId,
        contextId,
      })
    )}`;
    const result = await this.gad().call<SemanticDispatchResult>("vcsEnsureContext", {
      contextId,
      commandId,
      ingress: { causalParent: null },
    });
    const context = await this.drainSemanticResult<{
      working: { ref: VcsStateNodeRef };
    }>(result);
    const materialized = await this.materializer.materializationState(contextId);
    if (
      !materialized ||
      canonicalJson(materialized.targetState) !== canonicalJson(context.working.ref) ||
      !(await this.materializer.projectionMatches(materialized))
    ) {
      await this.repairContextMaterialization(contextId);
    }
    return context.working.ref;
  }

  private async repairContextMaterialization(contextId: string): Promise<void> {
    const current = await this.materializer.materializationState(contextId);
    const command = await this.gad().call<ContextMaterializationCommand>(
      "vcsContextMaterializationCommand",
      { contextId, materializedState: current?.targetState ?? null }
    );
    await this.materializer.materialize(command);
  }

  async activateWorkspaceFromSource(): Promise<{ stateHash: string; initialized: boolean }> {
    const contextId = `workspace-initialization:${this.deps.workspaceId}`;
    const state = await this.ensureContext(contextId);
    const inspected = await this.semanticDirectCall<VcsInspectResult>("vcsInspect", {
      node: state,
      edgeLimit: 1,
    });
    if (inspected.node.kind !== "event" || inspected.node.value.kind !== "genesis") {
      const existingRefs = this.deps.refs.listMains();
      if (existingRefs.length === 0) {
        if (
          state.kind !== "event" ||
          inspected.node.kind !== "event" ||
          inspected.node.value.parentEventIds.length !== 1
        ) {
          throw new Error(
            "semantic main exists but protected host refs are absent and the initialization publication cannot be reconstructed"
          );
        }
        // This code is the trusted workspace-initialization operation. Retrying
        // its exact first publication supplies lifecycle authority at the gate;
        // generic outbox recovery above intentionally cannot do so.
        await this.semanticWorkspaceInitializationPush<VcsPushResult>({
          contextId,
          commandId: `initial-push:${state.eventId}`,
          expectedCommittedEventId: state.eventId,
          expectedMainEventId: inspected.node.value.parentEventIds[0],
        });
      }
      return { ...(await this.ensureFresh()), initialized: false };
    }

    const scanned = await this.contentProjection.localState(this.deps.workspaceRoot);
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

    const repositories = [];
    for (const repository of discoverRepos(scanned.files.map((file) => file.path))) {
      const prefix = `${repository.repoPath}/`;
      const sourceFiles = scanned.files.filter((file) => file.path.startsWith(prefix));
      const files = sourceFiles.map((file) => ({
        path: file.path.slice(prefix.length),
        contentHash: file.contentHash,
        mode: file.mode & 0o777,
      }));
      repositories.push({
        repoPath: repository.repoPath,
        files,
      });
    }

    const importResult = await this.semanticDirectCall<VcsImportSnapshotResult>(
      "vcsImportSnapshot",
      {
        contextId,
        commandId: `initial-import:${scanned.stateHash}`,
        expectedWorkingHead: state,
        intentSummary: "Import the initial workspace snapshot",
        source: {
          kind: "filesystem",
          uri: "vibestudio://workspace-source",
          snapshotRevision: scanned.stateHash,
        },
        repositories,
        message: "Import initial workspace snapshot",
      }
    );
    await this.semanticWorkspaceInitializationPush<VcsPushResult>({
      contextId,
      commandId: `initial-push:${importResult.eventId}`,
      expectedCommittedEventId: importResult.eventId,
      expectedMainEventId: inspected.node.value.eventId,
    });
    return { ...(await this.ensureFresh()), initialized: true };
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
      const result = await this.gad().call<SemanticDispatchResult>("vcsForkContext", {
        sourceContextId,
        targetContextId,
        commandId,
        ingress: { causalParent: null },
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
      await this.gad().call("vcsDropContext", { contextId });
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
    return this.repositories.workspaceView();
  }

  private async resolveContentSelector(selector: string): Promise<string | null> {
    if (selector === "main") return (await this.ensureFresh()).stateHash;
    if (selector.startsWith("ctx:")) return this.resolveContextState(selector.slice(4));
    return null;
  }

  async resolveContextState(contextId: string): Promise<string> {
    const repositories = await this.contextRepoTargets(contextId);
    return (await this.repositories.contentView(repositories)).stateHash;
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
    const root = await this.materializeStateForGraphDiscovery(stateHash);
    return discoverPackageGraph(root);
  }

  async materializeForBuild(
    units: GraphNode[],
    stateRef: string,
    _workspaceRoot: string
  ): Promise<{ sourceRoot: string }> {
    const stateHash = await this.resolveStateReference(stateRef);
    const key = crypto.createHash("sha256").update(stateHash).digest("hex").slice(0, 24);
    const sourceRoot = path.join(this.deps.buildSourcesRoot, key);
    await this.locked(`build:${key}`, async () => {
      await this.contentProjection.ensureStateMirrored(stateHash);
      for (const unit of units) {
        const resolved = await resolveTreePath(this.deps.blobsDir, stateHash, unit.relativePath);
        if (!resolved) continue;
        if (resolved.kind !== "dir") {
          throw new Error(`build unit ${unit.relativePath} is not a directory at ${stateHash}`);
        }
        await materializeTree(
          this.deps.blobsDir,
          resolved.treeHash,
          path.join(sourceRoot, ...unit.relativePath.split("/"))
        );
      }
    });
    return { sourceRoot };
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
    await this.gad().call("appendLogEvent", {
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

  onProtectedPublication(callback: (event: ProtectedPublicationEvent) => void): () => void {
    this.emitter.on("protected-publication", callback);
    return () => this.emitter.off("protected-publication", callback);
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
    this.emitter.emit("protected-publication", {
      publicationId: publication.publicationId,
      resultHostRefsBasisDigest: publication.resultHostRefsBasisDigest,
      appliedAt: publication.appliedAt,
      workspaceStateHash,
      changedPaths,
      repositories,
    } satisfies ProtectedPublicationEvent);

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
