/**
 * External Dependency Cache — transitive external dep collection + cached installation.
 *
 * For a given panel/agent, walks the package graph and collects ALL external
 * dependencies from the unit itself and every internal package it transitively
 * depends on. The union is hashed and installed into a shared cache.
 *
 * {userData}/external-deps/{hash}/
 *   ├── node_modules/
 *   └── .ready   ← sentinel marking completed installation
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { getCentralDataPath } from "@vibestudio/env-paths";
import { NpmResolutionError, runNpmInstall } from "@vibestudio/shared/npmInstaller";
import type { PackageGraph, GraphNode } from "./packageGraph.js";
import { assertPresent } from "../../lintHelpers";
import { BuildRequestError } from "./diagnostics.js";

// ---------------------------------------------------------------------------
// Transitive collection
// ---------------------------------------------------------------------------

/**
 * Collect all external (non-workspace) dependencies transitively
 * from a unit and all its internal dependencies.
 */
export function collectTransitiveExternalDeps(
  unit: GraphNode,
  graph: PackageGraph,
  workspaceRoot?: string,
  packageRoots: string[] = []
): Record<string, string> {
  const externals: Record<string, string> = {};
  const appProvidedPackages = new Set([
    ...readWorkspacePatchedDependencyNames(),
    ...readWorkspacePatchedDependencyNames(process.env["VIBESTUDIO_APP_ROOT"]),
  ]);
  const visited = new Set<string>();
  const visitedPackageJson = new Set<string>();

  function recordExternal(name: string, version: string) {
    // Skip workspace:* deps — these are source packages resolved from the app
    // install or the package graph. Their own npm deps are collected by walking
    // the package.json when available.
    if (version.startsWith("workspace:")) return;
    // The external-deps cache is installed with npm, so it cannot apply pnpm
    // patches. Let patched app dependencies resolve from the app node_modules
    // instead of shadowing them with unpatched registry installs.
    if (appProvidedPackages.has(name)) return;
    // External dependency — take higher version if conflict
    if (!externals[name] || compareVersions(version, assertPresent(externals[name])) > 0) {
      externals[name] = version;
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
        if (pkg) walkPackageJson(pkg.path, pkg.dependencies);
        continue;
      }
      recordExternal(name, version);
    }
  }

  function walkPackageJson(packageJsonPath: string, dependencies: Record<string, string>) {
    if (visitedPackageJson.has(packageJsonPath)) return;
    visitedPackageJson.add(packageJsonPath);
    walkDeps(dependencies, { walkWorkspaceDeps: false });
  }

  function walkNode(node: GraphNode) {
    if (visited.has(node.name)) return;
    visited.add(node.name);
    walkDeps(node.dependencies, { walkWorkspaceDeps: true });
  }

  walkNode(unit);
  return externals;
}

export function collectTransitiveDependencyOverrides(
  unit: GraphNode,
  graph: PackageGraph,
  workspaceRoot?: string,
  packageRoots: string[] = []
): Record<string, string> {
  const overrides: Record<string, string> = {};
  const visited = new Set<string>();
  const visitedPackageJson = new Set<string>();

  function record(source: Record<string, string>) {
    Object.assign(overrides, source);
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
        if (pkg) walkPackageJson(pkg.path, pkg.dependencies, pkg.dependencyOverrides);
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
    record(dependencyOverrides);
    walkDeps(dependencies, { walkWorkspaceDeps: false });
  }

  function walkNode(node: GraphNode) {
    if (visited.has(node.name)) return;
    visited.add(node.name);
    record(node.dependencyOverrides);
    walkDeps(node.dependencies, { walkWorkspaceDeps: true });
  }

  walkNode(unit);
  return overrides;
}

