/**
 * Effective Version Computer — content-tree subtree hash + bottom-up EV
 * computation.
 *
 * Every buildable unit gets an effective version: a single hash capturing
 * its own content AND all its transitive internal dependencies.
 *
 * ev(leaf)    = hash(contentHash(leaf))
 * ev(package) = hash(contentHash(package), depSig(dep_1), depSig(dep_2), ...)
 *
 * Content hashes are `manifest:` subtree hashes of each unit's directory
 * within the workspace state's content-addressed tree — resolved from the
 * generic content store (WorkspaceVcs.unitHashes → blobstore
 * resolveTreePath; byte-identical to the historical gad-DO subtree hashes,
 * so EVs and build keys are stable) and INJECTED here. This module is pure
 * recomputation over an immutable PackageGraph; it never touches git, the
 * store, or the filesystem (except EV-map persistence, a P1 cache).
 *
 * DESIGN NOTE (build-key hermeticity): computeBuildKey additionally folds in a
 * "root-dependency fingerprint" hashed from host-root package/lock/workspace
 * files plus the nested workspace package/lock/workspace/tsconfig files (see
 * computeRootDependencyFingerprint). These files are read off live disk. The
 * app/workspace roots are now injected explicitly (setBuildRootConfig) rather
 * than guessed from process.cwd(). A future design step should move these inputs
 * into GAD workspace state so the whole build key is derived from
 * content-addressed state; that migration is intentionally out of scope here.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { PackageGraph } from "./packageGraph.js";
import { getUserDataPath } from "@vibestudio/env-paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EffectiveVersionMap {
  [packageName: string]: string;
}

export interface ChangeSet {
  changed: string[];
  added: string[];
  removed: string[];
}

/** Per-unit GAD subtree hash, tracked separately from the immutable PackageGraph. */
export interface ContentHashMap {
  [packageName: string]: string;
}

function buildDepSignatures(
  graph: PackageGraph,
  nodeName: string,
  evMap: EffectiveVersionMap,
  contentHashes: ContentHashMap
): string[] {
  const node = graph.get(nodeName);
  const deps: string[] = [];

  for (const depName of node.internalDeps) {
    const depNode = graph.tryGet(depName);
    if (!depNode) continue;
    deps.push(
      `${depName}\0content:${contentHashes[depName] ?? "missing"}\0ev:${evMap[depName] ?? ""}`
    );
  }

  return deps.sort();
}

// ---------------------------------------------------------------------------
// Hashing Utility
// ---------------------------------------------------------------------------

function hashStrings(parts: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Effective Version Computation
// ---------------------------------------------------------------------------

/**
 * Compute effective versions for all nodes in the graph from injected
 * content hashes. Nodes with no content hash (not present in the workspace
 * state) are skipped — they are not buildable at this state.
 */
export function computeEffectiveVersions(
  graph: PackageGraph,
  contentHashes: ContentHashMap
): { evMap: EffectiveVersionMap; contentHashes: ContentHashMap } {
  const evMap: EffectiveVersionMap = {};

  for (const node of graph.topologicalOrder()) {
    const hash = contentHashes[node.name];
    if (!hash) continue;
    const depSigs = buildDepSignatures(graph, node.name, evMap, contentHashes);
    evMap[node.name] = hashStrings([hash, ...depSigs]);
  }

  return { evMap, contentHashes: { ...contentHashes } };
}

/**
 * Recompute the EV for changed nodes and propagate up through reverse
 * dependencies. Does NOT mutate the graph or its inputs.
 *
 * @param updatedHashes - New content hashes for the changed units
 *   (unit name → subtree hash; a null/absent hash leaves the old one).
 */
export function recomputeFromNodes(
  graph: PackageGraph,
  changedNames: string[],
  currentEvMap: EffectiveVersionMap,
  contentHashes: ContentHashMap,
  updatedHashes: ContentHashMap
): { evMap: EffectiveVersionMap; contentHashes: ContentHashMap } {
  const newHashes = { ...contentHashes, ...updatedHashes };

  const affected = new Set<string>();
  for (const name of changedNames) {
    if (!graph.has(name)) continue;
    affected.add(name);
    for (const dep of graph.getReverseDeps(name)) {
      affected.add(dep);
    }
  }

  const newEvMap = { ...currentEvMap };
  for (const n of graph.topologicalOrder()) {
    if (!affected.has(n.name)) continue;
    const hash = newHashes[n.name];
    if (!hash) continue;
    const depSigs = buildDepSignatures(graph, n.name, newEvMap, newHashes);
    newEvMap[n.name] = hashStrings([hash, ...depSigs]);
  }

  return { evMap: newEvMap, contentHashes: newHashes };
}

/**
 * Diff two EV maps to produce a changeset.
 */
export function diffEvMaps(previous: EffectiveVersionMap, current: EffectiveVersionMap): ChangeSet {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [name, ev] of Object.entries(current)) {
    if (!(name in previous)) {
      added.push(name);
    } else if (previous[name] !== ev) {
      changed.push(name);
    }
  }

  for (const name of Object.keys(previous)) {
    if (!(name in current)) {
      removed.push(name);
    }
  }

  return { changed, added, removed };
}

