/**
 * State Transition Trigger — subscribes to protected workspace publications,
 * recomputes effective versions for touched units, and rebuilds them.
 *
 * Replaces the git PushTrigger: change detection consumes explicit content-state differences
 * (precise per-file), content hashes are manifest subtree hashes, and the
 * build's sources come from the same immutable state the EVs were computed
 * at — there is no commit/push race to patch around.
 *
 * Immutability: never mutates the PackageGraph; EV maps and content-hash
 * maps are value types replaced wholesale.
 */

import { EventEmitter } from "events";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import type { GraphNode, PackageGraph } from "./packageGraph.js";
import {
  computeEffectiveVersions,
  recomputeFromNodes,
  diffEvMaps,
  persistEvState,
  type ContentHashMap,
  type EffectiveVersionMap,
} from "./effectiveVersion.js";
import * as buildStore from "./buildStore.js";
import { buildUnit, computeBuildUnitKey } from "./builder.js";
import { diagnosticsFromError, type BuildDiagnostic } from "./diagnostics.js";
import { recordDiagnostics } from "./diagnosticsStore.js";
import { assertPresent } from "../../lintHelpers";

// ---------------------------------------------------------------------------
// Workspace state source (implemented by vcsHost/workspaceVcs.ts)
// ---------------------------------------------------------------------------

export interface BuildRecord {
  inputStateHash: string;
  unitName: string;
  subtree: string;
  ev: string;
  buildKey: string;
  status: "ok" | "error";
  error?: string;
  /** Structured esbuild/tsc diagnostics for this build (replaces the lossy
   *  `error` string when present). */
  diagnostics?: BuildDiagnostic[];
}

export interface StateChangedUnit {
  name: string;
  relativePath: string;
  kind: GraphNode["kind"];
}