function readWorkspacePackageJson(
  workspaceRoot: string,
  packageName: string,
  packageRoots: string[] = []
): {
  path: string;
  dependencies: Record<string, string>;
  dependencyOverrides: Record<string, string>;
} | null {
  for (const pkgJsonPath of workspacePackageJsonCandidates(
    workspaceRoot,
    packageName,
    packageRoots
  )) {
    if (!fs.existsSync(pkgJsonPath)) continue;
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
        name?: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
        overrides?: unknown;
        pnpm?: { overrides?: unknown };
      };
      if (pkg.name !== packageName) continue;
      return {
        path: pkgJsonPath,
        dependencies: { ...pkg.peerDependencies, ...pkg.dependencies },
        dependencyOverrides: normalizeSimpleOverrides(pkg.overrides, pkg.pnpm?.overrides),
      };
    } catch {
      continue;
    }
  }

  for (const baseDir of workspacePackageRoots(workspaceRoot)) {
    if (!fs.existsSync(baseDir)) continue;
    for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const pkgJsonPath = path.join(baseDir, entry.name, "package.json");
      if (!fs.existsSync(pkgJsonPath)) continue;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
          name?: string;
          dependencies?: Record<string, string>;
          peerDependencies?: Record<string, string>;
          overrides?: unknown;
          pnpm?: { overrides?: unknown };
        };
        if (pkg.name !== packageName) continue;
        return {
          path: pkgJsonPath,
          dependencies: { ...pkg.peerDependencies, ...pkg.dependencies },
          dependencyOverrides: normalizeSimpleOverrides(pkg.overrides, pkg.pnpm?.overrides),
        };
      } catch {
        continue;
      }
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
  const repoRoot = path.dirname(workspaceRoot);
  return [path.join(workspaceRoot, "packages"), path.join(repoRoot, "packages")];
}

/**
 * Simple semver-ish comparison. Returns >0 if a > b.
 * Handles workspace:*, *, ^x.y.z, ~x.y.z, x.y.z
 */
function compareVersions(a: string, b: string): number {
  // Wildcards are lowest priority
  if (a === "*" || a === "workspace:*") return -1;
  if (b === "*" || b === "workspace:*") return 1;

  const parseVersion = (v: string): number[] => {
    const cleaned = v.replace(/^[\^~>=<]+/, "");
    return cleaned.split(".").map((n) => parseInt(n, 10) || 0);
  };

  const aParts = parseVersion(a);
  const bParts = parseVersion(b);

  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Cached Installation
// ---------------------------------------------------------------------------

function hashDeps(deps: Record<string, string>, overrides: Record<string, string> = {}): string {
  const entries = Object.entries(deps).sort(([a], [b]) => a.localeCompare(b));
  const overrideEntries = Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b));
  const hash = crypto.createHash("sha256");
  hash.update(JSON.stringify({ deps: entries, overrides: overrideEntries }));
  return hash.digest("hex").slice(0, 16);
}

function readWorkspaceNpmOverrides(): Record<string, string> {
  const pkgPath = path.join(process.env["VIBESTUDIO_APP_ROOT"] ?? process.cwd(), "package.json");
  if (!fs.existsSync(pkgPath)) return {};

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      overrides?: unknown;
      pnpm?: { overrides?: unknown };
    };
    return {
      ...normalizeSimpleOverrides(pkg.overrides, pkg.pnpm?.overrides),
    };
  } catch {
    return {};
  }
}

function readWorkspacePatchedDependencyNames(root = process.cwd()): string[] {
  if (!root) return [];
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return [];

  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as {
      pnpm?: { patchedDependencies?: unknown };
    };
    const patchedDependencies = pkg.pnpm?.patchedDependencies;
    if (!patchedDependencies || typeof patchedDependencies !== "object") return [];
    return Object.keys(patchedDependencies as Record<string, unknown>).map((specifier) =>
      specifier.replace(/@\d.*$/, "")
    );
  } catch {
    return [];
  }
}

function getExternalDepsBaseDir(): string {
  return path.join(getCentralDataPath(), "external-deps");
}

