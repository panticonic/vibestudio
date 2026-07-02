/**
 * Effective Version Computer — GAD subtree hash + bottom-up EV computation.
 *
 * Every buildable unit gets an effective version: a single hash capturing
 * its own content AND all its transitive internal dependencies.
 *
 * ev(leaf)    = hash(contentHash(leaf))
 * ev(package) = hash(contentHash(package), depSig(dep_1), depSig(dep_2), ...)
 *
 * Content hashes are GAD manifest subtree hashes of each unit's directory
 * within the single workspace tree (`vcs:workspace` log) — computed by the
 * gad-store DO and INJECTED here. This module is pure recomputation over an
 * immutable PackageGraph; it never touches git, the DO, or the filesystem
 * (except EV-map persistence, a P1 cache).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import type { PackageGraph } from "./packageGraph.js";
import { getUserDataPath } from "@natstack/env-paths";

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

/** Increment when build logic changes (plugins, esbuild options, shims) to invalidate all cached builds. */
const BUILD_CACHE_VERSION = "16";
const ROOT_DEPENDENCY_FINGERPRINT_FILES = ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"];
let rootDependencyFingerprintCache: { root: string; value: string } | null = null;

function rootDependencyFingerprint(): string {
  const root = process.env["NATSTACK_APP_ROOT"] ?? process.cwd();
  if (rootDependencyFingerprintCache?.root === root) {
    return rootDependencyFingerprintCache.value;
  }
  const hash = crypto.createHash("sha256");
  hash.update("root-deps-v1");
  for (const file of ROOT_DEPENDENCY_FINGERPRINT_FILES) {
    const filePath = path.join(root, file);
    if (!fs.existsSync(filePath)) continue;
    hash.update(file);
    hash.update("\0");
    hash.update(fs.readFileSync(filePath));
    hash.update("\0");
  }
  const value = hash.digest("hex").slice(0, 16);
  rootDependencyFingerprintCache = { root, value };
  return value;
}

/**
 * Compute the build key for a unit: hash(BUILD_CACHE_VERSION, unitName, ev, sourcemap).
 * This is the content-addressed store key. Unit name is included to prevent
 * different units with identical EVs from sharing builds (different entry points,
 * HTML titles, dependency sets produce different artifacts).
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
