/**
 * Build System V2 — Public API + RPC service registration.
 *
 * The build system lives entirely in the server process.
 * Electron requests builds via RPC. The headless server gets builds for free.
 *
 * Builds are triggered by protected workspace publication effects. Cold start
 * compares the persisted effective-version state with the exact current
 * publication resolved from the semantic authority.
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
  setBuildRootConfig,
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
import {
  setBuildSourceProvider,
  getBuildSourceProvider,
  collectTransitiveInternalDeps,
  type BuildSourceProvider,
} from "./buildSource.js";
import { validateBuildRef } from "./refs.js";
import { typecheckUnit } from "./typecheckFold.js";
import {
  BuildRequestError,
  diagnosticsFromError,
  hasErrors,
  type BuildDiagnostic,
} from "./diagnostics.js";
import { recordDiagnostics, diagnosticsForUnit } from "./diagnosticsStore.js";
import type { LibraryBuildTarget } from "@vibestudio/service-schemas/build";
import type { UnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import {
  StateTransitionTrigger,
  unitsForChangedPaths,
  isBuildableKind,
  sourcemapForKind,
  MAIN_HEAD,
  type StateChangedUnit,
  type WorkspaceStateSource,
} from "./stateTrigger.js";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import {
  collectTransitiveDependencyOverrides,
  collectTransitiveExternalDeps,
  ensureExternalDeps,
} from "./externalDeps.js";
import { EXTENSION_RUNTIME_ABI_VERSION } from "@vibestudio/shared/extensionRuntimeAbi";
import { ABOUT_SOURCE_PREFIX, isAboutSource } from "@vibestudio/workspace-contracts/aboutNamespace";
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
  /** Structured esbuild/tsc diagnostics on a build-error event. */
  diagnostics?: BuildDiagnostic[];
  trigger?: ProtectedPublicationEvent;
  timestamp: string;
}

export interface BuildSystemUnitChangeEvent extends StateChangedUnit {
  trigger: ProtectedPublicationEvent;
}

export interface RuntimeImageBinding {
  source: string;
  unitName: string;
  stateHash: string;
  effectiveVersion: string;
  buildKey: string;
  executionDigest: string;
  authorityRequests: UnitAuthorityManifest["requests"];
  authorityEvalCeilings: UnitAuthorityManifest["evalCeilings"];
}

// ---------------------------------------------------------------------------
// Exact-state unit build report — agent-actionable, not a blob.
// ---------------------------------------------------------------------------

export type UnitBuildTargetKind = "runtime" | "library:panel" | "library:worker";

export interface UnitBuildTarget {
  target: UnitBuildTargetKind;
  exportPath?: string;
  buildKey?: string;
  /** Artifact manifests only — never byte content. */
  artifacts?: Array<{ path: string; role: string; contentType: string; integrity?: string }>;
  diagnostics: BuildDiagnostic[];
}

export interface UnitBuildReport {
  repoPath: string;
  unitName?: string;
  kind: GraphNode["kind"] | "content";
  status: "ok" | "failed" | "skipped";
  /** All target diagnostics in one agent-actionable list. */
  diagnostics: BuildDiagnostic[];
  builds: UnitBuildTarget[];
}

export type { BuildUnitOptions } from "./builder.js";
export type { WorkspaceStateSource, BuildRecord, StateChangedUnit } from "./stateTrigger.js";
export type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
export type { BuildSourceProvider } from "./buildSource.js";
export type { BuildDiagnostic } from "./diagnostics.js";
export { setBuildSourceProvider, directorySourceProvider } from "./buildSource.js";
export {
  clearBuildProvidersForTests,
  listBuildProviders,
  registerBuildProvider,
  resolveBuildProvider,
  onBuildProviderChange,
  unregisterBuildProvider,
} from "./buildProviderRegistry.js";

export interface BuildUnitResolution {
  unitPath: string;
  unitName: string;
  kind: GraphNode["kind"];
  stateHash: string;
  effectiveVersion: string;
}

export interface BuildUnitIdentityResolution extends BuildUnitResolution {
  dependencyEvs: Record<string, string>;
  externalDeps: Record<string, string>;
}

