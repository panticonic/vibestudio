/**
 * Build source provider — the seam between the builder and the CONTENT STORE.
 *
 * Production builds never read mutable workspace or context directories.
 * Published and candidate builds use immutable workspace-rooted content
 * states. Contexts resolve to the same kind of aggregate content coordinate as
 * protected main, so the builder needs no second repository-set identity.
 *
 * The source view is immutable for the build. Once materialized,
 * `WorkspaceStateSource.ensureFresh()` resolves the current protected
 * workspace publication; it does not scan or infer meaning from disk. Context
 * edits belong to semantic working frontiers, and explicit scan/project host
 * effects merely exchange byte facts with their disposable projections. Build
 * materialization is likewise a deletable, per-state cache hardlinked from the
 * blobstore CAS.
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
 * Used by builder unit tests (no semantic control plane involved).
 */
export function directorySourceProvider(sourceRoot: string): BuildSourceProvider {
  return {
    async materializeForBuild() {
      return { sourceRoot };
    },
  };
}

/**
 * Passthrough provider serving the invocation directory. Test-only: production
 * builds always materialize exact content-addressed state.
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
