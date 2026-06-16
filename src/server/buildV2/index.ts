/**
 * Build System V2 — Public API + RPC service registration.
 *
 * The build system lives entirely in the server process.
 * Electron requests builds via RPC. The headless server gets builds for free.
 *
 * Builds are triggered by workspace state advances on the GAD vcs log
 * (`vcs:workspace`). Cold start compares the persisted EV state's workspace
 * state hash against a fresh scan-on-demand snapshot — the snapshot IS the
 * change detection.
 *
 * Immutability: the PackageGraph is never mutated after creation. Content
 * hashes (GAD manifest subtree hashes) are tracked in a separate
 * ContentHashMap, ensuring EV computations are always consistent with their
 * inputs. Build sources are materialized from the immutable state the EVs
 * were computed at — the old commit/push race cannot exist.
 */

import * as path from "path";
import type { PackageGraph, GraphNode } from "./packageGraph.js";
import {
  computeEffectiveVersions,
  loadPersistedEvState,
  persistEvState,
  diffEvMaps,
  computeBuildKey,
  type ContentHashMap,
  type ChangeSet,
  type EffectiveVersionMap,
} from "./effectiveVersion.js";
import * as buildStore from "./buildStore.js";
import { primaryTextArtifactContent, type BuildResult } from "./buildStore.js";
import {
  analyzeExtensionDependencies,
  buildUnit,
  computeBuildUnitKey,
  buildNpmLibrary,
  buildPlatformLibrary,
  initBuilder,
  normalizeExtensionDependencyMode,
  type BuildUnitOptions,
  type ExtensionDependencyDiagnostics,
} from "./builder.js";
import { setBuildSourceProvider, type BuildSourceProvider } from "./buildSource.js";
import { validateBuildRef } from "./refs.js";
import {
  StateTransitionTrigger,
  unitsForChangedPaths,
  isBuildableKind,
  sourcemapForKind,
  MAIN_HEAD,
  type StateAdvancedEvent,
  type WorkspaceStateSource,
} from "./stateTrigger.js";
import {
  collectTransitiveDependencyOverrides,
  collectTransitiveExternalDeps,
  ensureExternalDeps,
} from "./externalDeps.js";
import { EXTENSION_RUNTIME_ABI_VERSION } from "@natstack/shared/extensionRuntimeAbi";
import { assertPresent } from "../../lintHelpers";
import { onBuildProviderChange, resolveBuildProvider } from "./buildProviderRegistry.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AboutPageMeta {
  name: string;
  title: string;
  description?: string;
  hiddenInLauncher: boolean;
}

export interface ExtensionDoctorReport {
  name: string;
  kind: "extension";
  path: string;
  dependencyDiagnostics: ExtensionDependencyDiagnostics;
  buildMetadata: BuildResult["metadata"] | null;
  checks: Array<{ name: string; status: "pass" | "warn" | "fail"; message: string }>;
}

export interface BuildSystemBuildEvent {
  type: "build-started" | "build-complete" | "build-error";
  name: string;
  relativePath?: string;
  buildKey?: string;
  error?: string;
  trigger?: StateAdvancedEvent;
  timestamp: string;
}

export interface RuntimeImageBinding {
  source: string;
  unitName: string;
  stateHash: string;
  effectiveVersion: string;
  buildKey: string;
}

export type { BuildUnitOptions } from "./builder.js";
export type { WorkspaceStateSource, StateAdvancedEvent, BuildRecord } from "./stateTrigger.js";
export type { BuildSourceProvider } from "./buildSource.js";
export { setBuildSourceProvider, directorySourceProvider } from "./buildSource.js";
export {
  clearBuildProvidersForTests,
  listBuildProviders,
  registerBuildProvider,
  resolveBuildProvider,
  onBuildProviderChange,
  unregisterBuildProvider,
} from "./buildProviderRegistry.js";

