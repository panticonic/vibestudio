import { readFileSync } from "node:fs";
import path from "node:path";
import type { Alias } from "vite";
import type { GraphNode } from "./src/server/buildV2/packageGraph";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Resolve one explicit host/Base pair's TypeScript package paths. */
export function workspaceSourceAliases(hostRoot: string, workspaceRoot: string): Alias[] {
  hostRoot = path.resolve(hostRoot);
  workspaceRoot = path.resolve(workspaceRoot);
  const workspaceTsconfig = JSON.parse(
    readFileSync(path.resolve(workspaceRoot, "tsconfig.json"), "utf8")
  ) as { compilerOptions?: { paths?: Record<string, string[]> } };
  const tsconfigPaths = workspaceTsconfig.compilerOptions?.paths ?? {};
  const aliases: Alias[] = [];

  // Subpath mappings must precede their less-specific bare-package mapping.
  for (const [importPath, sourcePaths] of Object.entries(tsconfigPaths).sort(
    (a, b) => b[0].length - a[0].length
  )) {
    const sourcePath = sourcePaths[0];
    // TypeScript paths may intentionally point at a package's curated public
    // declarations. Those mappings constrain type checking; they are not
    // executable module aliases. Passing one to Vite makes esbuild parse the
    // declaration file as runtime source instead of selecting the package's
    // implementation through a broader source alias or its exports map.
    if (!sourcePath || /\.d\.[cm]?ts$/.test(sourcePath)) continue;

    if (importPath.includes("*") && sourcePath.includes("*")) {
      aliases.push({
        find: new RegExp(`^${escapeRegex(importPath).replace("\\*", "(.+)")}$`),
        replacement: resolvePairPath(hostRoot, workspaceRoot, sourcePath).replace("*", "$1"),
      });
    } else {
      aliases.push({
        find: importPath,
        replacement: resolvePairPath(hostRoot, workspaceRoot, sourcePath),
      });
    }
  }

  return aliases;
}

/** Exact aliases contributed by the semantic package graph and its export maps. */
export function discoveredUserlandSourceAliases(units: readonly GraphNode[]): Alias[] {
  return units
    .flatMap((unit): Alias[] => {
      const manifest = JSON.parse(readFileSync(path.join(unit.path, "package.json"), "utf8")) as {
        exports?: string | Record<string, unknown>;
      };
      return normalizedExports(manifest.exports).map(([subpath, target]) => ({
        find: subpath === "." ? unit.name : `${unit.name}/${subpath.slice(2)}`,
        replacement: path.resolve(unit.path, target),
      }));
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
  for (const condition of ["browser", "import", "default", "types"]) {
    const target = exportTarget(conditions[condition]);
    if (target) return target;
  }
  return null;
}

function resolvePairPath(hostRoot: string, workspaceRoot: string, sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/");
  if (normalized.startsWith("../packages/")) {
    return path.resolve(hostRoot, normalized.slice(3));
  }
  return path.resolve(workspaceRoot, sourcePath);
}
