/**
 * Package Graph — DAG discovery from workspace package.json files.
 *
 * Scans the buildable-unit directories declared by BUILDABLE_UNIT_DIRS in
 * @vibestudio/workspace-contracts/sourceDirs (packages, panels, apps, about, workers,
 * extensions, skills, templates) and builds an adjacency-list DAG of internal
 * dependencies. Detects cycles, produces topological ordering.
 */

import * as fs from "fs";
import * as path from "path";
import type { PackageManifest } from "@vibestudio/shared/types";
import {
  BUILDABLE_UNIT_DIRS,
  WORKSPACE_PACKAGE_SCOPES,
} from "@vibestudio/workspace-contracts/sourceDirs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type { PackageManifest };

export interface GraphNode {
  /** Absolute path to the unit directory */
  path: string;
  /** Workspace-relative path (e.g., "packages/core", "panels/chat") */
  relativePath: string;
  /** Package name from package.json (e.g., "@workspace/lib-a") */
  name: string;
  /** Unit kind */
  kind: "package" | "panel" | "worker" | "extension" | "app" | "template";
  /** All dependencies from package.json (name → version) */
  dependencies: Record<string, string>;
  /** Simple package-manager overrides from package.json overrides / pnpm.overrides. */
  dependencyOverrides: Record<string, string>;
  /** Resolved internal dependency names */
  internalDeps: string[];
  /** Dependency declaration errors that block this unit without aborting graph discovery. */
  dependencyErrors?: string[];
  /**
   * Declared `exports` subpaths from package.json (the keys, e.g. ".",
   * "./panel"). Used by the push gate to validate a package's library bundles
   * for each declared export, not just the root entry.
   */
  exports?: string[];
  /** vibestudio manifest from package.json */
  manifest: PackageManifest;
}

export class PackageGraph {
  /** name → GraphNode */
  private nodes = new Map<string, GraphNode>();
  /** Topologically sorted node names (leaves first) */
  private topoOrder: string[] = [];

  addNode(node: GraphNode): void {
    this.nodes.set(node.name, node);
  }

  get(name: string): GraphNode {
    const node = this.nodes.get(name);
    if (!node) throw new Error(`Unknown package: ${name}`);
    return node;
  }

  tryGet(name: string): GraphNode | undefined {
    return this.nodes.get(name);
  }

  has(name: string): boolean {
    return this.nodes.has(name);
  }

  isInternal(name: string): boolean {
    return this.nodes.has(name);
  }

  allNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  /** Returns nodes in topological order (leaves first, dependents last). */
  topologicalOrder(): GraphNode[] {
    return this.topoOrder.map((name) => this.get(name));
  }

  /**
   * Compute topological ordering. Throws on cycles.
   */
  computeTopologicalOrder(): void {
    const visited = new Set<string>();
    const visiting = new Set<string>(); // cycle detection
    const order: string[] = [];

    const visit = (name: string, stack: string[]) => {
      if (visited.has(name)) return;
      if (visiting.has(name)) {
        const cycle = [...stack.slice(stack.indexOf(name)), name];
        throw new Error(`Dependency cycle detected: ${cycle.join(" → ")}`);
      }

      visiting.add(name);
      stack.push(name);

      const node = this.get(name);
      for (const dep of node.internalDeps) {
        visit(dep, stack);
      }

      visiting.delete(name);
      stack.pop();
      visited.add(name);
      order.push(name);
    };

    for (const name of this.nodes.keys()) {
      visit(name, []);
    }

    this.topoOrder = order;
  }