export interface BuildSystemV2 {
  /**
   * Get build result for a panel/worker/extension/library.
   * `ref` selects the workspace state to build from: undefined = main HEAD
   * (scan-on-demand), a head name (e.g. `ctx:abc`), or an immutable
   * `state:…` hash.
   */
  getBuild(
    unitPath: string,
    ref: string | undefined,
    options: BuildUnitOptions & { library: true }
  ): Promise<{ bundle: string }>;
  getBuild(
    unitPath: string,
    ref?: string,
    options?: BuildUnitOptions & { library?: false | undefined }
  ): Promise<BuildResult>;

  /** Get an immutable build-store artifact by build key. */
  getBuildByKey(key: string): BuildResult | null;

  /**
   * Binder API for runtime entities. Resolves a head/scope to a committed
   * state off the hot path, builds the unit from that immutable state, and
   * returns the global artifact identity the loader can fetch by key.
   */
  bindRuntimeImage(unitPath: string, ref?: string): Promise<RuntimeImageBinding>;

  /** Build an npm package as a CJS library bundle for sandbox use. */
  getBuildNpm(
    specifier: string,
    version: string,
    externals?: string[]
  ): Promise<{ bundle: string }>;

  /** Get effective version for a unit */
  getEffectiveVersion(unitName: string): string | null;

  /** Get external npm runtime/build dependencies for a unit. */
  getExternalDeps(unitName: string): Record<string, string>;

  /** Get the active provider identity that affects builds for a pluggable target. */
  getBuildProviderDetails(target: "react-native"): {
    name: string;
    activeEv: string | null;
    activeBuildKey: string | null;
    contractVersion: string;
  } | null;

  /** Subscribe to provider registration changes that can invalidate app build trust. */
  onBuildProviderChange(
    callback: (event: {
      type: "registered" | "unregistered";
      target: "react-native";
      provider: {
        name: string;
        activeEv: string | null;
        activeBuildKey: string | null;
        contractVersion: string;
      };
    }) => void
  ): () => void;

  /** Inspect an extension manifest, dependency routing, cached metadata, and smoke/build status. */
  doctorExtension(unitName: string): Promise<ExtensionDoctorReport>;

  /** Force recompute all effective versions */
  recompute(): Promise<ChangeSet>;

  /** Garbage collect unreferenced builds */
  gc(activeUnits: string[]): Promise<{ freed: number }>;

  /** List available about pages (for launcher UI) */
  getAboutPages(): Promise<AboutPageMeta[]>;

  /** Get the package graph */
  getGraph(): PackageGraph;

  /** Check if a unit exists */
  hasUnit(name: string): boolean;

  /** Get the workspace root */
  getWorkspaceRoot(): string;

  /** Recent state-triggered build lifecycle events and failures. */
  listRecentBuildEvents(unitName?: string): BuildSystemBuildEvent[];

  /** Wait until all queued state-advance processing has settled. */
  whenSettled(): Promise<void>;

  /**
   * Subscribe to state-triggered build lifecycle events (started/complete/error).
   * Returns an unsubscribe function. Used to feed unit diagnostics so build
   * failures are queryable alongside runtime logs.
   */
  onBuildEvent(callback: (event: BuildSystemBuildEvent) => void): () => void;

  /**
   * Register a callback for when a state-triggered build completes.
   * The callback receives the source path (e.g. "panels/chat") so the
   * HTTP server can invalidate its serving cache.
   */
  onPushBuild(
    callback: (source: string, trigger?: StateAdvancedEvent, buildKey?: string) => void
  ): void;

