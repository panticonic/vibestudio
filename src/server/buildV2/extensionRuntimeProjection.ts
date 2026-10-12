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
  if (!expectedKey || runtimeDependencyProjectionKey(nodeModulesDir) !== expectedKey) return false;
  // The receipt is written only after every admitted file copy joins. Resolve
  // each declared package from inside this tree to reject host-ancestor fallbacks.
  const runtimeRequire = createRequire(
    path.join(nodeModulesDir, ".vibestudio-resolver", "resolve.cjs")
  );
  try {
    for (const dep of deps) {
      const packageEntry = path.join(nodeModulesDir, ...dep.split("/"));
      const packageRoot = fs.realpathSync(packageEntry);
      const resolvedPath = fs.realpathSync(runtimeRequire.resolve(dep));
      const relative = path.relative(packageRoot, resolvedPath);
      if (!fs.statSync(packageRoot).isDirectory()) return false;
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        return false;
    }
    return true;
  } catch {
    return false;
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
