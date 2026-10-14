import fs from "node:fs";
import path from "node:path";

/** Facts captured while preparing a trusted npm installation for compilation. */
export interface PreparedDependencyResolution {
  nodePaths: readonly string[];
  absentOptionalImports: ReadonlyMap<string, ReadonlySet<string>>;
  packageDirectories: ReadonlySet<string>;
  /** Every observed logical or physical package location mapped to one physical identity. */
  packageDirectoryIdentities: ReadonlyMap<string, string>;
  /** The exact installation search directory selected for each importer dependency edge. */
  dependencyResolveDirectories: ReadonlyMap<string, ReadonlyMap<string, string>>;
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
  const normalizedNodePaths = nodePaths.map((root) => path.resolve(root));
  const absentOptionalImports = new Map<string, ReadonlySet<string>>();
  const manifests = new Map<string, PackageManifest>();
  const packagesByLocation = new Map<string, string>();
  const locationsByPackage = new Map<string, Set<string>>();
  const dependencyResolveDirectories = new Map<string, Map<string, string>>();
  const missingLocations = new Set<string>();
  const installationRoots = normalizedNodePaths.map((root) => fs.realpathSync.native(root));
  const resolvedPackages = new Map<string, string>();
  const locationKey = (directory: string): string => {
    const normalized = path.resolve(directory);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  };
  const filesystemPrefixAliases: Array<readonly [string, string]> = [];
  for (const root of normalizedNodePaths) {
    let ancestor = root;
    for (;;) {
      try {
        const physicalAncestor = fs.realpathSync.native(ancestor);
        filesystemPrefixAliases.push([ancestor, physicalAncestor]);
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
          throw error;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
  }
  const expandLocationAliases = (directory: string): Set<string> => {
    const aliases = new Set<string>([path.resolve(directory)]);
    const aliasKeys = new Set<string>([locationKey(path.resolve(directory))]);
    const pending = [...aliases];
    for (let index = 0; index < pending.length; index++) {
      const location = pending[index]!;
      for (const [logical, physical] of filesystemPrefixAliases) {
        for (const [fromPrefix, toPrefix] of [
          [logical, physical],
          [physical, logical],
        ] as const) {
          const relative = path.relative(fromPrefix, location);
          if (
            relative !== "" &&
            (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
          )
            continue;
          const alias = path.resolve(toPrefix, relative);
          const key = locationKey(alias);
          if (aliasKeys.has(key)) continue;
          aliases.add(alias);
          aliasKeys.add(key);
          pending.push(alias);
        }
      }
    }
    return aliases;
  };
  const recordLocation = (physical: string, candidate: string, from?: string): void => {
    const locations = locationsByPackage.get(physical) ?? new Set<string>();
    for (const location of expandLocationAliases(physical)) locations.add(location);
    for (const location of expandLocationAliases(candidate)) locations.add(location);
    if (from) {
      const relative = path.relative(from, candidate);
      for (const alias of locationsByPackage.get(from) ?? []) {
        for (const location of expandLocationAliases(path.resolve(alias, relative)))
          locations.add(location);
      }
    }
    locationsByPackage.set(physical, locations);
    for (const location of locations) packagesByLocation.set(locationKey(location), physical);
  };
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
    for (const root of [...localPaths, ...normalizedNodePaths]) {
      const candidate = path.join(root, ...name.split("/"));
      const candidateKey = locationKey(candidate);
      const known = packagesByLocation.get(candidateKey);
      if (known) {
        if (from) {
          const dependencies = dependencyResolveDirectories.get(from) ?? new Map<string, string>();
          dependencies.set(name, path.dirname(root));
          dependencyResolveDirectories.set(from, dependencies);
        }
        resolvedPackages.set(key, known);
        return known;
      }
      if (missingLocations.has(candidateKey)) continue;
      try {
        const manifest = JSON.parse(
          fs.readFileSync(path.join(candidate, "package.json"), "utf8")
        ) as PackageManifest;
        const physical = fs.realpathSync.native(candidate);
        if (!manifests.has(physical)) manifests.set(physical, manifest);
        recordLocation(physical, candidate, from);
        if (from) {
          const dependencies = dependencyResolveDirectories.get(from) ?? new Map<string, string>();
          dependencies.set(name, path.dirname(root));
          dependencyResolveDirectories.set(from, dependencies);
        }
        resolvedPackages.set(key, physical);
        return physical;
      } catch (error) {
        if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
          missingLocations.add(candidateKey);
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
  const packageDirectoryIdentities = new Map<string, string>();
  for (const physical of visited) {
    for (const location of locationsByPackage.get(physical) ?? [physical]) {
      packageDirectoryIdentities.set(locationKey(location), physical);
    }
  }
  return {
    nodePaths: normalizedNodePaths,
    absentOptionalImports,
    packageDirectories: visited,
    packageDirectoryIdentities,
    dependencyResolveDirectories,
  };
}

/** Resolve an observed path spelling without consulting the filesystem during compilation. */
export function preparedDependencyDirectoryIdentity(
  prepared: PreparedDependencyResolution,
  directory: string
): string | undefined {
  const normalized = path.resolve(directory);
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  return prepared.packageDirectoryIdentities.get(key);
}
