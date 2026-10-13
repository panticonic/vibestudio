import fs from "node:fs";
import path from "node:path";

/** Facts captured while preparing a trusted npm installation for compilation. */
export interface PreparedDependencyResolution {
  nodePaths: readonly string[];
  absentOptionalImports: ReadonlyMap<string, ReadonlySet<string>>;
  packageDirectories: ReadonlySet<string>;
}

type PackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
};

/**
 * Capture optional-dependency availability once, before invoking the compiler.
 * Installation ownership/identity belongs to the installer and build root. This
 * is not an admission check: linked packages and the selected host installation
 * are ordinary trusted inputs. Only the requested dependency closure is visited.
 */
export function prepareDependencyResolution(
  nodePaths: readonly string[],
  packageNames: readonly string[]
): PreparedDependencyResolution {
  const absentOptionalImports = new Map<string, ReadonlySet<string>>();
  const manifests = new Map<string, PackageManifest>();
  const packagesByLocation = new Map<string, string>();
  const missingLocations = new Set<string>();
  const installationRoots = nodePaths.map((root) => fs.realpathSync.native(root));
  const resolvedPackages = new Map<string, string>();
  const resolvePackage = (name: string, from?: string): string | undefined => {
    const key = `${from ?? ""}\0${name}`;
    const captured = resolvedPackages.get(key);
    if (captured) return captured;
    const localPaths: string[] = [];
    if (from) {
      let directory = from;
      for (;;) {
        if (path.basename(directory) !== "node_modules") {
          const local = path.join(directory, "node_modules");
          // Availability belongs to this installation, not to a node_modules
          // somebody placed above it. Linked packages retain their own local
          // installation; their enclosing host installation is explicit below.
          if (
            directory === from ||
            installationRoots.some((root) => {
              const relative = path.relative(root, local);
              return (
                relative === "" ||
                (relative !== ".." &&
                  !relative.startsWith(`..${path.sep}`) &&
                  !path.isAbsolute(relative))
              );
            })
          )
            localPaths.push(local);
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    for (const root of [...localPaths, ...nodePaths]) {
      const candidate = path.join(root, ...name.split("/"));
      const known = packagesByLocation.get(candidate);
      if (known) {
        resolvedPackages.set(key, known);
        return known;
      }
      if (missingLocations.has(candidate)) continue;
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(candidate, "package.json"), "utf8")
        ) as PackageManifest;
        const physical = fs.realpathSync.native(candidate);
        if (!manifests.has(physical)) manifests.set(physical, manifest);
        packagesByLocation.set(candidate, physical);
        resolvedPackages.set(key, physical);
        return physical;
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          missingLocations.add(candidate);
          continue;
        }
        throw error;
      }
    }
    return undefined;
  };
  const pending = packageNames.flatMap((name) => {
    const resolved = resolvePackage(name);
    return resolved ? [resolved] : [];
  });
  const visited = new Set<string>();
  for (let index = 0; index < pending.length; index++) {
    const directory = pending[index]!;
    if (visited.has(directory)) continue;
    visited.add(directory);
    const manifest = manifests.get(directory)!;
    const optional = new Set([
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.entries(manifest.peerDependenciesMeta ?? {})
        .filter(([name, metadata]) => metadata.optional && manifest.peerDependencies?.[name])
        .map(([name]) => name),
    ]);
    const absent = new Set<string>();
    const dependencies = new Set([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.optionalDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const name of dependencies) {
      const dependency = resolvePackage(name, directory);
      if (dependency) pending.push(dependency);
      else if (optional.has(name)) absent.add(name);
    }
    absentOptionalImports.set(directory, absent);
  }
  return { nodePaths: [...nodePaths], absentOptionalImports, packageDirectories: visited };
}
