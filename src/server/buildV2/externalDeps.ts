/**
 * External Dependency Cache — transitive external dep collection + cached installation.
 *
 * For a given panel/agent, walks the package graph and collects ALL external
 * dependencies from the unit itself and every internal package it transitively
 * depends on. The union is hashed and installed into a shared cache.
 *
 * {sharedDerivedData}/external-deps/{hash}/
 *   ├── node_modules/
 *   └── .ready   ← sentinel marking completed installation
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { applyPatch, parsePatch } from "diff";
import semver from "semver";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { NpmResolutionError, runNpmInstall } from "@vibestudio/shared/npmInstaller";
import {
  derivedCacheCoordinator,
  derivedCacheUnderPressure,
  scheduleDerivedCachePrune,
  type DerivedCacheLease,
} from "@vibestudio/shared/derivedCache";
import { optionalPeerNames, type PackageGraph, type GraphNode } from "./packageGraph.js";
import { BuildRequestError } from "./diagnostics.js";
import {
  deduplicateDependencyContent,
  makeDependencyTreeImmutable,
  pruneUnreferencedDependencyContent,
} from "./dependencyContentStore.js";
import { scheduleDependencyContentMaintenance } from "./dependencyContentMaintenance.js";

// ---------------------------------------------------------------------------
// Transitive collection
// ---------------------------------------------------------------------------

/**
 * The external half of a unit's source closure, split by who owns the version.
 *
 * `dependencies` are the unit's own: installed and bundled into it.
 * `providedPeers` are peers nobody in the closure declared as a dependency, so
 * the context that composes the unit provides them. They are installed (a
 * typecheck needs their declarations) but never bundled — a library resolves
 * them from the loading realm's module map, which is what keeps a guest from
 * carrying a second React into a panel that already has one.
 */
export interface ExternalDependencyClosure {
  dependencies: Record<string, string>;
  providedPeers: Record<string, string>;
  /**
   * Provided peers every declaring member marked optional. Installed and
   * externalized like any other provided peer, but a runtime root is not
   * required to own them.
   */
  optionalProvidedPeers: string[];
  /** Which closure members declared each provided peer, for actionable errors. */
  peerOwners: Record<string, string[]>;
  /**
   * Peers a closure member owns at a version its declared range does not
   * admit. Reported rather than thrown so unit *listing* stays total; the
   * build refuses on them.
   */
  peerConflicts: string[];
  /** Everything the closure resolves: `dependencies` ∪ `providedPeers`. */
  installSet: Record<string, string>;
}

/**
 * Collect all external (non-workspace) dependencies transitively
 * from a unit and all its internal dependencies.
 */
export function collectExternalDependencyClosure(
  unit: GraphNode,
  graph: PackageGraph,
  workspaceRoot?: string,
  packageRoots: string[] = []
): ExternalDependencyClosure {
  const dependencies: Record<string, string> = {};
  const peers: Record<string, string> = {};
  const peerOwners = new Map<string, Set<string>>();
  const requiredPeers = new Set<string>();
  const optionalPeers = new Set<string>();
  // Every declaration, not the merged spec: merging keeps the highest range, so
  // a lower floor declared elsewhere would be masked by a stricter sibling and
  // its disagreement with the resolved version would never surface.
  const peerDeclarations: Array<{ name: string; range: string; owner: string }> = [];
  const visited = new Set<string>();
  const visitedPackageJson = new Set<string>();

  function recordExternal(target: Record<string, string>, name: string, version: string): void {
    // Skip workspace:* deps — these are source packages resolved from the app
    // install or the package graph. Their own npm deps are collected by walking
    // the package.json when available.
    if (version.startsWith("workspace:")) return;
    if (target === peers) {
      const current = target[name];
      if (!current) {
        target[name] = version;
        return;
      }
      try {
        mergeExternalDependencySpecs(target, { [name]: version });
      } catch {
        // Keep closure discovery total so the owner-aware peer validation below
        // can name every declaring package. Dependencies fail immediately, but
        // incompatible peers need their declaration provenance in the refusal.
        target[name] = [current, version].sort().at(-1) ?? current;
      }
      return;
    }
    mergeExternalDependencySpecs(target, { [name]: version });
  }

  function walkDeps(
    declarations: Record<string, string>,
    target: Record<string, string>,
    options: { walkWorkspaceDeps: boolean; owner?: string; optional?: readonly string[] }
  ) {
    for (const [name, version] of Object.entries(declarations)) {
      if (target === peers) {
        if (options.owner) {
          const owners = peerOwners.get(name) ?? new Set<string>();
          owners.add(options.owner);
          peerOwners.set(name, owners);
        }
        // Optional only where every declaring member said so: one member that
        // genuinely needs the instance makes it required for the whole closure.
        (options.optional?.includes(name) ? optionalPeers : requiredPeers).add(name);
        if (!version.startsWith("workspace:") && !graph.isInternal(name)) {
          peerDeclarations.push({ name, range: version, owner: options.owner ?? name });
        }
      }
      if (graph.isInternal(name)) {
        const dep = graph.tryGet(name);
        if (dep) walkNode(dep);
        continue;
      }
      if (version.startsWith("workspace:") && options.walkWorkspaceDeps) {
        const pkg = workspaceRoot
          ? readWorkspacePackageJson(workspaceRoot, name, packageRoots)
          : null;
        if (pkg) {
          // Attribute by package name, not by the path it was found at: the
          // reader of a refusal edits a manifest, and a host checkout path
          // names a file they do not have.
          walkPackageJson(
            pkg.path,
            name,
            pkg.dependencies,
            pkg.peerDependencies,
            pkg.optionalPeerDependencies
          );
        }
        continue;
      }
      recordExternal(target, name, version);
    }
  }

  function walkPackageJson(
    packageJsonPath: string,
    packageName: string,
    packageDependencies: Record<string, string>,
    packagePeers: Record<string, string>,
    packageOptionalPeers: readonly string[]
  ) {
    if (visitedPackageJson.has(packageJsonPath)) return;
    visitedPackageJson.add(packageJsonPath);
    walkDeps(packageDependencies, dependencies, { walkWorkspaceDeps: false });
    walkDeps(packagePeers, peers, {
      walkWorkspaceDeps: false,
      owner: packageName,
      optional: packageOptionalPeers,
    });
  }

  function walkNode(node: GraphNode) {
    if (visited.has(node.name)) return;
    visited.add(node.name);
    walkDeps(node.dependencies, dependencies, { walkWorkspaceDeps: true });
    walkDeps(node.peerDependencies, peers, {
      walkWorkspaceDeps: true,
      owner: node.name,
      optional: node.optionalPeerDependencies,
    });
    for (const dependency of node.internalDeps) {
      const child = graph.tryGet(dependency);
      if (child) walkNode(child);
    }
  }

  walkNode(unit);

  // A peer someone in the closure also owns as a dependency is satisfied here;
  // only what remains has to come from outside. "Satisfied" is a real question,
  // not just a name match: an owner whose version the peer's range excludes is
  // the same defect as no owner at all, and stays silent otherwise.
  const providedPeers: Record<string, string> = {};
  for (const [name, range] of Object.entries(peers)) {
    if (dependencies[name] === undefined) providedPeers[name] = range;
  }

  // Whatever the closure will resolve for a peer -- an owner's version, or the
  // merged spec the composing realm is asked for -- has to satisfy every
  // member that declared it. A name match alone is not satisfaction.
  const peerConflicts: string[] = [];
  for (const { name, range, owner } of peerDeclarations) {
    const resolved = dependencies[name] ?? providedPeers[name];
    if (resolved === undefined) continue;
    if (semver.subset(resolved, range, { includePrerelease: true })) continue;
    peerConflicts.push(
      `${name} resolves to ${resolved}, which ${owner} does not accept (it requires ${range})`
    );
  }

  const installSet = { ...dependencies };
  mergeExternalDependencySpecs(installSet, providedPeers);
  return {
    dependencies,
    providedPeers,
    optionalProvidedPeers: Object.keys(providedPeers)
      .filter((name) => optionalPeers.has(name) && !requiredPeers.has(name))
      .sort(),
    peerOwners: Object.fromEntries(
      Object.keys(providedPeers).map((name) => [name, [...(peerOwners.get(name) ?? [])].sort()])
    ),
    peerConflicts: peerConflicts.sort(),
    installSet,
  };
}