// ---------------------------------------------------------------------------
// EV Map Persistence (P1 cache — derivation: computeEffectiveVersions at the
// persisted workspace state hash; deletable, recomputed on next boot)
// ---------------------------------------------------------------------------

interface PersistedEvState {
  /** Workspace state hash the EV map was computed at. */
  stateHash: string;
  evMap: EffectiveVersionMap;
  contentHashes: ContentHashMap;
}

function getEvStatePath(): string {
  return path.join(getUserDataPath(), "ev-state.json");
}

export function loadPersistedEvState(): PersistedEvState | null {
  const p = getEvStatePath();
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as PersistedEvState;
      if (parsed && typeof parsed.stateHash === "string" && parsed.evMap && parsed.contentHashes) {
        return parsed;
      }
    }
  } catch {
    // Corrupted — treat as absent (cache amnesia)
  }
  return null;
}

export function persistEvState(state: PersistedEvState): void {
  const p = getEvStatePath();
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(p, JSON.stringify(state));
}

// ---------------------------------------------------------------------------
// Build Key
// ---------------------------------------------------------------------------

/**
 * Increment when build logic changes (plugins, esbuild options, shims) OR when
 * the build-key derivation itself changes, to invalidate all cached builds.
 *
 * "18": root-dependency fingerprint now includes the nested workspace package,
 * lock, workspace, and tsconfig files that participate in userland builds.
 */
const BUILD_CACHE_VERSION = "18";

/**
 * Host-root files whose CONTENTS are folded into every build key. Changing the
 * host's dependency set (root package.json / pnpm lockfile / workspace layout)
 * must invalidate cached workspace builds, since it can change what external
 * npm deps resolve to. These are host-root files, not content-addressed
 * workspace state — see the design note in effectiveVersion.ts's header for the
 * future step of moving them into GAD workspace state.
 */
const ROOT_DEPENDENCY_FINGERPRINT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
const WORKSPACE_DEPENDENCY_FINGERPRINT_FILES = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.integration.json",
];

/** Per-input record surfaced for build-metadata / diagnostics observability. */
export interface RootDependencyFingerprintFile {
  /** File name relative to the resolved app root. */
  file: string;
  /** Absolute path the fingerprint read (or would have read). */
  path: string;
  /** Whether the file existed and was readable at fingerprint time. */
  present: boolean;
  /** Short content hash of the file, or null when absent. */
  contentHash: string | null;
}

/** Observable description of the root-dependency fingerprint folded into build keys. */
export interface RootDependencyFingerprintInfo {
  /** Resolved app root the fingerprint was computed against. */
  root: string;
  /** How the app root was resolved (for diagnosing cwd-dependence). */
  rootSource: "env" | "injected" | "cwd";
  /** The 16-char fingerprint folded into computeBuildKey. */
  value: string;
  /** Per-input observability (paths + presence + per-file content hash). */
  files: RootDependencyFingerprintFile[];
}

/**
 * App root injected at build-system construction (see setBuildRootConfig).
 * Makes the fingerprint's file inputs explicit instead of cwd-guessing. The
 * VIBESTUDIO_APP_ROOT env var still overrides this; process.cwd() remains a
 * last-resort fallback when neither is set.
 */
let injectedAppRoot: string | null = null;
let injectedWorkspaceRoot: string | null = null;
let rootFingerprintLogged = false;

/**
 * Inject the host app root and optional workspace root used to locate the
 * dependency fingerprint inputs. Call once from the build system's construction
 * with explicit roots — this removes the fragile process.cwd() dependence from
 * the build-cache identity. Passing `null` clears the injected values (used by
 * tests). The VIBESTUDIO_APP_ROOT env var, when set, still takes precedence for the
 * host app root.
 */