function getExtensionRuntimeDepsBaseDir(): string {
  return path.join(getCentralDataPath(), "extension-runtime-deps");
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
 * Returns the direct dependency selected by an npm/pnpm simple override, if
 * any.  Package-manager override keys can be either `name` or `name@major`
 * (including scoped names such as `@scope/name@major`).  The latter is what
 * lets the root pin vulnerable transitive majors independently.
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

const EXTERNAL_DEPS_RECEIPT_VERSION = 1;

interface ExternalDepsReceipt {
  version: typeof EXTERNAL_DEPS_RECEIPT_VERSION;
  lockDigest: string;
  packageCount: number;
}

const validatedCacheReceipts = new Map<string, { mtimeMs: number; size: number }>();

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/**
 * Prove that npm produced a coherent immutable tree before publishing it.
 * The hidden lock describes the packages npm actually installed (unlike the
 * root lock, which may include platform-skipped optionals). Every registry
 * package must retain its integrity identity and matching package metadata.
 */
function createExternalDepsReceipt(cacheDir: string): ExternalDepsReceipt {
  const nodeModulesDir = path.join(cacheDir, "node_modules");
  const lockPath = path.join(nodeModulesDir, ".package-lock.json");
  const lockBytes = fs.readFileSync(lockPath);
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
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      version?: unknown;
    };
    if (packageJson.version !== record.version) {
      throw new Error(`installed dependency ${location} does not match its lock identity`);
    }
  }
  if (packageCount === 0) throw new Error("installed dependency lock is empty");
  return {
    version: EXTERNAL_DEPS_RECEIPT_VERSION,
    lockDigest: sha256(lockBytes),
    packageCount,
  };
}

