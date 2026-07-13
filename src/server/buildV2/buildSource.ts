/**
 * Build source provider — the seam between the builder and the CONTENT STORE.
 *
 * The builder never reads the live working tree *directly*: build inputs are
 * content-addressed trees in the generic content store (blobstoreService tree
 * objects), addressed by an immutable worktree state (`state:…` hash) and
 * frozen for the duration of a build (no commit/push race). The production
 * provider (WorkspaceVcs.materializeForBuild) resolves each unit's subtree
 * hash within the state's tree and projects it to disk with the content
 * store's `materializeTree` (hardlinked from the CAS) — the gad DO is never
 * queried for manifests; every state hash handed to the builder resolves in
 * the content store (the mirroring invariant, see
 * WorktreeStore.ensureStateMirrored).
 *
 * The state is immutable for the build. After bootstrap,
 * `WorkspaceStateSource.ensureFresh()` composes the current protected main
 * refs; it does not scan the source directory or publish uncommitted disk
 * changes. External edits belong to an active context checkout, where the
 * gad-store DO adopts them through the semantics-free worktree scan primitive.
 * The provider owns checkout caching (per-state dirs hardlinked from the
 * blobstore CAS — a P1 cache, deletable at any time).
 *
 * Tests install a passthrough provider that serves a plain directory.
 */

import type { GraphNode, PackageGraph } from "./packageGraph.js";

export interface BuildSourceProvider {
  /**
   * Ensure the sources for the given units (the build target plus its
   * transitive internal deps) exist on disk at the given workspace state.
   * Returns a root directory containing each unit at its `relativePath`.
   */
  materializeForBuild(
    units: GraphNode[],
    stateRef: string,
    workspaceRoot: string
  ): Promise<{ sourceRoot: string }>;
}

let activeProvider: BuildSourceProvider | null = null;

export function setBuildSourceProvider(provider: BuildSourceProvider | null): void {
  activeProvider = provider;
}

export function getBuildSourceProvider(): BuildSourceProvider {
  if (!activeProvider) {
    throw new Error(
      "No build source provider installed (initBuildSystemV2 not run; tests must call setBuildSourceProvider)"
    );
  }
  return activeProvider;
}

/**
 * Passthrough provider serving sources straight from a directory on disk.
 * Used by builder unit tests (no GAD store involved).
 */
export function directorySourceProvider(sourceRoot: string): BuildSourceProvider {
  return {
    async materializeForBuild() {
      return { sourceRoot };
    },
  };
}

/**
 * Passthrough provider serving the live working tree of whatever workspace
 * root the build was invoked with. Test-only: production builds always
 * materialize from an immutable GAD state.
 */
export function workingTreeSourceProvider(): BuildSourceProvider {
  return {
    async materializeForBuild(_units, _stateRef, workspaceRoot) {
      return { sourceRoot: workspaceRoot };
    },
  };
}

/**
 * Walk internalDeps recursively to collect all nodes needed for a build.
 * Returns the target node plus all its transitive internal dependencies.
 */
export function collectTransitiveInternalDeps(node: GraphNode, graph: PackageGraph): GraphNode[] {
  const visited = new Set<string>();
  const result: GraphNode[] = [];

  function walk(n: GraphNode): void {
    if (visited.has(n.name)) return;
    visited.add(n.name);

    for (const depName of n.internalDeps) {
      const dep = graph.tryGet(depName);
      if (dep) walk(dep);
    }

    result.push(n);
  }

  walk(node);
  return result;
}
