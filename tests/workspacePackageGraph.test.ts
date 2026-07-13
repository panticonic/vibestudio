import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

interface WorkspaceManifest {
  name: string;
  directory: string;
  dependencies: Record<string, string>;
}

const IGNORED_DIRECTORIES = new Set([".git", "dist", "node_modules", "test-results"]);

function collectManifests(directory: string, manifests: WorkspaceManifest[]): void {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      collectManifests(entryPath, manifests);
      continue;
    }
    if (entry.name !== "package.json") continue;
    const parsed = JSON.parse(fs.readFileSync(entryPath, "utf8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    if (!parsed.name) continue;
    manifests.push({
      name: parsed.name,
      directory: path.dirname(entryPath),
      dependencies: {
        ...parsed.peerDependencies,
        ...parsed.optionalDependencies,
        ...parsed.dependencies,
      },
    });
  }
}

function findDependencyCycle(manifests: WorkspaceManifest[]): string[] | null {
  const byName = new Map(manifests.map((manifest) => [manifest.name, manifest]));
  const visited = new Set<string>();
  const active = new Map<string, number>();
  const stack: string[] = [];

  const visit = (name: string): string[] | null => {
    if (visited.has(name)) return null;
    const activeIndex = active.get(name);
    if (activeIndex !== undefined) return [...stack.slice(activeIndex), name];

    active.set(name, stack.length);
    stack.push(name);
    const manifest = byName.get(name);
    for (const dependency of Object.keys(manifest?.dependencies ?? {}).sort()) {
      if (!byName.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    active.delete(name);
    visited.add(name);
    return null;
  };

  for (const name of [...byName.keys()].sort()) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return null;
}

describe("workspace package graph", () => {
  it("keeps runtime workspace-package dependencies acyclic", () => {
    const manifests: WorkspaceManifest[] = [];
    for (const root of ["packages", "apps", "workspace"]) {
      collectManifests(path.resolve(root), manifests);
    }
    const duplicateNames = manifests
      .map((manifest) => manifest.name)
      .filter((name, index, names) => names.indexOf(name) !== index);
    expect(duplicateNames, "workspace package names must be unique").toEqual([]);
    expect(findDependencyCycle(manifests), "workspace dependency cycle").toBeNull();
  });
});
