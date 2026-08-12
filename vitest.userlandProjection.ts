import * as fs from "node:fs";
import * as path from "node:path";
import type { Alias } from "vite";
import { prepareUserlandDependencyProjection } from "./scripts/lib/userland-dependency-projection";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Resolve userland-declared npm packages from the same content-addressed
 * dependency projection used by checkout typechecking. Source aliases remain
 * separate because workspace packages come from semantic source, not npm.
 */
export async function userlandDependencyAliases(appRoot: string): Promise<Alias[]> {
  const projection = await prepareUserlandDependencyProjection({
    appRoot,
    includeDevelopmentDependencies: true,
  });
  if (!projection.nodeModulesDir) return [];

  return Object.keys(projection.dependencies)
    .filter(
      (packageName) =>
        !fs.existsSync(
          path.join(appRoot, "node_modules", ...packageName.split("/"), "package.json")
        )
    )
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((packageName): Alias => {
      const packageDir = path.join(projection.nodeModulesDir, ...packageName.split("/"));
      return {
        find: new RegExp(`^${escapeRegex(packageName)}($|/)`, "u"),
        replacement: `${packageDir}$1`,
      };
    });
}