function writeExternalDepsReceipt(cacheDir: string, receipt: ExternalDepsReceipt): void {
  const sentinelPath = path.join(cacheDir, ".ready");
  const temporaryPath = `${sentinelPath}.tmp.${process.pid}.${crypto.randomBytes(8).toString("hex")}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(receipt));
    fs.renameSync(temporaryPath, sentinelPath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
}

function isReusableExternalDepsCache(cacheDir: string): boolean {
  const sentinelPath = path.join(cacheDir, ".ready");
  let sentinelStat: fs.Stats;
  try {
    sentinelStat = fs.statSync(sentinelPath);
  } catch {
    return false;
  }
  const memoized = validatedCacheReceipts.get(cacheDir);
  if (memoized?.mtimeMs === sentinelStat.mtimeMs && memoized.size === sentinelStat.size)
    return true;

  try {
    const raw = fs.readFileSync(sentinelPath, "utf8");
    let receipt: ExternalDepsReceipt;
    try {
      const parsed = JSON.parse(raw) as Partial<ExternalDepsReceipt>;
      if (
        parsed.version !== EXTERNAL_DEPS_RECEIPT_VERSION ||
        typeof parsed.lockDigest !== "string" ||
        typeof parsed.packageCount !== "number" ||
        parsed.packageCount <= 0
      ) {
        throw new Error("legacy receipt");
      }
      receipt = parsed as ExternalDepsReceipt;
    } catch {
      // Upgrade healthy timestamp-only sentinels in place. Invalid legacy
      // entries are rejected and reinstalled by the caller.
      receipt = createExternalDepsReceipt(cacheDir);
      writeExternalDepsReceipt(cacheDir, receipt);
      sentinelStat = fs.statSync(sentinelPath);
    }

    const lockBytes = fs.readFileSync(path.join(cacheDir, "node_modules", ".package-lock.json"));
    if (sha256(lockBytes) !== receipt.lockDigest) return false;
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

/**
 * Get or install external dependencies. Returns the path to the
 * node_modules directory.
 */
export async function ensureExternalDeps(
  deps: Record<string, string>,
  dependencyOverrides: Record<string, string> = {}
): Promise<string> {
  const overrides = { ...readWorkspaceNpmOverrides(), ...dependencyOverrides };
  return ensureDepsInstalled(deps, {
    baseDir: getExternalDepsBaseDir(),
    key: hashDeps(deps, overrides),
    ignoreScripts: true,
    overrides,
  });
}

export async function ensureExtensionRuntimeDeps(
  deps: Record<string, string>,
  dependencyOverrides: Record<string, string> = {}
): Promise<{ key: string | null; nodeModulesDir: string }> {
  if (Object.keys(deps).length === 0) {
    return { key: null, nodeModulesDir: "" };
  }
  const overrides = { ...readWorkspaceNpmOverrides(), ...dependencyOverrides };
  const key = [
    hashDeps(deps, overrides),
    process.platform,
    process.arch,
    `abi${process.versions.modules ?? "unknown"}`,
  ].join("-");
  const nodeModulesDir = await ensureDepsInstalled(deps, {
    baseDir: getExtensionRuntimeDepsBaseDir(),
    key,
    ignoreScripts: false,
    overrides,
  });
  return { key, nodeModulesDir };
}

type EnsureDepsOptions = {
  baseDir: string;
  key: string;
  ignoreScripts: boolean;
  overrides?: Record<string, string>;
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

  // A marker is evidence only when its validated receipt still matches the
  // immutable installed tree. Timestamp-only legacy markers are upgraded on
  // first use; partial trees are discarded and rebuilt.
  if (fs.existsSync(sentinelPath)) {
    if (isReusableExternalDepsCache(cacheDir)) return nodeModulesDir;
    try {
      fs.rmSync(cacheDir, { recursive: true, force: true });
      validatedCacheReceipts.delete(cacheDir);
    } catch (cleanupError) {
      warnCleanupFailure(cacheDir, cleanupError);
    }
  }

  // Install to temp dir, then atomically rename. Use crypto.randomBytes for
  // an unpredictable name; predictable names invite local symlink races
  // where another process pre-creates `${cacheDir}.tmp.<guessed-ms>.<pid>`
  // as a symlink to a writable target.
  const tmpDir = `${cacheDir}.tmp.${crypto.randomBytes(16).toString("hex")}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  // Write a minimal package.json for installation
  const pkgJson = {
    name: "external-deps-install",
    version: "0.0.0",
    private: true,
    dependencies: installPlan.dependencies,
    ...(Object.keys(installPlan.overrides).length > 0 ? { overrides: installPlan.overrides } : {}),
  };
  fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify(pkgJson, null, 2));

  try {
    await runNpmInstall(tmpDir, { ignoreScripts: options.ignoreScripts });

    // Validate npm's installed package identities before making the cache
    // visible, then publish the receipt atomically with the directory rename.
    writeExternalDepsReceipt(tmpDir, createExternalDepsReceipt(tmpDir));

    // Race-safe promotion: try rename, handle concurrent winner
    try {
      fs.renameSync(tmpDir, cacheDir);
    } catch (err: unknown) {
      if (isFileSystemErrorCode(err, ["ENOTEMPTY", "EEXIST", "ENOTDIR"])) {
        // Another process won — verify its receipt before use.
        if (isReusableExternalDepsCache(cacheDir)) {
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(tmpDir, cleanupError);
          }
          return nodeModulesDir;
        }
        // Winner incomplete — remove stale dir, retry rename
        try {
          fs.rmSync(cacheDir, { recursive: true, force: true });
          fs.renameSync(tmpDir, cacheDir);
        } catch {
          // Clean up both dirs to avoid stale state, let build fail transiently
          try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(tmpDir, cleanupError);
          }
          try {
            fs.rmSync(cacheDir, { recursive: true, force: true });
          } catch (cleanupError) {
            warnCleanupFailure(cacheDir, cleanupError);
          }
          throw new Error(`External deps cache race: failed to install for key ${options.key}`);
        }
      } else {
        throw err;
      }
    }

    return nodeModulesDir;
  } catch (error) {
    // Clean up temp dir on failure
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
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
