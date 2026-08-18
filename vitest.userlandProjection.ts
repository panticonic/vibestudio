import * as fs from "node:fs";
import * as path from "node:path";
import type { Alias } from "vite";
import { prepareUserlandDependencyProjection } from "./scripts/lib/userland-dependency-projection";

const RUNNER_OWNED_DEPENDENCIES = new Set(["vitest"]);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Resolve userland-declared npm packages from the same content-addressed
 * dependency projection used by checkout typechecking. Source aliases remain
 * separate because workspace packages come from semantic source, not npm.
 */
export async function userlandDependencyAliases(
  appRoot: string,
  workspaceRoot: string
): Promise<Alias[]> {
  const projection = await prepareUserlandDependencyProjection({
    appRoot,
    workspaceRoot,
    includeDevelopmentDependencies: true,
  });
  if (!projection.nodeModulesDir) return [];

  return Object.keys(projection.dependencies)
    // Test-framework imports belong to the active host runner. Projecting a
    // checkout's Vitest package into browser code splits @vitest/browser from
    // its companion runtime and breaks package-export resolution.
    .filter((packageName) => !RUNNER_OWNED_DEPENDENCIES.has(packageName))
    .flatMap((packageName): Alias[] => {
      const packageDir = path.join(projection.nodeModulesDir, ...packageName.split("/"));
      const manifest = JSON.parse(
        fs.readFileSync(path.join(packageDir, "package.json"), "utf8")
      ) as { exports?: string | Record<string, unknown>; main?: string; module?: string };
      const exported = normalizedExports(manifest.exports).map(([subpath, target]): Alias => {
        const specifier = subpath === "." ? packageName : `${packageName}/${subpath.slice(2)}`;
        if (!specifier.includes("*")) {
          return { find: specifier, replacement: path.resolve(packageDir, target) };
        }
        return {
          find: new RegExp(`^${escapeRegex(specifier).replace("\\*", "(.+)")}$`, "u"),
          replacement: path.resolve(packageDir, target).replace("*", "$1"),
        };
      });
      if (exported.length > 0) return exported;
      const entry = manifest.module ?? manifest.main;
      return entry
        ? [
            {
              find: new RegExp(`^${escapeRegex(packageName)}/(.+)$`, "u"),
              replacement: `${packageDir}/$1`,
            },
            { find: packageName, replacement: path.resolve(packageDir, entry) },
          ]
        : [
            {
              find: new RegExp(`^${escapeRegex(packageName)}($|/)`, "u"),
              replacement: `${packageDir}$1`,
            },
          ];
    })
    .sort((left, right) => String(right.find).length - String(left.find).length);
}

function normalizedExports(exports: string | Record<string, unknown> | undefined): Array<[string, string]> {
  if (typeof exports === "string") return [[".", exports]];
  if (!exports) return [];
  return Object.entries(exports).flatMap(([subpath, value]) => {
    const target = exportTarget(value);
    return target && (subpath === "." || subpath.startsWith("./")) ? [[subpath, target]] : [];
  });
}

function exportTarget(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const candidate of value) {
      const target = exportTarget(candidate);
      if (target) return target;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const conditions = value as Record<string, unknown>;
  for (const condition of ["import", "default", "browser", "require", "types"]) {
    const target = exportTarget(conditions[condition]);
    if (target) return target;
  }
  return null;
}