/** Exact-state discovery row for dynamic runtime and documentation catalogs. */
export interface BuildUnitCatalogEntry extends BuildUnitResolution {
  manifest: GraphNode["manifest"];
}

export interface BuildSystemRootOptions {
  /**
   * Host app root containing package.json/pnpm-lock.yaml/pnpm-workspace.yaml.
   * Defaults to VIBESTUDIO_APP_ROOT, then dirname(workspaceRoot), for older tests.
   */
  appRoot?: string;
  /**
   * Workspace dependency root containing the userland package/lock/workspace
   * files that influence build cache identity. This can differ from the active
   * managed workspace root in dev, where the app runs from a copied workspace
   * under user data but dependencies are installed from <appRoot>/workspace.
   */
  dependencyWorkspaceRoot?: string;
}

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
  ): Promise<{ bundle: string; format: "cjs" | "async-cjs" }>;
  getBuild(
    unitPath: string,
    ref?: string,
    options?: BuildUnitOptions & { library?: false | undefined }
  ): Promise<BuildResult>;

  /** Resolve a build unit at `main`, a `ctx:*` context selector, or `state:*`. */
  resolveBuildUnit(unitPath: string, ref?: string): Promise<BuildUnitResolution | null>;

  /** Resolve the complete version-bound trust identity without running a build. */
  resolveBuildUnitIdentity(
    unitPath: string,
    ref?: string
  ): Promise<BuildUnitIdentityResolution | null>;

  /** Enumerate exact executable identities from one immutable workspace view. */
  listBuildUnitIdentities(
    ref?: string,
    kinds?: readonly GraphNode["kind"][]
  ): Promise<BuildUnitIdentityResolution[]>;

  /** Enumerate build units and their declarations from one exact workspace view. */
  listBuildUnits(
    ref?: string,
    kinds?: readonly GraphNode["kind"][]
  ): Promise<BuildUnitCatalogEntry[]>;

  /** Get an immutable build-store artifact by build key. */
  getBuildByKey(key: string): BuildResult | null;

  /**
   * Binder API for runtime entities. Resolves a build content selector to an
   * exact state off the hot path, builds the unit from that immutable state, and
   * returns the global artifact identity the loader can fetch by key.
   */
  bindRuntimeImage(unitPath: string, ref?: string): Promise<RuntimeImageBinding>;

  /** Build an npm package as a CJS library bundle for sandbox use. */
  getBuildNpm(
    specifier: string,
    version: string,
    externals?: string[]
  ): Promise<{ bundle: string; format: "cjs" }>;

  /** Get effective version by package name or workspace-relative source path. */
  getEffectiveVersion(unitNameOrPath: string): string | null;

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

  /**
   * Build a single unit at an exact state (or the protected workspace
   * publication) and return its `UnitBuildReport` with structured diagnostics.
   * Does not publish content.
   */
  getBuildReport(unitName: string, stateHash?: string): Promise<UnitBuildReport>;

  /** Most recent structured build diagnostics for a unit, if any were captured. */
  getUnitDiagnostics(unitName: string): BuildDiagnostic[] | null;

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
   * Subscribe to effective-version changes detected from workspace publications.
   * Trusted unit hosts use this to rebuild apps/extensions through their
   * approval-aware activation paths because the state trigger intentionally
   * does not build trusted units directly.
   */
  onUnitChange(callback: (event: BuildSystemUnitChangeEvent) => void): () => void;

  /**
   * Register a callback for when a state-triggered build completes.
   * The callback receives the source path (e.g. "panels/chat") so the
   * HTTP server can invalidate its serving cache.
   */
  onPushBuild(
    callback: (source: string, trigger?: ProtectedPublicationEvent, buildKey?: string) => void
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
  appNodeModules: string | string[],
  rootOptions: BuildSystemRootOptions = {}
): Promise<BuildSystemV2> {
  console.log("[BuildV2] Initializing...");
  const appNodeModuleRoots = Array.isArray(appNodeModules) ? appNodeModules : [appNodeModules];

  // Build cache identity depends on dependency manifests, not on where the
  // active managed workspace copy happens to live. Server startup passes these
  // roots explicitly; defaults preserve direct test construction.
  setBuildRootConfig({
    appRoot:
      rootOptions.appRoot ?? process.env["VIBESTUDIO_APP_ROOT"] ?? path.dirname(workspaceRoot),
    workspaceRoot: rootOptions.dependencyWorkspaceRoot ?? workspaceRoot,
  });

  // Declare where @vibestudio/* platform packages live (workspace:* deps).
  initBuilder(appNodeModuleRoots);
  setBuildSourceProvider(source);

  // Step 1: Snapshot the workspace + discover package graph from that state
  // (scan-on-demand —
  // out-of-band edits made while the server was down become a first-class
  // observed transition right here).
  const tFresh = Date.now();
  const { stateHash } = await source.ensureFresh();
  const tGraph = Date.now();
  const graph = await source.discoverGraph(stateHash);
  const nodeCount = graph.allNodes().length;
  console.log(
    `[BuildV2] Discovered ${nodeCount} units in workspace (ensureFresh=${tGraph - tFresh}ms discoverGraph=${Date.now() - tGraph}ms)`
  );

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
    const tEv = Date.now();
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
        `${changeset.added.length} added, ${changeset.removed.length} removed (${Date.now() - tEv}ms)`
    );
    persistEvState({ stateHash, evMap, contentHashes });
  }

  // Step 3: Start the state trigger (subscribes to vcs state advances).
  // Panels and workers build on demand through getBuild/bindRuntimeImage; a
  // broad speculative startup build competes with the first unit a user
  // actually opens and makes shutdown wait for unrelated sample/test units.
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
  const unitChangeListeners = new Set<(event: BuildSystemUnitChangeEvent) => void>();
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
  trigger.on("build-error", ({ name, error, diagnostics, trigger: t }) => {
    recordBuildEvent({ type: "build-error", name, error, diagnostics, trigger: t });
  });
  trigger.on("change-detected", ({ units, trigger: t }) => {
    for (const unit of units) {
      const event: BuildSystemUnitChangeEvent = { ...unit, trigger: t };
      for (const listener of unitChangeListeners) {
        try {
          listener(event);
        } catch (err) {
          console.error("[BuildV2] unit-change listener failed:", err);
        }
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const libraryBuildResult = (
    build: BuildResult
  ): { bundle: string; format: "cjs" | "async-cjs" } => ({
    bundle: primaryTextArtifactContent(build),
    format: build.metadata.details.kind === "library" ? build.metadata.details.format : "cjs",
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

  // Runtime bindings are immutable facts. Cache them by the exact protected
  // state + unit + EV, not by a mutable source label. The fast path is valid
  // only while the publication trigger is settled; any queued publication
  // forces the normal settlement path before selecting an identity.
  const runtimeBindingCache = new Map<string, RuntimeImageBinding>();
  const runtimeBindingFlights = new Map<string, Promise<RuntimeImageBinding>>();
  const runtimeBindingKey = (stateHash: string, unitName: string, ev: string) =>
    `${stateHash}\0${unitName}\0${ev}`;
  const usableCachedBinding = (key: string): RuntimeImageBinding | null => {
    const binding = runtimeBindingCache.get(key);
    if (!binding) return null;
    if (buildStore.get(binding.buildKey)) return binding;
    runtimeBindingCache.delete(key);
    return null;
  };

  const bindRuntimeImage: BuildSystemV2["bindRuntimeImage"] = async (unitPath, requestedRef) => {
    const ref = validateBuildRef(requestedRef);

    if ((!ref || ref === MAIN_HEAD) && trigger.isSettled()) {
      const snapshot = currentState();
      const currentNode = resolveUnit(snapshot.graph, unitPath, workspaceRoot);
      const currentEv = currentNode ? snapshot.evMap[currentNode.name] : undefined;
      if (currentNode && currentEv) {
        const cached = usableCachedBinding(
          runtimeBindingKey(snapshot.stateHash, currentNode.name, currentEv)
        );
        if (cached) return cached;
      }
    }

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
        // `ctx:` is a user-facing build selector. Resolve the semantic
        // context's exact working frontier before graph discovery.
        stateHash = await source.resolveContextState(ref.slice(4));
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

    const identityKey = runtimeBindingKey(stateHash, node.name, ev);
    const cached = usableCachedBinding(identityKey);
    if (cached) return cached;
    const existingFlight = runtimeBindingFlights.get(identityKey);
    if (existingFlight) return existingFlight;

    const flight = (async (): Promise<RuntimeImageBinding> => {
      const buildKey = computeBuildUnitKey(node, ev);
      const build = await buildUnit(node, ev, graphAtState, workspaceRoot, stateHash);
      const executionDigest = build.metadata.execution?.executionDigest;
      if (!executionDigest) {
        throw new Error(`Runtime build ${build.buildKey} is missing its sealed execution identity`);
      }
      const authority = build.metadata.authority;
      if (!authority) {
        throw new Error(`Runtime build ${build.buildKey} is missing its sealed authority envelope`);
      }
      const binding: RuntimeImageBinding = {
        source: node.relativePath,
        unitName: node.name,
        stateHash,
        effectiveVersion: ev,
        buildKey,
        executionDigest,
        authorityRequests: authority.requests,
        authorityEvalCeilings: authority.evalCeilings,
      };
      runtimeBindingCache.set(identityKey, binding);
      return binding;
    })().finally(() => {
      runtimeBindingFlights.delete(identityKey);
    });
    runtimeBindingFlights.set(identityKey, flight);
    return flight;
  };

  // -------------------------------------------------------------------------
  // Exact-state unit build reports
  // -------------------------------------------------------------------------

  interface GraphView {
    graph: PackageGraph;
    evMap: EffectiveVersionMap;
  }

  /** Discover + EV-compute over one immutable content view. */
  const viewAt = async (viewStateHash: string, knownGraph?: PackageGraph): Promise<GraphView> => {
    const graph = knownGraph ?? (await source.discoverGraph(viewStateHash));
    const hashes = await contentHashesAt(graph, viewStateHash);
    const evMap = computeEffectiveVersions(graph, hashes).evMap;
    return { graph, evMap };
  };

  /** Manifest-only artifacts (no byte content) for a report. */
  const artifactManifests = (build: BuildResult): UnitBuildTarget["artifacts"] =>
    build.artifacts.map((a) => ({
      path: a.path,
      role: a.role,
      contentType: a.contentType,
      ...(a.integrity ? { integrity: a.integrity } : {}),
    }));

  /**
   * Build a single target for a unit at a state, capturing structured esbuild
   * diagnostics on failure + folding tsc diagnostics. Never throws — failures
   * land in the returned target's `diagnostics`.
   */
  const buildOneTarget = async (
    node: GraphNode,
    ev: string,
    graphAtView: PackageGraph,
    viewStateHash: string,
    spec: { target: "runtime" } | { target: "library:panel" | "library:worker"; exportPath: string }
  ): Promise<UnitBuildTarget> => {
    const libraryTarget: LibraryBuildTarget | null =
      spec.target === "library:panel"
        ? "panel"
        : spec.target === "library:worker"
          ? "worker"
          : null;
    const options: BuildUnitOptions | undefined = libraryTarget
      ? {
          library: true,
          libraryTarget,
          libraryEntrySubpath: (spec as { exportPath: string }).exportPath,
        }
      : undefined;
    const buildKey = computeBuildUnitKey(node, ev, options);

    const internalDeps = collectTransitiveInternalDeps(node, graphAtView);
    let diagnostics: BuildDiagnostic[] = [];
    let artifacts: UnitBuildTarget["artifacts"] | undefined;
    let buildError: unknown = null;
    try {
      const build = await buildUnit(node, ev, graphAtView, workspaceRoot, viewStateHash, options);
      artifacts = artifactManifests(build);
    } catch (error) {
      buildError = error;
    }

    // Fold typecheck diagnostics from the materialized source (best effort).
    // The same source root gives esbuild failure paths workspace coordinates
    // instead of cache/temp checkout paths.
    try {
      const { sourceRoot } = await getBuildSourceProvider().materializeForBuild(
        internalDeps,
        viewStateHash,
        workspaceRoot
      );
      if (buildError != null) {
        diagnostics = diagnosticsFromError(buildError, {
          workspaceRoot,
          sourceRoot,
          unitRelativePath: node.relativePath,
        });
      }
      // Provision resolution exactly like the build: workspace deps from the
      // materialized subtrees, external deps from the app node_modules. Without
      // both, the bare source root resolves nothing → false "Cannot find module".
      const tsc = await typecheckUnit(
        node.relativePath,
        sourceRoot,
        internalDeps.map((u) => ({ name: u.name, relativePath: u.relativePath })),
        appNodeModuleRoots
      );
      diagnostics = [...diagnostics, ...tsc];
    } catch (err) {
      console.warn(
        `[BuildV2] typecheck materialize failed for ${node.name}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
    if (buildError != null && diagnostics.length === 0) {
      diagnostics = diagnosticsFromError(buildError, {
        workspaceRoot,
        unitRelativePath: node.relativePath,
      });
    }

    recordDiagnostics(node.name, buildKey, diagnostics);
    return {
      target: spec.target,
      ...(spec.target !== "runtime"
        ? { exportPath: (spec as { exportPath: string }).exportPath }
        : {}),
      buildKey,
      ...(artifacts ? { artifacts } : {}),
      diagnostics,
    };
  };

  /**
   * Infer which library targets a package needs based on its dependents' kinds.
   * panel/about → library:panel; worker/extension → library:worker; app builds
   * its own graph but may pull a package as either, so it contributes both.
   * Falls back to BOTH when no buildable dependents are known.
   */
  const libraryTargetsForDependents = (
    pkgName: string,
    graphAtView: PackageGraph
  ): Set<"library:panel" | "library:worker"> => {
    const targets = new Set<"library:panel" | "library:worker">();
    for (const depName of graphAtView.getReverseDeps(pkgName)) {
      const dep = graphAtView.tryGet(depName);
      if (!dep) continue;
      switch (dep.kind) {
        case "panel":
          targets.add("library:panel");
          break;
        case "worker":
        case "extension":
          targets.add("library:worker");
          break;
        case "app":
          targets.add("library:panel");
          targets.add("library:worker");
          break;
        default:
          break;
      }
    }
    if (targets.size === 0) {
      targets.add("library:panel");
      targets.add("library:worker");
    }
    return targets;
  };

  /** All export subpaths to validate for a package (root + declared exports). */
  const packageExportPaths = (node: GraphNode): string[] => {
    const set = new Set<string>(["."]);
    for (const e of node.exports ?? []) set.add(e);
    return [...set];
  };

  /**
   * Build a unit's full report at a view. For packages this produces a
   * library:* target per (inferred target × export path); for buildable units a
   * single runtime target; content-only / templates are skipped.
   */
  const buildUnitReport = async (
    node: GraphNode,
    view: GraphView,
    viewStateHash: string
  ): Promise<UnitBuildReport> => {
    const ev = view.evMap[node.name];
    const base: Omit<UnitBuildReport, "status" | "diagnostics" | "builds"> = {
      repoPath: node.relativePath,
      unitName: node.name,
      kind: node.kind,
    };
    if (!ev) {
      return { ...base, status: "skipped", diagnostics: [], builds: [] };
    }
    if (node.kind === "template") {
      return { ...base, status: "skipped", diagnostics: [], builds: [] };
    }

    const builds: UnitBuildTarget[] = [];
    if (node.kind === "package") {
      const targets = libraryTargetsForDependents(node.name, view.graph);
      const exports = packageExportPaths(node);
      for (const target of targets) {
        for (const exportPath of exports) {
          builds.push(
            await buildOneTarget(node, ev, view.graph, viewStateHash, { target, exportPath })
          );
        }
      }
    } else {
      builds.push(await buildOneTarget(node, ev, view.graph, viewStateHash, { target: "runtime" }));
    }

    const diagnostics = builds.flatMap((build) => build.diagnostics);
    const failed = hasErrors(diagnostics);
    return { ...base, status: failed ? "failed" : "ok", diagnostics, builds };
  };

  const getBuild = async function getBuild(
    unitPath: string,
    ref?: string,
    options?: BuildUnitOptions
  ): Promise<BuildResult | { bundle: string; format: "cjs" | "async-cjs" }> {
    ref = validateBuildRef(ref);
    // ── Exact state / semantic-context build selector ──
    if (ref && ref !== MAIN_HEAD) {
      let buildState: string;
      if (ref.startsWith("state:")) {
        buildState = ref;
      } else if (ref.startsWith("ctx:")) {
        buildState = await source.resolveContextState(ref.slice(4));
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
        if (unitPath.startsWith("@vibestudio/") && options?.library) {
          const bundle = await buildPlatformLibrary(unitPath, options.externals ?? []);
          return { bundle, format: "cjs" };
        }
        throw new BuildRequestError(
          "package_not_found",
          `Unknown build unit at ${ref}: ${unitPath}`,
          { specifier: unitPath, ref }
        );
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
        // @vibestudio/* packages aren't in the workspace graph — they're compiled
        // platform packages in node_modules. Build them as library bundles
        // so eval can import them.
        if (unitPath.startsWith("@vibestudio/") && options?.library) {
          const bundle = await buildPlatformLibrary(unitPath, options.externals ?? []);
          return { bundle, format: "cjs" };
        }
        throw new BuildRequestError("package_not_found", `Unknown build unit: ${unitPath}`, {
          specifier: unitPath,
          ref: "main",
        });
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
    console.log(`[BuildV2] head library ${unitPath}: building ${node.name}`);
    const build = await buildUnit(node, ev, headGraph, workspaceRoot, headStateHash, buildOptions);
    console.log(`[BuildV2] head library ${unitPath}: build ready ${build.buildKey}`);
    return options?.library ? libraryBuildResult(build) : build;
  } as BuildSystemV2["getBuild"];

  return {
    getBuild,
    bindRuntimeImage,

    async resolveBuildUnit(
      unitPath: string,
      requestedRef?: string
    ): Promise<BuildUnitResolution | null> {
      const ref = validateBuildRef(requestedRef);
      const toResolution = (
        node: GraphNode,
        stateHash: string,
        effectiveVersion: string
      ): BuildUnitResolution => ({
        unitPath: node.relativePath,
        unitName: node.name,
        kind: node.kind,
        stateHash,
        effectiveVersion,
      });

      if (ref && ref !== MAIN_HEAD) {
        const stateHash = ref.startsWith("state:")
          ? ref
          : await source.resolveContextState(ref.slice("ctx:".length));
        const graph = await source.discoverGraph(stateHash);
        const node = resolveUnit(graph, unitPath, workspaceRoot);
        if (!node) return null;
        const hashes = await contentHashesAt(graph, stateHash);
        const effectiveVersion = computeEffectiveVersions(graph, hashes).evMap[node.name];
        if (!effectiveVersion) {
          throw new Error(`No effective version for ${node.name} at ${stateHash}`);
        }
        return toResolution(node, stateHash, effectiveVersion);
      }

      const resolveCurrent = (): BuildUnitResolution | null => {
        const snapshot = currentState();
        const node = resolveUnit(snapshot.graph, unitPath, workspaceRoot);
        if (!node) return null;
        const effectiveVersion = snapshot.evMap[node.name];
        if (!effectiveVersion) {
          throw new Error(`No effective version for ${node.name} at ${snapshot.stateHash}`);
        }
        return toResolution(node, snapshot.stateHash, effectiveVersion);
      };

      let resolved = resolveCurrent();
      if (!resolved) {
        const fresh = await source.ensureFresh();
        await trigger.whenSettled();
        if (currentState().stateHash !== fresh.stateHash) {
          await rediscoverAt(fresh.stateHash);
        }
        resolved = resolveCurrent();
      }
      return resolved;
    },

    async resolveBuildUnitIdentity(
      unitPath: string,
      requestedRef?: string
    ): Promise<BuildUnitIdentityResolution | null> {
      const ref = validateBuildRef(requestedRef);
      let stateHash: string;
      let graph: PackageGraph;
      let evMap: EffectiveVersionMap;
      if (ref && ref !== MAIN_HEAD) {
        stateHash = ref.startsWith("state:")
          ? ref
          : await source.resolveContextState(ref.slice("ctx:".length));
        graph = await source.discoverGraph(stateHash);
        const hashes = await contentHashesAt(graph, stateHash);
        evMap = computeEffectiveVersions(graph, hashes).evMap;
      } else {
        const snapshot = currentState();
        stateHash = snapshot.stateHash;
        graph = snapshot.graph;
        evMap = snapshot.evMap;
      }
      const node = resolveUnit(graph, unitPath, workspaceRoot);
      if (!node) return null;
      const effectiveVersion = evMap[node.name];
      if (!effectiveVersion) {
        throw new Error(`No effective version for ${node.name} at ${stateHash}`);
      }
      const dependencyEvs: Record<string, string> = {};
      for (const dependency of collectTransitiveInternalDeps(node, graph)) {
        const dependencyEv = evMap[dependency.name];
        if (dependencyEv) dependencyEvs[dependency.name] = dependencyEv;
      }
      return {
        unitPath: node.relativePath,
        unitName: node.name,
        kind: node.kind,
        stateHash,
        effectiveVersion,
        dependencyEvs,
        externalDeps: collectTransitiveExternalDeps(node, graph, workspaceRoot, appNodeModuleRoots),
      };
    },

    async listBuildUnitIdentities(
      requestedRef?: string,
      kinds?: readonly GraphNode["kind"][]
    ): Promise<BuildUnitIdentityResolution[]> {
      const ref = validateBuildRef(requestedRef);
      let stateHash: string;
      let graph: PackageGraph;
      let evMap: EffectiveVersionMap;
      if (ref && ref !== MAIN_HEAD) {
        stateHash = ref.startsWith("state:")
          ? ref
          : await source.resolveContextState(ref.slice("ctx:".length));
        graph = await source.discoverGraph(stateHash);
        const hashes = await contentHashesAt(graph, stateHash);
        evMap = computeEffectiveVersions(graph, hashes).evMap;
      } else {
        const snapshot = currentState();
        stateHash = snapshot.stateHash;
        graph = snapshot.graph;
        evMap = snapshot.evMap;
      }
      const admittedKinds = kinds ? new Set(kinds) : null;
      return graph
        .allNodes()
        .filter((node) => !admittedKinds || admittedKinds.has(node.kind))
        .map((node) => {
          const effectiveVersion = evMap[node.name];
          if (!effectiveVersion) {
            throw new Error(`No effective version for ${node.name} at ${stateHash}`);
          }
          const dependencyEvs: Record<string, string> = {};
          for (const dependency of collectTransitiveInternalDeps(node, graph)) {
            const dependencyEv = evMap[dependency.name];
            if (dependencyEv) dependencyEvs[dependency.name] = dependencyEv;
          }
          return {
            unitPath: node.relativePath,
            unitName: node.name,
            kind: node.kind,
            stateHash,
            effectiveVersion,
            dependencyEvs,
            externalDeps: collectTransitiveExternalDeps(
              node,
              graph,
              workspaceRoot,
              appNodeModuleRoots
            ),
          };
        })
        .sort((left, right) => left.unitName.localeCompare(right.unitName));
    },

    async listBuildUnits(
      requestedRef?: string,
      kinds?: readonly GraphNode["kind"][]
    ): Promise<BuildUnitCatalogEntry[]> {
      const ref = validateBuildRef(requestedRef);
      let stateHash: string;
      let graph: PackageGraph;
      let evMap: EffectiveVersionMap;
      if (ref && ref !== MAIN_HEAD) {
        stateHash = ref.startsWith("state:")
          ? ref
          : await source.resolveContextState(ref.slice("ctx:".length));
        graph = await source.discoverGraph(stateHash);
        const hashes = await contentHashesAt(graph, stateHash);
        evMap = computeEffectiveVersions(graph, hashes).evMap;
      } else {
        const snapshot = currentState();
        stateHash = snapshot.stateHash;
        graph = snapshot.graph;
        evMap = snapshot.evMap;
      }
      const admittedKinds = kinds ? new Set(kinds) : null;
      return graph
        .allNodes()
        .filter((node) => !admittedKinds || admittedKinds.has(node.kind))
        .map((node) => {
          const effectiveVersion = evMap[node.name];
          if (!effectiveVersion) {
            throw new Error(`No effective version for ${node.name} at ${stateHash}`);
          }
          return {
            unitPath: node.relativePath,
            unitName: node.name,
            kind: node.kind,
            stateHash,
            effectiveVersion,
            manifest: node.manifest,
          };
        })
        .sort((left, right) => left.unitName.localeCompare(right.unitName));
    },

    async getBuildNpm(
      specifier: string,
      version: string,
      externals?: string[]
    ): Promise<{ bundle: string; format: "cjs" }> {
      const bundle = await buildNpmLibrary(specifier, version, externals ?? []);
      return { bundle, format: "cjs" };
    },

    getBuildByKey(key: string): BuildResult | null {
      return buildStore.get(key);
    },

    getEffectiveVersion(unitNameOrPath: string): string | null {
      const snapshot = currentState();
      const node = resolveUnit(snapshot.graph, unitNameOrPath, workspaceRoot);
      return node ? (snapshot.evMap[node.name] ?? null) : null;
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

    async getBuildReport(unitName: string, stateHash?: string): Promise<UnitBuildReport> {
      const ref = validateBuildRef(stateHash);
      let view: GraphView;
      let viewStateHash: string;
      if (!ref || ref === MAIN_HEAD) {
        try {
          const fresh = await source.ensureFresh();
          await trigger.whenSettled();
          if (currentState().stateHash !== fresh.stateHash) {
            await rediscoverAt(fresh.stateHash);
          }
        } catch {
          // best effort — fall back to current snapshot
        }
        const snapshot = currentState();
        view = { graph: snapshot.graph, evMap: snapshot.evMap };
        viewStateHash = snapshot.stateHash;
      } else {
        let resolvedState: string;
        if (ref.startsWith("state:")) {
          resolvedState = ref;
        } else if (ref.startsWith("ctx:")) {
          resolvedState = await source.resolveContextState(ref.slice(4));
        } else {
          throw new Error(`Invalid build ref after validation: ${ref}`);
        }
        viewStateHash = resolvedState;
        view = await viewAt(resolvedState);
      }
      const node = resolveUnit(view.graph, unitName, workspaceRoot);
      if (!node) {
        return {
          repoPath: unitName,
          kind: "content",
          status: "skipped",
          diagnostics: [],
          builds: [],
        };
      }
      return buildUnitReport(node, view, viewStateHash);
    },

    getUnitDiagnostics(unitName: string): BuildDiagnostic[] | null {
      const node = resolveUnit(currentState().graph, unitName, workspaceRoot);
      return diagnosticsForUnit(node?.name ?? unitName);
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
        // About pages are gated purely by location: any unit under workspace/about/.
        // (No `shell` manifest flag — an about page is just a normal panel that
        // lives in about/.)
        if (!isAboutSource(n.relativePath)) continue;
        pages.push({
          name: n.relativePath.slice(ABOUT_SOURCE_PREFIX.length),
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

    onUnitChange(callback: (event: BuildSystemUnitChangeEvent) => void): () => void {
      unitChangeListeners.add(callback);
      return () => unitChangeListeners.delete(callback);
    },

    whenSettled(): Promise<void> {
      return trigger.whenSettled();
    },

    onPushBuild(
      callback: (source: string, trigger?: ProtectedPublicationEvent, buildKey?: string) => void
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
          trigger?: ProtectedPublicationEvent;
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