  /**
   * Get all nodes that transitively depend on the given node (reverse deps).
   * Useful for knowing what needs rebuilding when a package changes.
   */
  getReverseDeps(name: string): Set<string> {
    const result = new Set<string>();
    const queue = [name];
    while (queue.length > 0) {
      const current = assertPresent(queue.pop());
      for (const node of this.nodes.values()) {
        if (node.internalDeps.includes(current) && !result.has(node.name)) {
          result.add(node.name);
          queue.push(node.name);
        }
      }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

function isInternalDep(name: string): boolean {
  return WORKSPACE_PACKAGE_SCOPES.some((scope) => name.startsWith(scope));
}

function validateInternalDepSpec(depName: string, rawSpec: string): string | null {
  const raw = (rawSpec ?? "").trim();
  const normalized = raw.toLowerCase();

  if (!raw || raw === "*" || normalized === "workspace:*" || normalized === "workspace:") {
    return null;
  }

  return `Internal dependency ${depName} must use workspace:*; GAD workspace builds do not support per-dependency refs`;
}

function recordInternalDepSpecError(
  node: { name: string; dependencyErrors?: string[] },
  depName: string,
  rawSpec: string
): void {
  const error = validateInternalDepSpec(depName, rawSpec);
  if (!error) return;
  node.dependencyErrors ??= [];
  if (node.dependencyErrors.includes(error)) return;
  node.dependencyErrors.push(error);
  console.warn(`[PackageGraph] ${node.name}: ${error}`);
}

interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  vibestudio?: PackageManifest;
  overrides?: unknown;
  pnpm?: { overrides?: unknown };
  exports?: Record<string, unknown>;
  main?: string;
}

function normalizeSimpleOverrides(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
    if (typeof version === "string") result[name] = version;
  }
  return result;
}

function packageManagerOverrides(pkg: PackageJson): Record<string, string> {
  return {
    ...normalizeSimpleOverrides(pkg.overrides),
    ...normalizeSimpleOverrides(pkg.pnpm?.overrides),
  };
}

function readPackageJson(dir: string): PackageJson | null {
  const p = path.join(dir, "package.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as PackageJson;
  } catch {
    return null;
  }
}

function scanDirectory(dir: string, workspaceRoot: string, kind: GraphNode["kind"]): GraphNode[] {
  if (!fs.existsSync(dir)) return [];
  const nodes: GraphNode[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const unitDir = path.join(dir, entry.name);
    const pkg = readPackageJson(unitDir);
    if (!pkg?.name) continue;

    const allDeps = { ...pkg.peerDependencies, ...pkg.dependencies };
    const internalDeps: string[] = [];
    const partialNode = { name: pkg.name, dependencyErrors: undefined as string[] | undefined };

    for (const [depName, depSpec] of Object.entries(allDeps)) {
      if (isInternalDep(depName)) {
        internalDeps.push(depName);
        recordInternalDepSpecError(partialNode, depName, depSpec);
      }
    }

    nodes.push({
      path: unitDir,
      relativePath: path.relative(workspaceRoot, unitDir).replace(/\\/g, "/"),
      name: pkg.name,
      kind,
      dependencies: allDeps,
      dependencyOverrides: packageManagerOverrides(pkg),
      internalDeps,
      ...(partialNode.dependencyErrors ? { dependencyErrors: partialNode.dependencyErrors } : {}),
      ...(pkg.exports ? { exports: declaredExportSubpaths(pkg.exports) } : {}),
      manifest: pkg.vibestudio ?? {},
    });
  }

  return nodes;
}

/**
 * Extract concrete declared subpath keys from a package.json `exports` field,
 * e.g. `{ ".": ..., "./panel": ... }` → `[".", "./panel"]`.
 * Wildcard keys are consumer-resolved families, not literal build entry points;
 * validating `./tests/*` itself would resolve to a non-existent `*.ts` file.
 * Conditional-only exports (a flat condition map) collapse to `["."]`.
 */
function declaredExportSubpaths(exports: Record<string, unknown>): string[] {
  const keys = Object.keys(exports);
  const subpaths = keys.filter((k) => (k === "." || k.startsWith("./")) && !k.includes("*"));
  if (subpaths.length === 0) return ["."];
  return subpaths;
}

import type { TemplateConfig } from "./templateResolver.js";
import { assertPresent } from "../../lintHelpers";

function scanTemplates(dir: string, workspaceRoot: string): GraphNode[] {
  if (!fs.existsSync(dir)) return [];
  const nodes: GraphNode[] = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;

    const templateDir = path.join(dir, entry.name);
    const configPath = path.join(templateDir, "template.json");
    if (!fs.existsSync(configPath)) {
      console.warn(
        `[PackageGraph] Template directory ${entry.name} has no template.json, skipping`
      );
      continue;
    }

    let config: TemplateConfig = {};
    try {
      config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as TemplateConfig;
    } catch {
      console.warn(`[PackageGraph] Failed to parse template.json in ${entry.name}`);
    }

    nodes.push({
      path: templateDir,
      relativePath: path.relative(workspaceRoot, templateDir).replace(/\\/g, "/"),
      name: `template:${entry.name}`,
      kind: "template",
      dependencies: {},
      dependencyOverrides: {},
      internalDeps: [],
      manifest: { framework: config.framework },
    });
  }