export interface WorkspaceStateSource {
  /**
   * Resolve the current protected workspace publication to one exact,
   * workspace-rooted content state. No disk scan or projection participates.
   */
  ensureFresh(): Promise<{ stateHash: string }>;
  /** Batch manifest subtree hashes for unit-relative paths at a state. */
  unitHashes(stateHash: string, relPaths: string[]): Promise<Record<string, string | null>>;
  /** Resolve a semantic context's exact working frontier to workspace content. */
  resolveContextState(contextId: string): Promise<string>;
  /**
   * Discover package manifests from exact workspace-rooted content. Unit
   * relative paths, effective versions, and graph edges therefore share the
   * same coordinates regardless of repository boundaries.
   */
  discoverGraph(stateHash: string): Promise<PackageGraph>;
  /** Subscribe to atomic protected workspace publications. Returns unsubscribe. */
  onProtectedPublication(cb: (event: ProtectedPublicationEvent) => void): () => void;
  /** Append `build.completed` provenance to the builds log (best effort). */
  recordBuild(record: BuildRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export interface StateTriggerEvents {
  "build-started": { name: string; trigger?: ProtectedPublicationEvent };
  "build-complete": { name: string; buildKey: string; trigger?: ProtectedPublicationEvent };
  "build-error": {
    name: string;
    error: string;
    diagnostics: BuildDiagnostic[];
    trigger?: ProtectedPublicationEvent;
  };
  "change-detected": {
    names: string[];
    units: StateChangedUnit[];
    trigger: ProtectedPublicationEvent;
  };
  "graph-updated": {
    graph: PackageGraph;
    evMap: EffectiveVersionMap;
    contentHashes: ContentHashMap;
    stateHash: string;
  };
}

export const MAIN_HEAD = "main";

export interface BuildStateSnapshot {
  graph: PackageGraph;
  evMap: EffectiveVersionMap;
  contentHashes: ContentHashMap;
  stateHash: string;
}

export function isBuildableKind(kind: string): boolean {
  return kind !== "package" && kind !== "template";
}

export function sourcemapForKind(kind: string, manifestSourcemap: boolean | undefined): boolean {
  return kind === "extension" || kind === "app" ? true : manifestSourcemap !== false;
}

/** Map changed file paths to the graph units containing them (longest prefix). */
export function unitsForChangedPaths(
  graph: PackageGraph,
  changedPaths: string[]
): { units: Set<string>; unmatched: string[]; manifestTouched: boolean } {
  const byPath = graph
    .allNodes()
    .map((node) => ({ name: node.name, prefix: `${node.relativePath}/`, rel: node.relativePath }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const units = new Set<string>();
  const unmatched: string[] = [];
  let manifestTouched = false;
  for (const changed of changedPaths) {
    const owner = byPath.find((u) => changed === u.rel || changed.startsWith(u.prefix));
    if (!owner) {
      unmatched.push(changed);
      continue;
    }
    units.add(owner.name);
    if (changed === `${owner.rel}/package.json`) manifestTouched = true;
  }
  return { units, unmatched, manifestTouched };
}

export class StateTransitionTrigger extends EventEmitter {
  private queue: Promise<void> = Promise.resolve();
  private graph: PackageGraph;
  private evMap: EffectiveVersionMap;
  private contentHashes: ContentHashMap;
  private stateHash: string;
  private readonly workspaceRoot: string;
  private readonly source: WorkspaceStateSource;
  private unsubscribe: (() => void) | null = null;
  private queuedRevision = 0;
  private settledRevision = 0;

  constructor(opts: {
    graph: PackageGraph;
    evMap: EffectiveVersionMap;
    contentHashes: ContentHashMap;
    stateHash: string;
    workspaceRoot: string;
    source: WorkspaceStateSource;
  }) {
    super();
    this.graph = opts.graph;
    this.evMap = opts.evMap;
    this.contentHashes = opts.contentHashes;
    this.stateHash = opts.stateHash;
    this.workspaceRoot = opts.workspaceRoot;
    this.source = opts.source;
  }

  start(): void {
    this.unsubscribe = this.source.onProtectedPublication((event) => this.handlePublication(event));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  getState(): BuildStateSnapshot {
    return {
      graph: this.graph,
      evMap: this.evMap,
      contentHashes: this.contentHashes,
      stateHash: this.stateHash,
    };
  }

  /** Rediscover graph/EV state without triggering eager builds. */
  async rediscoverAt(stateHash: string): Promise<void> {
    const newGraph = await this.source.discoverGraph(stateHash);
    const relPaths = newGraph.allNodes().map((node) => node.relativePath);
    const hashesByPath = await this.source.unitHashes(stateHash, relPaths);
    const contentHashes: ContentHashMap = {};
    for (const node of newGraph.allNodes()) {
      const hash = hashesByPath[node.relativePath];
      if (hash) contentHashes[node.name] = hash;
    }

    const result = computeEffectiveVersions(newGraph, contentHashes);
    this.graph = newGraph;
    this.evMap = result.evMap;
    this.contentHashes = result.contentHashes;
    this.stateHash = stateHash;
    persistEvState({
      stateHash,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
    });
    this.emit("graph-updated", {
      graph: newGraph,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
      stateHash,
    });
  }

  /** Wait for all queued processing to finish (launch_panel: commit → settle → getBuild). */
  whenSettled(): Promise<void> {
    return this.queue.then(() => undefined);
  }

  /** Whether the protected-publication subscription has no queued transition. */
  isSettled(): boolean {
    return this.queuedRevision === this.settledRevision;
  }

  private handlePublication(event: ProtectedPublicationEvent): void {
    const revision = ++this.queuedRevision;
    this.queue = this.queue
      .then(() => this.process(event))
      .catch((error) => console.error(`[StateTrigger] Error processing publication:`, error))
      .finally(() => {
        this.settledRevision = revision;
      });
  }

  private async process(event: ProtectedPublicationEvent): Promise<void> {
    const { units, unmatched, manifestTouched } = unitsForChangedPaths(
      this.graph,
      event.changedPaths
    );

    if (unmatched.length > 0 || manifestTouched) {
      // New unit, deleted unit, or dependency-shape change — full rediscovery.
      await this.fullRediscovery(event);
      return;
    }
    if (units.size === 0) {
      this.stateHash = event.workspaceStateHash;
      return;
    }

    const changedNames = [...units];
    const freshHashes = await this.source.unitHashes(
      event.workspaceStateHash,
      changedNames.map((name) => this.graph.get(name).relativePath)
    );
    const updated: ContentHashMap = {};
    for (const name of changedNames) {
      const hash = freshHashes[this.graph.get(name).relativePath];
      if (hash) updated[name] = hash;
    }

    const result = recomputeFromNodes(
      this.graph,
      changedNames,
      this.evMap,
      this.contentHashes,
      updated
    );
    const changeset = diffEvMaps(this.evMap, result.evMap);

    this.evMap = result.evMap;
    this.contentHashes = result.contentHashes;
    this.stateHash = event.workspaceStateHash;
    persistEvState({
      stateHash: event.workspaceStateHash,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
    });
    this.emit("graph-updated", {
      graph: this.graph,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
      stateHash: event.workspaceStateHash,
    });

    this.prewarmChanged(
      [...changeset.changed, ...changeset.added],
      this.graph,
      result.evMap,
      event,
      null
    );
  }

  /**
   * Full graph rediscovery: re-scan workspace manifests from the immutable
   * state, hash every unit at that state, recompute all EVs, build what changed.
   */
  async fullRediscovery(event: ProtectedPublicationEvent, sourceUnitName?: string): Promise<void> {
    const newGraph = await this.source.discoverGraph(event.workspaceStateHash);
    const relPaths = newGraph.allNodes().map((node) => node.relativePath);
    const hashesByPath = await this.source.unitHashes(event.workspaceStateHash, relPaths);
    const contentHashes: ContentHashMap = {};
    for (const node of newGraph.allNodes()) {
      const hash = hashesByPath[node.relativePath];
      if (hash) contentHashes[node.name] = hash;
    }

    const result = computeEffectiveVersions(newGraph, contentHashes);
    const changeset = diffEvMaps(this.evMap, result.evMap);

    this.graph = newGraph;
    this.evMap = result.evMap;
    this.contentHashes = result.contentHashes;
    this.stateHash = event.workspaceStateHash;
    persistEvState({
      stateHash: event.workspaceStateHash,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
    });
    this.emit("graph-updated", {
      graph: newGraph,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
      stateHash: event.workspaceStateHash,
    });

    this.prewarmChanged(
      [...changeset.changed, ...changeset.added],
      newGraph,
      result.evMap,
      event,
      sourceUnitName ?? null
    );
  }

  /**
   * Cache warming is downstream work, not state-transition settlement.
   *
   * Graph/EV publication must become observable immediately after its exact
   * immutable state is indexed. Callers such as resolveBuildUnit can then
   * request the one unit they need; waiting for every speculative changed-unit
   * build here creates a head-of-line block where a single slow build makes a
   * newly published unit appear unresolved forever. buildUnit is
   * content-addressed and coalesced, so an on-demand request safely joins the
   * same background build.
   */
  private prewarmChanged(
    names: string[],
    graph: PackageGraph,
    evMap: EffectiveVersionMap,
    trigger: ProtectedPublicationEvent,
    sourceUnitName: string | null
  ): void {
    void this.buildChanged(names, graph, evMap, trigger, sourceUnitName).catch((error) => {
      console.error("[StateTrigger] Unexpected cache-warming failure:", error);
    });
  }

  private async buildChanged(
    names: string[],
    graph: PackageGraph,
    evMap: EffectiveVersionMap,
    trigger: ProtectedPublicationEvent,
    sourceUnitName: string | null
  ): Promise<void> {
    if (names.length === 0) return;
    this.emit("change-detected", {
      names,
      units: names
        .map((name) => graph.tryGet(name))
        .filter((node): node is GraphNode => !!node)
        .map((node) => ({
          name: node.name,
          relativePath: node.relativePath,
          kind: node.kind,
        })),
      trigger,
    });

    for (const name of names) {
      const node = graph.tryGet(name);
      if (!node) continue;
      if (!isBuildableKind(node.kind)) continue;
      // Trusted units (extensions/apps) rebuild only when directly targeted.
      if ((node.kind === "extension" || node.kind === "app") && name !== sourceUnitName) continue;

      const ev = assertPresent(evMap[name]);
      const buildKey = computeBuildUnitKey(node, ev);
      if (buildStore.has(buildKey)) {
        this.emit("build-complete", { name, buildKey, trigger });
        continue;
      }

      this.emit("build-started", { name, trigger });
      try {
        await buildUnit(node, ev, graph, this.workspaceRoot, trigger.workspaceStateHash);
        this.emit("build-complete", { name, buildKey, trigger });
        void this.source
          .recordBuild({
            inputStateHash: trigger.workspaceStateHash,
            unitName: name,
            subtree: node.relativePath,
            ev,
            buildKey,
            status: "ok",
          })
          .catch(() => {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const diagnostics = diagnosticsFromError(error, this.workspaceRoot);
        recordDiagnostics(name, buildKey, diagnostics);
        this.emit("build-error", { name, error: message, diagnostics, trigger });
        void this.source
          .recordBuild({
            inputStateHash: trigger.workspaceStateHash,
            unitName: name,
            subtree: node.relativePath,
            ev,
            buildKey,
            status: "error",
            error: message,
            diagnostics,
          })
          .catch(() => {});
      }
    }
  }
}
