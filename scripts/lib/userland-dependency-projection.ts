import * as fs from "node:fs";
import * as path from "node:path";
import {
  collectTransitiveDependencyOverrides,
  collectTransitiveExternalDeps,
  ensureExternalDeps,
  mergeExternalDependencySpecs,
} from "../../src/server/buildV2/externalDeps.js";
import {
  discoverPackageGraph,
  type GraphNode,
  type PackageGraph,
} from "../../src/server/buildV2/packageGraph.js";

export interface UserlandDependencyProjection {
  graph: PackageGraph;
  units: readonly GraphNode[];
  dependencies: Readonly<Record<string, string>>;
  dependencyOverrides: Readonly<Record<string, string>>;
  nodeModulesDir: string;
}

export interface PrepareUserlandDependencyProjectionOptions {
  /** Repository root containing package.json and workspace/. */
  appRoot: string;
  /** Include test/build-only requirements declared by userland units. */
  includeDevelopmentDependencies?: boolean;
  /** Units deliberately validated by a separate toolchain. */
  excludedUnitPaths?: ReadonlySet<string>;
}

const DEFAULT_EXCLUDED_UNIT_PATHS = new Set(["apps/mobile"]);

interface UnitPackageJson {
  devDependencies?: Record<string, string>;
}

/**
 * Materialize one content-addressed external dependency environment for
 * checkout-wide userland validation. Runtime builds still project the smaller
 * transitive closure of one exact semantic unit; this aggregate exists only
 * because repository typechecks and tests intentionally inspect many units in
 * one process.
 */
export async function prepareUserlandDependencyProjection(
  options: PrepareUserlandDependencyProjectionOptions
): Promise<UserlandDependencyProjection> {
  const appRoot = path.resolve(options.appRoot);
  const workspaceRoot = path.join(appRoot, "workspace");
  const appNodeModules = [path.join(appRoot, "node_modules")];
  const excluded = options.excludedUnitPaths ?? DEFAULT_EXCLUDED_UNIT_PATHS;
  const graph = discoverPackageGraph(workspaceRoot);
  const units = graph
    .topologicalOrder()
    .filter((unit) => unit.kind !== "template" && !excluded.has(unit.relativePath));
  const dependencies: Record<string, string> = {};
  const dependencyOverrides: Record<string, string> = {};

  for (const unit of units) {
    mergeExternalDependencySpecs(
      dependencies,
      collectTransitiveExternalDeps(unit, graph, workspaceRoot, appNodeModules, appRoot)
    );
    Object.assign(
      dependencyOverrides,
      collectTransitiveDependencyOverrides(unit, graph, workspaceRoot, appNodeModules)
    );
    if (options.includeDevelopmentDependencies) {
      mergeExternalDependencySpecs(dependencies, readExternalDevelopmentDependencies(unit, graph));
    }
  }

  const nodeModulesDir = await ensureExternalDeps(dependencies, dependencyOverrides, { appRoot });
  return { graph, units, dependencies, dependencyOverrides, nodeModulesDir };
}

function readExternalDevelopmentDependencies(
  unit: GraphNode,
  graph: PackageGraph
): Record<string, string> {
  let manifest: UnitPackageJson;
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(unit.path, "package.json"), "utf8")
    ) as UnitPackageJson;
  } catch (error) {
    throw new Error(`Cannot read development dependencies for ${unit.relativePath}`, {
      cause: error,
    });
  }

  const external: Record<string, string> = {};
  for (const [name, version] of Object.entries(manifest.devDependencies ?? {})) {
    if (graph.has(name) || version.startsWith("workspace:")) continue;
    external[name] = version;
  }
  return external;
}
