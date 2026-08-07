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
  buildUnit,
  computeBuildUnitKey,
  buildNpmLibrary,
  buildPlatformLibrary,
  initBuilder,
  type BuildUnitOptions,
} from "./builder.js";
import {
  setBuildSourceProvider,
  getBuildSourceProvider,
  collectTransitiveInternalDeps,
  type BuildSourceProvider,
} from "./buildSource.js";
import { validateBuildRef } from "./refs.js";
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
  createExactWorkspaceAuthorityEnvironment,
  resolveProviderCatalog,
  type ExactWorkspaceAuthorityEnvironment,
  type ExactWorkspaceServiceBinding,
} from "./userlandAuthority.js";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import {
  authorityDependencyIndexFromFacts,
  authorityConsumersForProviderChanges,
  type AuthorityDependencyIndex,
} from "./authorityDependencyIndex.js";
import { AuthorityIndexManager } from "./authorityIndexManager.js";
import {
  AuthorityAnalysisCache,
  authorityModuleClosureDigest,
  type AuthorityCompilerDependency,
  type AuthorityConsumerIdentity,
  type AuthorityIndexIdentity,
} from "./authorityAnalysisCache.js";
import { analyzeWorkspaceServiceCalls } from "./userlandAuthorityAnalyzer.js";
import {
  createAuthorityCompilerSnapshot,
  type AuthorityCompilerSnapshot,
} from "./authorityCompilerSnapshot.js";
import { workspaceRpcSchemaVersion } from "./workspaceRpcSchemas.js";
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
import { collectTransitiveExternalDeps } from "./externalDeps.js";
import { ABOUT_SOURCE_PREFIX, isAboutSource } from "@vibestudio/workspace-contracts/aboutNamespace";
import { assertPresent } from "../../lintHelpers";
import { onBuildProviderChange, resolveBuildProvider } from "./buildProviderRegistry.js";
import type {
  ExecutionArtifactRefV1,
  ExecutionRootProvider,
  ExecutionSourceContentRoot,
} from "@vibestudio/shared/execution/retention";
import {
  ExecutionRootProviderRegistry,
  executionArtifactRefFromBuild,
} from "../executionRootProviders.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AboutPageMeta {
  name: string;
  title: string;
  description?: string;
  hiddenInLauncher: boolean;
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
  /** Complete immutable identity, verified from the exact built artifact. */
  artifact: ExecutionArtifactRefV1;
  /** Complete sealed authority envelope for this exact executable build. */
  authority: UnitAuthorityManifest;
}

// ---------------------------------------------------------------------------
// Exact-state unit build report — agent-actionable, not a blob.
// ---------------------------------------------------------------------------

export type UnitBuildTargetKind = "runtime" | "library:panel" | "library:worker";

export interface UnitBuildTarget {
  target: UnitBuildTargetKind;
  exportPath?: string;
  buildKey?: string;
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

interface GraphView {
  graph: PackageGraph;
  evMap: EffectiveVersionMap;
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
  /**
   * Host-owned registries whose durable records resolve immutable build keys.
   * Collection is intentionally late-bound so the build system can start
   * before its consumers without making callers maintain an active-unit list.
   */
  executionRootProviders?: readonly ExecutionRootProvider[];
  /** Existing host diagnostics subscriber for visible retention findings. */
  onRetentionDiagnostic?: (report: BuildRetentionReport) => void;
  /** Exact-state live workspace service declarations used only to diagnose an
   * installed consumer's `workspace-service:<name>` manifest requirement. */
  workspaceAuthorityEnvironmentAt?: (
    stateHash: string
  ) => Promise<{ services: readonly ExactWorkspaceServiceBinding[] }>;
}

export interface BuildRetentionReport {
  epoch: number;
  mode: buildStore.BuildGcMode;
  complete: boolean;
  roots: number;
  /** Exact union of graph and authoritative host-owned build-key roots. */
  rootBuildKeys: string[];
  /** Rooted build keys currently present in build storage; metadata is verified by the coordinator. */
  storedRootBuildKeys: string[];
  /**
   * Root keys named by an authoritative host owner but absent from the store.
   * Unlike a graph key for a unit never built, this may name a live execution
   * artifact, so downstream content collection must fail closed.
   */
  unresolvedAuthoritativeRootBuildKeys: string[];
  reachableBuilds: number;
  unreferenced: number;
  unreferencedBytes: number;
  quarantined: number;
  deleted: number;
  retainedForGrace: number;
  notReconstructible: number;
  notReconstructibleDetails: Array<{ buildKey: string; missing: string[] }>;
  providerFailures: Array<{ provider: string; error: string }>;
  cleanupFailures: Array<{ buildKey: string; error: string }>;
  retainedSourceRoots: ExecutionSourceContentRoot[];
}

export interface PreparedBuildGc {
  readonly epoch: number;
  /** Read-only root/store snapshot used to preflight semantic content. */
  readonly report: BuildRetentionReport & { mode: "report" };
  /**
   * Commit artifact quarantine/sweep from the prepared root snapshot.
   * Coordinator-only: the public build service exposes report mode only.
   */
  commit(options: {
    publicationProtectedBuildKeys: ReadonlySet<string>;
    graceMs?: number;
    commitArtifactDeletion: (buildKey: string, commit: () => void) => boolean;
  }): Promise<BuildRetentionReport>;
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
  ): Promise<{
    bundle: string;
    format: "cjs" | "async-cjs";
    execution?: ExecutionArtifactRefV1;
  }>;
  getBuild(
    unitPath: string,
    ref?: string,
    options?: BuildUnitOptions & { library?: false | undefined }
  ): Promise<BuildResult>;

  /** Resolve a build unit at `main`, a `ctx:*` context selector, or `state:*`. */
  resolveBuildUnit(unitPath: string, ref?: string): Promise<BuildUnitResolution | null>;

