import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";

export const EXTENSION_RUNTIME_PROJECTION_RECEIPT = ".vibestudio-runtime-projection.json";

export function runtimeDependencyProjectionKey(nodeModulesDir: string): string | null {
  try {
    const receipt = JSON.parse(
      fs.readFileSync(path.join(nodeModulesDir, EXTENSION_RUNTIME_PROJECTION_RECEIPT), "utf8")
    ) as { version?: unknown; runtimeDepsKey?: unknown };
    return receipt.version === 1 && typeof receipt.runtimeDepsKey === "string"
      ? receipt.runtimeDepsKey
      : null;
  } catch {
    return null;
  }
}

export function runtimeDependencyProjectionComplete(
  nodeModulesDir: string,
  deps: readonly string[],
  expectedKey: string | null
): boolean {
  try {
    assertRuntimeDependencyProjectionComplete(nodeModulesDir, deps, expectedKey);
    return true;
  } catch {
    return false;
  }
}

export function assertRuntimeDependencyProjectionComplete(
  nodeModulesDir: string,
  deps: readonly string[],
  expectedKey: string | null
): void {
  if (path.basename(nodeModulesDir) !== "node_modules")
    throw new Error(
      `Runtime dependency projection must be a node_modules directory: ${nodeModulesDir}`
    );
  const actualKey = runtimeDependencyProjectionKey(nodeModulesDir);
  if (!expectedKey || actualKey !== expectedKey)
    throw new Error(
      `Runtime dependency projection receipt mismatch: expected ${expectedKey ?? "none"}, found ${actualKey ?? "none"}`
    );
  // Resolve from the parent, where Node actually searches this node_modules
  // directory. Never accept a package found only in an ancestor tree.
  const runtimeRequire = createRequire(
    path.join(path.dirname(nodeModulesDir), ".vibestudio-resolver", "resolve.cjs")
  );
  for (const dep of deps) {
    try {
      const packageEntry = path.join(nodeModulesDir, ...dep.split("/"));
      const packageRoot = fs.realpathSync(packageEntry);
      if (!fs.statSync(packageRoot).isDirectory())
        throw new Error(`Package entry is not a directory: ${packageEntry}`);
      const resolvedPath = fs.realpathSync(runtimeRequire.resolve(dep));
      const relative = path.relative(packageRoot, resolvedPath);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error(`Package entry resolves outside its projected root: ${resolvedPath}`);
    } catch (error) {
      throw new Error(
        `Runtime dependency ${dep} is not resolvable from ${nodeModulesDir}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }
}

export function extensionRuntimeDepsProjected(
  bundlePath: string,
  deps: string[],
  expectedKey: string | null
): boolean {
  if (deps.length === 0) return true;
  return runtimeDependencyProjectionComplete(
    path.join(path.dirname(bundlePath), "node_modules"),
    deps,
    expectedKey
  );
}
