/**
 * Source Closure Computer — content-tree subtree hash + bottom-up closure
 * computation.
 *
 * Every buildable unit gets a source-closure digest capturing
 * its own content AND all its transitive internal dependencies.
 *
 * sourceDigest(leaf)    = hash(contentHash(leaf))
 * sourceDigest(package) = hash(contentHash(package), depSig(dep_1), depSig(dep_2), ...)
 *
 * Content hashes are `manifest:` subtree hashes of each unit's directory
 * within the workspace state's content-addressed tree — resolved from the
 * generic content store (WorkspaceVcs.unitHashes → blobstore
 * resolveTreePath; byte-identical to the historical gad-DO subtree hashes,
 * so source digests and cache keys are stable) and INJECTED here. This module is pure
 * recomputation over an immutable PackageGraph; it never touches git, the
 * store, or the filesystem (except source-map persistence, a P1 cache).
 *
 * Source-closure digests are invalidation summaries only. They are full hashes, but
 * are never used as executable code identity; runtime authority is carried by
 * ExecutionArtifactRef. Compilation-cache keys also include a dependency
 * manifest sealed once during build-system startup, so a live filesystem edit
 * cannot mutate the meaning of an in-flight build.
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { PackageGraph } from "./packageGraph.js";
import { getUserDataPath } from "@vibestudio/env-paths";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SourceClosureMap {
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
  sourceMap: SourceClosureMap,
  contentHashes: ContentHashMap
): string[] {
  const node = graph.get(nodeName);
  const deps: string[] = [];

  for (const depName of node.internalDeps) {
    const depNode = graph.tryGet(depName);
    if (!depNode) continue;
    deps.push(
      `${depName}\0content:${contentHashes[depName] ?? "missing"}\0ev:${sourceMap[depName] ?? ""}`
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
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Source Closure Computation
// ---------------------------------------------------------------------------

/**
 * Compute source-closure digests for all nodes in the graph from injected
 * content hashes. Nodes with no content hash (not present in the workspace
 * state) are skipped — they are not buildable at this state.
 */
export function computeSourceClosures(
  graph: PackageGraph,
  contentHashes: ContentHashMap
): { sourceMap: SourceClosureMap; contentHashes: ContentHashMap } {
  const sourceMap: SourceClosureMap = {};

  for (const node of graph.topologicalOrder()) {
    const hash = contentHashes[node.name];
    if (!hash) continue;
    const depSigs = buildDepSignatures(graph, node.name, sourceMap, contentHashes);
    sourceMap[node.name] = hashStrings([hash, ...depSigs]);
  }

  return { sourceMap, contentHashes: { ...contentHashes } };
}

/**
 * Recompute the source closure for changed nodes and propagate through reverse
 * dependencies. Does NOT mutate the graph or its inputs.
 *
 * @param updatedHashes - New content hashes for the changed units
 *   (unit name → subtree hash; a null/absent hash leaves the old one).
 */
export function recomputeFromNodes(
  graph: PackageGraph,
  changedNames: string[],
  currentSourceMap: SourceClosureMap,
  contentHashes: ContentHashMap,
  updatedHashes: ContentHashMap
): { sourceMap: SourceClosureMap; contentHashes: ContentHashMap } {
  const newHashes = { ...contentHashes, ...updatedHashes };

  const affected = new Set<string>();
  for (const name of changedNames) {
    if (!graph.has(name)) continue;
    affected.add(name);
    for (const dep of graph.getReverseDeps(name)) {
      affected.add(dep);
    }
  }

  const newSourceMap = { ...currentSourceMap };
  for (const n of graph.topologicalOrder()) {
    if (!affected.has(n.name)) continue;
    const hash = newHashes[n.name];
    if (!hash) continue;
    const depSigs = buildDepSignatures(graph, n.name, newSourceMap, newHashes);
    newSourceMap[n.name] = hashStrings([hash, ...depSigs]);
  }

  return { sourceMap: newSourceMap, contentHashes: newHashes };
}

/**
 * Diff two source-closure maps to produce a changeset.
 */