  /** Shut down (stop state trigger) */
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

export async function initBuildSystemV2(
  workspaceRoot: string,
  source: WorkspaceStateSource & BuildSourceProvider,
  appNodeModules: string | string[]
): Promise<BuildSystemV2> {
  console.log("[BuildV2] Initializing...");
  const appNodeModuleRoots = Array.isArray(appNodeModules) ? appNodeModules : [appNodeModules];

  // Declare where @natstack/* platform packages live (workspace:* deps).
  initBuilder(appNodeModuleRoots);
  setBuildSourceProvider(source);

  // Step 1: Snapshot the workspace + discover package graph from that state
  // (scan-on-demand —
  // out-of-band edits made while the server was down become a first-class
  // observed transition right here).
  const { stateHash } = await source.ensureFresh();
  const graph = await source.discoverGraph(stateHash);
  const nodeCount = graph.allNodes().length;
  console.log(`[BuildV2] Discovered ${nodeCount} units in workspace`);

  // Step 2: Compute effective versions. Cold-start fast path: if the
  // persisted EV state was computed at this exact workspace state, reuse it
  // wholesale (zero DO hashing calls).
  const persisted = loadPersistedEvState();
  let evMap: EffectiveVersionMap;
  let contentHashes: ContentHashMap;
  if (persisted && persisted.stateHash === stateHash) {
    evMap = persisted.evMap;
    contentHashes = persisted.contentHashes;
    console.log(`[BuildV2] EV state reused (workspace unchanged at ${stateHash.slice(0, 18)}…)`);
  } else {
    const relPaths = graph.allNodes().map((node) => node.relativePath);
    const hashesByPath = await source.unitHashes(stateHash, relPaths);
    const fresh: ContentHashMap = {};
    for (const node of graph.allNodes()) {
      const hash = hashesByPath[node.relativePath];
      if (hash) fresh[node.name] = hash;
    }
    const result = computeEffectiveVersions(graph, fresh);
    evMap = result.evMap;
    contentHashes = result.contentHashes;
    const changeset = diffEvMaps(persisted?.evMap ?? {}, evMap);
    console.log(
      `[BuildV2] EV diff: ${changeset.changed.length} changed, ` +
        `${changeset.added.length} added, ${changeset.removed.length} removed`
    );
    persistEvState({ stateHash, evMap, contentHashes });
  }

  // Step 3: Build anything that's missing from the store
  const buildableNodes = graph
    .allNodes()
    // Trusted units are built only after the approval/reconcile path.
    .filter((n) => isNodeBuildable(n) && n.kind !== "extension" && n.kind !== "app");

  const missing = buildableNodes.filter((node) => {
    const ev = evMap[node.name];
    if (!ev) return false;
    return !buildStore.has(computeBuildKey(node.name, ev, sourcemapForNode(node)));
  });
  if (missing.length > 0) {
    console.log(`[BuildV2] Building ${missing.length} units...`);
    await Promise.all(
      missing.map(async (node) => {
        try {
          await buildUnit(node, assertPresent(evMap[node.name]), graph, workspaceRoot, stateHash);
          console.log(`[BuildV2] Built ${node.name}`);
        } catch (error) {
          console.error(
            `[BuildV2] Failed to build ${node.name}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      })
    );
    console.log(`[BuildV2] Initial builds complete`);
  } else {
    console.log(`[BuildV2] All builds up-to-date`);
  }

  // Step 4: Start the state trigger (subscribes to vcs state advances)
  const trigger = new StateTransitionTrigger({
    graph,
    evMap,
    contentHashes,
    stateHash,
    workspaceRoot,
    source,
  });
  trigger.start();
  console.log("[BuildV2] State trigger started");

  const currentState = () => trigger.getState();
  const recentBuildEvents: BuildSystemBuildEvent[] = [];
  const buildEventListeners = new Set<(event: BuildSystemBuildEvent) => void>();
  const recordBuildEvent = (event: Omit<BuildSystemBuildEvent, "relativePath" | "timestamp">) => {
    const node = currentState().graph.tryGet(event.name);
    const full: BuildSystemBuildEvent = {
      ...event,
      relativePath: node?.relativePath,
      timestamp: new Date().toISOString(),
    };
    recentBuildEvents.push(full);
    if (recentBuildEvents.length > 200) {
      recentBuildEvents.splice(0, recentBuildEvents.length - 200);
    }
    for (const listener of buildEventListeners) {
      try {
        listener(full);
      } catch (err) {
        console.error("[BuildV2] build-event listener failed:", err);
      }
    }
  };

  trigger.on("build-started", ({ name, trigger: t }) => {
    recordBuildEvent({ type: "build-started", name, trigger: t });
  });
  trigger.on("build-complete", ({ name, buildKey, trigger: t }) => {
    recordBuildEvent({ type: "build-complete", name, buildKey, trigger: t });
  });
  trigger.on("build-error", ({ name, error, trigger: t }) => {
    recordBuildEvent({ type: "build-error", name, error, trigger: t });
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const libraryBuildResult = (build: BuildResult): { bundle: string } => ({
    bundle: primaryTextArtifactContent(build),
  });

  /** Rediscover the graph and recompute all EVs at a state (new/unknown units). */
  const contentHashesAt = async (
    graphAtState: PackageGraph,
    atStateHash: string
  ): Promise<ContentHashMap> => {
    const relPaths = graphAtState.allNodes().map((node) => node.relativePath);
    const hashesByPath = await source.unitHashes(atStateHash, relPaths);
    const fresh: ContentHashMap = {};
    for (const node of graphAtState.allNodes()) {
      const hash = hashesByPath[node.relativePath];
      if (hash) fresh[node.name] = hash;
    }
    return fresh;
  };

  const rediscoverAt = (atStateHash: string): Promise<void> => trigger.rediscoverAt(atStateHash);

  const bindRuntimeImage: BuildSystemV2["bindRuntimeImage"] = async (unitPath, requestedRef) => {
    const ref = validateBuildRef(requestedRef);
    let graphAtState: PackageGraph;
    let evMapAtState: EffectiveVersionMap;
    let stateHash: string;

    if (!ref || ref === MAIN_HEAD) {
      const fresh = await source.ensureFresh();
      await trigger.whenSettled();
      if (currentState().stateHash !== fresh.stateHash) {
        await rediscoverAt(fresh.stateHash);
      }
      const snapshot = currentState();
      graphAtState = snapshot.graph;
      evMapAtState = snapshot.evMap;
      stateHash = snapshot.stateHash;
    } else {
      if (ref.startsWith("state:")) {
        stateHash = ref;
      } else if (ref.startsWith("ctx:")) {
        const resolved = await source.resolveHead(ref);
        if (!resolved) throw new Error(`Unknown vcs ref: ${ref}`);
        stateHash = resolved;
      } else {
        throw new Error(`Invalid build ref after validation: ${ref}`);
      }
      graphAtState = await source.discoverGraph(stateHash);
      const hashes = await contentHashesAt(graphAtState, stateHash);
      evMapAtState = computeEffectiveVersions(graphAtState, hashes).evMap;
    }

    let node = resolveUnit(graphAtState, unitPath, workspaceRoot);
    if (!node && (!ref || ref === MAIN_HEAD)) {
      await rediscoverAt(stateHash);
      const snapshot = currentState();
      graphAtState = snapshot.graph;
      evMapAtState = snapshot.evMap;
      node = resolveUnit(graphAtState, unitPath, workspaceRoot);
    }
    if (!node) throw new Error(`Unknown runtime build unit at ${ref ?? MAIN_HEAD}: ${unitPath}`);

    const ev = evMapAtState[node.name];
    if (!ev) throw new Error(`No effective version for ${node.name} at ${stateHash}`);

    const buildKey = computeBuildUnitKey(node, ev);
    await buildUnit(node, ev, graphAtState, workspaceRoot, stateHash);
    return {
      source: node.relativePath,
      unitName: node.name,
      stateHash,
      effectiveVersion: ev,
      buildKey,
    };
  };

  const getBuild = async function getBuild(
    unitPath: string,
    ref?: string,
    options?: BuildUnitOptions
  ): Promise<BuildResult | { bundle: string }> {
    ref = validateBuildRef(ref);
    // ── Pinned-state / head-ref build path ──
    if (ref && ref !== MAIN_HEAD) {
      let buildState: string;
      if (ref.startsWith("state:")) {
        buildState = ref;
      } else if (ref.startsWith("ctx:")) {
        const resolved = await source.resolveHead(ref);
        if (!resolved) throw new Error(`Unknown vcs ref: ${ref}`);
        buildState = resolved;
      } else {
        throw new Error(`Invalid build ref after validation: ${ref}`);
      }

      const graphAtState = await source.discoverGraph(buildState);
      const resolvePinnedUnit = (): { node: GraphNode | null; libraryEntrySubpath?: string } => {
        if (options?.library) {
          const parsed = resolveLibraryUnit(graphAtState, unitPath);
          if (parsed) return parsed;
        }
        return { node: resolveUnit(graphAtState, unitPath, workspaceRoot) };
      };
      const resolved = resolvePinnedUnit();
      const node = resolved.node;
      if (!node) {
        if (unitPath.startsWith("@natstack/") && options?.library) {
          const bundle = await buildPlatformLibrary(unitPath, options.externals ?? []);
          return { bundle };
        }
        throw new Error(`Unknown build unit at ${ref}: ${unitPath}`);
      }
      assertNodeBuildable(node);

      const hashes = await contentHashesAt(graphAtState, buildState);
      const result = computeEffectiveVersions(graphAtState, hashes);
      const ev = result.evMap[node.name];
      if (!ev) {
        throw new Error(`No effective version for ${node.name} at ref ${ref}`);
      }
      const buildOptions = options?.library
        ? { ...options, library: true, libraryEntrySubpath: resolved.libraryEntrySubpath ?? "." }
        : options;
      const build = await buildUnit(
        node,
        ev,
        graphAtState,
        workspaceRoot,
        buildState,
        buildOptions
      );
      return options?.library ? libraryBuildResult(build) : build;
    }

    // unitPath can be a package name or workspace-relative path
    const resolveRequestedUnit = (): { node: GraphNode | null; libraryEntrySubpath?: string } => {
      const { graph } = currentState();
      if (options?.library) {
        const parsed = resolveLibraryUnit(graph, unitPath);
        if (parsed) return parsed;
      }
      return { node: resolveUnit(graph, unitPath, workspaceRoot) };
    };
    let resolved = resolveRequestedUnit();
    let node = resolved.node;
    if (!node) {
      // Unit not in current graph — may have been just created via
      // create_project. Snapshot + rediscover before giving up.
      const fresh = await source.ensureFresh();
      await trigger.whenSettled();
      await rediscoverAt(fresh.stateHash);

      resolved = resolveRequestedUnit();
      node = resolved.node;
      if (!node) {
        // @natstack/* packages aren't in the workspace graph — they're compiled
        // platform packages in node_modules. Build them as library bundles
        // so eval can import them.
        if (unitPath.startsWith("@natstack/") && options?.library) {
          const bundle = await buildPlatformLibrary(unitPath, options.externals ?? []);
          return { bundle };
        }
        throw new Error(`Unknown build unit: ${unitPath}`);
      }
    }
    assertNodeBuildable(node);
    let buildOptions = options?.library
      ? { ...options, library: true, libraryEntrySubpath: resolved.libraryEntrySubpath ?? "." }
      : options;

    // ── HEAD build path ──
    // Snapshot the workspace before building so the artifact is reconstructable
    // from a committed GAD state. Serving loaders do not call this method.
    try {
      const fresh = await source.ensureFresh();
      if (fresh.stateHash !== currentState().stateHash) {
        await trigger.whenSettled();
      }
    } catch {
      // Scan failed — use cached EV (best effort)
    }

    const { graph: headGraph, evMap: headEvMap, stateHash: headStateHash } = currentState();
    // Re-resolve the unit against the freshly-settled graph: settlement may have
    // rediscovered it with a changed entry/dependency set, and building the
    // pre-settle node against the fresh EV map would miss those changes on the
    // first build after a commit.
    const settled = resolveRequestedUnit();
    if (settled.node) {
      node = settled.node;
      resolved = settled;
      assertNodeBuildable(node);
      buildOptions = options?.library
        ? { ...options, library: true, libraryEntrySubpath: resolved.libraryEntrySubpath ?? "." }
        : options;
    }
    const ev = headEvMap[node.name];
    if (!ev) {
      throw new Error(`No effective version for ${node.name}`);
    }

    // Build on demand (buildUnit handles cache + coalescing internally)
    const build = await buildUnit(node, ev, headGraph, workspaceRoot, headStateHash, buildOptions);
    return options?.library ? libraryBuildResult(build) : build;
  } as BuildSystemV2["getBuild"];

  return {
    getBuild,
    bindRuntimeImage,

    async getBuildNpm(
      specifier: string,
      version: string,
      externals?: string[]
    ): Promise<{ bundle: string }> {
      const bundle = await buildNpmLibrary(specifier, version, externals ?? []);
      return { bundle };
    },

    getBuildByKey(key: string): BuildResult | null {
      return buildStore.get(key);
    },

    getEffectiveVersion(unitName: string): string | null {
      return currentState().evMap[unitName] ?? null;
    },

    getExternalDeps(unitName: string): Record<string, string> {
      const { graph } = currentState();
      const node = resolveUnit(graph, unitName, workspaceRoot);
      if (!node) return {};
      return collectTransitiveExternalDeps(node, graph, workspaceRoot, appNodeModuleRoots);
    },

    getBuildProviderDetails(target: "react-native") {
      try {
        const provider = resolveBuildProvider(target);
        return {
          name: provider.name,
          activeEv: provider.activeEv,
          activeBuildKey: provider.activeBuildKey,
          contractVersion: provider.contractVersion,
        };
      } catch {
        return null;
      }
    },

    onBuildProviderChange(callback) {
      return onBuildProviderChange((event) => {
        if (event.target !== "react-native") return;
        callback({
          type: event.type,
          target: event.target,
          provider: {
            name: event.provider.name,
            activeEv: event.provider.activeEv,
            activeBuildKey: event.provider.activeBuildKey,
            contractVersion: event.provider.contractVersion,
          },
        });
      });
    },

    async doctorExtension(unitName: string): Promise<ExtensionDoctorReport> {
      const { graph, evMap } = currentState();
      const node = resolveUnit(graph, unitName, workspaceRoot);
      if (!node) {
        throw new Error(`Unknown extension: ${unitName}`);
      }
      if (node.kind !== "extension") {
        throw new Error(`Build unit is not an extension: ${unitName}`);
      }

      const dependencyMode = normalizeExtensionDependencyMode(
        node.manifest.extension?.dependencyMode
      );
      const externalDeps = collectTransitiveExternalDeps(
        node,
        graph,
        workspaceRoot,
        appNodeModuleRoots
      );
      const dependencyOverrides = collectTransitiveDependencyOverrides(
        node,
        graph,
        workspaceRoot,
        appNodeModuleRoots
      );
      const nodeModulesDir = await ensureExternalDeps(externalDeps, dependencyOverrides);
      const nodePaths = [...(nodeModulesDir ? [nodeModulesDir] : []), ...appNodeModuleRoots];
      const dependencyDiagnostics = analyzeExtensionDependencies(
        externalDeps,
        nodePaths,
        dependencyMode
      );
      const ev = evMap[node.name] ?? null;
      const buildKey = ev
        ? computeBuildKey(
            node.name,
            `${ev}:extension-runtime-abi:${EXTENSION_RUNTIME_ABI_VERSION}`,
            true
          )
        : null;
      const build = buildKey ? buildStore.get(buildKey) : null;
      const extensionDetails =
        build?.metadata.details.kind === "extension" ? build.metadata.details : null;
      const checks: ExtensionDoctorReport["checks"] = [
        { name: "manifest", status: "pass", message: "Extension manifest was discovered." },
        {
          name: "dependency-mode",
          status: "pass",
          message: `dependencyMode=${dependencyDiagnostics.dependencyMode}`,
        },
        {
          name: "runtime-deps",
          status: "pass",
          message: Object.keys(dependencyDiagnostics.runtimeExternalDeps).length
            ? `External runtime deps: ${Object.keys(dependencyDiagnostics.runtimeExternalDeps).join(", ")}`
            : "No external runtime deps are required.",
        },
        {
          name: "build-cache",
          status: build ? "pass" : "warn",
          message: build
            ? `Cached build found with ABI ${extensionDetails?.runtimeAbi ?? "unknown"}.`
            : "No cached build found for the current runtime ABI.",
        },
      ];
      if (extensionDetails?.smokeTest?.passed) {
        checks.push({
          name: "smoke-test",
          status: "pass",
          message: `Build smoke test passed in ${extensionDetails.smokeTest.mode}.`,
        });
      } else if (build) {
        checks.push({
          name: "smoke-test",
          status: "warn",
          message: "Cached build has no recorded smoke-test result.",
        });
      }
      for (const dep of dependencyDiagnostics.classifiedDeps) {
        checks.push({
          name: `dependency:${dep.name}`,
          status:
            dep.reasons.includes("missing-package-json") ||
            dep.reasons.includes("unreadable-package-json")
              ? "warn"
              : "pass",
          message: dep.explanation,
        });
      }

      return {
        name: node.name,
        kind: "extension",
        path: node.relativePath,
        dependencyDiagnostics,
        buildMetadata: build?.metadata ?? null,
        checks,
      };
    },

    async recompute(): Promise<ChangeSet> {
      const fresh = await source.ensureFresh();
      await trigger.whenSettled();
      const previousEvMap = currentState().evMap;
      await rediscoverAt(fresh.stateHash);
      const snapshot = currentState();
      const changes = diffEvMaps(previousEvMap, snapshot.evMap);

      // Trigger builds for changed buildable units
      const buildableChanged = [...changes.changed, ...changes.added].filter((name) => {
        const n = snapshot.graph.tryGet(name);
        return n && isNodeBuildable(n) && n.kind !== "extension" && n.kind !== "app";
      });

      for (const name of buildableChanged) {
        const n = snapshot.graph.get(name);
        const ev = assertPresent(snapshot.evMap[name]);
        const bk = computeBuildKey(name, ev, sourcemapForNode(n));
        if (!buildStore.has(bk)) {
          try {
            await buildUnit(n, ev, snapshot.graph, workspaceRoot, snapshot.stateHash);
          } catch (error) {
            console.error(
              `[BuildV2] Failed to rebuild ${name}:`,
              error instanceof Error ? error.message : String(error)
            );
          }
        }
      }

      return changes;
    },

    async gc(activeUnits: string[]): Promise<{ freed: number }> {
      const { graph, evMap } = currentState();
      const activeKeys = new Set<string>();
      for (const name of activeUnits) {
        const ev = evMap[name];
        if (!ev) continue;
        const n = graph.tryGet(name);
        if (!n) continue;
        activeKeys.add(computeBuildKey(name, ev, sourcemapForNode(n)));
      }
      return buildStore.gc(activeKeys);
    },

    async getAboutPages(): Promise<AboutPageMeta[]> {
      const pages: AboutPageMeta[] = [];
      for (const n of currentState().graph.allNodes()) {
        if (!n.manifest.shell) continue;
        pages.push({
          name: n.relativePath.startsWith("about/") ? n.relativePath.slice(6) : n.relativePath,
          title: n.manifest.title ?? n.name,
          description: n.manifest.description,
          hiddenInLauncher: n.manifest.hiddenInLauncher ?? false,
        });
      }
      return pages;
    },

    getGraph(): PackageGraph {
      return currentState().graph;
    },

    hasUnit(name: string): boolean {
      return currentState().graph.has(name);
    },

    getWorkspaceRoot(): string {
      return workspaceRoot;
    },

    listRecentBuildEvents(unitName?: string): BuildSystemBuildEvent[] {
      const lookupKeys = unitName ? normalizeBuildEventLookupKeys(unitName, workspaceRoot) : null;
      const events = unitName
        ? recentBuildEvents.filter(
            (event) =>
              lookupKeys?.has(event.name) ||
              (event.relativePath ? lookupKeys?.has(event.relativePath) : false)
          )
        : recentBuildEvents;
      return [...events];
    },

    onBuildEvent(callback: (event: BuildSystemBuildEvent) => void): () => void {
      buildEventListeners.add(callback);
      return () => buildEventListeners.delete(callback);
    },

    whenSettled(): Promise<void> {
      return trigger.whenSettled();
    },

    onPushBuild(
      callback: (source: string, trigger?: StateAdvancedEvent, buildKey?: string) => void
    ): void {
      trigger.on(
        "build-complete",
        ({
          name,
          buildKey,
          trigger: t,
        }: {
          name: string;
          buildKey: string;
          trigger?: StateAdvancedEvent;
        }) => {
          const node = currentState().graph.tryGet(name);
          if (node) callback(node.relativePath, t, buildKey);
        }
      );
    },

    async shutdown(): Promise<void> {
      trigger.stop();
      setBuildSourceProvider(null);
      console.log("[BuildV2] Shut down");
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUnit(
  graph: PackageGraph,
  unitPath: string,
  _workspaceRoot: string
): GraphNode | null {
  // Try direct name lookup first
  const byName = graph.tryGet(unitPath);
  if (byName) return byName;

  // Try workspace-relative path (e.g., "panels/chat", "about/about")
  for (const node of graph.allNodes()) {
    if (node.relativePath === unitPath) return node;
  }

  // Try as partial path (e.g., "chat" → "panels/chat")
  for (const node of graph.allNodes()) {
    const basename = path.basename(node.relativePath);
    if (basename === unitPath) return node;
  }

  return null;
}

function resolveLibraryUnit(
  graph: PackageGraph,
  specifier: string
): { node: GraphNode; libraryEntrySubpath: string } | null {
  const names = graph
    .allNodes()
    .map((node) => node.name)
    .sort((a, b) => b.length - a.length);

  for (const name of names) {
    if (specifier === name) {
      return { node: graph.get(name), libraryEntrySubpath: "." };
    }
    if (specifier.startsWith(`${name}/`)) {
      return {
        node: graph.get(name),
        libraryEntrySubpath: `./${specifier.slice(name.length + 1)}`,
      };
    }
  }

  return null;
}

function normalizeBuildEventLookupKeys(input: string, workspaceRoot: string): Set<string> {
  const keys = new Set<string>();
  const add = (value: string): void => {
    const normalized = value
      .replace(/\\/g, "/")
      .replace(/^\.\/+/, "")
      .replace(/\/+$/, "");
    if (normalized) keys.add(normalized);
  };

  const raw = input.trim();
  if (!raw) return keys;
  add(raw);

  if (path.isAbsolute(raw)) {
    const relative = path.relative(workspaceRoot, raw);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) add(relative);
  }

  const workspacePrefixed = raw.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (workspacePrefixed.startsWith("workspace/")) add(workspacePrefixed.slice("workspace/".length));

  return keys;
}

function sourcemapForNode(node: GraphNode): boolean {
  return sourcemapForKind(node.kind, node.manifest.sourcemap);
}

function dependencyErrorMessage(node: GraphNode): string | null {
  return node.dependencyErrors && node.dependencyErrors.length > 0
    ? node.dependencyErrors.join("; ")
    : null;
}

function isNodeBuildable(node: GraphNode): boolean {
  return isBuildableKind(node.kind) && dependencyErrorMessage(node) === null;
}

function assertNodeBuildable(node: GraphNode): void {
  const message = dependencyErrorMessage(node);
  if (message) throw new Error(`Build blocked for ${node.name}: ${message}`);
}

// re-exported for stateTrigger consumers
export { unitsForChangedPaths };
