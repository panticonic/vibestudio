/**
 * State Transition Trigger — subscribes to workspace state advances on the
 * GAD vcs log (`vcs:workspace` @ main), recomputes effective versions for
 * the touched units, and rebuilds them.
 *
 * Replaces the git PushTrigger: change detection is `diffGadStates` paths
 * (precise per-file), content hashes are manifest subtree hashes, and the
 * build's sources come from the same immutable state the EVs were computed
 * at — there is no commit/push race to patch around.
 *
 * Immutability: never mutates the PackageGraph; EV maps and content-hash
 * maps are value types replaced wholesale.
 */

import { EventEmitter } from "events";
import type { PackageGraph } from "./packageGraph.js";
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
import { assertPresent } from "../../lintHelpers";

// ---------------------------------------------------------------------------
// Workspace state source (implemented by gadVcs/workspaceVcs.ts)
// ---------------------------------------------------------------------------

export interface StateAdvancedEvent {
  head: string;
  stateHash: string;
  /** State this head advanced from; null when the prior state is unknown/new. */
  sinceStateHash: string | null;
  /** Producing log event for the transition, when the advance came from GAD. */
  eventId: string | null;
  /** New log-head hash after the producing event, when available. */
  headHash: string | null;
  /** Verified server-side actor that authored the transition. */
  actor: { id: string; kind: string } | null;
  /** Coarse source for consumers that need to distinguish authored edits from scans/merges. */
  transitionKind: "snapshot" | "edit" | "merge" | "merge-resolution";
  /** File paths changed vs the previous state of this head (workspace-relative). */
  changedPaths: string[];
  /** File-level delta with content hashes/modes for exact reconciliation. */
  fileChanges: Array<{
    kind: "added" | "removed" | "changed";
    path: string;
    oldContentHash: string | null;
    newContentHash: string | null;
    oldMode: number | null;
    newMode: number | null;
  }>;
  /** Authored edit intent, when the transition came from edit-first VCS writes. */
  editOps: Array<{
    kind: "replace" | "write" | "create" | "delete" | "chmod";
    path: string;
    oldContentHash: string | null;
    newContentHash: string | null;
    hunks?: unknown;
    mode?: number | null;
  }>;
}

export interface BuildRecord {
  inputStateHash: string;
  unitName: string;
  subtree: string;
  ev: string;
  buildKey: string;
  status: "ok" | "error";
  error?: string;
}

export interface WorkspaceStateSource {
  /** Scan-on-demand: commit any out-of-band edits, return the main head's current state. */
  ensureFresh(): Promise<{ stateHash: string }>;
  /** Batch manifest subtree hashes for unit-relative paths at a state. */
  unitHashes(stateHash: string, relPaths: string[]): Promise<Record<string, string | null>>;
  /** Resolve a head name to its current worktree state hash. */
  resolveHead(head: string): Promise<string | null>;
  /** Discover package manifests from the exact immutable workspace state. */
  discoverGraph(stateHash: string): Promise<PackageGraph>;
  /** Changed file paths between two states. */
  diffPaths(leftStateHash: string, rightStateHash: string): Promise<string[]>;
  /** Subscribe to state advances (any head). Returns unsubscribe. */
  onStateAdvanced(cb: (event: StateAdvancedEvent) => void): () => void;
  /** Append `build.completed` provenance to the builds log (best effort). */
  recordBuild(record: BuildRecord): Promise<void>;
}

// ---------------------------------------------------------------------------
// Trigger
// ---------------------------------------------------------------------------

export interface StateTriggerEvents {
  "build-started": { name: string; trigger?: StateAdvancedEvent };
  "build-complete": { name: string; buildKey: string; trigger?: StateAdvancedEvent };
  "build-error": { name: string; error: string; trigger?: StateAdvancedEvent };
  "change-detected": { names: string[] };
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
    this.unsubscribe = this.source.onStateAdvanced((event) => this.handleAdvance(event));
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

  private handleAdvance(event: StateAdvancedEvent): void {
    this.queue = this.queue
      .then(() => (event.head === MAIN_HEAD ? this.process(event) : this.processPinnedHead(event)))
      .catch((error) => console.error(`[StateTrigger] Error processing state advance:`, error));
  }