export function setBuildRootConfig(
  config: { appRoot: string; workspaceRoot?: string } | null
): void {
  injectedAppRoot = config?.appRoot ?? null;
  injectedWorkspaceRoot = config?.workspaceRoot ?? null;
}

function resolveAppRoot(): { root: string; source: RootDependencyFingerprintInfo["rootSource"] } {
  const envRoot = process.env["VIBESTUDIO_APP_ROOT"];
  if (envRoot) return { root: envRoot, source: "env" };
  if (injectedAppRoot) return { root: injectedAppRoot, source: "injected" };
  return { root: process.cwd(), source: "cwd" };
}

function shortHash(data: crypto.BinaryLike): string {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function dependencyFingerprintInputs(root: string): Array<{ file: string; path: string }> {
  const inputs = ROOT_DEPENDENCY_FINGERPRINT_FILES.map((file) => ({
    file,
    path: path.join(root, file),
  }));
  if (injectedWorkspaceRoot) {
    for (const file of WORKSPACE_DEPENDENCY_FINGERPRINT_FILES) {
      const filePath = path.join(injectedWorkspaceRoot, file);
      const relative = path.relative(root, filePath);
      inputs.push({
        file:
          relative && !relative.startsWith("..") && !path.isAbsolute(relative)
            ? relative
            : `workspace:${file}`,
        path: filePath,
      });
    }
  }
  return inputs;
}

function computeRootDependencyFingerprint(): RootDependencyFingerprintInfo {
  const { root, source } = resolveAppRoot();

  const hash = crypto.createHash("sha256");
  // Domain tag; bumped when the input set/encoding changes.
  hash.update("root-deps-v3\0");

  const files: RootDependencyFingerprintFile[] = [];
  for (const input of dependencyFingerprintInputs(root)) {
    const file = input.file;
    const filePath = input.path;
    hash.update(file);
    hash.update("\0");
    let present = false;
    let contentHash: string | null = null;
    try {
      const contents = fs.readFileSync(filePath);
      present = true;
      contentHash = shortHash(contents);
      // Explicit presence marker so an absent file and a present-empty file
      // never collide, and so the file set stays positionally unambiguous.
      hash.update("present\0");
      hash.update(contents);
      hash.update("\0");
    } catch {
      hash.update("absent\0");
    }
    files.push({ file, path: filePath, present, contentHash });
  }

  const info: RootDependencyFingerprintInfo = {
    root,
    rootSource: source,
    value: hash.digest("hex").slice(0, 16),
    files,
  };

  if (!rootFingerprintLogged) {
    rootFingerprintLogged = true;
    const summary = info.files
      .map((f) => `${f.file}=${f.present ? (f.contentHash ?? "?") : "absent"}`)
      .join(" ");
    console.log(
      `[BuildV2] root-deps fingerprint ${info.value} (root=${info.root} via ${info.rootSource}): ${summary}`
    );
  }

  return info;
}

/**
 * Observable description of the root-dependency fingerprint currently folded
 * into build keys. Surface this in build metadata/diagnostics so cache identity
 * (which host-root inputs it depends on, and how the root was resolved) is
 * inspectable rather than invisible.
 */
export function getRootDependencyFingerprintInfo(): RootDependencyFingerprintInfo {
  return computeRootDependencyFingerprint();
}

function rootDependencyFingerprint(): string {
  return computeRootDependencyFingerprint().value;
}

/**
 * Compute the build key for a unit:
 *   hash(BUILD_CACHE_VERSION, root-deps fingerprint, unitName, ev, sourcemap).
 * This is the content-addressed store key. The root-deps fingerprint folds in
 * the CONTENTS of the host's package.json / pnpm-lock.yaml / pnpm-workspace.yaml
 * (see getRootDependencyFingerprintInfo for observability). Unit name is
 * included to prevent different units with identical EVs from sharing builds
 * (different entry points, HTML titles, dependency sets produce different
 * artifacts).
 */
export function computeBuildKey(unitName: string, ev: string, sourcemap: boolean): string {
  return hashStrings([
    BUILD_CACHE_VERSION,
    `root-deps:${rootDependencyFingerprint()}`,
    unitName,
    ev,
    `sourcemap:${sourcemap}`,
  ]);
}