export function collectTransitiveDependencyOverrides(
  unit: GraphNode,
  graph: PackageGraph,
  workspaceRoot?: string,
  packageRoots: string[] = []
): Record<string, string> {
  const overrides: Record<string, string> = {};
  const owners = new Map<string, string>();
  const visited = new Set<string>();
  const visitedPackageJson = new Set<string>();

  function record(source: Record<string, string>, owner: string) {
    for (const [selector, version] of Object.entries(source)) {
      const existingVersion = overrides[selector];
      const existingOwner = owners.get(selector);
      if (existingVersion && existingVersion !== version && existingOwner) {
        throw new Error(
          `Dependency override ${selector} conflicts between ${existingOwner} (${existingVersion}) ` +
            `and ${owner} (${version})`
        );
      }
      overrides[selector] = version;
      owners.set(selector, owner);
    }
  }

  function walkDeps(dependencies: Record<string, string>, options: { walkWorkspaceDeps: boolean }) {
    for (const [name, version] of Object.entries(dependencies)) {
      if (graph.isInternal(name)) {
        const dep = graph.tryGet(name);
        if (dep) walkNode(dep);
        continue;
      }
      if (version.startsWith("workspace:") && options.walkWorkspaceDeps) {
        const pkg = workspaceRoot
          ? readWorkspacePackageJson(workspaceRoot, name, packageRoots)
          : null;
        if (pkg) {
          walkPackageJson(
            pkg.path,
            { ...pkg.peerDependencies, ...pkg.dependencies },
            pkg.dependencyOverrides
          );
        }
      }
    }
  }

  function walkPackageJson(
    packageJsonPath: string,
    dependencies: Record<string, string>,
    dependencyOverrides: Record<string, string>
  ) {
    if (visitedPackageJson.has(packageJsonPath)) return;
    visitedPackageJson.add(packageJsonPath);
    record(dependencyOverrides, packageJsonPath);
    walkDeps(dependencies, { walkWorkspaceDeps: false });
  }

  function walkNode(node: GraphNode) {
    if (visited.has(node.name)) return;
    visited.add(node.name);
    record(node.dependencyOverrides, node.name);
    // Override discovery is about which manifests the closure reaches, so both
    // declaration kinds are traversed here; the peer/dependency split only
    // decides how an *external* package is treated, not which owners are read.
    walkDeps({ ...node.peerDependencies, ...node.dependencies }, { walkWorkspaceDeps: true });
    for (const dependency of node.internalDeps) {
      const child = graph.tryGet(dependency);
      if (child) walkNode(child);
    }
  }

  walkNode(unit);
  return overrides;
}

export interface ExternalDependencyPatch {
  selector: string;
  packageName: string;
  version: string;
  owner: string;
  roots: string[];
  content: string;
  digest: string;
}

/**
 * Collect owner-declared dependency patches from the same immutable source
 * projection that will be compiled. Patches are build inputs, not ambient host
 * package-manager state.
 */
export async function collectTransitiveDependencyPatches(
  unit: GraphNode,
  graph: PackageGraph,
  sourceRoot: string
): Promise<ExternalDependencyPatch[]> {
  const patches = new Map<string, ExternalDependencyPatch>();
  const visited = new Set<string>();
  const closure: GraphNode[] = [];

  async function walkNode(node: GraphNode): Promise<void> {
    if (visited.has(node.name)) return;
    visited.add(node.name);
    closure.push(node);

    const ownerRoot = path.resolve(sourceRoot, ...node.relativePath.split("/"));
    for (const [selector, declaration] of Object.entries(
      dependencyPatchDeclarations(node, graph)
    )) {
      const { packageName, version } = parsePatchedDependencySelector(selector);
      const relativePatchPath = declaration.path;
      const patchPath = path.resolve(ownerRoot, relativePatchPath);
      if (!patchPath.startsWith(`${ownerRoot}${path.sep}`)) {
        throw new Error(
          `Dependency patch ${JSON.stringify(relativePatchPath)} escapes owner ${node.name}`
        );
      }
      const patchStat = await fs.promises.stat(patchPath).catch(() => null);
      if (!patchStat?.isFile()) {
        throw new Error(`Dependency patch for ${selector} does not exist: ${relativePatchPath}`);
      }
      const [realOwnerRoot, realPatchPath] = await Promise.all([
        fs.promises.realpath(ownerRoot),
        fs.promises.realpath(patchPath),
      ]);
      if (!realPatchPath.startsWith(`${realOwnerRoot}${path.sep}`)) {
        throw new Error(
          `Dependency patch ${JSON.stringify(relativePatchPath)} escapes owner ${node.name}`
        );
      }
      const content = await fs.promises.readFile(realPatchPath, "utf8");
      const patch: ExternalDependencyPatch = {
        selector,
        packageName,
        version,
        owner: node.name,
        roots: declaration.roots,
        content,
        digest: sha256(content),
      };
      const existing = patches.get(selector);
      if (existing && existing.owner !== node.name) {
        throw new Error(
          `Dependency patch ${selector} has multiple owners: ${existing.owner} and ${node.name}`
        );
      }
      patches.set(selector, patch);
    }

    for (const dependency of node.internalDeps) {
      const child = graph.tryGet(dependency);
      if (child) await walkNode(child);
    }
  }

  await walkNode(unit);
  for (const patch of patches.values()) {
    for (const consumer of closure) {
      if (consumer.name === patch.owner) continue;
      if (Object.prototype.hasOwnProperty.call(consumer.dependencies, patch.packageName)) {
        throw new Error(
          `${consumer.name} directly depends on patched external ${patch.packageName}; ` +
            `depend on its patch owner ${patch.owner} instead`
        );
      }
      if (
        Object.keys(consumer.dependencyOverrides).some(
          (selector) =>
            selector === patch.packageName || selector.startsWith(`${patch.packageName}@`)
        )
      ) {
        throw new Error(
          `${consumer.name} overrides patched external ${patch.packageName}; ` +
            `the dependency policy belongs to ${patch.owner}`
        );
      }
    }
  }
  return [...patches.values()].sort((left, right) => left.selector.localeCompare(right.selector));
}