export function diffSourceMaps(previous: SourceClosureMap, current: SourceClosureMap): ChangeSet {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [name, sourceDigest] of Object.entries(current)) {
    if (!(name in previous)) {
      added.push(name);
    } else if (previous[name] !== sourceDigest) {
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
// Source Map Persistence (P1 cache — derivation: computeSourceClosures at the
// persisted workspace state hash; deletable, recomputed on next boot)
// ---------------------------------------------------------------------------

interface PersistedSourceState {
  /** Workspace state hash the source map was computed at. */
  stateHash: string;
  sourceMap: SourceClosureMap;
  contentHashes: ContentHashMap;
}

function getSourceStatePath(): string {
  return path.join(getUserDataPath(), "source-closure-state.json");
}

export function loadPersistedSourceState(): PersistedSourceState | null {
  const p = getSourceStatePath();
  try {
    if (fs.existsSync(p)) {
      const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as PersistedSourceState;
      if (
        parsed &&
        typeof parsed.stateHash === "string" &&
        parsed.sourceMap &&
        parsed.contentHashes
      ) {
        return parsed;
      }
    }
  } catch {
    // Corrupted — treat as absent (cache amnesia)
  }
  return null;
}

export function persistSourceState(state: PersistedSourceState): void {
  const p = getSourceStatePath();
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
const COMPILATION_CACHE_VERSION = "1";

/**
 * Host-root files whose CONTENTS are folded into every compilation cache key. Changing the
 * host's dependency set (root package.json / pnpm lockfile / workspace layout)
 * must invalidate cached workspace builds, since it can change what external
 * npm deps resolve to. These are host-root files, not content-addressed
 * workspace state. They are sealed before compilation and folded into the
 * authoritative execution recipe separately from the source closure.
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
export interface SealedBuildInput {
  /** File name relative to the resolved app root. */
  file: string;
  /** Absolute path the fingerprint read (or would have read). */
  path: string;
  /** Whether the file existed and was readable at fingerprint time. */
  present: boolean;
  /** Full content hash of the file, or null when absent. */
  contentHash: string | null;
}

/** Observable, immutable dependency manifest captured at build-system startup. */
export interface SealedBuildEnvironment {
  root: string;
  workspaceRoot: string | null;
  digest: string;
  inputs: readonly SealedBuildInput[];
}

/** Process-wide build system instances seal this before compiling anything. */
let sealedBuildEnvironment: SealedBuildEnvironment | null = null;

/**
 * Capture host and workspace dependency inputs exactly once. Passing null is
 * intentionally test-only teardown; production never changes a sealed manifest.
 */
export function sealBuildEnvironment(
  config: { appRoot: string; workspaceRoot?: string } | null
): SealedBuildEnvironment | null {
  if (!config) {
    sealedBuildEnvironment = null;
    return null;
  }
  const root = path.resolve(config.appRoot);
  const workspaceRoot = config.workspaceRoot ? path.resolve(config.workspaceRoot) : null;
  const inputs = ROOT_DEPENDENCY_FINGERPRINT_FILES.map((file) => ({
    file,
    path: path.join(root, file),
  }));
  if (workspaceRoot) {
    for (const file of WORKSPACE_DEPENDENCY_FINGERPRINT_FILES) {
      const filePath = path.join(workspaceRoot, file);
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
  const hash = crypto.createHash("sha256");
  hash.update("vibestudio/sealed-build-environment/v1\0");
  const sealedInputs: SealedBuildInput[] = [];
  for (const input of inputs) {
    const file = input.file;
    const filePath = input.path;
    hash.update(file);
    hash.update("\0");
    let present = false;
    let contentHash: string | null = null;
    try {
      const contents = fs.readFileSync(filePath);
      present = true;
      contentHash = crypto.createHash("sha256").update(contents).digest("hex");
      // Explicit presence marker so an absent file and a present-empty file
      // never collide, and so the file set stays positionally unambiguous.
      hash.update("present\0");
      hash.update(contents);
      hash.update("\0");
    } catch {
      hash.update("absent\0");
    }
    sealedInputs.push({ file, path: filePath, present, contentHash });
  }
  sealedBuildEnvironment = Object.freeze({
    root,
    workspaceRoot,
    digest: hash.digest("hex"),
    inputs: Object.freeze(sealedInputs.map((input) => Object.freeze(input))),
  });
  return sealedBuildEnvironment;
}

/** Return the exact manifest used by every compilation in this process. */
export function getSealedBuildEnvironment(): SealedBuildEnvironment {
  if (!sealedBuildEnvironment) {
    throw new Error("Build environment has not been sealed");
  }
  return sealedBuildEnvironment;
}

/** Internal compilation-cache identity; never a runtime or authority identity. */
export function computeCompilationCacheKey(
  unitName: string,
  sourceDigest: string,
  sourcemap: boolean
): string {
  const environment = getSealedBuildEnvironment();
  return hashStrings([
    `compilation-cache:${COMPILATION_CACHE_VERSION}`,
    `environment:${environment.digest}`,
    unitName,
    sourceDigest,
    `sourcemap:${sourcemap}`,
  ]);
}