  /** Full graph + effective-version map at a given state (the pinned head's own
   *  baseline — never main's). */
  private async fullEvAtState(
    stateHash: string
  ): Promise<{ graph: PackageGraph; evMap: EffectiveVersionMap }> {
    const graph = await this.source.discoverGraph(stateHash);
    const relPaths = graph.allNodes().map((node) => node.relativePath);
    const hashesByPath = await this.source.unitHashes(stateHash, relPaths);
    const contentHashes: ContentHashMap = {};
    for (const node of graph.allNodes()) {
      const hash = hashesByPath[node.relativePath];
      if (hash) contentHashes[node.name] = hash;
    }
    return { graph, evMap: computeEffectiveVersions(graph, contentHashes).evMap };
  }

  private async processPinnedHead(event: StateAdvancedEvent): Promise<void> {
    if (event.changedPaths.length === 0) return;
    // No persisted per-head EV baseline exists (this.graph/evMap/contentHashes track
    // MAIN only), so recomputing a pinned head incrementally against the main baseline
    // would omit this head's own earlier unpublished changes to a dependency and could
    // reuse a stale artifact. Compute the full EV at the pinned head's OWN state, and
    // diff against its prior state for a precise changeset (so unrelated pinned
    // instances aren't needlessly restarted on every commit).
    const fresh = await this.fullEvAtState(event.stateHash);
    let toNotify: string[];
    if (event.sinceStateHash) {
      const prior = await this.fullEvAtState(event.sinceStateHash);
      const changeset = diffEvMaps(prior.evMap, fresh.evMap);
      toNotify = [...changeset.changed, ...changeset.added];
    } else {
      toNotify = Object.keys(fresh.evMap);
    }
    await this.buildChanged(toNotify, fresh.graph, fresh.evMap, event, null);
  }

  private async process(event: StateAdvancedEvent): Promise<void> {
    if (event.stateHash === this.stateHash) return; // already current

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
      this.stateHash = event.stateHash;
      return;
    }

    const changedNames = [...units];
    const freshHashes = await this.source.unitHashes(
      event.stateHash,
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
    this.stateHash = event.stateHash;
    persistEvState({
      stateHash: event.stateHash,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
    });
    this.emit("graph-updated", {
      graph: this.graph,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
      stateHash: event.stateHash,
    });

    await this.buildChanged(
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
  async fullRediscovery(event: StateAdvancedEvent, sourceUnitName?: string): Promise<void> {
    const newGraph = await this.source.discoverGraph(event.stateHash);
    const relPaths = newGraph.allNodes().map((node) => node.relativePath);
    const hashesByPath = await this.source.unitHashes(event.stateHash, relPaths);
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
    this.stateHash = event.stateHash;
    persistEvState({
      stateHash: event.stateHash,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
    });
    this.emit("graph-updated", {
      graph: newGraph,
      evMap: result.evMap,
      contentHashes: result.contentHashes,
      stateHash: event.stateHash,
    });

    await this.buildChanged(
      [...changeset.changed, ...changeset.added],
      newGraph,
      result.evMap,
      event,
      sourceUnitName ?? null
    );
  }

  private async buildChanged(
    names: string[],
    graph: PackageGraph,
    evMap: EffectiveVersionMap,
    trigger: StateAdvancedEvent,
    sourceUnitName: string | null
  ): Promise<void> {
    if (names.length === 0) return;
    this.emit("change-detected", { names });

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
        await buildUnit(node, ev, graph, this.workspaceRoot, trigger.stateHash);
        this.emit("build-complete", { name, buildKey, trigger });
        void this.source
          .recordBuild({
            inputStateHash: trigger.stateHash,
            unitName: name,
            subtree: node.relativePath,
            ev,
            buildKey,
            status: "ok",
          })
          .catch(() => {});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.emit("build-error", { name, error: message, trigger });
        void this.source
          .recordBuild({
            inputStateHash: trigger.stateHash,
            unitName: name,
            subtree: node.relativePath,
            ev,
            buildKey,
            status: "error",
            error: message,
          })
          .catch(() => {});
      }
    }
  }
}