  /**
   * Resolve several build units against one immutable graph/EV view.
   * Results preserve input order and use null for paths absent from the view.
   */
  resolveBuildUnits(
    unitPaths: readonly string[],
    ref: string
  ): Promise<Array<BuildUnitResolution | null>>;

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

  /**
   * List the build units affected by workspace-relative source changes at an
   * exact state, including the complete transitive reverse-dependency closure.
   * Candidate and published graphs both participate so dependency removal,
   * package renaming, and deletion cannot hide consumers that still need
   * validation. Paths outside both graphs have no build closure.
   */
  listAffectedBuildUnits(stateHash: string, changedPaths: readonly string[]): Promise<string[]>;

  /** Stage the complete authority index for an exact candidate state. */
  stageAuthorityIndex(stateHash: string): Promise<void>;

  /** Begin opportunistic analysis after the owning host has published readiness. */
  prewarmAuthorityIndex(): void;

  /** Return the current authority-analysis epoch for publication coordination. */
  authorityAnalysisEpoch(): { analyzerVersion: string; rpcSchemaVersion: string };

  /** Discard a candidate index after a denied, failed, or superseded validation. */
  discardAuthorityIndex(stateHash: string): void;

  /** Get an immutable build-store artifact by build key. */
  getBuildByKey(key: string): BuildResult | null;

  /** Get one exact semantic execution retained for reusable artifact bytes. */
  getBuildByExecution(key: string, executionDigest: string): BuildResult | null;

  /** Side-effect-free verified lookup of one workspace-owned build record. */
  peekBuildByKey(key: string): BuildResult | null;

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

  /** Diagnose build retention from host-owned roots without deleting artifacts. */
  gc(): Promise<BuildRetentionReport & { mode: "report" }>;

  /** Prepare the private, two-collector retention commit for one host epoch. */
  prepareGc(options: { epoch: number }): Promise<PreparedBuildGc>;

  inspectExecution(executionDigest: string): Promise<{
    artifact: ExecutionArtifactRefV1 | null;
    roots: Array<{ owner: string; ownerId: string; reason: string }>;
    reconstructible: boolean;
    missing: string[];
  }>;

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
  const authorityEnvironmentFlights = new Map<
    string,
    Promise<ExactWorkspaceAuthorityEnvironment>
  >();
  const authorityFactCache = new Map<
    string,
    { facts: ReturnType<typeof analyzeWorkspaceServiceCalls>; moduleClosureDigest: string }
  >();
  const rememberAuthorityFacts = (
    key: string,
    value: { facts: ReturnType<typeof analyzeWorkspaceServiceCalls>; moduleClosureDigest: string }
  ): void => {
    authorityFactCache.delete(key);
    authorityFactCache.set(key, value);
    while (authorityFactCache.size > 256) {
      const oldest = authorityFactCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      authorityFactCache.delete(oldest);
    }
  };
  const authorityIndexManager = new AuthorityIndexManager();
  const authorityAnalysisCache = AuthorityAnalysisCache.forWorkspace(source.workspaceId);
  const authorityEpoch = {
    analyzerVersion: "userland-authority-v5",
    rpcSchemaVersion: workspaceRpcSchemaVersion(),
  } as const;
  const authorityEnvironmentAt = (
    stateHash: string,
    graphAtView: PackageGraph,
    evMapAtView: EffectiveVersionMap
  ): Promise<ExactWorkspaceAuthorityEnvironment> => {
    const existing = authorityEnvironmentFlights.get(stateHash);
    if (existing) return existing;
    const flight = (async () => {
      let services: readonly ExactWorkspaceServiceBinding[] = [];
      if (rootOptions.workspaceAuthorityEnvironmentAt) {
        services = (await rootOptions.workspaceAuthorityEnvironmentAt(stateHash)).services;
      }
      return createExactWorkspaceAuthorityEnvironment({
        stateHash,
        services,
        resolveCatalog: async (binding) => {
          if (binding.target.kind === "worker") {
            return {
              provider: {
                unitName: binding.source,
                source: binding.source,
                effectiveVersion: evMapAtView[binding.source] ?? "unknown",
                className: "worker",
              },
              methods: new Map(),
              digest: "stateless-worker",
            };
          }
          const provider = graphAtView
            .allNodes()
            .find((node) => node.kind === "worker" && node.relativePath === binding.source);
          if (!provider)
            throw new Error(
              `Workspace service provider ${binding.source} is not an exact build unit`
            );
          const effectiveVersion = evMapAtView[provider.name];
          if (!effectiveVersion)
            throw new Error(
              `Workspace service provider ${provider.name} has no exact effective version`
            );
          return resolveProviderCatalog({
            stateHash,
            provider,
            effectiveVersion,
            className: binding.target.className,
            graph: graphAtView,
            workspaceRoot,
            source: getBuildSourceProvider(),
          });
        },
      });
    })();
    authorityEnvironmentFlights.set(stateHash, flight);
    void flight.catch(() => {
      if (authorityEnvironmentFlights.get(stateHash) === flight)
        authorityEnvironmentFlights.delete(stateHash);
    });
    while (authorityEnvironmentFlights.size > 16) {
      const oldest = authorityEnvironmentFlights.keys().next().value as string | undefined;
      if (oldest === undefined || oldest === stateHash) break;
      authorityEnvironmentFlights.delete(oldest);
    }
    return flight;
  };

