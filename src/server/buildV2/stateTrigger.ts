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

export interface StateAdvancedEvent {
  head: string;
  stateHash: string;
  /**
   * The advanced log's OWN state hash — the identity space of the values
   * `vcs.edit`/`readFile`/`revert` return. For a per-repo advance this is
   * the subtree-rooted repo state, whereas `stateHash` is re-rooted to the
   * composed workspace/context view for the build trigger; the two differ.
   * Equals `stateHash` for whole-workspace advances. Clients correlating an RPC
   * result with a head advance (e.g. a panel's self-echo / undo guards) MUST
   * match on this field, not `stateHash`.
   */
  repoStateHash: string;
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
  /**
   * Routing metadata only (per-repo VCS): which repo's log advanced. The build
   * trigger stays workspace-rooted — a per-repo advance re-roots its changed
   * paths to workspace-relative and builds against the composed workspace view,
   * so `changedPaths`/`stateHash` remain workspace-rooted regardless. Used for
   * per-repo memory indexing and dependent selection. Absent for legacy
   * whole-workspace advances.
   */
  repoPath?: string;
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

/**
 * Emitted by `recordEdit` when a repo's UNCOMMITTED working content advances on a
 * `ctx:*` head. Deliberately distinct from {@link StateAdvancedEvent}: an edit is
 * NOT a state operation — it does not advance the commit head, appear in
 * `vcs.log`, or trigger a build. The build trigger does not subscribe to this;
 * consumers that mirror working content (reactive views, dirty indicators) do.
 */
export interface WorkingAdvancedEvent {
  head: string;
  /** Which repo's working content advanced (per-repo VCS). */
  repoPath?: string;
  /** Verified server-side actor that authored the edit. */
  actor: { id: string; kind: string } | null;
  /** The working state hash (committed base + uncommitted ops) projected to disk. */
  stateHash: string;
  /** The committed base the working content composes on. */
  baseStateHash: string;
  /** The shared per-call edit sequence for this edit's ops. */
  editSeq: number;
  /** Paths changed by THIS edit (workspace-relative). */
  changedPaths: string[];
}

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
   * Scan-on-demand: adopt any out-of-band disk edits into the ACTIVE context
   * (D2 — the workspace root is that context's checkout, not `main`), then
   * return its composed view (the live union of repo mains overlaid with the
   * context's working edits). This is what a default (`main`/no-ref)
   * `bindRuntimeImage`/`getBuild` builds — the active-context view, not the
   * plain `main` union. With no drift the two are identical.
   */
  ensureFresh(): Promise<{ stateHash: string }>;
  /** Batch manifest subtree hashes for unit-relative paths at a state. */
  unitHashes(stateHash: string, relPaths: string[]): Promise<Record<string, string | null>>;
  /** Resolve a head name to its current worktree state hash. */
  resolveHead(head: string): Promise<string | null>;
  /** Resolve a `ctx:{contextId}` ref to its composed view state (every repo at
   *  main, with the context's writable repos overlaid at their ctx heads). */
  resolveContextView(contextId: string): Promise<string>;
  /**
   * Discover package manifests from a workspace-rooted state. Per the per-repo
   * VCS reshape this is the composed live workspace view (`workspaceView()` =
   * `composeRepoStatesLocal` over each repo's `main`), which equals the legacy
   * whole-workspace state for discovery purposes: discovery stays
   * workspace-rooted so unit `relativePath`s, EVs, and the build graph are all
   * in workspace coordinates regardless of which repo advanced.
   */
  discoverGraph(stateHash: string): Promise<PackageGraph>;
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
  "build-error": {
    name: string;
    error: string;
    diagnostics: BuildDiagnostic[];
    trigger?: StateAdvancedEvent;
  };
  "change-detected": {
    names: string[];
    units: StateChangedUnit[];
    trigger: StateAdvancedEvent;
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

  /**
   * Non-main (pinned / `ctx:*`) state advance. In the edit→commit→push model a
   * ctx-head commit emits `state-advanced` ONLY for memory/attribution
   * bookkeeping (consumed directly off `workspaceVcs.onStateAdvanced`) — it is
   * NOT a publication and MUST NOT build: builds are validated at the push gate
   * (`validate`/`validateRepoPush` build + cache the candidate, idempotently —
   * they do NOT record the baseline), and the recorded baseline (`persistEvState`
   * + `recordBuild`) is promoted ONLY here, reactively, when `main` advances.
   * On-demand previews of working content go through `previewBuild` (which
   * never touches the EV baseline). So the build trigger deliberately does
   * nothing here: no `buildChanged`, no `change-detected`/unit-reconcile, and —
   * critically — no `persistEvState` (the EV baseline tracks ONLY pushed main
   * states; a pinned/working state must never poison it).
   */
  private async processPinnedHead(_event: StateAdvancedEvent): Promise<void> {
    // Intentionally a no-op. See the doc comment above.
  }

  private async process(event: StateAdvancedEvent): Promise<void> {
    // A per-repo group push emits ONE event per advanced repo, all carrying the
    // same composed workspace `stateHash` but DISTINCT per-repo `changedPaths`.
    // Deduping on `stateHash` alone would drop every repo after the first (the
    // first advances `this.stateHash` to the composed view), leaving the later
    // repos' units' content hashes / EV / build notifications stale. So only
    // short-circuit whole-workspace advances (no `repoPath`); a per-repo
    // event is always processed for its own `changedPaths` — an empty delta is
    // still cheaply handled by the `units.size === 0` branch below.
    if (!event.repoPath && event.stateHash === this.stateHash) return; // already current

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
        const diagnostics = diagnosticsFromError(error, this.workspaceRoot);
        recordDiagnostics(name, buildKey, diagnostics);
        this.emit("build-error", { name, error: message, diagnostics, trigger });
        void this.source
          .recordBuild({
            inputStateHash: trigger.stateHash,
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