  return nodes;
}

/**
 * Discover all buildable units in the workspace and build the package graph.
 */
export function discoverPackageGraph(workspaceRoot: string): PackageGraph {
  const graph = new PackageGraph();

  // Scan every buildable-unit directory declared by the shared taxonomy, in the
  // declared order. Templates use a dedicated scanner (template.json, synthetic
  // `template:*` names); all other dirs are standard package.json scans.
  for (const { dir, kind } of BUILDABLE_UNIT_DIRS) {
    const absDir = path.join(workspaceRoot, dir);
    const discovered =
      kind === "template"
        ? scanTemplates(absDir, workspaceRoot)
        : scanDirectory(absDir, workspaceRoot, kind);
    for (const node of discovered) {
      graph.addNode(node);
    }
  }

  // The template workspace may contain packages whose real package name is not
  // under an @workspace/* scope, e.g. @vendor/shared-utils. Treat any dependency
  // whose package name is present in the graph as internal so source
  // materialization, source digest computation, and esbuild resolution all see the same
  // workspace graph.
  for (const node of graph.allNodes()) {
    for (const [depName, depSpec] of Object.entries(node.dependencies)) {
      if (!graph.has(depName) || node.internalDeps.includes(depName)) continue;
      node.internalDeps.push(depName);
      recordInternalDepSpecError(node, depName, depSpec);
    }
  }

  // Inject template dependencies into panels so template content flows into source digests
  const hasDefaultTemplate = graph.has("template:default");
  for (const node of graph.allNodes()) {
    if (node.kind !== "panel") continue;

    if (node.manifest.template) {
      // Explicit template reference
      const templateName = `template:${node.manifest.template}`;
      if (graph.has(templateName)) {
        node.internalDeps.push(templateName);
      } else {
        console.warn(
          `[PackageGraph] ${node.name} references template "${node.manifest.template}" which does not exist`
        );
      }
    } else if (hasDefaultTemplate) {
      // Always inject default template as a dep so its content flows into the
      // panel's source digest. Even panels with their own index.html get this dep — the
      // cost is trivial (template files materialized alongside panel source)
      // and it avoids a state-correctness issue: the live filesystem check for
      // index.html could disagree with the requested build state.
      // resolveFramework() handles the "has own HTML" case at build time from
      // materialized source.
      node.internalDeps.push("template:default");
    }
  }

  // Validate: all internal deps must exist in the graph
  for (const node of graph.allNodes()) {
    for (const dep of node.internalDeps) {
      if (!graph.has(dep)) {
        console.warn(`[PackageGraph] ${node.name} depends on ${dep} which is not in the workspace`);
        // Remove missing deps to avoid topo sort errors
        node.internalDeps = node.internalDeps.filter((d) => d !== dep);
      }
    }
  }

  graph.computeTopologicalOrder();
  return graph;
}
