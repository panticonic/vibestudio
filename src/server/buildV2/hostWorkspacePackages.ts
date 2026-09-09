import fs from "node:fs";
import path from "node:path";

/**
 * Discover host-owned workspace packages from source, independently of pnpm's
 * node_modules links. A source server may be current even when the install was
 * created before a newly added host package; build projection must still use
 * the exact package implementation that participates in the host fingerprint.
 */
export function discoverHostWorkspacePackageManifests(appRoot: string): Map<string, string> {
  const manifests = new Map<string, string>();
  const packagesRoot = path.join(appRoot, "packages");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(packagesRoot, { withFileTypes: true });
  } catch {
    return manifests;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const manifestPath = path.join(packagesRoot, entry.name, "package.json");
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: unknown };
      if (typeof manifest.name === "string" && manifest.name.length > 0) {
        manifests.set(manifest.name, manifestPath);
      }
    } catch {
      // Non-package directories are not host workspace packages.
    }
  }
  return manifests;
}

export function resolveHostWorkspacePackageManifest(
  packageName: string,
  localManifests: ReadonlyMap<string, string>,
  appNodeModules: readonly string[]
): string | null {
  const localManifest = localManifests.get(packageName);
  if (localManifest) return localManifest;
  return (
    appNodeModules
      .map((nodeModulesPath) =>
        path.join(nodeModulesPath, ...packageName.split("/"), "package.json")
      )
      .find((candidate) => fs.existsSync(candidate)) ?? null
  );
}
