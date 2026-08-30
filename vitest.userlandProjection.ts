import * as fs from "node:fs";
import * as path from "node:path";
import type { Alias, ResolverFunction } from "vite";
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

  return (
    Object.keys(projection.dependencies)
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
            return {
              find: specifier,
              replacement: path.resolve(packageDir, target),
              customResolver: preserveNestedDependencyResolution(
                projection.nodeModulesDir,
                () => specifier
              ),
            };
          }
          const replacement = path.resolve(packageDir, target).replace("*", "$1");
          return {
            find: new RegExp(`^${escapeRegex(specifier).replace("\\*", "(.+)")}$`, "u"),
            replacement,
            customResolver: preserveNestedDependencyResolution(
              projection.nodeModulesDir,
              (updatedId) => specifier.replace("*", captureAliasWildcard(updatedId, replacement))
            ),
          };
        });
        if (exported.length > 0) return exported;
        const entry = manifest.module ?? manifest.main;
        return entry
          ? [
              {
                find: new RegExp(`^${escapeRegex(packageName)}/(.+)$`, "u"),
                replacement: `${packageDir}/$1`,
                customResolver: preserveNestedDependencyResolution(
                  projection.nodeModulesDir,
                  (updatedId) =>
                    `${packageName}/${path.relative(packageDir, updatedId).split(path.sep).join("/")}`
                ),
              },
              {
                find: packageName,
                replacement: path.resolve(packageDir, entry),
                customResolver: preserveNestedDependencyResolution(
                  projection.nodeModulesDir,
                  () => packageName
                ),
              },
            ]
          : [
              {
                find: new RegExp(`^${escapeRegex(packageName)}($|/)`, "u"),
                replacement: `${packageDir}$1`,
                customResolver: preserveNestedDependencyResolution(
                  projection.nodeModulesDir,
                  (updatedId) => {
                    const relative = path.relative(packageDir, updatedId).split(path.sep).join("/");
                    return relative === "" ? packageName : `${packageName}/${relative}`;
                  }
                ),
              },
            ];
      })
      .sort((left, right) => String(right.find).length - String(left.find).length)
  );
}

function preserveNestedDependencyResolution(
  projectedNodeModules: string,
  originalSpecifier: (updatedId: string) => string
): ResolverFunction {
  const projectedPrefix = `${path.resolve(projectedNodeModules)}${path.sep}`;
  return async function (updatedId, importer, options) {
    const importerPath = importer ? path.resolve(importer.split("?", 1)[0] ?? importer) : null;
    if (!importerPath || !importerPath.startsWith(projectedPrefix)) {
      return updatedId;
    }
    const specifier = originalSpecifier(updatedId);
    const packageName = packageNameFromSpecifier(specifier);
    const projectedPackage = path.join(projectedNodeModules, ...packageName.split("/"));
    const nearestPackage = nearestDependencyPackage(
      importerPath,
      projectedNodeModules,
      packageName
    );
    if (!nearestPackage || path.resolve(nearestPackage) === path.resolve(projectedPackage)) {
      return updatedId;
    }
    return this.resolve(specifier, importer, { ...options, skipSelf: true });
  };
}

function packageNameFromSpecifier(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
}

function nearestDependencyPackage(
  importer: string,
  projectedNodeModules: string,
  packageName: string
): string | null {
  const projectionRoot = path.dirname(projectedNodeModules);
  let directory = path.dirname(importer);
  while (directory.startsWith(projectionRoot)) {
    const candidate = path.join(directory, "node_modules", ...packageName.split("/"));
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (directory === projectionRoot) break;
    directory = path.dirname(directory);
  }
  return null;
}

function captureAliasWildcard(updatedId: string, replacement: string): string {
  const [prefix, suffix = ""] = replacement.split("$1");
  if (!updatedId.startsWith(prefix) || !updatedId.endsWith(suffix)) {
    throw new Error(`Cannot recover projected dependency subpath from ${updatedId}`);
  }
  return updatedId.slice(prefix.length, suffix.length === 0 ? undefined : -suffix.length);
}

function normalizedExports(
  exports: string | Record<string, unknown> | undefined
): Array<[string, string]> {
  if (typeof exports === "string") return [[".", exports]];
  if (!exports) return [];
  // A package may expose its root as a condition map rather than as an
  // explicit `"."` entry (`{ development, default }`, for example). Treat
  // that shape as the root export. Falling through to a directory alias lets
  // Vite turn the replacement into an `/@fs/.../package` URL before package
  // export resolution, which is not a valid filesystem module identity.
  if (Object.keys(exports).every((key) => !key.startsWith("."))) {
    const target = exportTarget(exports);
    return target ? [[".", target]] : [];
  }
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
