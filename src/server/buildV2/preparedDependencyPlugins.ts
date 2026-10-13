import * as fs from "node:fs";
import * as path from "node:path";
import { isBuiltin } from "node:module";
import * as esbuild from "esbuild";

type Location = { physicalPath: string; resolveDir?: string };
const RESOLVE_CONTEXT = Symbol("prepared-dependency-resolve-context");
type ResolveContext = { [RESOLVE_CONTEXT]: "request" | "skip"; pluginData: unknown };

const OWNED_FILE_NAMESPACE = "vibestudio-prepared-file";
const OWNED_NAMESPACE_PREFIX = "vibestudio-prepared-plugin:";

function withinCanonical(root: string, candidate: string): boolean {
  if (process.platform === "win32") {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  }
  // Both operands are absolute canonical paths. A separator-aware prefix is
  // the POSIX ancestry relation; resolving and splitting both paths for each
  // root in the package census adds no information to the ownership check.
  return (
    candidate === root ||
    candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`)
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
  // Plugin callbacks can return the resolution they obtained through
  // build.resolve(). Preserve our already-owned namespace instead of nesting a
  // second wrapper namespace that has no corresponding onLoad registration.
  if (isOwnedNamespace(namespace)) return namespace;
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
  // Prepared source/dependency inputs are immutable for one compilation.
  // Admission checks revisit the same roots and importer directories for
  // every import; resolve each existing path once in this compile rather
  // than walking all of its filesystem ancestors on every ownership check.
  const canonicalPaths = new Map<string, string>();
  const canonical = (value: string): string => {
    const captured = canonicalPaths.get(value);
    if (captured !== undefined) return captured;
    const absolute = path.resolve(value);
    const known = canonicalPaths.get(absolute);
    if (known !== undefined) return known;
    try {
      const resolved = fs.realpathSync.native(absolute);
      canonicalPaths.set(absolute, resolved);
      canonicalPaths.set(value, resolved);
      canonicalPaths.set(resolved, resolved);
      return resolved;
    } catch {
      // Outputs may be generated later in the same build. Do not memoize a
      // missing path as though it were already a sealed filesystem input.
      return absolute;
    }
  };
  const within = (root: string, candidate: string): boolean => {
    return withinCanonical(canonical(root), canonical(candidate));
  };
  const rootIdentities = [
    ...nodePaths.map((root, index) =>
      root
        ? {
            root: canonical(path.resolve(root)),
            lexicalRoot: path.resolve(root),
            identity: `dependency-${index}`,
          }
        : null
    ),
    ...ownedRoots.map((root, index) =>
      root
        ? {
            root: canonical(path.resolve(root)),
            lexicalRoot: path.resolve(root),
            identity: index === 0 ? "source" : index === 1 ? "output" : `owned-${index - 2}`,
          }
        : null
    ),
  ].filter((root): root is NonNullable<typeof root> => root !== null);
  const roots = rootIdentities.map(({ root }) => root);
  const workspaceRoots = ownedRoots
    .filter((root) => !nodePaths.includes(root))
    .map((root) => path.resolve(root));
  const packageRoots = new Set<string>();
  const packageRootIdentities = new Map<string, string>();
  const dependencySearchRoots = new Set<string>();
  const locations = new Map<string, Location>();
  const metadataPaths = new Map<string, string>();
  const namespaceKey = (namespace: string, file: string) => `${namespace}\0${file}`;

  const virtualInputPath = (physicalPath: string): string => {
    const canonicalPath = canonical(physicalPath);
    const ownedPackageRoots = [...packageRootIdentities].map(([root, identity]) => ({
      root,
      identity,
    }));
    const matches = [...rootIdentities, ...ownedPackageRoots]
      .filter(({ root }) => withinCanonical(root, canonicalPath))
      .sort((left, right) => right.root.length - left.root.length);
    const match = matches[0];
    if (!match) throw new Error(`Prepared input has no stable owned root: ${physicalPath}`);
    const relative = path.relative(match.root, canonicalPath).replaceAll("\\", "/");
    return relative ? `${match.identity}/${relative}` : match.identity;
  };

  const rememberLocation = (namespace: string, file: string, location: Location): void => {
    locations.set(namespaceKey(namespace, file), location);
    if (!isOwnedNamespace(namespace)) return;
    const original = originalNamespace(namespace);
    const canonicalPath =
      original === "file" ? location.physicalPath : `${original ?? namespace}:${file}`;
    const identity = `${namespace}:${file}`;
    metadataPaths.set(identity, canonicalPath);
    metadataPaths.set(identity.replaceAll("\\", "/"), canonicalPath);
  };

  const canonicalMetadataPath = (value: string): string =>
    metadataPaths.get(value) ?? metadataPaths.get(value.replaceAll("\\", "/")) ?? value;

  const normalizeMetafile = (metafile: esbuild.Metafile): void => {
    const normalizedInputs: esbuild.Metafile["inputs"] = {};
    for (const [inputPath, input] of Object.entries(metafile.inputs)) {
      const normalizedPath = canonicalMetadataPath(inputPath);
      const imports = input.imports.map((item) => ({
        ...item,
        path: canonicalMetadataPath(item.path),
      }));
      const existing = normalizedInputs[normalizedPath];
      normalizedInputs[normalizedPath] = existing
        ? {
            ...existing,
            bytes: Math.max(existing.bytes, input.bytes),
            imports: [
              ...existing.imports,
              ...imports.filter(
                (item) =>
                  !existing.imports.some(
                    (previous) =>
                      previous.path === item.path &&
                      previous.kind === item.kind &&
                      previous.external === item.external &&
                      previous.original === item.original &&
                      JSON.stringify(previous.with) === JSON.stringify(item.with)
                  )
              ),
            ],
          }
        : { ...input, imports };
    }
    metafile.inputs = normalizedInputs;

    const normalizedOutputs: esbuild.Metafile["outputs"] = {};
    for (const [outputPath, output] of Object.entries(metafile.outputs)) {
      const normalizedModuleInputs: esbuild.Metafile["outputs"][string]["inputs"] = {};
      for (const [inputPath, input] of Object.entries(output.inputs)) {
        const normalizedPath = canonicalMetadataPath(inputPath);
        const existing = normalizedModuleInputs[normalizedPath];
        normalizedModuleInputs[normalizedPath] = existing
          ? { bytesInOutput: existing.bytesInOutput + input.bytesInOutput }
          : input;
      }
      normalizedOutputs[outputPath] = {
        ...output,
        ...(output.entryPoint ? { entryPoint: canonicalMetadataPath(output.entryPoint) } : {}),
        inputs: normalizedModuleInputs,
        imports: output.imports.map((item) => ({
          ...item,
          path: canonicalMetadataPath(item.path),
        })),
      };
    }
    metafile.outputs = normalizedOutputs;
  };

  const normalizeBuildResult = (result: esbuild.BuildResult): void => {
    if (result.metafile) normalizeMetafile(result.metafile);
    const normalizeMessages = (messages: esbuild.Message[]): void => {
      for (const message of messages) {
        const location = message.location;
        if (!location) continue;
        let namespace = location.namespace;
        let file = location.file;
        if (namespace && file.startsWith(`${namespace}:`)) {
          file = file.slice(namespace.length + 1);
        } else if (file.startsWith(`${OWNED_FILE_NAMESPACE}:`)) {
          namespace = OWNED_FILE_NAMESPACE;
          file = file.slice(OWNED_FILE_NAMESPACE.length + 1);
        }
        if (!namespace) continue;
        const ownedLocation = locations.get(namespaceKey(namespace, file));
        if (ownedLocation) Object.assign(location, { file: ownedLocation.physicalPath });
      }
    };
    normalizeMessages(result.errors);
    normalizeMessages(result.warnings);
  };

  const locationFor = (namespace: string, file: string, resolveDir?: string): Location => {
    const normalizedFile = file.startsWith(`${namespace}:`)
      ? file.slice(namespace.length + 1)
      : file;
    const stored = locations.get(namespaceKey(namespace, normalizedFile));
    if (stored) return stored;
    const physicalPath = path.isAbsolute(normalizedFile)
      ? normalizedFile
      : path.resolve(resolveDir ?? process.cwd(), normalizedFile);
    return { physicalPath, resolveDir: resolveDir ?? path.dirname(physicalPath) };
  };

  const allowedPath = (candidate: string): boolean =>
    roots.some((root) => within(root, candidate)) ||
    [...packageRoots].some((root) => within(root, candidate));

  const packageSearchRoots = (resolveDir: string | undefined): string[] => {
    const localRoots: string[] = [];
    if (resolveDir) {
      let directory = path.resolve(resolveDir);
      while (
        roots.some((root) => within(root, directory)) ||
        [...packageRoots].some((root) => within(root, directory))
      ) {
        if (fs.existsSync(path.join(directory, "package.json"))) {
          localRoots.push(path.join(directory, "node_modules"));
        }
        const parent = path.dirname(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return [...new Set([...localRoots, ...roots, ...dependencySearchRoots])];
  };

  const registerPackage = (specifier: string, resolveDir: string | undefined): void => {
    if (!isBare(specifier)) return;
    const name = packageName(specifier);
    for (const searchRoot of packageSearchRoots(resolveDir)) {
      const candidate = path.join(searchRoot, ...name.split("/"));
      if (!fs.existsSync(path.join(candidate, "package.json"))) continue;
      const physicalRoot = canonical(candidate);
      packageRoots.add(physicalRoot);
      if (!packageRootIdentities.has(physicalRoot)) {
        let version = "";
        try {
          const manifest = JSON.parse(
            fs.readFileSync(path.join(physicalRoot, "package.json"), "utf8")
          ) as { version?: unknown };
          if (typeof manifest.version === "string" && manifest.version)
            version = `@${manifest.version}`;
        } catch {
          // The package is admitted by its owned manifest below; absence of a
          // version only changes the stable source label, not admission.
        }
        const baseIdentity = `package/${name}${version}`;
        let owningRoot = rootIdentities
          .filter(({ root }) => within(root, physicalRoot))
          .sort((left, right) => right.root.length - left.root.length)[0];
        let relative = owningRoot ? path.relative(owningRoot.root, physicalRoot) : "";
        if (!owningRoot) {
          const lexicalCandidate = path.resolve(candidate);
          owningRoot = rootIdentities
            .filter(({ lexicalRoot }) => within(lexicalRoot, lexicalCandidate))
            .sort((left, right) => right.lexicalRoot.length - left.lexicalRoot.length)[0];
          if (owningRoot) relative = path.relative(owningRoot.lexicalRoot, lexicalCandidate);
        }
        relative = relative.replaceAll("\\", "/");
        const enclosingPackage = [...packageRootIdentities]
          .filter(([root]) => within(root, searchRoot))
          .sort((left, right) => right[0].length - left[0].length)[0];
        const packageIdentity = owningRoot
          ? `${baseIdentity}/${owningRoot.identity}/${relative}`
          : enclosingPackage
            ? `${enclosingPackage[1]}/${path.relative(enclosingPackage[0], physicalRoot).replaceAll("\\", "/")}`
            : baseIdentity;
        packageRootIdentities.set(physicalRoot, packageIdentity);
      }
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
            return async (specifier: string, options: esbuild.ResolveOptions) => {
              const result = await realResolve(specifier, {
                ...options,
                pluginData: withResolveContext(options.pluginData, "request"),
              });
              if (!isOwnedNamespace(result.namespace)) return result;
              const namespace = result.namespace;
              const virtualPath = result.path.startsWith(`${namespace}:`)
                ? result.path.slice(namespace.length + 1)
                : result.path;
              const location = locations.get(namespaceKey(namespace, virtualPath));
              if (!location) return result;
              return {
                ...result,
                path: location.physicalPath,
                namespace: originalNamespace(namespace) ?? namespace,
                pluginData: visiblePluginData(result.pluginData),
              };
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
              const original = options.namespace;
              const namespaces =
                original === undefined
                  ? [undefined]
                  : original === "file"
                    ? ["file", OWNED_FILE_NAMESPACE]
                    : [mapNamespace(original)];
              for (const namespace of namespaces) {
                const registrationOptions =
                  namespace === undefined ? options : { ...options, namespace };
                build.onResolve(registrationOptions, async (args) => {
                  const marked = resolveContext(args.pluginData);
                  if (marked?.[RESOLVE_CONTEXT] === "skip") return null;
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
                    importer:
                      owned && args.importer && (!originalNs || originalNs === "file")
                        ? loc.physicalPath
                        : args.importer,
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
                  const resolveDir =
                    resultNamespace === "file" || isOwnedNamespace(resultNamespace)
                      ? path.dirname(physicalPath)
                      : (adapted.resolveDir ?? path.dirname(physicalPath));
                  // A file resolved by a plugin must have the same identity as
                  // that file resolved by esbuild's default resolver. Physical
                  // paths and virtual paths in one namespace are distinct
                  // modules, which would duplicate contexts and other singletons.
                  const ownedPath =
                    resultNamespace === "file" ? virtualInputPath(physicalPath) : resultPath;
                  const locationKey = namespaceKey(nextNamespace, ownedPath);
                  if (!locations.has(locationKey)) {
                    rememberLocation(nextNamespace, ownedPath, { physicalPath, resolveDir });
                  }
                  return { ...result, path: ownedPath, namespace: nextNamespace };
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
              const original = options.namespace;
              const namespaces =
                original === undefined
                  ? [undefined]
                  : original === "file"
                    ? ["file", OWNED_FILE_NAMESPACE]
                    : [mapNamespace(original)];
              for (const namespace of namespaces) {
                const registrationOptions =
                  namespace === undefined ? options : { ...options, namespace };
                build.onLoad(registrationOptions, async (args) => {
                  const owned = isOwnedNamespace(args.namespace);
                  const loc = locationFor(args.namespace, args.path);
                  const originalNs = owned ? originalNamespace(args.namespace) : args.namespace;
                  const adapted = {
                    ...args,
                    namespace: originalNs ?? args.namespace,
                    path:
                      owned && (!originalNs || originalNs === "file")
                        ? loc.physicalPath
                        : args.path,
                    pluginData: visiblePluginData(args.pluginData),
                  };
                  const result = await callback(adapted);
                  if (!result || !owned) return result;
                  if (result.resolveDir) {
                    locations.set(namespaceKey(args.namespace, args.path), {
                      ...loc,
                      resolveDir: result.resolveDir,
                    });
                  }
                  const { resolveDir: _resolveDir, ...preserved } = result;
                  return preserved;
                });
              }
            };
          }
          if (property === "onEnd") {
            return (
              callback: (
                result: esbuild.BuildResult
              ) => esbuild.OnEndResult | null | void | Promise<esbuild.OnEndResult | null | void>
            ) => {
              build.onEnd(async (result) => {
                normalizeBuildResult(result);
                return callback(result);
              });
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
      build.onStart(() => {
        canonicalPaths.clear();
      });
      const resolveRequest = async (
        args: esbuild.OnResolveArgs
      ): Promise<esbuild.OnResolveResult | null | undefined> => {
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
          const declaredWorkspaceDependency = workspaceDependencyDeclared(resolveDir, name);
          if (workspaceTarget && !declaredWorkspaceDependency) return null;
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
        const resolutionDir =
          declaredRoot && nodePaths.some((root) => canonical(root) === canonical(declaredRoot))
            ? path.dirname(declaredRoot)
            : allowedResolveDir;
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
          const virtualPath = virtualInputPath(entryPath);
          rememberLocation(OWNED_FILE_NAMESPACE, virtualPath, {
            physicalPath: entryPath,
            resolveDir: path.dirname(entryPath),
          });
          return { path: virtualPath, namespace: OWNED_FILE_NAMESPACE };
        }

        const resolved = await build.resolve(specifier, {
          kind: args.kind,
          resolveDir: name ? resolutionDir : allowedResolveDir,
          pluginData: withResolveContext(args.pluginData, "skip"),
        });
        if (resolved.errors.length > 0) {
          if (owned && isOptionalPeer(resolveDir, name)) return { path: specifier, external: true };
          return declaredRoot || pluginRequest || !owned ? resolved : null;
        }
        if (resolved.external || resolved.namespace !== "file") return resolved;
        registerPackage(specifier, allowedResolveDir);
        const pathIsOwned = allowedPath(resolved.path);
        if (!pathIsOwned) {
          if (owned && isOptionalPeer(resolveDir, name)) return { path: specifier, external: true };
          if (!declaredRoot && owned && !pluginRequest) return null;
          return {
            errors: [
              {
                text: `Dependency ${specifier} escaped the prepared build environment to ${resolved.path}.`,
              },
            ],
          };
        }
        const namespace = OWNED_FILE_NAMESPACE;
        const virtualPath = virtualInputPath(resolved.path);
        rememberLocation(namespace, virtualPath, {
          physicalPath: resolved.path,
          resolveDir: path.dirname(resolved.path),
        });
        return {
          ...resolved,
          path: virtualPath,
          namespace,
          pluginData: visiblePluginData(resolved.pluginData),
        };
      };
      build.onResolve({ filter: /.*/ }, resolveRequest);
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
      build.onEnd(normalizeBuildResult);
    },
  };
  return [...isolatedPlugins, resolver];
}
