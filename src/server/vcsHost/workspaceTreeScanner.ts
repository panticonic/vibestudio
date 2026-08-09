/**
 * Workspace source tree scanner. Walks the workspace scope directories on disk
 * and reports repo roots (package.json / SKILL.md) with launchable/package/
 * skill metadata.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import type { WorkspaceNode, WorkspaceTree } from "@vibestudio/shared/types";
import { WORKSPACE_SOURCE_DIRS } from "@vibestudio/workspace-contracts/sourceDirs";
import { isAboutSource } from "@vibestudio/workspace-contracts/aboutNamespace";
import { discoverPackageGraph, type GraphNode } from "../buildV2/packageGraph.js";
import { readWorkspaceSkillEntry } from "./workspaceSkills.js";

interface InFlightScan {
  generation: number;
  promise: Promise<WorkspaceTree>;
}

export class WorkspaceTreeScanner {
  private cache: WorkspaceTree | null = null;
  private inFlight: InFlightScan | null = null;
  private generation = 0;

  constructor(private readonly sourceRoot: string | (() => Promise<string>)) {}

  invalidate(): void {
    this.cache = null;
    this.generation += 1;
  }

  async getSourceTree(): Promise<WorkspaceTree> {
    // The source root is an immutable semantic projection. Protected
    // publications explicitly invalidate this scanner, so a time-based expiry
    // only turns an unchanged catalog into repeated materialization and I/O.
    if (this.cache) return this.cache;
    if (this.inFlight?.generation === this.generation) return this.inFlight.promise;

    const generation = this.generation;
    const promise = this.scan(generation);
    this.inFlight = { generation, promise };
    try {
      return await promise;
    } finally {
      if (this.inFlight?.promise === promise) this.inFlight = null;
    }
  }

  private async scan(generation: number): Promise<WorkspaceTree> {
    const workspaceRoot =
      typeof this.sourceRoot === "string" ? this.sourceRoot : await this.sourceRoot();
    const graphByPath = new Map(
      discoverPackageGraph(workspaceRoot)
        .allNodes()
        .map((node) => [node.relativePath, node])
    );
    const children: WorkspaceNode[] = [];
    for (const scope of WORKSPACE_SOURCE_DIRS) {
      const scopeAbs = path.join(workspaceRoot, scope);
      let entries: import("fs").Dirent[];
      try {
        entries = await fs.readdir(scopeAbs, { withFileTypes: true });
      } catch {
        continue;
      }
      if (scope === "meta") {
        // meta is itself a unit root (workspace config), not a scope of units.
        const node: WorkspaceNode = {
          name: "meta",
          path: "meta",
          isUnit: true,
          children: [],
        };
        const skill = await readWorkspaceSkillEntry(workspaceRoot, "meta");
        if (skill) node.skillInfo = { name: skill.name, description: skill.description };
        children.push(node);
        continue;
      }
      const scopeChildren: WorkspaceNode[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const unitRel = `${scope}/${entry.name}`;
        const node = await this.unitNode(
          workspaceRoot,
          unitRel,
          entry.name,
          graphByPath.get(unitRel)
        );
        if (node) scopeChildren.push(node);
      }
      if (scopeChildren.length > 0) {
        children.push({
          name: scope,
          path: scope,
          isUnit: false,
          children: scopeChildren.sort((a, b) => compareUtf16CodeUnits(a.name, b.name)),
        });
      }
    }
    const tree: WorkspaceTree = { children };
    // A publication may have landed while the old projection was being read.
    // Return that request's coherent result, but never install it as the cache
    // for the newer generation.
    if (generation === this.generation) this.cache = tree;
    return tree;
  }

  private async unitNode(
    workspaceRoot: string,
    unitRel: string,
    name: string,
    graphNode?: GraphNode
  ): Promise<WorkspaceNode | null> {
    const abs = path.join(workspaceRoot, unitRel);
    const node: WorkspaceNode = { name, path: unitRel, isUnit: true, children: [] };

    if (graphNode) {
      node.packageInfo = { name: graphNode.name };
      this.applyManifestMetadata(node, unitRel, name, graphNode.manifest);
    } else {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(abs, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
          vibestudio?: {
            title?: string;
            description?: string;
            hiddenInLauncher?: boolean;
            shell?: unknown;
          };
        };
        if (pkg.name) {
          node.packageInfo = { name: pkg.name, ...(pkg.version ? { version: pkg.version } : {}) };
        }
        this.applyManifestMetadata(node, unitRel, name, pkg.vibestudio);
      } catch {
        // no package.json — may still be a skill
      }
    }

    const skill = await readWorkspaceSkillEntry(workspaceRoot, unitRel);
    if (skill) node.skillInfo = { name: skill.name, description: skill.description };

    if (!node.packageInfo && !node.skillInfo) {
      // Bare directory with no unit markers — still listed so the UI can
      // surface it (matches the old tree manager's lenient posture) as long
      // as it has any files.
      try {
        const sub = await fs.readdir(abs);
        if (sub.length === 0) return null;
      } catch {
        return null;
      }
    }
    return node;
  }

  private applyManifestMetadata(
    node: WorkspaceNode,
    unitRel: string,
    name: string,
    manifest: { title?: string; description?: string; hiddenInLauncher?: boolean } | undefined
  ): void {
    if (!manifest || (!unitRel.startsWith("panels/") && !isAboutSource(unitRel))) return;
    node.launchable = {
      type: "app",
      title: manifest.title ?? name,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.hiddenInLauncher ? { hidden: true } : {}),
    };
  }
}
