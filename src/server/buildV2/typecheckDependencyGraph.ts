import fs from "node:fs";
import path from "node:path";
import { PackageGraph, packageNodeFromJson, type GraphNode } from "./packageGraph.js";
import { mergeExternalDependencySpecs } from "./externalDeps.js";
import {
  discoverHostWorkspacePackageManifests,
  resolveHostWorkspacePackageManifest,
} from "./hostWorkspacePackages.js";

/** Compiler programs include authored tests and imported SDK declarations.
 * Derive that source closure from explicit package manifests, keeping it
 * separate from the smaller graph that composes executable runtime instances.
 * The ordinary dependency resolver consumes both graphs. */
export function typecheckDependencyGraph(
  unit: GraphNode,
  semanticGraph: PackageGraph,
  appRoot: string,
  appNodeModules: readonly string[]
): { graph: PackageGraph; workspacePackages: Record<string, string> } {
  const graph = new PackageGraph();
  const workspacePackages: Record<string, string> = {};
  const installed = discoverHostWorkspacePackageManifests(appRoot);
  const pending = [unit];
  while (pending.length) {
    const source = pending.pop()!;
    if (graph.has(source.name)) continue;
    const dependencies = { ...source.dependencies };
    mergeExternalDependencySpecs(dependencies, source.devDependencies ?? {});
    const node = { ...source, dependencies, internalDeps: [] as string[] };
    graph.addNode(node);
    for (const [name, version] of Object.entries({ ...source.peerDependencies, ...dependencies })) {
      const semantic = semanticGraph.tryGet(name);
      if (semantic) {
        node.internalDeps.push(name);
        pending.push(semantic);
      } else if (version.startsWith("workspace:")) {
        const manifest = resolveHostWorkspacePackageManifest(name, installed, appNodeModules);
        if (!manifest) throw new Error(`Missing declared compiler dependency: ${name}`);
        const packageRoot = fs.realpathSync(path.dirname(manifest));
        const sdk = packageNodeFromJson(
          packageRoot,
          "",
          "package",
          fs.readFileSync(manifest, "utf8")
        );
        if (!sdk || sdk.name !== name)
          throw new Error(`Incorrect installed compiler dependency: ${name}`);
        workspacePackages[name] = packageRoot;
        node.internalDeps.push(name);
        pending.push(sdk);
      }
    }
  }
  // Discovery above admits cycles in development-only source imports: the
  // compiler can analyze them without creating a cyclic runtime composition.
  return { graph, workspacePackages };
}