function dependencyPatchDeclarations(
  node: GraphNode,
  graph: PackageGraph
): Record<string, { path: string; roots: string[] }> {
  const value = node.manifest.dependencyResolution?.patches as unknown;
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${node.name} dependencyResolution.patches must be an object`);
  }
  const declarations: Record<string, { path: string; roots: string[] }> = {};
  for (const [selector, rawDeclaration] of Object.entries(value as Record<string, unknown>)) {
    if (!rawDeclaration || typeof rawDeclaration !== "object" || Array.isArray(rawDeclaration)) {
      throw new Error(`${node.name} dependency patch ${selector} must declare path and roots`);
    }
    const declaration = rawDeclaration as Record<string, unknown>;
    if (Object.keys(declaration).sort().join(",") !== "path,roots") {
      throw new Error(`${node.name} dependency patch ${selector} must contain only path and roots`);
    }
    const patchPath = declaration["path"];
    const roots = declaration["roots"];
    if (typeof patchPath !== "string" || patchPath.length === 0) {
      throw new Error(`${node.name} dependency patch ${selector} must name a relative file path`);
    }
    if (
      !Array.isArray(roots) ||
      roots.length === 0 ||
      roots.some((root) => typeof root !== "string" || root.length === 0) ||
      new Set(roots).size !== roots.length
    ) {
      throw new Error(
        `${node.name} dependency patch ${selector} must name unique dependency roots`
      );
    }
    for (const root of roots as string[]) {
      const specifier = node.dependencies[root];
      if (!specifier || specifier.startsWith("workspace:") || graph.isInternal(root)) {
        throw new Error(
          `${node.name} dependency patch ${selector} root ${root} must be its direct external dependency`
        );
      }
    }
    declarations[selector] = {
      path: patchPath,
      roots: (roots as string[]).slice().sort((left, right) => left.localeCompare(right)),
    };
  }
  return declarations;
}

function parsePatchedDependencySelector(selector: string): {
  packageName: string;
  version: string;
} {
  const separator = selector.lastIndexOf("@");
  if (separator <= 0 || separator === selector.length - 1) {
    throw new Error(
      `Invalid patched dependency selector ${JSON.stringify(selector)}; expected package@exact-version`
    );
  }
  const packageName = selector.slice(0, separator);
  const version = selector.slice(separator + 1);
  if (
    !/^(@[a-z0-9\-~][a-z0-9\-._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*$/u.test(packageName) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error(
      `Invalid patched dependency selector ${JSON.stringify(selector)}; expected package@exact-version`
    );
  }
  return { packageName, version };
}

interface WorkspacePackageDeclarations {
  path: string;
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  optionalPeerDependencies: string[];
  dependencyOverrides: Record<string, string>;
}

function readWorkspacePackageDeclarations(
  pkgJsonPath: string,
  packageName: string
): WorkspacePackageDeclarations | null {
  if (!fs.existsSync(pkgJsonPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
      name?: string;
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
      vibestudio?: { dependencyResolution?: { overrides?: unknown } };
    };
    if (pkg.name !== packageName) return null;
    return {
      path: pkgJsonPath,
      dependencies: { ...pkg.dependencies },
      peerDependencies: { ...pkg.peerDependencies },
      optionalPeerDependencies: optionalPeerNames(pkg),
      dependencyOverrides: normalizeSimpleOverrides(
        pkg.vibestudio?.dependencyResolution?.overrides
      ),
    };
  } catch {
    return null;
  }
}

function readWorkspacePackageJson(
  workspaceRoot: string,
  packageName: string,
  packageRoots: string[] = []
): WorkspacePackageDeclarations | null {
  for (const pkgJsonPath of workspacePackageJsonCandidates(
    workspaceRoot,
    packageName,
    packageRoots
  )) {
    const declarations = readWorkspacePackageDeclarations(pkgJsonPath, packageName);
    if (declarations) return declarations;
  }

  for (const baseDir of workspacePackageRoots(workspaceRoot)) {
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const declarations = readWorkspacePackageDeclarations(
        path.join(baseDir, entry.name, "package.json"),
        packageName
      );
      if (declarations) return declarations;
    }
  }
  return null;
}

function normalizeSimpleOverrides(...values: unknown[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const value of values) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const [name, version] of Object.entries(value as Record<string, unknown>)) {
      if (typeof version === "string") result[name] = version;
    }
  }
  return result;
}

function workspacePackageJsonCandidates(
  workspaceRoot: string,
  packageName: string,
  packageRoots: string[]
): string[] {
  const candidates: string[] = [];
  const addNodeModulesCandidate = (baseDir: string) => {
    candidates.push(path.join(baseDir, ...packageName.split("/"), "package.json"));
  };
  const addWorkspacePackageCandidate = (baseDir: string) => {
    candidates.push(path.join(baseDir, packageName.replace(/^@[^/]+\//, ""), "package.json"));
  };

  for (const baseDir of packageRoots) {
    addNodeModulesCandidate(baseDir);
  }
  for (const baseDir of workspacePackageRoots(workspaceRoot)) {
    addWorkspacePackageCandidate(baseDir);
  }

  return candidates;
}

function workspacePackageRoots(workspaceRoot: string): string[] {
  return [path.join(workspaceRoot, "packages")];
}

/**
 * Merge dependency requirements using the same deterministic conflict rule as
 * build-graph traversal. Checkout tooling uses this when it projects several
 * independently buildable userland units into one validation environment.
 */
export function mergeExternalDependencySpecs(
  target: Record<string, string>,
  source: Readonly<Record<string, string>>
): void {
  for (const [name, version] of Object.entries(source)) {
    const current = target[name];
    if (!current) {
      target[name] = version;
      continue;
    }
    if (current === version) continue;
    const currentRange = semver.validRange(current);
    const incomingRange = semver.validRange(version);
    if (currentRange && incomingRange) {
      if (!semver.intersects(currentRange, incomingRange, { includePrerelease: true })) {
        throw new Error(
          `External dependency ${name} has incompatible requirements ${current} and ${version}`
        );
      }
      if (semver.subset(currentRange, incomingRange, { includePrerelease: true })) continue;
      if (semver.subset(incomingRange, currentRange, { includePrerelease: true })) {
        target[name] = version;
        continue;
      }
      // Preserve the actual intersection. Picking either range would authorize
      // versions one of the declaring units rejected.
      target[name] = [current, version].sort().join(" ");
      continue;
    }
    if (current !== version) {
      throw new Error(
        `External dependency ${name} has incompatible non-semver requirements ${current} and ${version}`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Cached Installation
// ---------------------------------------------------------------------------

function hashDeps(
  deps: Record<string, string>,
  overrides: Record<string, string> = {},
  patches: readonly ExternalDependencyPatch[] = []
): string {
  const entries = Object.entries(deps).sort(([a], [b]) => a.localeCompare(b));
  const overrideEntries = Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b));
  const patchEntries = patches
    .map(
      ({ selector, digest, roots }) =>
        [selector, digest, [...roots].sort((left, right) => left.localeCompare(right))] as const
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify({ deps: entries, overrides: overrideEntries, patches: patchEntries }));
  return hash.digest("hex").slice(0, 16);
}

function validateDependencyPatches(
  patches: readonly ExternalDependencyPatch[]
): ExternalDependencyPatch[] {
  const validated = new Map<string, ExternalDependencyPatch>();
  for (const patch of patches) {
    const identity = parsePatchedDependencySelector(patch.selector);
    if (identity.packageName !== patch.packageName || identity.version !== patch.version) {
      throw new Error(`Dependency patch ${patch.selector} has inconsistent package identity`);
    }
    if (sha256(patch.content) !== patch.digest) {
      throw new Error(`Dependency patch ${patch.selector} does not match its content digest`);
    }
    if (
      !Array.isArray(patch.roots) ||
      patch.roots.length === 0 ||
      patch.roots.some((root) => typeof root !== "string" || root.length === 0) ||
      new Set(patch.roots).size !== patch.roots.length
    ) {
      throw new Error(`Dependency patch ${patch.selector} has invalid dependency roots`);
    }
    if (validated.has(patch.selector)) {
      throw new Error(`Dependency patch ${patch.selector} is declared more than once`);
    }
    validated.set(patch.selector, patch);
  }
  return [...validated.values()].sort((left, right) => left.selector.localeCompare(right.selector));
}

export function dependencyPatchesForExternalRoots(
  patches: readonly ExternalDependencyPatch[],
  dependencies: Readonly<Record<string, string>>
): ExternalDependencyPatch[] {
  return patches.filter((patch) => patch.roots.some((root) => dependencies[root] !== undefined));
}

function assertDependencyPatchRootsPresent(
  patches: readonly ExternalDependencyPatch[],
  dependencies: Readonly<Record<string, string>>
): void {
  for (const patch of patches) {
    if (!patch.roots.some((root) => dependencies[root] !== undefined)) {
      throw new Error(
        `Dependency patch ${patch.selector} has no declared root in this dependency environment`
      );
    }
  }
}

function getExternalDepsBaseDir(): string {
  return path.join(getSharedDerivedDataPath(), "external-deps");
}

function getExtensionRuntimeDepsBaseDir(): string {
  return path.join(getSharedDerivedDataPath(), "extension-runtime-deps");
}

function isFileSystemErrorCode(error: unknown, codes: readonly string[]): boolean {
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && codes.includes(code);
}

function validateNpmSpecMap(kind: string, specs: Record<string, string>): void {
  // Reject any version specifier that npm would interpret as a non-registry
  // source (file:, git+ssh://, https://, github:, npm:, local paths). Panel
  // / worker manifests can pass arbitrary `version` strings here through
  // the package.json transitive-collection path; without this guard, a
  // hostile manifest could `npm install` from any URL or copy any
  // user-readable file path into the build cache. See `buildNpmLibrary`'s
  // `validateNpmVersion` for the authoritative shape allow-list.
  // TODO: route legitimate non-registry installs through a separate,
  // shell-only API rather than relaxing this regex.
  const NPM_DEP_VERSION_RE =
    /^(\^|~|>=|<=|=|>|<)?(?:\d+|\d+\.\d+|\d+\.\d+\.\d+(-[\w.+-]+)?(\+[\w.+-]+)?)$/;
  for (const [name, version] of Object.entries(specs)) {
    if (typeof version !== "string" || version.length === 0 || version.length > 64) {
      throw new Error(`Invalid npm ${kind} version for ${name}: ${version}`);
    }
    if (version === "latest" || version === "*") continue;
    if (version.startsWith("workspace:")) continue;
    if (!NPM_DEP_VERSION_RE.test(version)) {
      throw new Error(
        `Refusing non-registry npm ${kind} specifier for ${name}: "${version}". ` +
          `Only strict semver, "latest", or "*" allowed.`
      );
    }
  }
}

function applyDirectDependencyOverrides(
  deps: Record<string, string>,
  overrides: Record<string, string> = {}
): { dependencies: Record<string, string>; overrides: Record<string, string> } {
  const dependencies = { ...deps };
  const transitiveOverrides: Record<string, string> = {};

  for (const [selector, version] of Object.entries(overrides)) {
    const direct = directDependencyOverrideTarget(selector, dependencies);
    if (direct) {
      // npm rejects an override that targets a direct dependency unless the
      // dependency itself names that exact spec. Apply a matching major-scoped
      // override to the direct dependency and omit it from npm's overrides;
      // the generated install still enforces the same resolved version.
      dependencies[direct] = version;
    } else {
      transitiveOverrides[selector] = version;
    }
  }

  return { dependencies, overrides: transitiveOverrides };
}

/**
 * Returns the direct dependency selected by a simple Build V2 override, if
 * any. Override keys can be either `name` or `name@major`
 * (including scoped names such as `@scope/name@major`).  The latter is what
 * lets a unit pin vulnerable transitive majors independently.
 */
function directDependencyOverrideTarget(
  selector: string,
  dependencies: Record<string, string>
): string | null {
  if (Object.prototype.hasOwnProperty.call(dependencies, selector)) return selector;

  const at = selector.lastIndexOf("@");
  if (at <= 0) return null;
  const name = selector.slice(0, at);
  const requestedMajor = majorFromSimpleVersion(selector.slice(at + 1));
  const directMajor = majorFromSimpleVersion(dependencies[name] ?? "");
  return requestedMajor !== null && requestedMajor === directMajor ? name : null;
}

function majorFromSimpleVersion(spec: string): number | null {
  // `validateNpmSpecMap` admits only this simple semver subset.  Do not treat
  // inequalities as a single-major request: `>=8` may legitimately resolve
  // to 9 and must remain a transitive override instead of being rewritten.
  const match = /^(?:\^|~|=)?(\d+)(?:\.\d+)?(?:\.\d+)?$/u.exec(spec);
  return match ? Number(match[1]) : null;
}

function warnCleanupFailure(pathName: string, error: unknown): void {
  console.warn(
    `[externalDeps] Failed to remove ${pathName}: ${error instanceof Error ? error.message : String(error)}`
  );
}

const EXTERNAL_DEPS_RECEIPT_VERSION = 3;

interface PatchedFileReceipt {
  path: string;
  digest: string | null;
}

interface ExternalDepsReceipt {
  version: typeof EXTERNAL_DEPS_RECEIPT_VERSION;
  lockDigest: string;
  packageCount: number;
  patchedFiles: PatchedFileReceipt[];
}

const validatedCacheReceipts = new Map<string, { mtimeMs: number; size: number }>();

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

interface InstalledPackage {
  version: string;
  peerDependencies: Record<string, string>;
  optionalPeers: Set<string>;
}

/**
 * Resolve a peer the way Node would from the requiring package's location:
 * nearest enclosing `node_modules` first, then outward to the install root.
 */
function resolveInstalledPeer(
  installed: Map<string, InstalledPackage>,
  requiredBy: string,
  peerName: string
): { location: string; installed: InstalledPackage } | null {
  const segments = requiredBy.split("/");
  for (let end = segments.length; end >= 0; end--) {
    const prefix = segments.slice(0, end).join("/");
    const location = prefix
      ? `${prefix.replace(/\/node_modules\/[^/]+$/u, "")}/node_modules/${peerName}`
      : `node_modules/${peerName}`;
    const match = installed.get(location);
    if (match) return { location, installed: match };
  }
  return null;
}

/**
 * Peer ranges declared *between packages the closure actually installed* must
 * hold. npm's own ERESOLVE check is off (see `runNpmInstall`) because it would
 * rather invent an undeclared package than report a gap; this keeps the part of
 * that check that is about the declared set, and stays silent about peers the
 * closure deliberately leaves to the composing realm.
 */
function assertInstalledPeersSatisfied(installed: Map<string, InstalledPackage>): void {
  for (const [location, record] of installed) {
    for (const [peerName, range] of Object.entries(record.peerDependencies)) {
      const resolved = resolveInstalledPeer(installed, location, peerName);
      if (!resolved) continue; // provided by the composing realm, or unused here
      if (record.optionalPeers.has(peerName)) continue;
      if (semver.satisfies(resolved.installed.version, range, { includePrerelease: true })) {
        continue;
      }
      throw new Error(
        `installed dependency ${location}@${record.version} requires ${peerName}@${range}, ` +
          `but the closure installed ${peerName}@${resolved.installed.version}. ` +
          `Declare a ${peerName} version its dependents agree on.`
      );
    }
  }
}

/**
 * Prove that npm produced a coherent immutable tree before publishing it.
 * The hidden lock describes the packages npm actually installed (unlike the
 * root lock, which may include platform-skipped optionals). Every registry
 * package must retain its integrity identity and matching package metadata,
 * and every peer range between installed packages must hold.
 */
async function createExternalDepsReceipt(
  cacheDir: string,
  patchedFiles: PatchedFileReceipt[]
): Promise<ExternalDepsReceipt> {
  const nodeModulesDir = path.join(cacheDir, "node_modules");
  const lockPath = path.join(nodeModulesDir, ".package-lock.json");
  const lockBytes = await fs.promises.readFile(lockPath);
  const lock = JSON.parse(lockBytes.toString("utf8")) as {
    packages?: Record<
      string,
      { version?: unknown; integrity?: unknown; link?: unknown; inBundle?: unknown }
    >;
  };
  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error("installed dependency lock has no package inventory");
  }

  let packageCount = 0;
  const installed = new Map<string, InstalledPackage>();
  for (const [location, record] of Object.entries(lock.packages)) {
    if (!location.startsWith("node_modules/") || record.link === true) continue;
    packageCount += 1;
    if (typeof record.version !== "string" || record.version.length === 0) {
      throw new Error(`installed dependency ${location} has no version identity`);
    }
    if (typeof record.integrity !== "string" && record.inBundle !== true) {
      throw new Error(`installed dependency ${location} has no registry integrity`);
    }

    const packageDir = path.resolve(cacheDir, location);
    if (!packageDir.startsWith(`${path.resolve(cacheDir)}${path.sep}`)) {
      throw new Error(`installed dependency ${location} escapes its cache`);
    }
    const packageJsonPath = path.join(packageDir, "package.json");
    const packageJson = JSON.parse(await fs.promises.readFile(packageJsonPath, "utf8")) as {
      version?: unknown;
      peerDependencies?: Record<string, string>;
      peerDependenciesMeta?: Record<string, { optional?: boolean }>;
    };
    if (packageJson.version !== record.version) {
      throw new Error(`installed dependency ${location} does not match its lock identity`);
    }
    installed.set(location, {
      version: record.version,
      peerDependencies: { ...packageJson.peerDependencies },
      optionalPeers: new Set(
        Object.entries(packageJson.peerDependenciesMeta ?? {})
          .filter(([, meta]) => meta?.optional === true)
          .map(([name]) => name)
      ),
    });
  }
  if (packageCount === 0) throw new Error("installed dependency lock is empty");
  assertInstalledPeersSatisfied(installed);
  return {
    version: EXTERNAL_DEPS_RECEIPT_VERSION,
    lockDigest: sha256(lockBytes),
    packageCount,
    patchedFiles,
  };
}

async function writeExternalDepsReceipt(
  cacheDir: string,
  receipt: ExternalDepsReceipt
): Promise<void> {
  const sentinelPath = path.join(cacheDir, ".ready");
  const temporaryPath = `${sentinelPath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  try {
    await fs.promises.writeFile(temporaryPath, JSON.stringify(receipt));
    await fs.promises.rename(temporaryPath, sentinelPath);
  } finally {
    await fs.promises.rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

async function isReusableExternalDepsCache(cacheDir: string): Promise<boolean> {
  const sentinelPath = path.join(cacheDir, ".ready");
  let sentinelStat: fs.Stats;
  try {
    sentinelStat = await fs.promises.stat(sentinelPath);
  } catch {
    return false;
  }
  const memoized = validatedCacheReceipts.get(cacheDir);
  if (memoized?.mtimeMs === sentinelStat.mtimeMs && memoized.size === sentinelStat.size)
    return true;

  try {
    const raw = await fs.promises.readFile(sentinelPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ExternalDepsReceipt>;
    if (
      parsed.version !== EXTERNAL_DEPS_RECEIPT_VERSION ||
      typeof parsed.lockDigest !== "string" ||
      typeof parsed.packageCount !== "number" ||
      parsed.packageCount <= 0 ||
      !Array.isArray(parsed.patchedFiles)
    ) {
      throw new Error("External dependency cache has no current receipt");
    }
    const receipt = parsed as ExternalDepsReceipt;

    const lockBytes = await fs.promises.readFile(
      path.join(cacheDir, "node_modules", ".package-lock.json")
    );
    if (sha256(lockBytes) !== receipt.lockDigest) return false;
    for (const patchedFile of receipt.patchedFiles) {
      if (
        !patchedFile ||
        typeof patchedFile.path !== "string" ||
        (typeof patchedFile.digest !== "string" && patchedFile.digest !== null)
      ) {
        return false;
      }
      const target = path.resolve(cacheDir, ...patchedFile.path.split("/"));
      if (!target.startsWith(`${path.resolve(cacheDir)}${path.sep}`)) return false;
      if (patchedFile.digest === null) {
        try {
          await fs.promises.access(target);
          return false;
        } catch {
          // Expected absence.
        }
      } else {
        const contents = await fs.promises.readFile(target).catch(() => null);
        if (!contents || sha256(contents) !== patchedFile.digest) return false;
      }
    }
    validatedCacheReceipts.set(cacheDir, {
      mtimeMs: sentinelStat.mtimeMs,
      size: sentinelStat.size,
    });
    return true;
  } catch (error) {
    console.warn(
      `[externalDeps] Rejecting incomplete cache ${cacheDir}: ${error instanceof Error ? error.message : String(error)}`
    );
    return false;
  }
}

export interface ExternalDependencyBorrow {
  key: string | null;
  nodeModulesDir: string;
  release(): void;
}

async function acquireDependencyCache(
  deps: Record<string, string>,
  options: EnsureDepsOptions
): Promise<ExternalDependencyBorrow> {
  if (Object.keys(deps).length === 0) {
    return { key: null, nodeModulesDir: "", release() {} };
  }
  const lease = derivedCacheCoordinator(options.baseDir).acquire(options.baseDir, options.key);
  try {
    if (derivedCacheUnderPressure(options.baseDir)) {
      await derivedCacheCoordinator(options.baseDir).prune(options.baseDir);
    }
    const nodeModulesDir = await ensureDepsInstalled(deps, options);
    return borrowedDependencyEnvironment(options.baseDir, options.key, nodeModulesDir, lease);
  } catch (error) {
    lease.release();
    throw error;
  }
}

function borrowedDependencyEnvironment(
  baseDir: string,
  key: string,
  nodeModulesDir: string,
  lease: DerivedCacheLease
): ExternalDependencyBorrow {
  let released = false;
  return {
    key,
    nodeModulesDir,
    release() {
      if (released) return;
      released = true;
      lease.release();
      void scheduleDerivedCachePrune(baseDir)
        .then((pruned) => (pruned ? pruneUnreferencedDependencyContent() : undefined))
        .catch((error) => {
          console.warn(
            `[externalDeps] Cache prune failed: ${error instanceof Error ? error.message : String(error)}`
          );
        });
    },
  };
}

export async function acquireExternalDeps(
  deps: Record<string, string>,
  dependencyOverrides: Record<string, string> = {},
  options: { appRoot: string; patches?: readonly ExternalDependencyPatch[] }
): Promise<ExternalDependencyBorrow> {
  const overrides = { ...dependencyOverrides };
  const patches = validateDependencyPatches(options.patches ?? []);
  assertDependencyPatchRootsPresent(patches, deps);
  return acquireDependencyCache(deps, {
    baseDir: getExternalDepsBaseDir(),
    key: hashDeps(deps, overrides, patches),
    ignoreScripts: true,
    appRoot: options.appRoot,
    overrides,
    patches,
    contentDeduplication: "background",
  });
}

export interface ExternalDependencyEnvironment {
  nodeModulesDir: string;
  nodePaths: string[];
  externalDeps: Record<string, string>;
  /**
   * Closure externals nobody in the unit's own closure owns. Installed above
   * (a typecheck needs their declarations) but never bundled: the realm that
   * composes the unit supplies the live instance.
   */
  providedPeers: Record<string, string>;
  /** Provided peers no closure member requires an instance of. */
  optionalProvidedPeers: string[];
  /** Which closure members declared each provided peer. */
  peerOwners: Record<string, string[]>;
  /** Peers owned at a version their declared range does not admit. */
  peerConflicts: string[];
  dependencyOverrides: Record<string, string>;
  dependencyPatches: ExternalDependencyPatch[];
  release(): void;
}

/**
 * Use dependencies already shipped with the host whenever the complete named
 * closure satisfies the workspace's declared ranges. Exact versions therefore
 * remain exact while ordinary semver ranges can reuse a compatible installed
 * graph. A source patch still requires isolation because it changes bytes.
 */
export function resolveHostDependencyProjection(
  dependencies: Readonly<Record<string, string>>,
  dependencyOverrides: Readonly<Record<string, string>>,
  patches: readonly ExternalDependencyPatch[],
  hostNodeModules: readonly string[]
): { nodeModulesDir: string; nodePaths: string[] } | null {
  if (
    Object.keys(dependencies).length === 0 ||
    Object.keys(dependencyOverrides).length > 0 ||
    patches.length > 0 ||
    hostNodeModules.length === 0
  ) {
    return null;
  }
  // Reuse is one complete dependency realm, never a synthetic union of roots.
  // Combining independently installed trees lets transitive resolution choose
  // a different package according to importer location and traversal order.
  for (const root of hostNodeModules) {
    let complete = true;
    for (const [name, requested] of Object.entries(dependencies)) {
      const manifestPath = path.join(root, ...name.split("/"), "package.json");
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
          name?: unknown;
          version?: unknown;
        };
        if (
          manifest.name === name &&
          typeof manifest.version === "string" &&
          semver.satisfies(manifest.version, requested, { includePrerelease: true })
        ) {
          continue;
        }
      } catch {
        // This root is incomplete; try the next complete installation.
      }
      complete = false;
      break;
    }
    if (complete) return { nodeModulesDir: root, nodePaths: [root] };
  }
  return null;
}

/**
 * Provision the one dependency environment shared by bundling and typechecking.
 * Keeping this closure canonical prevents the compiler from reporting modules
 * that the bundler can resolve, or falling through to an ambient checkout.
 */
export async function prepareExternalDependencyEnvironment(
  unit: GraphNode,
  graph: PackageGraph,
  workspaceRoot: string,
  sourceRoot: string,
  appRoot: string,
  appNodeModules: string[] = []
): Promise<ExternalDependencyEnvironment> {
  const closure = collectExternalDependencyClosure(unit, graph, workspaceRoot, appNodeModules);
  const externalDeps = closure.installSet;
  const dependencyOverrides = collectTransitiveDependencyOverrides(
    unit,
    graph,
    workspaceRoot,
    appNodeModules
  );
  const dependencyPatches = await collectTransitiveDependencyPatches(unit, graph, sourceRoot);
  const hostProjection = resolveHostDependencyProjection(
    externalDeps,
    dependencyOverrides,
    dependencyPatches,
    appNodeModules
  );
  const borrowed = hostProjection
    ? null
    : await acquireExternalDeps(externalDeps, dependencyOverrides, {
        appRoot,
        patches: dependencyPatches,
      });
  if (hostProjection) {
    console.log(
      `[externalDeps] Reusing ${Object.keys(externalDeps).length} fingerprinted host dependencies for ${unit.name}`
    );
  }
  return {
    nodeModulesDir: hostProjection?.nodeModulesDir ?? borrowed?.nodeModulesDir ?? "",
    nodePaths: hostProjection
      ? hostProjection.nodePaths
      : [...(borrowed?.nodeModulesDir ? [borrowed.nodeModulesDir] : []), ...appNodeModules],
    externalDeps,
    providedPeers: closure.providedPeers,
    optionalProvidedPeers: closure.optionalProvidedPeers,
    peerOwners: closure.peerOwners,
    peerConflicts: closure.peerConflicts,
    dependencyOverrides,
    dependencyPatches,
    release: () => borrowed?.release(),
  };
}

export async function ensureExtensionRuntimeDeps(
  appRoot: string,
  deps: Record<string, string>,
  dependencyOverrides: Record<string, string> = {},
  patches: readonly ExternalDependencyPatch[] = []
): Promise<ExternalDependencyBorrow> {
  const validatedPatches = validateDependencyPatches(patches);
  assertDependencyPatchRootsPresent(validatedPatches, deps);
  if (Object.keys(deps).length === 0) {
    return { key: null, nodeModulesDir: "", release() {} };
  }
  const overrides = { ...dependencyOverrides };
  const key = [
    hashDeps(deps, overrides, validatedPatches),
    process.platform,
    process.arch,
    `abi${process.versions.modules ?? "unknown"}`,
  ].join("-");
  return acquireDependencyCache(deps, {
    baseDir: getExtensionRuntimeDepsBaseDir(),
    key,
    ignoreScripts: false,
    appRoot,
    overrides,
    patches: validatedPatches,
    // Runtime publication requires an immutable dependency tree, not immediate
    // physical byte sharing. Hashing and relinking every installed payload in
    // the workspace server can monopolize its event loop for tens of seconds,
    // stalling unrelated panel and Iroh RPC work. The background mode makes
    // the tree immutable before publication and hands content deduplication to
    // the detached maintenance process after the first-use critical path.
    contentDeduplication: "background",
  });
}

type EnsureDepsOptions = {
  baseDir: string;
  key: string;
  ignoreScripts: boolean;
  appRoot: string;
  overrides?: Record<string, string>;
  patches?: readonly ExternalDependencyPatch[];
  contentDeduplication: "blocking" | "background";
};

// Builds for several panels commonly converge on the same dependency graph.
// Share one install promise per cache key so concurrency produces parallel
// builds, not duplicate npm processes competing for network/cache resources.
const inFlightInstalls = new Map<string, Promise<string>>();

async function ensureDepsInstalled(
  deps: Record<string, string>,
  options: EnsureDepsOptions
): Promise<string> {
  const flightKey = `${path.resolve(options.baseDir)}\0${options.key}`;
  const existing = inFlightInstalls.get(flightKey);
  if (existing) return existing;

  const pending = ensureDepsInstalledOnce(deps, options).finally(() => {
    if (inFlightInstalls.get(flightKey) === pending) inFlightInstalls.delete(flightKey);
  });
  inFlightInstalls.set(flightKey, pending);
  return pending;
}

async function ensureDepsInstalledOnce(
  deps: Record<string, string>,
  options: EnsureDepsOptions
): Promise<string> {
  const profileStartedAt = Date.now();
  const profile = {
    cacheValidationMs: 0,
    npmInstallMs: 0,
    patchMs: 0,
    receiptMs: 0,
    contentFinalizationMs: 0,
    publishMs: 0,
  };
  const logProfile = (result: "hit" | "installed"): void => {
    const totalMs = Date.now() - profileStartedAt;
    if (totalMs < 5_000 && process.env["VIBESTUDIO_VERBOSE_BUILD_LOG"] !== "1") return;
    console.warn("[externalDeps] dependency environment profile", {
      key: options.key,
      result,
      directDependencies: Object.keys(deps).length,
      patches: options.patches?.length ?? 0,
      ...profile,
      totalMs,
    });
  };
  if (Object.keys(deps).length === 0) {
    // No external deps — return a dummy path
    return "";
  }

  const installPlan = applyDirectDependencyOverrides(deps, options.overrides);
  validateNpmSpecMap("dependency", installPlan.dependencies);
  validateNpmSpecMap("override", installPlan.overrides);

  const cacheDir = path.join(options.baseDir, options.key);
  const sentinelPath = path.join(cacheDir, ".ready");
  const nodeModulesDir = path.join(cacheDir, "node_modules");

  // A marker is evidence only when its current validated receipt still matches
  // the immutable installed tree. Invalid or partial trees are rebuilt.
  try {
    await fs.promises.access(sentinelPath);
    if (await isReusableExternalDepsCache(cacheDir)) {
      profile.cacheValidationMs = Date.now() - profileStartedAt;
      logProfile("hit");
      return nodeModulesDir;
    }
    try {
      await fs.promises.rm(cacheDir, { recursive: true, force: true });
      validatedCacheReceipts.delete(cacheDir);
    } catch (cleanupError) {
      warnCleanupFailure(cacheDir, cleanupError);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  profile.cacheValidationMs = Date.now() - profileStartedAt;

  // Install to temp dir, then atomically rename. Use crypto.randomBytes for
  // an unpredictable name; predictable names invite local symlink races
  // where another process pre-creates `${cacheDir}.tmp.<guessed-ms>.<pid>`
  // as a symlink to a writable target.
  const tmpDir = `${cacheDir}.tmp.${crypto.randomBytes(16).toString("hex")}`;
  await fs.promises.mkdir(tmpDir, { recursive: true });

  // Write a minimal package.json for installation
  const pkgJson = {
    name: "external-deps-install",
    version: "0.0.0",
    private: true,
    dependencies: installPlan.dependencies,
    ...(Object.keys(installPlan.overrides).length > 0 ? { overrides: installPlan.overrides } : {}),
  };
  await fs.promises.writeFile(path.join(tmpDir, "package.json"), JSON.stringify(pkgJson, null, 2));

  try {
    const npmStartedAt = Date.now();
    await runNpmInstall(tmpDir, {
      appRoot: options.appRoot,
      ignoreScripts: options.ignoreScripts,
    });
    profile.npmInstallMs = Date.now() - npmStartedAt;

    const patchStartedAt = Date.now();
    const patchedFiles = await applyExternalDependencyPatches(tmpDir, options.patches ?? []);
    profile.patchMs = Date.now() - patchStartedAt;

    // Validate npm's installed package identities before making the cache
    // visible, then publish the receipt atomically with the directory rename.
    const receiptStartedAt = Date.now();
    await writeExternalDepsReceipt(tmpDir, await createExternalDepsReceipt(tmpDir, patchedFiles));
    profile.receiptMs = Date.now() - receiptStartedAt;

    // A closure owns resolution topology, not another physical copy of every
    // immutable package byte. Content-address the completed, patched tree while
    // it is still unpublished so readers never observe a partially linked view.
    const deduplicateStartedAt = Date.now();
    if (options.contentDeduplication === "blocking") {
      await deduplicateDependencyContent(tmpDir);
    } else {
      await makeDependencyTreeImmutable(tmpDir);
    }
    profile.contentFinalizationMs = Date.now() - deduplicateStartedAt;

    // Race-safe promotion: try rename, handle concurrent winner
    const publishStartedAt = Date.now();
    try {
      await fs.promises.rename(tmpDir, cacheDir);
    } catch (err: unknown) {
      if (isFileSystemErrorCode(err, ["ENOTEMPTY", "EEXIST", "ENOTDIR"])) {
        // Another process won — verify its receipt before use.
        if (await isReusableExternalDepsCache(cacheDir)) {
          try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(tmpDir, cleanupError);
          }
          return nodeModulesDir;
        }
        // Winner incomplete — remove stale dir, retry rename
        try {
          await fs.promises.rm(cacheDir, { recursive: true, force: true });
          await fs.promises.rename(tmpDir, cacheDir);
        } catch {
          // Clean up both dirs to avoid stale state, let build fail transiently
          try {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(tmpDir, cleanupError);
          }
          try {
            await fs.promises.rm(cacheDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(cacheDir, cleanupError);
          }
          throw new Error(`External deps cache race: failed to install for key ${options.key}`);
        }
      } else {
        throw err;
      }
    }

    profile.publishMs = Date.now() - publishStartedAt;
    if (options.contentDeduplication === "background") {
      scheduleDependencyContentMaintenance(cacheDir, options.appRoot);
    }
    logProfile("installed");

    return nodeModulesDir;
  } catch (error) {
    // Clean up temp dir on failure
    try {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    } catch (cleanupError) {
      warnCleanupFailure(tmpDir, cleanupError);
    }
    if (error instanceof NpmResolutionError) {
      const packages = Object.entries(installPlan.dependencies).map(([specifier, version]) => ({
        specifier,
        version,
      }));
      const requested = packages
        .map(({ specifier, version }) => `${specifier}@${version}`)
        .join(", ");
      throw new BuildRequestError(
        "package_not_found",
        error.reason === "version-not-found"
          ? `No matching npm package version was found for: ${requested}`
          : `npm package not found: ${requested}`,
        { reason: error.reason, packages }
      );
    }
    throw new Error(
      `Failed to install external dependencies: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function applyExternalDependencyPatches(
  installRoot: string,
  patches: readonly ExternalDependencyPatch[]
): Promise<PatchedFileReceipt[]> {
  const receipts = new Map<string, PatchedFileReceipt>();
  for (const patch of patches) {
    const packageRoots = await matchingInstalledPackageRoots(installRoot, patch);
    if (packageRoots.length === 0) {
      throw new Error(
        `Dependency patch ${patch.selector} from ${patch.owner} matched no installed package`
      );
    }
    const filePatches = parsePatch(patch.content);
    if (filePatches.length === 0) {
      throw new Error(`Dependency patch ${patch.selector} contains no file changes`);
    }

    for (const packageRoot of packageRoots) {
      for (const filePatch of filePatches) {
        const oldName = normalizedPatchFileName(filePatch.oldFileName);
        const newName = normalizedPatchFileName(filePatch.newFileName);
        if (!oldName && !newName) {
          throw new Error(`Dependency patch ${patch.selector} has no target path`);
        }
        const oldTarget = oldName ? await resolveSafePatchTarget(packageRoot, oldName) : null;
        const newTarget = newName ? await resolveSafePatchTarget(packageRoot, newName) : null;

        const original = oldTarget ? await fs.promises.readFile(oldTarget, "utf8") : "";
        const updated = applyPatch(original, filePatch);
        if (updated === false) {
          throw new Error(
            `Dependency patch ${patch.selector} failed for ${newName ?? oldName ?? "unknown file"}`
          );
        }
        if (oldTarget && oldTarget !== newTarget) {
          await fs.promises.rm(oldTarget);
          recordPatchedFile(receipts, installRoot, oldTarget, null);
        }
        if (newTarget) {
          await fs.promises.mkdir(path.dirname(newTarget), { recursive: true });
          await fs.promises.writeFile(newTarget, updated, "utf8");
          recordPatchedFile(receipts, installRoot, newTarget, sha256(updated));
        }
      }
    }
  }
  return [...receipts.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function recordPatchedFile(
  receipts: Map<string, PatchedFileReceipt>,
  installRoot: string,
  target: string,
  digest: string | null
): void {
  const receiptPath = path.relative(installRoot, target).split(path.sep).join("/");
  receipts.set(receiptPath, { path: receiptPath, digest });
}

async function resolveSafePatchTarget(packageRoot: string, relativePath: string): Promise<string> {
  const target = path.resolve(packageRoot, ...relativePath.split("/"));
  if (!target.startsWith(`${packageRoot}${path.sep}`)) {
    throw new Error(`Dependency patch target escapes its package: ${relativePath}`);
  }

  let cursor = packageRoot;
  for (const segment of relativePath.split("/")) {
    cursor = path.join(cursor, segment);
    const stat = await fs.promises.lstat(cursor).catch(() => null);
    if (!stat) continue;
    if (stat.isSymbolicLink()) {
      throw new Error(`Dependency patch target traverses a symbolic link: ${relativePath}`);
    }
  }
  return target;
}

async function matchingInstalledPackageRoots(
  installRoot: string,
  patch: ExternalDependencyPatch
): Promise<string[]> {
  const lockPath = path.join(installRoot, "node_modules", ".package-lock.json");
  const lock = JSON.parse(await fs.promises.readFile(lockPath, "utf8")) as {
    packages?: Record<string, { version?: unknown; link?: unknown }>;
  };
  const matches: string[] = [];
  for (const [location, record] of Object.entries(lock.packages ?? {})) {
    if (!location.startsWith("node_modules/") || record.link === true) continue;
    if (record.version !== patch.version) continue;
    const packageRoot = path.resolve(installRoot, ...location.split("/"));
    if (!packageRoot.startsWith(`${path.resolve(installRoot)}${path.sep}`)) {
      throw new Error(`Installed dependency path escapes its cache: ${location}`);
    }
    const manifestPath = path.join(packageRoot, "package.json");
    const manifestText = await fs.promises.readFile(manifestPath, "utf8").catch(() => null);
    if (!manifestText) continue;
    const manifest = JSON.parse(manifestText) as {
      name?: unknown;
      version?: unknown;
    };
    if (manifest.name === patch.packageName && manifest.version === patch.version) {
      matches.push(packageRoot);
    }
  }
  return matches.sort();
}

function normalizedPatchFileName(value: string | undefined): string | null {
  if (!value || value === "/dev/null") return null;
  const normalized = value.replace(/\\/gu, "/").replace(/^(?:a|b)\//u, "");
  if (!normalized || path.posix.isAbsolute(normalized) || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe dependency patch path: ${JSON.stringify(value)}`);
  }
  return normalized;
}
