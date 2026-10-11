import * as fs from "node:fs";
import * as path from "node:path";
import { isBuiltin } from "node:module";
import * as esbuild from "esbuild";

type Location = { physicalPath: string; resolveDir?: string };
const RESOLVE_CONTEXT = Symbol("prepared-dependency-resolve-context");
type ResolveContext = { [RESOLVE_CONTEXT]: "request" | "skip"; pluginData: unknown };

const OWNED_FILE_NAMESPACE = "vibestudio-prepared-file";
const OWNED_NAMESPACE_PREFIX = "vibestudio-prepared-plugin:";

function canonical(value: string): string {
  try {
    return fs.realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(canonical(root), canonical(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function packageName(specifier: string): string {
  if (specifier.startsWith("@")) return specifier.split("/", 2).join("/");
  return specifier.split("/", 1)[0] ?? "";
}

function isBare(specifier: string): boolean {
  return !specifier.startsWith(".") && !path.isAbsolute(specifier) && !specifier.startsWith("#");
}

function matchesExternal(specifier: string, externals: readonly string[]): boolean {
  return externals.some((item) =>
    item.endsWith("/*") ? specifier.startsWith(item.slice(0, -1)) : specifier === item
  );
}

function mapNamespace(namespace: string | undefined): string {
  if (!namespace || namespace === "file") return OWNED_FILE_NAMESPACE;
  return `${OWNED_NAMESPACE_PREFIX}${namespace}`;
}

function originalNamespace(namespace: string): string | undefined {
  if (namespace === OWNED_FILE_NAMESPACE) return "file";
  if (namespace.startsWith(OWNED_NAMESPACE_PREFIX))
    return namespace.slice(OWNED_NAMESPACE_PREFIX.length);
  return undefined;
}

function isOwnedNamespace(namespace: string): boolean {
  return namespace === OWNED_FILE_NAMESPACE || namespace.startsWith(OWNED_NAMESPACE_PREFIX);
}

function resolveContext(value: unknown): ResolveContext | undefined {
  if (!value || typeof value !== "object") return undefined;
  const context = value as Partial<ResolveContext>;
  return context[RESOLVE_CONTEXT] === "request" || context[RESOLVE_CONTEXT] === "skip"
    ? (context as ResolveContext)
    : undefined;
}

function withResolveContext(
  pluginData: unknown,
  kind: ResolveContext[typeof RESOLVE_CONTEXT]
): ResolveContext {
  return { [RESOLVE_CONTEXT]: kind, pluginData };
}

function visiblePluginData(pluginData: unknown): unknown {
  const context = resolveContext(pluginData);
  return context ? context.pluginData : pluginData;
}

/**
 * Compose esbuild plugins so modules resolved from prepared roots stay in an
 * isolated namespace. That lets esbuild itself distinguish guarded missing
 * imports from required ones without falling back to ambient filesystem paths.
 */
export function composePreparedDependencyPlugins(
  plugins: readonly esbuild.Plugin[],
  nodePaths: readonly string[],
  ownedRoots: readonly string[],
  externals: readonly string[] = []
): esbuild.Plugin[] {
  const roots = [...nodePaths, ...ownedRoots].filter(Boolean).map((root) => path.resolve(root));
  const workspaceRoots = ownedRoots
    .filter((root) => !nodePaths.includes(root))
    .map((root) => path.resolve(root));
  const packageRoots = new Set<string>();
  const dependencySearchRoots = new Set<string>();
  const locations = new Map<string, Location>();
  const namespaceKey = (namespace: string, file: string) => `${namespace}\0${file}`;

  const locationFor = (namespace: string, file: string, resolveDir?: string): Location => {
    const stored = locations.get(namespaceKey(namespace, file));
    if (stored) return stored;
    const physicalPath = path.isAbsolute(file)
      ? file
      : path.resolve(resolveDir ?? process.cwd(), file);
    return { physicalPath, resolveDir: resolveDir ?? path.dirname(physicalPath) };
  };

  const allowedPath = (candidate: string): boolean =>
    roots.some((root) => within(root, candidate)) ||
    [...packageRoots].some((root) => within(root, candidate));

  const packageSearchRoots = (resolveDir: string | undefined): string[] => {
    const result = [...roots, ...dependencySearchRoots];
    if (!resolveDir) return result;
    let directory = path.resolve(resolveDir);
    while (
      roots.some((root) => within(root, directory)) ||
      [...packageRoots].some((root) => within(root, directory))
    ) {
      if (fs.existsSync(path.join(directory, "package.json"))) {
        result.push(path.join(directory, "node_modules"));
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return [...new Set(result)];
  };

  const registerPackage = (specifier: string, resolveDir: string | undefined): void => {
    if (!isBare(specifier)) return;
    const name = packageName(specifier);
    for (const searchRoot of packageSearchRoots(resolveDir)) {
      const candidate = path.join(searchRoot, ...name.split("/"));
      if (!fs.existsSync(path.join(candidate, "package.json"))) continue;
      const physicalRoot = canonical(candidate);
      packageRoots.add(physicalRoot);
      dependencySearchRoots.add(path.dirname(candidate));
      dependencySearchRoots.add(path.dirname(physicalRoot));
      return;
    }
  };

  const workspaceDependencyDeclared = (resolveDir: string | undefined, name: string): boolean => {
    if (!resolveDir) return false;
    let directory = path.resolve(resolveDir);
    while (
      workspaceRoots.some((root) => within(root, directory)) ||
      [...packageRoots].some((root) => within(root, directory))
    ) {
      const manifestPath = path.join(directory, "package.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
        };
        const declaration = manifest.dependencies?.[name] ?? manifest.peerDependencies?.[name];
        return Boolean(declaration?.startsWith("workspace:"));
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return false;
  };

  const isOptionalPeer = (resolveDir: string | undefined, name: string): boolean => {
    if (!resolveDir || !name) return false;
    let directory = path.resolve(resolveDir);
    while (
      roots.some((root) => within(root, directory)) ||
      [...packageRoots].some((root) => within(root, directory))
    ) {
      const manifestPath = path.join(directory, "package.json");
      if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          optionalDependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
          peerDependenciesMeta?: Record<string, { optional?: boolean }>;
        };
        return Boolean(
          manifest.optionalDependencies?.[name] ||
          (manifest.peerDependencies?.[name] && manifest.peerDependenciesMeta?.[name]?.optional)
        );
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return false;
  };

  const wrapPlugin = (plugin: esbuild.Plugin, index: number): esbuild.Plugin => ({
    name: `prepared-${plugin.name}-${index}`,
    setup(build) {
      const realResolve = build.resolve.bind(build);
      const proxy = new Proxy(build, {
        get(target, property, receiver) {
          if (property === "resolve") {
            return (specifier: string, options: esbuild.ResolveOptions) => {
              return realResolve(specifier, {
                ...options,
                pluginData: withResolveContext(options.pluginData, "request"),
              });
            };
          }
          if (property === "onResolve") {
            return (
              options: esbuild.OnResolveOptions,
              callback: (
                args: esbuild.OnResolveArgs
              ) =>
                | esbuild.OnResolveResult
                | null
                | undefined
                | Promise<esbuild.OnResolveResult | null | undefined>
            ) => {
              const original = options.namespace ?? "file";
              const namespaces =
                original === "file" ? ["file", OWNED_FILE_NAMESPACE] : [mapNamespace(original)];
              for (const namespace of namespaces) {
                build.onResolve({ ...options, namespace }, async (args) => {
                  const marked = resolveContext(args.pluginData);
                  const owned =
                    isOwnedNamespace(args.namespace) || marked?.[RESOLVE_CONTEXT] === "request";
                  const originalNs = owned ? originalNamespace(args.namespace) : args.namespace;
                  const loc = locationFor(
                    args.namespace,
                    args.importer || args.path,
                    args.resolveDir
                  );
                  const adapted = {
                    ...args,
                    namespace: originalNs ?? args.namespace,
                    resolveDir: owned
                      ? (loc.resolveDir ?? path.dirname(loc.physicalPath))
                      : args.resolveDir,
                    importer: owned && args.importer ? loc.physicalPath : args.importer,
                    pluginData: visiblePluginData(args.pluginData),
                  };
                  const result = await callback(adapted);
                  if (!result || result.external || typeof result.path !== "string") return result;
                  const resultPath = result.path;
                  const resultNamespace = result.namespace ?? "file";
                  const nextNamespace = mapNamespace(resultNamespace);
                  const physicalPath = path.isAbsolute(resultPath)
                    ? resultPath
                    : path.resolve(adapted.resolveDir ?? process.cwd(), resultPath);
                  registerPackage(adapted.path, adapted.resolveDir);
                  if (resultNamespace === "file" && path.isAbsolute(physicalPath)) {
                    if (!allowedPath(physicalPath)) {
                      return {
                        errors: [
                          {
                            text: `Plugin ${plugin.name} resolved outside the prepared build roots: ${physicalPath}`,
                          },
                        ],
                      };
                    }
                  }
                  const resolveDir = adapted.resolveDir ?? path.dirname(physicalPath);
                  locations.set(namespaceKey(nextNamespace, resultPath), {
                    physicalPath,
                    resolveDir,
                  });
                  return { ...result, namespace: nextNamespace };
                });
              }
            };
          }
          if (property === "onLoad") {
            return (
              options: esbuild.OnLoadOptions,
              callback: (
                args: esbuild.OnLoadArgs
              ) =>
                | esbuild.OnLoadResult
                | null
                | undefined
                | Promise<esbuild.OnLoadResult | null | undefined>
            ) => {
              const original = options.namespace ?? "file";
              const namespaces =
                original === "file" ? ["file", OWNED_FILE_NAMESPACE] : [mapNamespace(original)];
              for (const namespace of namespaces) {
                build.onLoad({ ...options, namespace }, async (args) => {
                  const owned = isOwnedNamespace(args.namespace);
                  const loc = locationFor(args.namespace, args.path);
                  const adapted = {
                    ...args,
                    namespace: owned
                      ? (originalNamespace(args.namespace) ?? args.namespace)
                      : args.namespace,
                    path: owned ? loc.physicalPath : args.path,
                    pluginData: visiblePluginData(args.pluginData),
                  };
                  const result = await callback(adapted);
                  if (!result || !owned || !result.resolveDir) return result;
                  locations.set(namespaceKey(args.namespace, args.path), {
                    ...loc,
                    resolveDir: result.resolveDir,
                  });
                  const { resolveDir: _resolveDir, ...preserved } = result;
                  return preserved;
                });
              }
            };
          }
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      plugin.setup(proxy);
    },
  });

  const isolatedPlugins = plugins.map(wrapPlugin);
  const resolver: esbuild.Plugin = {
    name: "prepared-dependency-authority",
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        const marked = resolveContext(args.pluginData);
        if (marked?.[RESOLVE_CONTEXT] === "skip") return null;
        const pluginRequest = marked?.[RESOLVE_CONTEXT] === "request";
        const sourcePath = args.kind === "entry-point" ? args.path : args.importer;
        const knownResolveDir =
          isOwnedNamespace(args.namespace) && sourcePath
            ? locationFor(args.namespace, sourcePath, args.resolveDir).resolveDir
            : args.resolveDir;
        const owned =
          isOwnedNamespace(args.namespace) ||
          marked?.[RESOLVE_CONTEXT] === "request" ||
          Boolean(knownResolveDir && roots.some((root) => within(root, knownResolveDir))) ||
          Boolean(sourcePath && roots.some((root) => within(root, sourcePath)));
        const importerLocation =
          owned && sourcePath
            ? locationFor(args.namespace, sourcePath, knownResolveDir)
            : undefined;
        const resolveDir = importerLocation?.resolveDir ?? args.resolveDir;
        const specifier = args.path;
        if (path.isAbsolute(specifier) && !owned) return null;
        if (!isBare(specifier) && !owned) return null;
        if (build.initialOptions.platform === "node" && isBuiltin(specifier))
          return { path: specifier, external: true };
        if (matchesExternal(specifier, externals)) return { path: specifier, external: true };

        const name = isBare(specifier) ? packageName(specifier) : "";
        if (owned && name) {
          const workspaceTarget = packageSearchRoots(resolveDir)
            .map((root) => path.join(root, ...name.split("/")))
            .find((candidate) => {
              if (!fs.existsSync(path.join(candidate, "package.json"))) return false;
              const physical = canonical(candidate);
              const linkedOutsidePreparedRoots =
                physical !== path.resolve(candidate) &&
                !roots.some((root) => within(root, physical)) &&
                ![...packageRoots].some((root) => within(root, physical));
              return (
                workspaceRoots.some((root) => within(root, physical)) || linkedOutsidePreparedRoots
              );
            });
          if (workspaceTarget && !workspaceDependencyDeclared(resolveDir, name)) return null;
        }
        registerPackage(specifier, resolveDir);
        const declaredRoot = packageSearchRoots(resolveDir).find(
          (root) => name && fs.existsSync(path.join(root, ...name.split("/"), "package.json"))
        );
        const entryPath =
          args.kind === "entry-point"
            ? path.isAbsolute(specifier)
              ? specifier
              : path.resolve(args.resolveDir || process.cwd(), specifier)
            : undefined;
        const allowedResolveDir = owned ? resolveDir : declaredRoot;
        if (args.kind !== "entry-point" && !allowedResolveDir) {
          return {
            errors: [
              {
                text: `Dependency ${name || specifier} is not present in the prepared build environment.`,
              },
            ],
          };
        }

        if (args.kind === "entry-point") {
          if (!entryPath || !allowedPath(entryPath)) return null;
          locations.set(namespaceKey(OWNED_FILE_NAMESPACE, entryPath), {
            physicalPath: entryPath,
            resolveDir: path.dirname(entryPath),
          });
          return { path: entryPath, namespace: OWNED_FILE_NAMESPACE };
        }

        const resolved = await build.resolve(specifier, {
          kind: args.kind,
          resolveDir: allowedResolveDir,
          pluginData: withResolveContext(args.pluginData, "skip"),
        });
        if (resolved.errors.length > 0) {
          if (owned && isOptionalPeer(resolveDir, name)) return { path: specifier, external: true };
          if (pluginRequest) return resolved;
          return owned ? null : resolved;
        }
        if (resolved.external || resolved.namespace !== "file") return resolved;
        registerPackage(specifier, allowedResolveDir);
        const pathIsOwned = allowedPath(resolved.path);
        if (!pathIsOwned) {
          if (owned && isOptionalPeer(resolveDir, name)) return { path: specifier, external: true };
          if (pluginRequest) {
            return {
              errors: [
                {
                  text: `Dependency ${specifier} escaped the prepared build environment to ${resolved.path}.`,
                },
              ],
            };
          }
          if (owned) return null;
          return {
            errors: [
              {
                text: `Dependency ${specifier} escaped the prepared build environment to ${resolved.path}.`,
              },
            ],
          };
        }
        const namespace = OWNED_FILE_NAMESPACE;
        locations.set(namespaceKey(namespace, resolved.path), {
          physicalPath: resolved.path,
          resolveDir: path.dirname(resolved.path),
        });
        return { ...resolved, namespace, pluginData: visiblePluginData(resolved.pluginData) };
      });
      build.onLoad({ filter: /.*/, namespace: OWNED_FILE_NAMESPACE }, async (args) => {
        const loc = locationFor(args.namespace, args.path);
        try {
          const contents = await fs.promises.readFile(loc.physicalPath);
          return { contents, loader: "default" };
        } catch (error) {
          return {
            errors: [
              { text: `Unable to load prepared module ${loc.physicalPath}: ${String(error)}` },
            ],
          };
        }
      });
    },
  };
  return [...isolatedPlugins, resolver];
}
