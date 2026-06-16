/**
 * Build source provider — the seam between the builder and the GAD store.
 *
 * Builds never read the live working tree: they read a materialized checkout
 * of an immutable GAD worktree state (`state:…` hash), so build inputs are
 * content-addressed by construction and the old commit/push race cannot
 * exist. The provider owns checkout caching (per-state dirs hardlinked from
 * the blobstore CAS — a P1 cache, deletable at any time).
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
