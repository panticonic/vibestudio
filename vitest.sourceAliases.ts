import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Alias } from "vite";
import type { GraphNode } from "./src/server/buildV2/packageGraph";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Host source mappings belong to the host developer toolchain. */
export function hostSourceAliases(hostRoot: string): Alias[] {
  hostRoot = path.resolve(hostRoot);
  const hostTsconfig = JSON.parse(
    readFileSync(path.resolve(hostRoot, "tsconfig.json"), "utf8")
  ) as { compilerOptions?: { paths?: Record<string, string[]> } };
  const tsconfigPaths = hostTsconfig.compilerOptions?.paths ?? {};
  // Source-only SDK packages publish executable source exports. Resolve those
  // from this host even when the importer is in an external template checkout.
  // Their manifest is authoritative; new subpaths need no duplicate path entry.
  const sdkUnits = readdirSync(path.join(hostRoot, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const packageRoot = path.join(hostRoot, "packages", entry.name);
      let manifest: { name?: string; vibestudio?: { buildProfile?: string } };
      try {
        manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      return manifest.name && manifest.vibestudio?.buildProfile === "source-only"
        ? [{ name: manifest.name, path: packageRoot }]
        : [];
    });
  const aliases: Alias[] = discoveredUserlandSourceAliases(sdkUnits);

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
        replacement: path.resolve(hostRoot, sourcePath).replace("*", "$1"),
      });
    } else {
      aliases.push({
        find: new RegExp(`^${escapeRegex(importPath)}$`),
        replacement: path.resolve(hostRoot, sourcePath),
      });
    }
  }

  return aliases;
}

/** Exact aliases contributed by the semantic package graph and its export maps. */
export function discoveredUserlandSourceAliases(
  units: readonly Pick<GraphNode, "name" | "path">[]
): Alias[] {
  return discoveredUserlandSourceMappings(units).map(({ find, replacement }) => ({
    find: new RegExp(`^${escapeRegex(find).replace("\\*", "(.+)")}$`),
    replacement: replacement.replace("*", "$1"),
  }));
}

export function discoveredUserlandSourceMappings(
  units: readonly Pick<GraphNode, "name" | "path">[]
): Array<{ find: string; replacement: string }> {
  return units
    .flatMap((unit): Array<{ find: string; replacement: string }> => {
      const manifest = JSON.parse(readFileSync(path.join(unit.path, "package.json"), "utf8")) as {
        exports?: string | Record<string, unknown>;
        main?: string;
        vibestudio?: { entry?: string };
      };
      const exports = normalizedExports(manifest.exports);
      const entry = manifest.vibestudio?.entry ?? manifest.main;
      if (entry && !exports.some(([subpath]) => subpath === ".")) exports.push([".", entry]);
      return exports
        .filter(([, target]) => !/\.d\.[cm]?ts$/.test(target))
        .map(([subpath, target]) => ({
          find: subpath === "." ? unit.name : `${unit.name}/${subpath.slice(2)}`,
          replacement: path.resolve(unit.path, target),
        }));
    })
    .sort(
      (left, right) =>
        Number(left.find.includes("*")) - Number(right.find.includes("*")) ||
        right.find.length - left.find.length
    );
}

function normalizedExports(
  exports: string | Record<string, unknown> | undefined
): Array<[string, string]> {
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