  const authorityIndexAt = (
    stateHash: string,
    view: GraphView
  ): Promise<AuthorityDependencyIndex> => {
    const prepare = async () => {
      const environment = await authorityEnvironmentAt(stateHash, view.graph, view.evMap);
      const nodes = view.graph
        .allNodes()
        .filter((candidate) => candidate.kind !== "template")
        .sort((a, b) => a.name.localeCompare(b.name));
      const consumerIdentities = new Map<
        string,
        Omit<AuthorityConsumerIdentity, "moduleClosureDigest">
      >();
      for (const node of nodes) {
        const effectiveVersion = view.evMap[node.name] ?? "unknown";
        consumerIdentities.set(node.name, {
          epoch: authorityEpoch,
          unitName: node.name,
          effectiveVersion:
            effectiveVersion === "unknown" ? `${effectiveVersion}:${stateHash}` : effectiveVersion,
        });
      }
      const identity: AuthorityIndexIdentity = {
        stateHash,
        epoch: authorityEpoch,
        environmentDigest: environment.digest,
        graphDigest: sha256Canonical({
          version: 2,
          nodes: nodes.map((node) => ({
            name: node.name,
            relativePath: node.relativePath,
            kind: node.kind,
            effectiveVersion: view.evMap[node.name] ?? "unknown",
            internalDeps: [...node.internalDeps].sort(),
            dependencies: node.dependencies,
            manifest: node.manifest,
          })),
        }),
      };
      return { environment, nodes, consumerIdentities, identity };
    };
    const prepared = prepare();
    return prepared.then(({ environment, nodes, consumerIdentities, identity }) =>
      authorityIndexManager.indexAt(
        stateHash,
        authorityEpoch,
        async () => {
          const expectedConsumers = new Map(
            [...consumerIdentities.keys()].map((unitName) => [
              unitName,
              {
                effectiveVersion: view.evMap[unitName] ?? "unknown",
              },
            ])
          );
          const cacheValidation = authorityAnalysisCache.validation();
          const persisted = authorityAnalysisCache.index(
            identity,
            expectedConsumers,
            cacheValidation
          );
          if (persisted) {
            console.log(
              `[BuildV2] Restored authority baseline for ${stateHash} from durable cache`
            );
            return persisted;
          }
          const consumers: Array<{
            unitName: string;
            effectiveVersion: string;
            moduleClosureDigest: string;
            facts: ReturnType<typeof analyzeWorkspaceServiceCalls>;
          }> = [];
          const factsToPersist: Array<{
            identity: AuthorityConsumerIdentity;
            dependencies: AuthorityCompilerDependency[];
            facts: ReturnType<typeof analyzeWorkspaceServiceCalls>;
          }> = [];
          const blockingConsumers = new Set<string>();
          const missingConsumers: Array<{
            node: (typeof nodes)[number];
            effectiveVersion: string;
            consumerIdentity: Omit<AuthorityConsumerIdentity, "moduleClosureDigest">;
            factCacheKey: string;
            internalDeps: ReturnType<typeof collectTransitiveInternalDeps>;
          }> = [];
          const analysisStartedAt = Date.now();
          let memoryFactHits = 0;
          let durableFactHits = 0;
          for (const node of nodes) {
            const effectiveVersion = view.evMap[node.name] ?? "unknown";
            const consumerIdentity = assertPresent(consumerIdentities.get(node.name));
            const factCacheKey = sha256Canonical(consumerIdentity);
            const durableFacts = authorityAnalysisCache.factForConsumer(
              consumerIdentity,
              cacheValidation
            );
            const memoryFacts = authorityFactCache.get(factCacheKey);
            const cachedFacts =
              memoryFacts ??
              (durableFacts
                ? {
                    facts: durableFacts.facts,
                    moduleClosureDigest: durableFacts.identity.moduleClosureDigest,
                  }
                : undefined);
            if (cachedFacts) {
              if (memoryFacts) memoryFactHits += 1;
              else durableFactHits += 1;
              rememberAuthorityFacts(factCacheKey, cachedFacts);
              consumers.push({
                unitName: node.name,
                effectiveVersion,
                moduleClosureDigest: cachedFacts.moduleClosureDigest,
                facts: cachedFacts.facts,
              });
              continue;
            }
            missingConsumers.push({
              node,
              effectiveVersion,
              consumerIdentity,
              factCacheKey,
              internalDeps: collectTransitiveInternalDeps(node, view.graph),
            });
          }
          let projectionMs = 0;
          let sourceLoadMs = 0;
          let programMs = 0;
          let maxProgramMs = 0;
          let importGraphMs = 0;
          let analyzerMs = 0;
          let compositionMs = 0;
          let nativeCompiler: AuthorityCompilerSnapshot["timings"]["native"] | null = null;
          let sharedProgramConsumers = 0;
          let compilerGroups = 0;
          if (missingConsumers.length > 0) {
            const projectionStartedAt = Date.now();
            const projectionUnits = new Map<string, (typeof nodes)[number]>();
            for (const consumer of missingConsumers) {
              for (const unit of consumer.internalDeps) projectionUnits.set(unit.name, unit);
            }
            const projectedUnits = [...projectionUnits.values()].sort((a, b) =>
              a.name.localeCompare(b.name)
            );
            const materialized = await getBuildSourceProvider().materializeForBuild(
              projectedUnits,
              stateHash,
              workspaceRoot
            );
            projectionMs = Date.now() - projectionStartedAt;

            let compilerSnapshot: Awaited<
              ReturnType<typeof createAuthorityCompilerSnapshot>
            > | null = null;
            try {
              compilerSnapshot = await createAuthorityCompilerSnapshot({
                sourceRoot: materialized.sourceRoot,
                consumerNames: new Set(missingConsumers.map((consumer) => consumer.node.name)),
                units: projectedUnits.map((unit) => ({
                  name: unit.name,
                  relativePath: unit.relativePath,
                  effectiveVersion: view.evMap[unit.name],
                  packageDigest: sha256Canonical(unit.manifest),
                })),
                nodeModulesPaths: appNodeModuleRoots,
              });
            } catch (error) {
              for (const consumer of missingConsumers) blockingConsumers.add(consumer.node.name);
              console.warn(
                `[BuildV2] Authority compiler snapshot failed for ${missingConsumers.length} consumer(s):`,
                error instanceof Error ? error.message : String(error)
              );
            }
            if (compilerSnapshot) {
              sourceLoadMs = compilerSnapshot.timings.sourceLoadMs;
              programMs = compilerSnapshot.timings.programMs;
              maxProgramMs = compilerSnapshot.timings.maxProgramMs;
              importGraphMs = compilerSnapshot.timings.importGraphMs;
              analyzerMs = compilerSnapshot.timings.analyzerMs;
              compositionMs = compilerSnapshot.timings.compositionMs;
              nativeCompiler = compilerSnapshot.timings.native;
              compilerGroups = compilerSnapshot.groups.length;

              for (const consumer of missingConsumers) {
                const { node, effectiveVersion, consumerIdentity, factCacheKey } = consumer;
                try {
                  const sharedFacts = compilerSnapshot.factsByConsumer.get(node.name);
                  if (!sharedFacts) {
                    throw new Error(`Compiler snapshots omitted consumer ${node.name}`);
                  }
                  const facts = [...sharedFacts];
                  const compilerDependencies = compilerSnapshot.dependenciesByConsumer.get(
                    node.name
                  );
                  if (!compilerDependencies) {
                    throw new Error(`Compiler snapshots omitted dependencies for ${node.name}`);
                  }
                  const identity: AuthorityConsumerIdentity = {
                    ...consumerIdentity,
                    moduleClosureDigest: authorityModuleClosureDigest({
                      ...consumerIdentity,
                      compilerDependencies,
                    }),
                  };
                  sharedProgramConsumers += 1;
                  consumers.push({
                    unitName: node.name,
                    effectiveVersion,
                    moduleClosureDigest: identity.moduleClosureDigest,
                    facts,
                  });
                  rememberAuthorityFacts(factCacheKey, {
                    facts,
                    moduleClosureDigest: identity.moduleClosureDigest,
                  });
                  factsToPersist.push({
                    identity,
                    dependencies: [...compilerDependencies],
                    facts,
                  });
                } catch (error) {
                  blockingConsumers.add(node.name);
                  console.warn(
                    `[BuildV2] Authority baseline could not analyze ${node.name}:`,
                    error instanceof Error ? error.message : String(error)
                  );
                }
              }
            }
          }
          const foldStartedAt = Date.now();
          const index = await authorityDependencyIndexFromFacts({
            stateHash,
            epoch: authorityEpoch,
            consumers,
            environment,
            blockingConsumers,
          });
          const foldMs = Date.now() - foldStartedAt;
          let commitMs = 0;
          if (index.complete) {
            const commitStartedAt = Date.now();
            try {
              authorityAnalysisCache.commit(identity, index, factsToPersist);
            } catch (error) {
              console.warn(
                `[BuildV2] Could not persist authority analysis cache:`,
                error instanceof Error ? error.message : String(error)
              );
            }
            commitMs = Date.now() - commitStartedAt;
          }
          if (missingConsumers.length > 0) {
            console.log("[BuildV2] Authority analysis phases", {
              stateHash,
              consumers: nodes.length,
              memoryFactHits,
              durableFactHits,
              misses: missingConsumers.length,
              projectionUnits: new Set(
                missingConsumers.flatMap((consumer) =>
                  consumer.internalDeps.map((unit) => unit.name)
                )
              ).size,
              projectionMs,
              sourceLoadMs,
              programMs,
              maxProgramMs,
              importGraphMs,
              analyzerMs,
              compositionMs,
              nativeCompiler,
              compilerGroups,
              sharedProgramConsumers,
              foldMs,
              commitMs,
              totalMs: Date.now() - analysisStartedAt,
              complete: index.complete,
            });
          }
          return index;
        },
        sha256Canonical(identity)
      )
    );
  };
  const executionRootProviders = new ExecutionRootProviderRegistry();
  for (const provider of rootOptions.executionRootProviders ?? []) {
    executionRootProviders.register(provider);
  }
  if (rootOptions.executionRootProviders) executionRootProviders.assertCompleteCensus();

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
  buildStore.setBuildExecutionIdentityContext({
    workspaceId: source.workspaceId,
    executionStateForContent: (stateHash) => source.executionStateForContent?.(stateHash) ?? null,
  });

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
  const authorityPublicationUnsubscribe = source.onProtectedPublication((event) => {
    if (authorityIndexManager.promotePublished(event.workspaceStateHash, authorityEpoch)) {
      console.log(`[BuildV2] Promoted authority baseline for ${event.workspaceStateHash}`);
    }
  });

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
  ): {
    bundle: string;
    format: "cjs" | "async-cjs";
    execution?: ExecutionArtifactRefV1;
  } => {
    const execution = build.metadata.execution
      ? executionArtifactRefFromBuild(source.workspaceId, build)
      : undefined;
    return {
      bundle: primaryTextArtifactContent(build),
      format: build.metadata.details.kind === "library" ? build.metadata.details.format : "cjs",
      ...(execution ? { execution } : {}),
    };
  };

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

  // Immutable state hashes make graph views safe to share across callers. The
  // initialization pass is the first cache entry, so exact-state lookups for
  // the shipped snapshot do not repeat discovery and EV computation. Pending
  // work lives in a separate flight map so LRU eviction can never break
  // single-flight behavior.
  const MAX_GRAPH_VIEWS = 8;
  const graphViewCache = new Map<string, GraphView>();
  const graphViewFlights = new Map<string, Promise<GraphView>>();
  const cacheGraphView = (viewStateHash: string, view: GraphView): GraphView => {
    graphViewCache.delete(viewStateHash);
    graphViewCache.set(viewStateHash, view);
    while (graphViewCache.size > MAX_GRAPH_VIEWS) {
      const oldest = graphViewCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      graphViewCache.delete(oldest);
    }
    return view;
  };
  cacheGraphView(stateHash, { graph, evMap });

  /** Discover + EV-compute over one immutable content view. */
  const viewAt = (viewStateHash: string, knownGraph?: PackageGraph): Promise<GraphView> => {
    const cached = graphViewCache.get(viewStateHash);
    if (cached) {
      return Promise.resolve(cacheGraphView(viewStateHash, cached));
    }
    const existing = graphViewFlights.get(viewStateHash);
    if (existing) return existing;

    const flight = (async () => {
      const graphAtState = knownGraph ?? (await source.discoverGraph(viewStateHash));
      const hashes = await contentHashesAt(graphAtState, viewStateHash);
      return cacheGraphView(viewStateHash, {
        graph: graphAtState,
        evMap: computeEffectiveVersions(graphAtState, hashes).evMap,
      });
    })().finally(() => {
      graphViewFlights.delete(viewStateHash);
    });
    graphViewFlights.set(viewStateHash, flight);
    return flight;
  };

  let shuttingDown = false;
  let authorityPrewarmStarted = false;
  const prewarmAuthorityIndex = (): void => {
    if (authorityPrewarmStarted || shuttingDown || !rootOptions.workspaceAuthorityEnvironmentAt)
      return;
    authorityPrewarmStarted = true;
    const prewarmState = currentState().stateHash;
    const startedAt = Date.now();
    void authorityIndexAt(prewarmState, currentState())
      .then((index) => {
        if (currentState().stateHash !== prewarmState) return;
        authorityIndexManager.establishPublished(index);
        console.log(
          `[BuildV2] Prewarmed authority baseline for ${prewarmState} (${Date.now() - startedAt}ms)`
        );
      })
      .catch((error) => {
        console.warn(
          `[BuildV2] Authority baseline prewarm failed; publication will retry:`,
          error instanceof Error ? error.message : String(error)
        );
      });
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
    const build = buildStore.get(binding.artifact.buildKey);
    // BuildV2 reuses artifact bytes across semantic states, so the build
    // directory's metadata may have been rebound since this binding was
    // cached. A build-key hit alone is not enough: returning the old sealed
    // execution identity would make the publication journal reject the owner
    // write (or, worse, execute bytes under the wrong provenance).
    if (
      build?.metadata.execution?.buildKey === binding.artifact.buildKey &&
      build.metadata.execution.executionDigest === binding.artifact.executionDigest &&
      build.metadata.execution.artifactDigest === binding.artifact.artifactDigest
    ) {
      return binding;
    }
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
      const view = await viewAt(stateHash);
      graphAtState = view.graph;
      evMapAtState = view.evMap;
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
      const build = await buildUnit(node, ev, graphAtState, workspaceRoot, stateHash);
      const authority = build.metadata.authority;
      if (!authority) {
        throw new Error(`Runtime build ${build.buildKey} is missing its sealed authority envelope`);
      }
      const binding: RuntimeImageBinding = {
        source: node.relativePath,
        unitName: node.name,
        artifact: executionArtifactRefFromBuild(source.workspaceId, build),
        authority,
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
  ): Promise<{ target: UnitBuildTarget; reusable: boolean }> => {
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
    let buildError: unknown = null;
    let built: BuildResult | null = null;
    let reusable = true;
    try {
      built = await buildUnit(node, ev, graphAtView, workspaceRoot, viewStateHash, options);
    } catch (error) {
      buildError = error;
      // Build failures can include transient storage or dependency provisioning
      // faults. Keep the fail-closed report, but let the next request retry it.
      reusable = false;
    }

    // Fold typecheck diagnostics from the exact materialized source. This is
    // fail-closed: typecheck engine/materialization failures become errors in
    // the report and therefore cannot pass a protected-main build gate.
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
      // TypeScript and its virtual standard-library payload are build-report
      // dependencies, not server-bootstrap dependencies.
      const { typecheckUnit } = await import("./typecheckFold.js");
      let authorityEnvironment: ExactWorkspaceAuthorityEnvironment | undefined;
      try {
        authorityEnvironment = await authorityEnvironmentAt(
          viewStateHash,
          graphAtView,
          (await viewAt(viewStateHash)).evMap
        );
      } catch (error) {
        reusable = false;
        diagnostics.push({
          source: "authority",
          severity: "error",
          file: `${node.relativePath}/package.json`,
          line: 1,
          column: 1,
          message: `Authority analysis could not resolve the exact provider catalog: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
      const tsc = await typecheckUnit(
        node.relativePath,
        sourceRoot,
        internalDeps.map((u) => ({ name: u.name, relativePath: u.relativePath })),
        appNodeModuleRoots,
        {
          manifest: {
            ...node.manifest,
            authority: node.manifest.authority ?? { requests: [], provides: [] },
          },
          ...(authorityEnvironment ? { environment: authorityEnvironment } : {}),
          workspaceId: source.workspaceId,
          executableModules: built?.metadata.executableModules,
        }
      );
      diagnostics = [...diagnostics, ...tsc];
    } catch (err) {
      reusable = false;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[BuildV2] typecheck materialize failed for ${node.name}:`, message);
      diagnostics.push({
        source: "tsc",
        severity: "error",
        file: node.relativePath,
        line: 1,
        column: 1,
        message: `Typecheck could not complete: ${message}`,
      });
    }
    if (buildError != null && diagnostics.length === 0) {
      diagnostics = diagnosticsFromError(buildError, {
        workspaceRoot,
        unitRelativePath: node.relativePath,
      });
    }

    recordDiagnostics(node.name, buildKey, diagnostics);
    return {
      target: {
        target: spec.target,
        ...(spec.target !== "runtime"
          ? { exportPath: (spec as { exportPath: string }).exportPath }
          : {}),
        buildKey,
        diagnostics,
      },
      reusable,
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
  ): Promise<{ report: UnitBuildReport; reusable: boolean }> => {
    const ev = view.evMap[node.name];
    const base: Omit<UnitBuildReport, "status" | "diagnostics" | "builds"> = {
      repoPath: node.relativePath,
      unitName: node.name,
      kind: node.kind,
    };
    if (!ev) {
      return {
        report: { ...base, status: "skipped", diagnostics: [], builds: [] },
        reusable: true,
      };
    }
    if (node.kind === "template") {
      return {
        report: { ...base, status: "skipped", diagnostics: [], builds: [] },
        reusable: true,
      };
    }

    const outcomes: Array<{ target: UnitBuildTarget; reusable: boolean }> = [];
    if (node.kind === "package") {
      const targets = libraryTargetsForDependents(node.name, view.graph);
      const exports = packageExportPaths(node);
      for (const target of targets) {
        for (const exportPath of exports) {
          outcomes.push(
            await buildOneTarget(node, ev, view.graph, viewStateHash, { target, exportPath })
          );
        }
      }
    } else {
      outcomes.push(
        await buildOneTarget(node, ev, view.graph, viewStateHash, { target: "runtime" })
      );
    }

    const builds = outcomes.map((outcome) => outcome.target);
    const diagnostics = builds.flatMap((build) => build.diagnostics);
    const failed = hasErrors(diagnostics);
    return {
      report: { ...base, status: failed ? "failed" : "ok", diagnostics, builds },
      reusable: outcomes.every((outcome) => outcome.reusable),
    };
  };

  // A report is a pure projection of an immutable workspace state and unit.
  // Successful validation is substantially more expensive than artifact reuse,
  // so retain the complete projection instead of rerunning materialization,
  // authority analysis, and TypeScript on every diagnostics read. Transient
  // infrastructure failures are marked non-reusable by buildUnitReport.
  const MAX_BUILD_REPORTS = 256;
  const buildReportCache = new Map<string, UnitBuildReport>();
  const buildReportFlights = new Map<string, Promise<UnitBuildReport>>();
  const reportCacheKey = (viewStateHash: string, unitName: string): string =>
    `${viewStateHash}\0${unitName}`;
  const cacheBuildReport = (key: string, report: UnitBuildReport): UnitBuildReport => {
    buildReportCache.delete(key);
    buildReportCache.set(key, report);
    while (buildReportCache.size > MAX_BUILD_REPORTS) {
      const oldest = buildReportCache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      buildReportCache.delete(oldest);
    }
    return report;
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

      const view = await viewAt(buildState);
      const graphAtState = view.graph;
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

      const ev = view.evMap[node.name];
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

  const buildSystem: BuildSystemV2 = {
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
        const { graph, evMap } = await viewAt(stateHash);
        const node = resolveUnit(graph, unitPath, workspaceRoot);
        if (!node) return null;
        const effectiveVersion = evMap[node.name];
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

    async resolveBuildUnits(
      unitPaths: readonly string[],
      requestedRef: string
    ): Promise<Array<BuildUnitResolution | null>> {
      const ref = validateBuildRef(requestedRef);
      if (!ref || ref === MAIN_HEAD) {
        const snapshot = currentState();
        return unitPaths.map((unitPath) => {
          const node = resolveUnit(snapshot.graph, unitPath, workspaceRoot);
          if (!node) return null;
          const effectiveVersion = snapshot.evMap[node.name];
          if (!effectiveVersion) {
            throw new Error(`No effective version for ${node.name} at ${snapshot.stateHash}`);
          }
          return {
            unitPath: node.relativePath,
            unitName: node.name,
            kind: node.kind,
            stateHash: snapshot.stateHash,
            effectiveVersion,
          };
        });
      }

      const stateHash = ref.startsWith("state:")
        ? ref
        : await source.resolveContextState(ref.slice("ctx:".length));
      const { graph, evMap } = await viewAt(stateHash);
      return unitPaths.map((unitPath) => {
        const node = resolveUnit(graph, unitPath, workspaceRoot);
        if (!node) return null;
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
        };
      });
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
        ({ graph, evMap } = await viewAt(stateHash));
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
        ({ graph, evMap } = await viewAt(stateHash));
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
        ({ graph, evMap } = await viewAt(stateHash));
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

    getBuildByExecution(key: string, executionDigest: string): BuildResult | null {
      return buildStore.getByExecution(key, executionDigest);
    },

    peekBuildByKey(key: string): BuildResult | null {
      return buildStore.peekLocal(key);
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

    async listAffectedBuildUnits(
      stateHash: string,
      changedPaths: readonly string[]
    ): Promise<string[]> {
      const ref = validateBuildRef(stateHash);
      if (!ref) throw new Error(`Missing exact state for affected-unit lookup`);
      const view = await viewAt(ref);
      const publishedGraph = currentState().graph;
      const candidateSeeds = unitsForChangedPaths(view.graph, [...changedPaths]).units;
      const publishedSeeds = unitsForChangedPaths(publishedGraph, [...changedPaths]).units;
      const names = new Set<string>();

      const addReverseClosure = (graph: PackageGraph, seeds: Iterable<string>): void => {
        const pending = [...seeds];
        const visited = new Set<string>();
        while (pending.length > 0) {
          const name = pending.shift()!;
          if (visited.has(name)) continue;
          visited.add(name);
          if (view.graph.has(name)) names.add(name);
          for (const dependent of graph.getReverseDeps(name)) pending.push(dependent);
        }
      };

      // The candidate graph catches newly introduced edges; the currently
      // published graph catches removed/renamed/deleted edges. Their union is
      // the exact conservative closure—never an unrelated whole-workspace
      // sweep.
      addReverseClosure(view.graph, candidateSeeds);
      addReverseClosure(publishedGraph, publishedSeeds);

      // A current-epoch baseline is required before incremental authority
      // selection. A cold process may construct it lazily; a blocking
      // baseline consumer remains affected until its exact report is clean.
      const publishedState = currentState().stateHash;
      let publishedIndex = authorityIndexManager.publishedBaseline(authorityEpoch);
      if (
        rootOptions.workspaceAuthorityEnvironmentAt &&
        (!publishedIndex || publishedIndex.stateHash !== publishedState)
      ) {
        const publishedView = await viewAt(publishedState);
        publishedIndex = await authorityIndexAt(publishedState, publishedView);
        authorityIndexManager.establishPublished(publishedIndex);
      }
      if (publishedIndex && rootOptions.workspaceAuthorityEnvironmentAt) {
        for (const name of publishedIndex.blockingConsumers) {
          if (view.graph.has(name)) names.add(name);
        }
      }

      // Service authority is intentionally a separate relation from the
      // package DAG. A provider's decorator/manifest/configuration can change
      // a consumer's static authority result without changing its module
      // closure, so protected validation consults both exact authority views.
      const authorityRelevant = changedPaths.some(
        (changed) => changed === "meta/vibestudio.yml" || changed.startsWith("workers/")
      );
      if (authorityRelevant) {
        const candidateIndex = await authorityIndexAt(ref, view);
        const publishedAuthorityIndex =
          publishedIndex ?? (await authorityIndexAt(publishedState, await viewAt(publishedState)));
        const candidateProviderUnits = new Set(
          view.graph
            .allNodes()
            .filter(
              (node) =>
                node.kind === "worker" &&
                changedPaths.some(
                  (changed) =>
                    changed === node.relativePath || changed.startsWith(`${node.relativePath}/`)
                )
            )
            .map((node) => node.relativePath)
        );
        const publishedProviderUnits = new Set(
          publishedGraph
            .allNodes()
            .filter(
              (node) =>
                node.kind === "worker" &&
                changedPaths.some(
                  (changed) =>
                    changed === node.relativePath || changed.startsWith(`${node.relativePath}/`)
                )
            )
            .map((node) => node.relativePath)
        );
        const changedQueries = new Set<string>();
        if (
          changedPaths.some(
            (changed) => changed === "meta/vibestudio.yml" || changed.startsWith("meta/")
          )
        ) {
          for (const query of candidateIndex.consumersByQuery.keys()) changedQueries.add(query);
          for (const query of publishedAuthorityIndex.consumersByQuery.keys())
            changedQueries.add(query);
        }
        const authorityConsumers = authorityConsumersForProviderChanges(
          [candidateIndex, publishedAuthorityIndex],
          new Set([...candidateProviderUnits, ...publishedProviderUnits]),
          changedQueries
        );
        for (const name of authorityConsumers) {
          if (view.graph.has(name)) names.add(name);
        }
      }
      return view.graph
        .topologicalOrder()
        .filter((node) => names.has(node.name) && node.kind !== "template")
        .map((node) => node.name);
    },

    async stageAuthorityIndex(stateHash: string): Promise<void> {
      const ref = validateBuildRef(stateHash);
      if (!ref) throw new Error("Missing exact state for authority index staging");
      const view = await viewAt(ref);
      const index = await authorityIndexAt(ref, view);
      if (index.blockingConsumers.size > 0) {
        throw new Error(
          `Authority baseline has blocking consumers: ${[...index.blockingConsumers].sort().join(", ")}`
        );
      }
      authorityIndexManager.stageCandidate(index);
    },

    prewarmAuthorityIndex,

    authorityAnalysisEpoch(): { analyzerVersion: string; rpcSchemaVersion: string } {
      return { ...authorityEpoch };
    },

    discardAuthorityIndex(stateHash: string): void {
      authorityIndexManager.discardCandidate(stateHash, authorityEpoch);
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
      const cacheKey = reportCacheKey(viewStateHash, node.name);
      const cached = buildReportCache.get(cacheKey);
      if (cached) {
        // Map insertion order is the LRU order.
        buildReportCache.delete(cacheKey);
        buildReportCache.set(cacheKey, cached);
        return cached;
      }
      const pending = buildReportFlights.get(cacheKey);
      if (pending) return pending;

      const flight = buildUnitReport(node, view, viewStateHash)
        .then(({ report, reusable }) =>
          reusable ? cacheBuildReport(cacheKey, report) : report
        )
        .finally(() => {
          buildReportFlights.delete(cacheKey);
        });
      buildReportFlights.set(cacheKey, flight);
      return flight;
    },

    getUnitDiagnostics(unitName: string): BuildDiagnostic[] | null {
      const node = resolveUnit(currentState().graph, unitName, workspaceRoot);
      return diagnosticsForUnit(node?.name ?? unitName);
    },

    async prepareGc({ epoch }): Promise<PreparedBuildGc> {
      const { graph, evMap } = currentState();
      const roots = new Set<string>();
      const authoritativeRoots = new Set<string>();
      const providerSnapshot = await executionRootProviders.snapshot(epoch);

      for (const node of graph.allNodes()) {
        const ev = evMap[node.name];
        if (!ev) continue;
        roots.add(computeBuildKey(node.name, ev, sourcemapForNode(node)));
      }

      for (const root of providerSnapshot.roots) {
        // Product seeds are verified execution roots, but their artifacts are
        // not owned by this workspace BuildStore (nor by workspace content GC).
        if (root.artifact.sourceState.kind === "product-seed") continue;
        roots.add(root.artifact.buildKey);
        authoritativeRoots.add(root.artifact.buildKey);
      }

      const collect = async (options: {
        mode: "report" | "sweep";
        publicationProtectedBuildKeys: ReadonlySet<string>;
        graceMs: number;
        commitArtifactDeletion?: (buildKey: string, commit: () => void) => boolean;
      }): Promise<BuildRetentionReport> => {
        const providerFailures = [...providerSnapshot.providerFailures];
        const scan = await buildStore.scanRetention();
        providerFailures.push(
          ...scan.failures.map((failure) => ({
            provider: `build-store:${failure.key}`,
            error: failure.error,
          }))
        );
        const storedRootBuildKeys = scan.builds
          .filter((build) => roots.has(build.key))
          .map((build) => build.key)
          .sort();
        const storedBuildKeys = new Set(scan.builds.map((build) => build.key));
        const unresolvedAuthoritativeRootBuildKeys = [...authoritativeRoots]
          .filter((key) => !storedBuildKeys.has(key))
          .sort();
        const unreferencedBuilds = scan.builds.filter((build) => !roots.has(build.key));
        const complete =
          providerFailures.length === 0 && unresolvedAuthoritativeRootBuildKeys.length === 0;
        const effectiveMode = complete ? options.mode : "report";
        const collection = await buildStore.collectRetention({
          epoch,
          mode: effectiveMode,
          rootedBuildKeys: roots,
          publicationProtectedBuildKeys: options.publicationProtectedBuildKeys,
          graceMs: options.graceMs,
          commitArtifactDeletion: options.commitArtifactDeletion,
        });
        const report: BuildRetentionReport = {
          epoch,
          mode: effectiveMode,
          complete,
          roots: roots.size,
          rootBuildKeys: [...roots].sort(),
          storedRootBuildKeys,
          unresolvedAuthoritativeRootBuildKeys,
          reachableBuilds: storedRootBuildKeys.length,
          unreferenced: unreferencedBuilds.length,
          unreferencedBytes: unreferencedBuilds.reduce((total, build) => total + build.bytes, 0),
          quarantined: collection.quarantined,
          deleted: collection.deleted,
          retainedForGrace: collection.retainedForGrace,
          notReconstructible: collection.notReconstructible.length,
          notReconstructibleDetails: collection.notReconstructible,
          providerFailures,
          cleanupFailures: collection.cleanupFailures,
          retainedSourceRoots: collection.retainedSourceRoots,
        };
        if (
          report.providerFailures.length > 0 ||
          report.unresolvedAuthoritativeRootBuildKeys.length > 0 ||
          report.notReconstructible > 0 ||
          report.cleanupFailures.length > 0 ||
          report.unreferencedBytes > 0
        ) {
          rootOptions.onRetentionDiagnostic?.(report);
        }
        return report;
      };

      const report = (await collect({
        mode: "report",
        publicationProtectedBuildKeys: new Set(),
        graceMs: 24 * 60 * 60 * 1_000,
      })) as BuildRetentionReport & { mode: "report" };
      let committed = false;
      return {
        epoch,
        report,
        async commit(options) {
          if (committed) throw new Error(`Build GC epoch ${epoch} was already committed`);
          committed = true;
          return collect({
            mode: "sweep",
            publicationProtectedBuildKeys: options.publicationProtectedBuildKeys,
            graceMs: options.graceMs ?? 24 * 60 * 60 * 1_000,
            commitArtifactDeletion: options.commitArtifactDeletion,
          });
        },
      };
    },

    async gc(): Promise<BuildRetentionReport & { mode: "report" }> {
      return (await buildSystem.prepareGc({ epoch: 0 })).report;
    },

    async inspectExecution(executionDigest: string) {
      if (!/^[0-9a-f]{64}$/u.test(executionDigest)) {
        throw new Error("Execution digest must be a full lowercase SHA-256 digest");
      }
      const snapshot = await executionRootProviders.snapshot(0);
      const matchingRoots = snapshot.roots.filter(
        (root) => root.artifact.executionDigest === executionDigest
      );
      let artifact = matchingRoots[0]?.artifact ?? null;
      if (!artifact) {
        const scan = await buildStore.scanRetention();
        for (const stored of scan.builds) {
          const build = buildStore.peekLocal(stored.key);
          if (build?.metadata.execution?.executionDigest === executionDigest) {
            try {
              artifact = executionArtifactRefFromBuild(source.workspaceId, build);
            } catch {
              artifact = null;
            }
            break;
          }
        }
      }
      const missing: string[] = [];
      if (!artifact) missing.push("artifact");
      if (artifact && !buildStore.peekLocal(artifact.buildKey)) missing.push("artifact bytes");
      if (artifact) {
        if (!source.inspectContentRoot) {
          missing.push("source content-store inspection authority");
        } else {
          for (const root of artifact.sourceState.contentRoots) {
            const inspection = await source.inspectContentRoot(root.stateHash);
            if (!inspection.reconstructible) missing.push(...inspection.missing);
          }
        }
      }
      if (!snapshot.complete) {
        missing.push(
          ...snapshot.providerFailures.map(
            (failure) => `root provider ${failure.provider}: ${failure.error}`
          )
        );
      }
      return {
        artifact,
        roots: matchingRoots.map((root) => ({
          owner: root.owner,
          ownerId: root.ownerId,
          reason: root.reason,
        })),
        reconstructible: artifact !== null && missing.length === 0,
        missing,
      };
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
      shuttingDown = true;
      trigger.stop();
      authorityPublicationUnsubscribe();
      setBuildSourceProvider(null);
      console.log("[BuildV2] Shut down");
    },
  };
  return buildSystem;
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
