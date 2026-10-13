import * as fs from "node:fs";
import * as path from "node:path";
import { createHostBuildUnitGate } from "@vibestudio/shared/hostBuildUnits";
import { contextIdForTargetKey } from "@vibestudio/shared/runtime/contextIdentity";
import {
  UnitHost,
  UnitRegistry,
  UnitTrustResolver,
  FileUnitIdentityApprovalStore,
  collectTransitiveUnitDependencyEvs,
  createPendingUnitRegistryEntry,
  createUnitBuildIdentity,
  createReviewedUnitBase,
  findUnitGraphNode,
  normalizeUnitRepoPath as normalizeRepoPath,
  normalizeUnitRef as normalizeRef,
  requestUnitInstallReview,
  requireExactUnitAdmission,
  UNIT_ROLLBACK_HISTORY_LIMIT,
  unitBuildIdentityFromRegistryEntry,
  unitSupervisionChange,
  observeUnitSupervision,
  canonicalUnitBuildIdentity,
  unitAuthorityManifestFromPackageJson,
  type UnitBuildIdentity,
  type UnitDescriptor,
  type UnitApprovalCoordinator,
  type UnitChangeApprovalProvider,
  type UnitReconcileOptions,
  type UnitReconcileTrigger,
  type UnitRegistryEntryBase,
  type UnitVersionRecord,
  type ExactUnitAdmissionReview,
} from "@vibestudio/unit-host";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import type { EventService } from "@vibestudio/shared/eventsService";
import type {
  AppAdoptionPolicy,
  NotificationPayload,
  SupervisionChange,
} from "@vibestudio/shared/events";
import type { ExecutionPublicationPort } from "@vibestudio/shared/execution/retention";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import {
  isAuthorizedChromeAppSource,
  normalizeAppSourcePath,
  type WorkspaceAppTrustGrants,
} from "@vibestudio/shared/chromeTrust";
import type {
  PendingApproval,
  PendingUnitInstallReviewApproval,
  ReviewedUnit,
} from "@vibestudio/shared/approvals";
import type { CapabilityPresentationResolver } from "@vibestudio/shared/authorityPresentation";
import type {
  UnitAuthorityRequest,
  UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import type { InstallReviewOrigin } from "@vibestudio/shared/authority/unitInstallReview";
import { readWorkspaceConfig, resolveDeclaredApps } from "@vibestudio/workspace/configParser";
import {
  UnitManifestError,
  APP_CAPABILITIES_BY_TARGET,
  appUnitManifestDescriptor,
  readAndValidateUnitManifest,
  type AppCapability,
  type WorkspaceAppTarget,
} from "@vibestudio/shared/unitManifest";
import type { HostTarget, HostTargetCandidate } from "@vibestudio/shared/hostTargets";
import { appArtifactRoute } from "@vibestudio/shared/appArtifacts";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { writeAppDistBake, type AppDistBakeManifest } from "./buildV2/distBake.js";
import {
  type BuildArtifactManifestEntry,
  type BuildMetadata,
  type StoredBuildArtifact,
  type StoredBuildResult,
} from "./buildV2/buildStore.js";

import {
  createCapabilityAuthorizer,
  type CapabilityAuthorizer,
} from "./services/capabilityAuthorizer.js";
import { DeviceAppPrincipals, type DeviceAppPrincipal } from "./deviceAppPrincipals.js";
import type { RuntimeDiagnosticsStore } from "./runtimeDiagnosticsStore.js";
import { ReactNativeAppAdapter } from "./reactNativeAppAdapter.js";
import {
  validateAppBuildContract,
  type AppBuildProviderDetails,
} from "./buildV2/appBuildContract.js";
import {
  requireActiveExecutionIdentity,
  type ActiveExecutionIdentity,
} from "./runtimeExecutionIdentity.js";

export type { ReactNativeAppBootstrap, ReactNativeHostReadiness } from "./reactNativeAppAdapter.js";

function canonicalAuthority(value: unknown): string {
  return sha256Canonical(value);
}

const APP_UNIT_DESCRIPTOR: UnitDescriptor<"app"> = {
  kind: "app",
  sourceRoot: "apps",
  buildKind: "app",
  approvalFraming: {
    serviceName: "apps",
    unitLabel: "app",
    unitLabelPlural: "apps",
    nativeCode: false,
  },
  seedTrustEligible: true,
  versionedFields: ["target", "capabilities"],
};

export interface AppUpdateErrorDiagnostic {
  phase: "build" | "target-validation" | "activation";
  target?: WorkspaceAppTarget;
  buildKey?: string | null;
  source: string;
}

export interface WorkspaceAppDeclaration {
  source: string;
  ref: string;
}

export interface AppRegistryEntry extends UnitRegistryEntryBase {
  unitKind: "app";
  target: WorkspaceAppTarget;
  capabilities: AppCapability[];
  previousVersions: AppVersionRecord[];
  lastErrorDetails?: AppUpdateErrorDiagnostic | null;
  activationTrust?: AppActivationTrustRecord | null;
}

export interface AppVersionRecord extends UnitVersionRecord {
  target: WorkspaceAppTarget;
  capabilities: AppCapability[];
}

export interface AppActivationTrustRecord {
  decision: "host-target-pinned-ref";
  identityKey: string;
  actor: "shell-host";
  reason: string;
  acceptedAt: number;
}

export type ElectronHostReadiness =
  | {
      ready: true;
      source: string;
      appId: string;
      buildKey: string;
      artifactRoute: string;
      details: string[];
    }
  | {
      ready: false;
      source: string | null;
      appId?: string | null;
      reason: string;
      details: string[];
    };

interface BuildSystemLike {
  getStoredBuild(unitPath: string, ref?: string): Promise<AppBuildResultLike>;
  getBuildByKey(key: string): Promise<AppBuildResultLike | null>;
  readBuildArtifactBytes(
    build: Pick<AppBuildResultLike, "dir">,
    artifact: BuildArtifactManifestEntry
  ): Promise<Buffer>;
  readBuildArtifactContent(
    build: Pick<AppBuildResultLike, "dir">,
    artifact: BuildArtifactManifestEntry
  ): Promise<string>;
  getBuildArtifactPath(
    build: Pick<AppBuildResultLike, "dir">,
    artifact: BuildArtifactManifestEntry
  ): string;
  getEffectiveVersion(unitName: string): string | null;
  listAffectedBuildUnits?(stateHash: string, changedPaths: readonly string[]): Promise<string[]>;
  resolveBuildUnitIdentity(
    unitPath: string,
    ref?: string
  ): Promise<{
    unitPath: string;
    unitName: string;
    stateHash: string;
    effectiveVersion: string;
    dependencyEvs: Record<string, string>;
    externalDeps: Record<string, string>;
    manifest: { authority?: UnitAuthorityManifest };
    serviceBindings: readonly import("@vibestudio/shared/authority/unitInstallReview").ServiceBindingFact[];
    serviceReviews: readonly import("@vibestudio/shared/authority/unitInstallReview").WorkspaceServiceReviewFact[];
  } | null>;
  getExternalDeps(unitName: string): Record<string, string>;
  getBuildProviderDetails?(target: "react-native"): AppBuildProviderDetails | null;
  onBuildProviderChange?(
    callback: (event: {
      type: "registered" | "unregistered";
      target: "react-native";
      provider: AppBuildProviderDetails;
    }) => void
  ): () => void;
  getGraph(): {
    allNodes(): AppGraphNode[];
  };
  onPushBuild(callback: (source: string, trigger?: ProtectedPublicationEvent) => void): void;
  onUnitChange?(
    callback: (event: {
      name: string;
      relativePath: string;
      kind: string;
      trigger: ProtectedPublicationEvent;
    }) => void
  ): () => void;
}

export type AppBuildArtifactLike = StoredBuildArtifact;

export type AppBuildResultLike = StoredBuildResult;

interface AppGraphNode {
  name: string;
  kind: string;
  relativePath: string;
  path: string;
  internalDeps: string[];
  manifest: {
    displayName?: string;
    title?: string;
    icon?: string;
    app?: { target?: WorkspaceAppTarget; capabilities?: AppCapability[] };
  };
}

interface AppBuildMetadataLike {
  buildKey?: string;
  sourcePath?: string | null;
  ev: string;
  sourceStateHash?: string | null;
  execution?: BuildMetadata["execution"];
  authority?: BuildMetadata["authority"];
  bundleReport?: BuildMetadata["bundleReport"];
  details?:
    | {
        kind: "app";
        target: WorkspaceAppTarget;
        integrity?: string | null;
        rnHostAbi?: string | null;
        provider?: {
          name: string;
          activeEv: string | null;
          activeBuildKey: string | null;
          contractVersion: string;
        } | null;
      }
    | { kind: string };
}

interface ApprovalQueueLike {
  request(req: {
    kind: "unit-install-review";
    callerId: string;
    callerKind: "panel" | "app" | "worker" | "do" | "system";
    requestedByUserId?: string;
    repoPath: string;
    effectiveVersion: string;
    dedupKey?: string | null;
    mode: PendingUnitInstallReviewApproval["mode"];
    title: string;
    description: string;
    units: ReviewedUnit[];
    /** Where each unit's bytes came from, keyed by repo path (§7.6.3). */
    origins?: ReadonlyMap<string, InstallReviewOrigin>;
    configWrite?: PendingUnitInstallReviewApproval["configWrite"];
  }): Promise<"accepted" | "deny" | "dismiss">;
  listPending(): PendingApproval[];
}

interface NotificationServiceLike {
  show(notification: Omit<NotificationPayload, "id">): string;
}

export interface AppHostDeps {
  statePath: string;
  workspacePath: string;
  workspaceId: string;
  diagnostics: Pick<RuntimeDiagnosticsStore, "record" | "history">;
  /** Protected hub designation, never workspace-authored app or trust configuration. */
  isSystemWorkspace(): boolean;
  /** Current semantic manifest of this workspace, independent of other loaded manifests. */
  getWorkspaceTrustGrants(): WorkspaceAppTrustGrants;
  readWorkspaceFileAtState(stateHash: string, filePath: string): Promise<string | null>;
  describeCapability?: CapabilityPresentationResolver;
  buildSystem: BuildSystemLike;
  eventService: EventService;
  approvalQueue: ApprovalQueueLike;
  notificationService?: NotificationServiceLike;
  approvalCoordinator?: UnitApprovalCoordinator<ReviewedUnit>;
  /**
   * Where these units' bytes came from, derived by the server from workspace
   * state it reads itself.
   *
   * The launch gate is organized on origin, not on kind or permission, so an
   * app review without this cannot answer the only question it asks. Absent in
   * tests, where every unit reads as the host's own build.
   */
  resolveUnitOrigins?(
    repoPaths: readonly string[]
  ): Promise<ReadonlyMap<string, InstallReviewOrigin>>;
  /**
   * Whether this exact app version's declared authority has been admitted.
   * Absent in tests and hosts with no authority ledger, where activation trust
   * stands alone.
   */
  isAdmitted?(repoPath: string, effectiveVersion: string): boolean;
  openUnitReviewFor?(code: {
    repoPath: string;
    effectiveVersion: string;
  }): ExactUnitAdmissionReview | null;
  entityCache?: Pick<EntityCache, "resolve" | "listActive" | "_onActivate" | "_onRetire">;
  executionPublicationPort?: ExecutionPublicationPort;
  getReactNativeAppArtifactBaseUrl(): string;
  getTerminalAppArtifactBaseUrl(): string;
  /**
   * The manifest-declared preferred app (and its required extensions) for a
   * host target — `hostTargets.<target>` in meta/vibestudio.yml, resolved via
   * `resolveHostTargetDecl`. Absent (or null for a target) ⇒ no preferred
   * app: selection falls back to generic declared/recommended candidates,
   * never to a hardcoded unit name.
   */
  getHostTargetDecl?(
    target: HostTarget
  ): { appSource: string; requiresExtensions: string[] } | null;
  /** Admit and stage what a demanded host target needs: its app and required extensions. */
  prepareHostTarget?(target: HostTarget): Promise<void>;
}

export class AppHost implements UnitChangeApprovalProvider<ReviewedUnit> {
  readonly registry: UnitRegistry<AppRegistryEntry>;
  readonly reactNative: ReactNativeAppAdapter;
  readonly principals: DeviceAppPrincipals;
  private readonly trustResolver: UnitTrustResolver<AppRegistryEntry>;
  private readonly unitHost: UnitHost<
    AppRegistryEntry,
    WorkspaceAppDeclaration,
    AppGraphNode,
    ReviewedUnit
  >;
  private readonly loggedUnauthorizedPanelHostingSources = new Set<string>();
  private lastDeclared: WorkspaceAppDeclaration[] = [];
  private lastDevStatusDiagnosticKey: string | null = null;
  private readonly activationFlights = new Map<string, Promise<"ready">>();
  private readonly eventFlights = new Set<Promise<void>>();
  private eventFailures: unknown[] = [];
  private initialization: Promise<void> | null = null;
  private initializationComplete = false;
  private retiring = false;

  constructor(private readonly deps: AppHostDeps) {
    this.registry = new UnitRegistry<AppRegistryEntry>({
      statePath: deps.statePath,
      unitKind: "app",
      normalizeEntry: (entry) => ({
        ...entry,
        capabilities: entry.capabilities ?? [],
        lastErrorDetails: entry.lastErrorDetails ?? null,
        activationTrust: entry.activationTrust ?? null,
      }),
      publicationPort: deps.executionPublicationPort,
    });
    observeUnitSupervision(this.registry, (change, entry) => this.publish(change, entry));
    this.trustResolver = new UnitTrustResolver<AppRegistryEntry>({
      entryIdentity: (entry) => this.registryEntryIdentity(entry),
    });
    const isHostBuildUnit = createHostBuildUnitGate({
      statePath: deps.statePath,
      workspacePath: deps.workspacePath,
    });
    this.unitHost = new UnitHost({
      descriptor: APP_UNIT_DESCRIPTOR,
      registry: this.registry,
      resolveNode: (source) => this.findAppNode(source),
      candidateIdentity: (node, decl) => this.declarationIdentity(node, decl),
      trustResolver: this.trustResolver,
      approvalStore: new FileUnitIdentityApprovalStore({
        statePath: deps.statePath,
        unitKind: "app",
      }),
      ...(deps.isAdmitted
        ? {
            isAdmitted: (identity) =>
              identity.effectiveVersion !== null &&
              deps.isAdmitted!(identity.source.repo, identity.effectiveVersion),
          }
        : {}),
      // The desktop, mobile, and terminal apps that ARE Vibestudio arrived
      // unmodified in the template this build designates. The user decided
      // about them by installing Vibestudio; asking again on a surface one of
      // them renders would be a question that cannot be answered (§7.6).
      isSeedTrusted: (node, identity) =>
        identity.effectiveVersion !== null && isHostBuildUnit(node.relativePath),
      makePendingEntry: (node, decl, building) => this.pendingEntryFor(node, decl, building),
      applyTrusted: (node, decl) => this.applyDeclared(node, decl),
      removeUndeclared: async (entry) => {
        this.principals.retireForEntry(entry);
        this.retireAppEntity(entry.name);
      },
      notifyUnresolved: (sources) => {
        this.deps.notificationService?.show({
          type: "error",
          title: "Unknown apps declared",
          message: `meta/vibestudio.yml declares apps that don't exist: ${sources.join(", ")}.`,
        });
      },
      validateBeforeApproval: (node) => this.validateAppManifestAtPath(node.path, node.name),
      approvalEntry: (node, decl) => this.buildBatchEntry(node, decl),
      approvalOrigins: (entries) => this.resolveOriginsFor(entries),
      requestApproval: async (entries, trigger) => {
        // Whose code this is, resolved before the question is asked.
        const origins = await this.resolveOriginsFor(entries);
        return requestUnitInstallReview<
          "app",
          ReviewedUnit,
          InstallReviewOrigin,
          NonNullable<PendingUnitInstallReviewApproval["configWrite"]>
        >({
          descriptor: APP_UNIT_DESCRIPTOR,
          approvalQueue: {
            request: async (request) =>
              requireUnitApprovalDecision(await this.deps.approvalQueue.request(request)),
          },
          entries,
          trigger,
          ...(origins ? { origins } : {}),
        });
      },
      approvalCoordinator: deps.approvalCoordinator,
      onBackgroundError: (err) => {
        console.error(
          "[AppHost] Background app approval flow failed:",
          err instanceof Error ? err.message : String(err)
        );
      },
    });
    this.reactNative = new ReactNativeAppAdapter({
      workspaceId: deps.workspaceId,
      registry: this.registry,
      buildSystem: deps.buildSystem,
      resolveActiveBuild: (entry) => this.resolveActiveAppBuild(entry),
      approvalCoordinator: deps.approvalCoordinator,
      getArtifactBaseUrl: () => deps.getReactNativeAppArtifactBaseUrl(),
      selectedSource: () => deps.getHostTargetDecl?.("react-native")?.appSource ?? null,
      listCandidates: () => this.listHostTargetCandidates("react-native"),
      declaredForCandidate: (candidate) => this.declaredForCandidate(candidate),
      requiredExtensions: () => deps.getHostTargetDecl?.("react-native")?.requiresExtensions ?? [],
      ensureRequiredExtensions: () => deps.prepareHostTarget?.("react-native") ?? Promise.resolve(),
      whenDeclarationsStaged: () => this.unitHost.whenDeclarationsStaged(),
      whenReconciled: () => this.unitHost.whenReconciled(),
      reconcileDeclaration: (declaration, options) =>
        this.reconcileHostTargetDeclaration("react-native", declaration, options),
      approvalForDeclarations: (declarations) =>
        this.unitHost.approvalForDeclarations(declarations),
      acceptPreapprovedTrust: (keys) => this.unitHost.acceptPreapprovedTrust(keys),
    });
    this.principals = new DeviceAppPrincipals({
      workspaceId: deps.workspaceId,
      registry: this.registry,
      entityCache: deps.entityCache,
      resolveActiveBuild: (entry) => this.resolveActiveAppBuild(entry),
    });
    deps.buildSystem.onPushBuild((source, trigger) => {
      this.admitEventWork(() => this.handleSourceRebuilt(source, trigger));
    });
    deps.buildSystem.onUnitChange?.((event) => {
      if (event.kind !== "app") return;
      this.admitEventWork(() => this.handleChangedAppUnit(event));
    });
    deps.buildSystem.onBuildProviderChange?.((event) => {
      if (event.target !== "react-native") return;
      this.admitEventWork(() => this.reconcileAfterProviderChange(event.provider.name));
    });
  }

  /** Backfill durable app execution identities before any unit reconciliation is admitted. */
  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.backfillExecutionIdentities().then(() => {
        this.initializationComplete = true;
      });
    }
    return this.initialization;
  }

  private async backfillExecutionIdentities(): Promise<void> {
    for (const entry of this.registry.list()) {
      const activeExecutionDigest = entry.activeBundleKey
        ? (entry.activeExecutionDigest ??
          (await this.resolveStoredExecutionDigest(entry.name, entry.activeBundleKey)))
        : null;
      const previousVersionReads = await Promise.allSettled(
        entry.previousVersions.map(async (version) =>
          version.executionDigest
            ? version
            : {
                ...version,
                executionDigest: await this.resolveStoredExecutionDigest(
                  entry.name,
                  version.activeBundleKey
                ),
              }
        )
      );
      const previousVersionFailures = previousVersionReads.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : []
      );
      if (previousVersionFailures.length === 1) throw previousVersionFailures[0];
      if (previousVersionFailures.length > 1) {
        throw new AggregateError(previousVersionFailures, "App history identity backfill failed", {
          cause: previousVersionFailures[0],
        });
      }
      const previousVersions = previousVersionReads.map((result) => {
        if (result.status !== "fulfilled") {
          throw new Error("App history identity backfill lost a settled result");
        }
        return result.value;
      });
      const changed =
        activeExecutionDigest !== entry.activeExecutionDigest ||
        previousVersions.some(
          (version, index) =>
            version.executionDigest !== entry.previousVersions[index]?.executionDigest
        );
      if (changed) {
        this.registry.patch(entry.name, { activeExecutionDigest, previousVersions });
      }
    }
  }

  private async resolveStoredExecutionDigest(appName: string, buildKey: string): Promise<string> {
    const build = await this.deps.buildSystem.getBuildByKey(buildKey);
    const executionDigest = build?.metadata.execution?.executionDigest;
    if (
      !build ||
      build.buildKey !== buildKey ||
      build.metadata.buildKey !== buildKey ||
      typeof executionDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(executionDigest)
    ) {
      throw new Error(`App ${appName} references unverifiable build ${buildKey}`);
    }
    return executionDigest;
  }

  private admitEventWork(work: () => Promise<void>): void {
    if (this.retiring) return;
    const flight = this.initialize().then(work);
    this.eventFlights.add(flight);
    void flight.then(
      () => this.eventFlights.delete(flight),
      (error) => {
        this.eventFlights.delete(flight);
        this.eventFailures.push(error);
      }
    );
  }

  private async joinEventWork(): Promise<void> {
    await Promise.allSettled([...this.eventFlights]);
    const failures = this.eventFailures;
    this.eventFailures = [];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "AppHost event work failed", { cause: failures[0] });
    }
  }

  async reconcileDeclared(
    declared: WorkspaceAppDeclaration[],
    opts: UnitReconcileOptions = {}
  ): Promise<void> {
    await this.initialize();
    this.lastDeclared = this.hostedDeclarations(declared);
    await this.unitHost.reconcileDeclared(this.lastDeclared, opts);
    this.emitDevStatusDiagnostic(opts.trigger ?? "startup");
  }

  setDeclared(
    declared: WorkspaceAppDeclaration[],
    opts: { trigger?: UnitReconcileTrigger } = {}
  ): void {
    this.lastDeclared = this.hostedDeclarations(declared);
    this.emitDevStatusDiagnostic(opts.trigger ?? "startup");
  }

  /** Plan exact-version trust without starting a target-specific app build. */
  async reviewDeclared(declared: WorkspaceAppDeclaration[] = this.lastDeclared): Promise<{
    units: ReviewedUnit[];
    identityKeys: string[];
  }> {
    await this.initialize();
    const review = await this.unitHost.approvalForDeclarations(this.hostedDeclarations(declared));
    return { units: review.entries, identityKeys: review.identityKeys };
  }

  /** Declared apps that ship in the host build, for the server to admit. */
  seedTrustedDeclared(
    declared: WorkspaceAppDeclaration[] = this.lastDeclared
  ): Promise<ReviewedUnit[]> {
    return this.initialize().then(() =>
      this.unitHost.seedTrustedDeclarations(this.hostedDeclarations(declared))
    );
  }

  private hostedDeclarations(declared: WorkspaceAppDeclaration[]): WorkspaceAppDeclaration[] {
    return this.deps.isSystemWorkspace() ? declared.map((decl) => ({ ...decl })) : [];
  }

  private assertInitialized(): void {
    if (!this.initializationComplete) {
      throw new Error("AppHost must be initialized before reading app version history");
    }
  }

  private assertAppHosting(): void {
    if (!this.deps.isSystemWorkspace())
      throw new Error("Native apps can run only in a designated System workspace");
  }

  async whenSettled(): Promise<void> {
    await this.initialize();
    await this.unitHost.whenSettled();
    await this.joinEventWork();
    // Reconcile returns once work is staged, so the line it prints is all
    // `status=building ev=none` — true, and useless. The line a developer reads
    // is this one: what each app actually settled on.
    this.emitDevStatusDiagnostic("settled");
  }

  async whenReconciled(): Promise<void> {
    await this.initialize();
    await this.unitHost.whenReconciled();
    await this.joinEventWork();
  }

  /** Declared apps are classified (entries + staged approvals); builds may still run. */
  async whenDeclarationsStaged(): Promise<void> {
    await this.initialize();
    await this.unitHost.whenDeclarationsStaged();
    await this.joinEventWork();
  }

  async shutdown(): Promise<void> {
    this.retiring = true;
    const lifecyclePromises: Promise<unknown>[] = [
      ...this.activationFlights.values(),
      ...this.eventFlights,
      ...(this.initialization ? [this.initialization] : []),
    ];
    const lifecycle = await Promise.allSettled(lifecyclePromises);
    const failures = [
      ...this.eventFailures,
      ...lifecycle.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ];
    this.eventFailures = [];
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "AppHost shutdown failed", { cause: failures[0] });
    }
  }

  async unitChangeApprovalForCommit(
    commit: string,
    scope?: { changedPaths: readonly string[] }
  ): Promise<{
    units: ReviewedUnit[];
    identityKeys: string[];
    unchangedCount: number;
    previousRequests: Map<string, readonly UnitAuthorityRequest[]>;
    identityKeysByRepo: Map<string, string>;
  }> {
    const units: ReviewedUnit[] = [];
    const identityKeys: string[] = [];
    const previousRequests = new Map<string, readonly UnitAuthorityRequest[]>();
    const identityKeysByRepo = new Map<string, string>();
    let unchangedCount = 0;
    const configChanged = scope?.changedPaths.some(
      (changedPath) => normalizeRepoPath(changedPath) === "meta/vibestudio.yml"
    );
    const affected =
      scope && !configChanged && this.deps.buildSystem.listAffectedBuildUnits
        ? new Set(await this.deps.buildSystem.listAffectedBuildUnits(commit, scope.changedPaths))
        : null;
    for (const declaration of await this.readDeclaredAppsFromState(commit)) {
      const candidate = await this.deps.buildSystem.resolveBuildUnitIdentity(
        declaration.source,
        commit
      );
      if (!candidate) {
        throw new Error(`Cannot resolve app ${declaration.source} at ${commit}`);
      }
      if (affected && !affected.has(candidate.unitName)) continue;
      const packageJsonSource = await this.deps.readWorkspaceFileAtState(
        commit,
        `${candidate.unitPath}/package.json`
      );
      if (!packageJsonSource) {
        throw new Error(`Candidate app manifest is missing at ${candidate.unitPath}/package.json`);
      }
      const packageJson = JSON.parse(packageJsonSource) as {
        name?: unknown;
        version?: unknown;
        vibestudio?: {
          displayName?: unknown;
          title?: unknown;
          icon?: unknown;
          authority?: unknown;
          app?: { target?: unknown; capabilities?: unknown };
        };
      };
      if (packageJson.name !== candidate.unitName) {
        throw new Error(`Candidate app package name does not match ${candidate.unitName}`);
      }
      const target = packageJson.vibestudio?.app?.target;
      if (target !== "electron" && target !== "react-native" && target !== "terminal") {
        throw new Error(`Candidate app ${candidate.unitName} has no valid target`);
      }
      const rawCapabilities = packageJson.vibestudio?.app?.capabilities;
      if (
        rawCapabilities !== undefined &&
        (!Array.isArray(rawCapabilities) ||
          rawCapabilities.some((value) => typeof value !== "string"))
      ) {
        throw new Error(`Candidate app ${candidate.unitName} has invalid capabilities`);
      }
      const declaredCapabilities = rawCapabilities ?? [];
      const allowedCapabilities = new Set<string>(APP_CAPABILITIES_BY_TARGET[target]);
      if (declaredCapabilities.some((value) => !allowedCapabilities.has(value))) {
        throw new Error(
          `Candidate app ${candidate.unitName} requests a capability invalid for ${target}`
        );
      }
      const capabilities = [...new Set(declaredCapabilities)].sort((left, right) =>
        left.localeCompare(right)
      ) as AppCapability[];
      const provider =
        target === "react-native"
          ? (this.deps.buildSystem.getBuildProviderDetails?.("react-native") ?? null)
          : null;
      const externalDeps = this.externalDepsWithProvider(candidate.externalDeps, provider);
      const identity = createUnitBuildIdentity({
        unitKind: "app" as const,
        name: candidate.unitName,
        sourceRepo: candidate.unitPath,
        ref: declaration.ref,
        effectiveVersion: candidate.effectiveVersion,
        dependencyEvs: candidate.dependencyEvs,
        externalDeps,
        capabilities,
      });
      const identityKey = canonicalUnitBuildIdentity(identity);
      const active = this.registry.get(candidate.unitName);
      const activeIdentity = active?.activeBundleKey ? this.registryEntryIdentity(active) : null;
      const providerChanged =
        target === "react-native" &&
        activeIdentity !== null &&
        canonicalAuthority(activeIdentity.externalDeps) !== canonicalAuthority(externalDeps);
      const currentDeclaration = this.lastDeclared.find(
        (entry) => normalizeRepoPath(entry.source) === normalizeRepoPath(declaration.source)
      );
      const current = currentDeclaration
        ? await this.deps.buildSystem.resolveBuildUnitIdentity(
            currentDeclaration.source,
            currentDeclaration.ref
          )
        : null;
      const currentIdentity = current
        ? createUnitBuildIdentity({
            unitKind: "app" as const,
            name: current.unitName,
            sourceRepo: current.unitPath,
            ref: currentDeclaration?.ref ?? "main",
            effectiveVersion: current.effectiveVersion,
            dependencyEvs: current.dependencyEvs,
            externalDeps: this.externalDepsWithProvider(current.externalDeps, provider),
            capabilities,
          })
        : null;
      if (
        !providerChanged &&
        currentIdentity &&
        canonicalUnitBuildIdentity(currentIdentity) === identityKey
      ) {
        continue;
      }
      const previousPackageJson = current
        ? await this.deps.readWorkspaceFileAtState(
            current.stateHash,
            `${current.unitPath}/package.json`
          )
        : null;
      const previousAuthority = previousPackageJson
        ? unitAuthorityManifestFromPackageJson(
            previousPackageJson,
            current?.unitName ?? candidate.unitName
          )
        : { requests: [], provides: [] };
      const authority = unitAuthorityManifestFromPackageJson(packageJsonSource, candidate.unitName);
      identityKeys.push(identityKey);
      identityKeysByRepo.set(candidate.unitPath, identityKey);
      if (
        current &&
        !providerChanged &&
        canonicalAuthority({
          manifest: previousAuthority,
          serviceBindings: current.serviceBindings,
          serviceReviews: current.serviceReviews,
        }) ===
          canonicalAuthority({
            manifest: authority,
            serviceBindings: candidate.serviceBindings,
            serviceReviews: candidate.serviceReviews,
          })
      ) {
        unchangedCount += 1;
        continue;
      }
      units.push({
        ...createReviewedUnitBase({
          unitKind: "app",
          name: candidate.unitName,
          displayName:
            typeof packageJson.vibestudio?.displayName === "string"
              ? packageJson.vibestudio.displayName
              : typeof packageJson.vibestudio?.title === "string"
                ? packageJson.vibestudio.title
                : candidate.unitName,
          ...(typeof packageJson.vibestudio?.icon === "string"
            ? { icon: packageJson.vibestudio.icon }
            : {}),
          ...(typeof packageJson.vibestudio?.icon === "string" &&
          packageJson.vibestudio.icon.trim().startsWith("./")
            ? { iconState: candidate.stateHash }
            : {}),
          version: typeof packageJson.version === "string" ? packageJson.version : "unknown",
          sourceRepo: candidate.unitPath,
          ref: declaration.ref,
          effectiveVersion: candidate.effectiveVersion,
          dependencyEvs: candidate.dependencyEvs,
          externalDeps,
        }),
        target,
        capabilities,
        authority: {
          ...authority,
          serviceBindings: [...candidate.serviceBindings],
          serviceReviews: [...candidate.serviceReviews],
        },
        integrity: null,
        provider,
      });
      if (current) previousRequests.set(candidate.unitPath, previousAuthority.requests);
    }
    return { units, identityKeys, unchangedCount, previousRequests, identityKeysByRepo };
  }

  acceptPreapprovedTrust(keys: Iterable<string>): void {
    this.unitHost.acceptPreapprovedTrust(keys);
  }

  preparePreapprovedTrust(keys: Iterable<string>) {
    return this.unitHost.preparePreapprovedTrust(keys);
  }

  listWorkspaceUnits(): Array<{
    name: string;
    kind: "app";
    source: string;
    displayName: string;
    status: AppRegistryEntry["status"];
    version: string;
    ev: string | null;
    activeEv: string | null;
    activeBundleKey: string | null;
    activeRuntimeDepsKey: string | null;
    lastError: string | null;
    lastErrorDetails?: AppUpdateErrorDiagnostic | null;
    target: WorkspaceAppTarget;
    canRollback: boolean;
    rollbackRetentionLimit: number;
    previousVersions: AppVersionRecord[];
  }> {
    return this.unitHost.listWorkspaceUnits().map((row) => {
      const entry = this.registry.get(row.name);
      return {
        ...row,
        target: entry?.target ?? "electron",
        canRollback: !!entry?.previousVersions?.length,
        rollbackRetentionLimit: UNIT_ROLLBACK_HISTORY_LIMIT,
        lastErrorDetails: entry?.lastErrorDetails ?? null,
        previousVersions: entry?.previousVersions ?? [],
      };
    });
  }

  listAppVersions(sourceOrName: string): {
    current: AppVersionRecord | null;
    previous: AppVersionRecord[];
    retentionLimit: number;
  } {
    this.assertInitialized();
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) return { current: null, previous: [], retentionLimit: UNIT_ROLLBACK_HISTORY_LIMIT };
    return {
      current: this.unitHost.currentVersion(entry),
      previous: [...entry.previousVersions],
      retentionLimit: UNIT_ROLLBACK_HISTORY_LIMIT,
    };
  }

  async listHostTargetCandidates(target: HostTarget): Promise<HostTargetCandidate[]> {
    if (!this.deps.isSystemWorkspace()) return [];
    await this.initialize();
    const declaredNames = new Set(
      this.lastDeclared
        .map((decl) => this.tryFindAppNode(decl.source)?.name)
        .filter((name): name is string => typeof name === "string")
    );
    const nodes = this.deps.buildSystem
      .getGraph()
      .allNodes()
      .filter(
        (node) => node.kind === "app" && normalizeRepoPath(node.relativePath).startsWith("apps/")
      )
      .filter((node) => this.appTarget(node) === target);
    const candidates = await Promise.all(
      nodes.map((node) => this.hostTargetCandidate(node, target, declaredNames.has(node.name)))
    );
    return candidates.sort(
      (a, b) => Number(b.declared) - Number(a.declared) || a.source.localeCompare(b.source)
    );
  }

  private async prepareReleaseAtRef(
    target: HostTarget,
    sourceOrName: string,
    ref: string
  ): Promise<{ buildKey: string; effectiveVersion: string; appId: string; source: string }> {
    await this.initialize();
    const candidate = (await this.listHostTargetCandidates(target)).find(
      (item) => item.name === sourceOrName || item.source === normalizeRepoPath(sourceOrName)
    );
    if (!candidate) throw new Error(`No ${target} app candidate found for ${sourceOrName}`);
    const node = this.findAppNode(candidate.name);
    const previous = this.registry.get(candidate.name) ?? null;
    const decl: WorkspaceAppDeclaration = {
      source: candidate.source,
      ref,
    };
    this.assertHostTargetMatchesManifest(node, target);
    const build = await this.deps.buildSystem.getStoredBuild(candidate.name, ref);
    this.validateBuildForTarget(candidate.name, target, build);
    // Building and inspecting an exact candidate remains available while
    // its launch review is pending; only promotion requires acceptance.
    if (this.deps.isAdmitted && !this.deps.isAdmitted(node.relativePath, build.metadata.ev)) {
      return {
        buildKey: path.basename(build.dir),
        effectiveVersion: build.metadata.ev,
        appId: candidate.name,
        source: candidate.source,
      };
    }
    const externalDeps = this.externalDepsForBuild(node, build.metadata, decl);
    const dependencyEvs = this.currentDependencyEvs(node);
    const trust = this.hostPinnedRefTrustRecord(
      createUnitBuildIdentity({
        unitKind: "app",
        name: node.name,
        sourceRepo: node.relativePath,
        ref,
        effectiveVersion: build.metadata.ev,
        dependencyEvs,
        externalDeps,
        capabilities: this.appCapabilities(node),
      })
    );
    if (!previous) this.registry.upsert(this.pendingEntryFor(node, decl, true));
    this.adoptBuild(node, target, ref, build, { dependencyEvs, externalDeps }, trust);
    return {
      buildKey: path.basename(build.dir),
      effectiveVersion: build.metadata.ev,
      appId: candidate.name,
      source: candidate.source,
    };
  }

  async prepareRelease(
    sourceOrName: string,
    ref: string
  ): Promise<{ buildKey: string; effectiveVersion: string; appId: string; source: string }> {
    await this.initialize();
    for (const target of ["electron", "react-native", "terminal"] as const) {
      const candidate = (await this.listHostTargetCandidates(target)).find(
        (item) => item.name === sourceOrName || item.source === normalizeRepoPath(sourceOrName)
      );
      if (candidate) return this.prepareReleaseAtRef(target, candidate.name, ref);
    }
    throw new Error(`Unknown app release: ${sourceOrName}`);
  }

  async rollbackAppVersion(sourceOrName: string, buildKey?: string): Promise<AppRegistryEntry> {
    await this.initialize();
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown app: ${sourceOrName}`);
    const selected = buildKey
      ? entry.previousVersions.find((candidate) => candidate.activeBundleKey === buildKey)
      : entry.previousVersions[0];
    if (!selected) {
      throw new Error(
        buildKey
          ? `No rollback version ${buildKey} is available for app ${entry.name}`
          : `No rollback version is available for app ${entry.name}`
      );
    }
    const build = await this.deps.buildSystem.getBuildByKey(selected.activeBundleKey);
    if (!build)
      throw new Error(
        `Rollback app build is missing from the build store: ${selected.activeBundleKey}`
      );
    this.validateBuildForTarget(entry.name, selected.target, build);

    const updated = this.unitHost.selectVersion(entry.name, selected, {
      status: "running",
      lastErrorDetails: null,
      activationTrust: null,
    });
    const activated = this.registry.get(updated.name) ?? updated;
    await this.adopt(activated, "rolled-back", build, { notify: true });
    return activated;
  }

  async restart(sourceOrName: string): Promise<void> {
    await this.initialize();
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown app: ${sourceOrName}`);
    if (!entry.activeBundleKey) throw new Error(`App ${entry.name} has no active build`);
    const build = await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey);
    if (!build) throw new Error(`Active app build is missing: ${entry.activeBundleKey}`);
    this.validateBuildForTarget(entry.name, entry.target, build);
    await this.adopt(entry, "adopted", build);
  }

  /** Ensure the declared release has an owned preparation and activation.
   * Registry status survives process death; it never proves a flight exists. */
  ensureActivated(sourceOrName: string): Promise<"ready"> {
    if (this.retiring) return Promise.reject(new Error("App host is retiring"));
    this.assertAppHosting();
    const node = this.findAppNode(sourceOrName);
    const pending = this.activationFlights.get(node.name);
    if (pending) return pending;
    const flight = Promise.resolve()
      .then(async () => {
        await this.initialize();
        // A host target's app can be demanded before startup reconciliation
        // admits the host build's units; its target preparation admits them.
        const target = this.appTarget(node);
        const hostTarget = this.deps.getHostTargetDecl?.(target);
        if (
          hostTarget &&
          normalizeRepoPath(hostTarget.appSource) === normalizeRepoPath(node.relativePath)
        ) {
          await this.deps.prepareHostTarget?.(target);
        }
        await this.unitHost.whenDeclarationsStaged();
        await this.unitHost.whenApplied(node.name);
        const entry = this.findRegistryEntry(node.name);
        const declared = this.lastDeclared.find(
          (item) => normalizeRepoPath(item.source) === normalizeRepoPath(node.relativePath)
        );
        if (!declared) throw new Error(`App is not declared: ${node.relativePath}`);
        // A ready immutable release (including an explicitly selected rollback)
        // can be activated directly. Interrupted preparation must be reproduced
        // through the ordinary build owner, regardless of saved status.
        if (
          !entry ||
          !isCapabilityActiveStatus(entry.status) ||
          !entry.activeBundleKey ||
          !(await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey))
        ) {
          // Permission review owns grants separately from deterministic preparation.
          // Starting a window must not resolve that review or wait on its decision.
          await this.applyDeclared(node, declared);
        }
        await this.activateRelease(node.name);
        return "ready" as const;
      })
      .finally(() => {
        if (this.activationFlights.get(node.name) === flight)
          this.activationFlights.delete(node.name);
      });
    this.activationFlights.set(node.name, flight);
    return flight;
  }

  async activateRelease(sourceOrName: string): Promise<void> {
    await this.initialize();
    let prepared = this.findRegistryEntry(sourceOrName);
    if (!prepared) throw new Error(`Unknown app: ${sourceOrName}`);
    let build = prepared.activeBundleKey
      ? await this.deps.buildSystem.getBuildByKey(prepared.activeBundleKey)
      : null;
    if (!build) {
      const preparedSourceRepo = prepared.source.repo;
      const declared = this.lastDeclared.find(
        (entry) => normalizeRepoPath(entry.source) === normalizeRepoPath(preparedSourceRepo)
      );
      if (declared) {
        // Activation is the final race-free readiness boundary. A workspace
        // child can recover its durable registry before bootstrap cleanup has
        // settled the artifact store, so declaration reconciliation alone is
        // not sufficient: recover the exact approved declaration here too.
        await this.applyDeclared(this.findAppNode(declared.source), declared);
        prepared = this.findRegistryEntry(sourceOrName);
        build = prepared?.activeBundleKey
          ? await this.deps.buildSystem.getBuildByKey(prepared.activeBundleKey)
          : null;
      }
    }
    if (!prepared?.activeBundleKey) throw new Error(`App ${sourceOrName} has no active build`);
    if (!build) throw new Error(`Active app build is missing: ${prepared.activeBundleKey}`);
    this.validateBuildForTarget(prepared.name, prepared.target, build);
    this.requireAdmission(prepared.name, prepared.source.repo, build.metadata.ev);
    // A recorded update that was not adopted describes the candidate, not this
    // build, so activating the adopted build leaves it in place.
    await this.adopt(this.registry.patch(prepared.name, { status: "running" }), "adopted", build);
  }

  async retire(sourceOrName: string): Promise<void> {
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown app: ${sourceOrName}`);
    this.retireAppEntity(entry.name);
    this.registry.patch(entry.name, { status: "stopped", lastError: null });
  }

  listWorkspaceUnitLogs(name: string): Array<{
    workspaceId: string;
    unitName: string;
    kind: "app";
    timestamp: number;
    level: "info" | "error";
    message: string;
  }> {
    return this.deps.diagnostics.history(name).entries.map((entry) => ({
      workspaceId: entry.workspaceId ?? this.deps.workspaceId,
      unitName: entry.entityId,
      kind: "app",
      timestamp: entry.timestamp,
      level: entry.level === "error" ? "error" : "info",
      message: entry.message,
    }));
  }

  /**
   * Activate the device-scoped principal through which a client device runs
   * the selected app of `target` (`hostTargets.<target>.app` unless `source`
   * names another app). Returns null while that app has no running build.
   */
  async registerDevicePrincipal(
    target: WorkspaceAppTarget,
    deviceId: string,
    source?: string | null
  ): Promise<DeviceAppPrincipal | null> {
    // Client apps are System-workspace units; nowhere else can mint their principals.
    this.assertAppHosting();
    await this.initialize();
    const resolvedSource = source ?? this.deps.getHostTargetDecl?.(target)?.appSource;
    if (!resolvedSource) return null;
    return this.principals.register(target, deviceId, resolvedSource);
  }

  hasAppCapability(callerId: string, capability: AppCapability): boolean {
    if (!this.deps.isSystemWorkspace()) return false;
    const entry =
      this.registry.get(callerId) ??
      this.registry.list().find((candidate) => {
        const source = normalizeRepoPath(candidate.source.repo);
        return callerId.startsWith(`app:${source}:`);
      });
    if (
      capability === "panel-hosting" &&
      entry &&
      isCapabilityActiveStatus(entry.status) &&
      entry.capabilities.includes(capability) &&
      !this.isTrustGatedCapabilityAuthorized(entry.source.repo, capability)
    ) {
      return false;
    }
    return (
      !!entry && isCapabilityActiveStatus(entry.status) && entry.capabilities.includes(capability)
    );
  }

  /**
   * Authorization check for the trust-gated `panel-hosting` capability. It may
   * only be granted to app sources in `trust.chromeApps`; every other capability
   * is ungated. Emits a one-time warning when the gated capability is
   * self-declared by an unauthorized source, matching the historical
   * `hasAppCapability` logging behavior.
   */
  private isTrustGatedCapabilityAuthorized(repo: string, capability: AppCapability): boolean {
    if (capability === "panel-hosting") {
      if (isAuthorizedChromeAppSource(repo, this.deps.getWorkspaceTrustGrants())) return true;
      const source = normalizeAppSourcePath(repo);
      if (!this.loggedUnauthorizedPanelHostingSources.has(source)) {
        this.loggedUnauthorizedPanelHostingSources.add(source);
        console.warn(
          `[AppHost] Ignoring panel-hosting declaration from unauthorized app source '${source}'`
        );
      }
      return false;
    }
    return true;
  }

  /**
   * The server-vetted capability set for an app entry: the self-declared
   * capabilities with `panel-hosting` removed unless the app's source is
   * authorized. This is the set that MUST be
   * projected onto client-facing surfaces (e.g. the `supervision:changed` event), so
   * that a client can never treat an unauthorized self-declaration as granted.
   */
  private effectiveCapabilities(entry: AppRegistryEntry): AppCapability[] {
    return entry.capabilities.filter((capability) =>
      this.isTrustGatedCapabilityAuthorized(entry.source.repo, capability)
    );
  }

  capabilityAuthorizer(): CapabilityAuthorizer {
    return createCapabilityAuthorizer({
      hasAppCapability: (callerId, capability) => this.hasAppCapability(callerId, capability),
    });
  }

  async bakeDist(sourceOrName: string, outDir: string): Promise<AppDistBakeManifest> {
    await this.initialize();
    const entry =
      this.registry.get(sourceOrName) ??
      this.registry
        .list()
        .find(
          (candidate) =>
            normalizeRepoPath(candidate.source.repo) === normalizeRepoPath(sourceOrName)
        );
    if (!entry?.activeBundleKey) {
      throw new Error(`No active approved app build found for dist bake: ${sourceOrName}`);
    }
    const build = await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey);
    if (!build) {
      throw new Error(`Active app build is missing from the build store: ${entry.activeBundleKey}`);
    }
    const artifacts = await appArtifactsForDist(
      build,
      entry,
      build.artifacts,
      (storedBuild, artifact) =>
        this.deps.buildSystem.readBuildArtifactContent(storedBuild, artifact)
    );
    return writeAppDistBake({
      entry,
      build: {
        metadata: appBuildMetadataForDist(entry, build.metadata),
        artifacts,
      },
      outDir,
      buildKey: entry.activeBundleKey,
    });
  }

  /** Whether this app registry serves the build: it is active or retained for rollback. */
  async servesBuild(buildKey: string): Promise<boolean> {
    await this.initialize();
    return this.registry
      .list()
      .some(
        (entry) =>
          entry.activeBundleKey === buildKey ||
          entry.previousVersions.some((version) => version.activeBundleKey === buildKey)
      );
  }

  async ensureElectronReady(
    source?: string | null,
    opts: { waitForApproval?: boolean } = {}
  ): Promise<ElectronHostReadiness> {
    await this.initialize();
    // Launch-gate polls (waitForApproval: false) must not block on the full
    // unit reconcile — that made desktop readiness wait for every declared
    // unit to finish building. Wait only until declarations are classified,
    // then report an in-flight build as not-ready ("building" details map to
    // a preparing launch state); app status events re-poll until ready.
    const nonBlocking = opts.waitForApproval === false;
    if (nonBlocking) await this.unitHost.whenDeclarationsStaged();
    else await this.whenReconciled();

    const first = await this.electronReadinessSnapshot(source);
    if (first.ready) return first;

    const resolvedSource =
      first.source ?? source ?? this.deps.getHostTargetDecl?.("electron")?.appSource;
    if (!resolvedSource) return first;
    const candidate = (await this.listHostTargetCandidates("electron")).find(
      (item) =>
        item.source === normalizeRepoPath(resolvedSource) ||
        item.name === resolvedSource ||
        item.name === first.appId
    );
    if (!candidate) return first;
    const declared = this.declaredForCandidate(candidate);
    if (!declared) {
      return {
        ready: false,
        source: candidate.source,
        appId: candidate.name,
        reason: "Electron app is not declared in meta/vibestudio.yml",
        details: [`Declare ${candidate.source} under apps: before desktop clients can pair.`],
      };
    }

    if (nonBlocking) {
      const entry = this.registry.get(candidate.name);
      if (entry && (entry.status === "building" || entry.status === "pending-approval")) {
        return this.electronReadinessSnapshot(candidate.source);
      }
    }

    await this.reconcileHostTargetDeclaration("electron", declared, opts);
    return this.electronReadinessSnapshot(candidate.source);
  }

  /**
   * Compile and validate the selected Electron host artifact without admitting
   * or activating workspace code. Server readiness uses this operation so the
   * first desktop client never becomes the build scheduler; the normal launch
   * path owns the executable-principal transition; permission review owns grants.
   */
  async prepareElectronArtifact(source?: string | null): Promise<ElectronHostReadiness> {
    await this.initialize();
    await this.unitHost.whenDeclarationsStaged();

    const current = await this.electronReadinessSnapshot(source);
    if (current.ready) return current;

    const resolvedSource =
      current.source ?? source ?? this.deps.getHostTargetDecl?.("electron")?.appSource;
    if (!resolvedSource) return current;
    const candidate = (await this.listHostTargetCandidates("electron")).find(
      (item) =>
        item.source === normalizeRepoPath(resolvedSource) ||
        item.name === resolvedSource ||
        item.name === current.appId
    );
    if (!candidate) return current;
    if (!candidate.compatibility.selectable) return current;
    const declared = this.declaredForCandidate(candidate);
    if (!declared) {
      return {
        ready: false,
        source: candidate.source,
        appId: candidate.name,
        reason: "Electron app is not declared in meta/vibestudio.yml",
        details: [`Declare ${candidate.source} under apps: before desktop clients can pair.`],
      };
    }

    const build = await this.deps.buildSystem.getStoredBuild(candidate.name, declared.ref);
    this.validateBuildForTarget(candidate.name, "electron", build);
    const htmlArtifact = build.artifacts?.find((artifact) => artifact.role === "html");
    if (!htmlArtifact) {
      return {
        ready: false,
        source: candidate.source,
        appId: candidate.name,
        reason: "Selected Electron app build has no HTML entry point",
        details: [`${candidate.source}: build ${path.basename(build.dir)}`],
      };
    }
    const buildKey = path.basename(build.dir);
    return {
      ready: true,
      source: candidate.source,
      appId: candidate.name,
      buildKey,
      artifactRoute: appArtifactRoute(buildKey, htmlArtifact.path),
      details: [],
    };
  }

  private async electronReadinessSnapshot(source?: string | null): Promise<ElectronHostReadiness> {
    const resolvedSource = source ?? this.deps.getHostTargetDecl?.("electron")?.appSource;
    const candidates = await this.listHostTargetCandidates("electron");
    if (!resolvedSource) {
      return {
        ready: false,
        source: null,
        reason: "No Electron workspace app is selected",
        details:
          candidates.length > 0
            ? candidates.map(
                (candidate) =>
                  `${candidate.source}: ${candidate.status}${
                    candidate.compatibility.reasons.length > 0
                      ? ` (${candidate.compatibility.reasons.join("; ")})`
                      : ""
                  }`
              )
            : ["No apps with vibestudio.app.target: electron were found."],
      };
    }

    const normalizedSource = normalizeRepoPath(resolvedSource);
    const candidate = candidates.find(
      (item) => item.source === normalizedSource || item.name === resolvedSource
    );
    if (!candidate) {
      return {
        ready: false,
        source: normalizedSource,
        reason: "Selected Electron app is not available",
        details:
          candidates.length > 0
            ? candidates.map((item) => `${item.source}: ${item.status}`)
            : ["No Electron app candidates were found."],
      };
    }
    if (!candidate.compatibility.selectable) {
      return {
        ready: false,
        source: candidate.source,
        appId: candidate.name,
        reason: "Selected Electron app is not compatible",
        details: candidate.compatibility.reasons,
      };
    }

    const entry = this.registry
      .list()
      .find(
        (item) =>
          item.target === "electron" &&
          isCapabilityActiveStatus(item.status) &&
          normalizeRepoPath(item.source.repo) === normalizeRepoPath(candidate.source) &&
          item.activeBundleKey
      );
    const build = entry?.activeBundleKey
      ? await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey)
      : null;
    const htmlArtifact = build?.artifacts?.find((artifact) => artifact.role === "html");
    if (!entry?.activeBundleKey || !build || !htmlArtifact) {
      return {
        ready: false,
        source: candidate.source,
        appId: candidate.name,
        reason: "Selected Electron app does not have a prepared HTML build",
        details: [`${candidate.source}: ${candidate.status}`],
      };
    }

    const artifactRoute = appArtifactRoute(entry.activeBundleKey, htmlArtifact.path);
    return {
      ready: true,
      source: candidate.source,
      appId: entry.name,
      buildKey: entry.activeBundleKey,
      artifactRoute,
      details: [],
    };
  }

  private async applyDeclared(node: AppGraphNode, decl: WorkspaceAppDeclaration): Promise<void> {
    await this.initialize();
    if (
      this.appTarget(node, decl) === "react-native" &&
      !this.deps.buildSystem.getBuildProviderDetails?.("react-native")
    ) {
      // The native host supplies the React Native build provider when a mobile
      // client connects. A desktop-only server is therefore waiting for a
      // capability, not observing a failed app build. Preserve an existing
      // runnable bundle; otherwise keep a clean stopped entry that provider
      // registration can reconcile on demand.
      const existing = this.registry.get(node.name) ?? null;
      if (!existing) this.registry.upsert(this.pendingEntryFor(node, decl));
      this.registry.patch(node.name, {
        status: existing?.activeBundleKey ? "running" : "stopped",
        lastError: null,
        lastErrorDetails: null,
      });
      return;
    }
    await this.unitHost.applyRuntimeDeclaration({
      node,
      decl,
      validateBeforeApply: () => this.validateAppManifestAtPath(node.path, node.name),
      needsBuildRefresh: (entry) => this.needsBuildRefresh(entry, node, decl),
      buildAndActivate: async (n, d) => {
        await this.buildAndActivate(n, d);
      },
      validateBeforeActivateCurrent: (entry) => this.validateActiveBuild(entry),
      // Nothing to activate for an up-to-date unit; activation is demand-driven.
      activateCurrent: async () => undefined,
    });
  }

  /** Build, prove and adopt the declared release; returns the adopted build. */
  private async buildAndActivate(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): Promise<AppBuildResultLike> {
    this.assertAppHosting();
    const previous = this.registry.get(node.name) ?? null;
    const diagnostic: AppUpdateErrorDiagnostic = { phase: "build", source: node.relativePath };
    try {
      if (!previous) this.registry.upsert(this.pendingEntryFor(node, decl, true));
      else this.unitHost.markBuilding(node.name);
      const build = await this.deps.buildSystem.getStoredBuild(node.name, decl.ref);
      diagnostic.buildKey = path.basename(build.dir);
      diagnostic.phase = "target-validation";
      const target = this.appTarget(node, decl);
      diagnostic.target = target;
      this.validateBuildForTarget(node.name, target, build);
      this.requireAdmission(node.name, node.relativePath, build.metadata.ev);
      diagnostic.phase = "activation";
      this.adoptBuild(
        node,
        target,
        decl.ref,
        build,
        {
          dependencyEvs: this.currentDependencyEvs(node),
          externalDeps: this.externalDepsForBuild(node, build.metadata, decl),
        },
        null
      );
      return build;
    } catch (err) {
      if (err && typeof err === "object") {
        (err as { appUpdateDiagnostic?: AppUpdateErrorDiagnostic }).appUpdateDiagnostic =
          diagnostic;
      }
      // The running build stays; the failed update is recorded, never promoted.
      this.unitHost.rejectUpdate(
        node.name,
        previous,
        err instanceof Error ? err.message : String(err),
        { lastErrorDetails: diagnostic }
      );
      throw err;
    }
  }

  /**
   * Announce an adopted build to clients and, unless it is an update, activate
   * its entity. `adopted` covers first activation and updates alike; the
   * target's adoption policy tells each client whether to take it now, ask
   * first, or ignore it. An update is announced only: the running build keeps
   * serving, with its principals and capabilities, until a client takes it.
   */
  private async adopt(
    entry: AppRegistryEntry,
    change: "adopted" | "rolled-back",
    build: AppBuildResultLike,
    opts: { update?: boolean; notify?: boolean } = {}
  ): Promise<void> {
    if (opts.update !== true) await this.activateAppEntity(entry, build);
    if (!build.metadata.authority) {
      throw new Error(`Active app ${entry.name} build is missing sealed authority metadata`);
    }
    const primary =
      (entry.target === "electron"
        ? build.artifacts.find((artifact) => artifact.role === "html")
        : undefined) ??
      build.artifacts.find((artifact) => artifact.role === "primary") ??
      build.artifacts[0];
    this.publish(
      {
        ...unitSupervisionChange(entry, null, change),
        previousBuildKey: entry.previousVersions[0]?.activeBundleKey ?? null,
        previousEffectiveVersion: entry.previousVersions[0]?.activeEv ?? null,
        adoption: appAdoptionPolicy(entry.target, opts.update === true),
        app: {
          ...this.appInfo(entry),
          artifactRoute: appArtifactRoute(
            entry.activeBundleKey ?? "",
            primary?.path ?? "index.html"
          ),
          authority: build.metadata.authority,
        },
      },
      entry
    );
    if (opts.notify) this.notifyAppUpdateAvailable(entry);
  }

  private appInfo(entry: AppRegistryEntry): NonNullable<SupervisionChange["app"]> {
    return { target: entry.target, capabilities: this.effectiveCapabilities(entry) };
  }

  /** The one place an app's state leaves the host: diagnostics, then clients. */
  private publish(change: SupervisionChange, entry: AppRegistryEntry): void {
    const name = change.identity.entityId;
    this.deps.diagnostics.record({
      workspaceId: this.deps.workspaceId,
      entityId: name,
      kind: "app",
      level: change.status === "error" || change.lastError ? "error" : "info",
      message: change.lastError ?? `App ${name} is ${change.status}`,
      source: "lifecycle",
      fields: { status: change.status, errorDetails: entry.lastErrorDetails ?? null },
    });
    this.deps.eventService.emit("supervision:changed", {
      ...change,
      app: { ...this.appInfo(entry), ...change.app },
    });
  }

  /** Current state of every app, for clients that start watching late. */
  supervisionSnapshot(): SupervisionChange[] {
    return this.registry.list().map((entry) => ({
      ...unitSupervisionChange(entry, null),
      app: this.appInfo(entry),
    }));
  }

  private async validateActiveBuild(entry: AppRegistryEntry): Promise<void> {
    if (!entry.activeBundleKey) throw new Error(`Active app ${entry.name} has no active build key`);
    const build = await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey);
    if (!build)
      throw new Error(`Active app build is missing from the build store: ${entry.activeBundleKey}`);
    this.validateBuildForTarget(entry.name, entry.target, build);
  }

  /** Adopt a proven build; the unit host records what it supersedes for rollback. */
  private adoptBuild(
    node: AppGraphNode,
    target: WorkspaceAppTarget,
    ref: string,
    build: AppBuildResultLike,
    deps: { dependencyEvs: Record<string, string>; externalDeps: Record<string, string> },
    trust: AppActivationTrustRecord | null
  ): AppRegistryEntry {
    return this.unitHost.activateBuild({
      name: node.name,
      version: readPackageVersion(node.path),
      sourceRepo: node.relativePath,
      ref,
      buildDir: build.dir,
      effectiveVersion: build.metadata.ev,
      activeSourceHash: requireBuildSourceStateHash(node.name, build),
      ...deps,
      runtimeDepsKey: null,
      status: "available",
      extra: {
        target,
        capabilities: this.appCapabilities(node),
        activeExecutionDigest: build.metadata.execution?.executionDigest ?? null,
        activationTrust: trust,
        lastErrorDetails: null,
      },
    });
  }

  /** Every app target runs only an exact build the user has accepted to run. */
  private requireAdmission(name: string, repoPath: string, effectiveVersion: string): void {
    requireExactUnitAdmission({
      service: "runtime.supervision",
      operation: "activate",
      unitLabel: "app",
      name,
      repoPath,
      effectiveVersion,
      isAdmitted: this.deps.isAdmitted,
      openReviewFor: this.deps.openUnitReviewFor,
    });
  }

  private validateBuildForTarget(
    appName: string,
    target: WorkspaceAppTarget,
    build: AppBuildResultLike
  ): void {
    this.assertAppHosting();
    validateAppBuildContract(appName, target, build);
  }

  private notifyAppUpdateAvailable(entry: AppRegistryEntry): void {
    const targetCopy = appUpdateTargetCopy(entry.target);
    const actions = [
      ...(entry.target === "electron"
        ? [
            {
              id: "app.applyUpdate",
              label: "Load update",
              variant: "solid" as const,
              command: { type: "app.applyUpdate" as const, appId: entry.name },
            },
          ]
        : []),
      ...(entry.previousVersions.length > 0
        ? [
            {
              id: "runtime.supervision.rollback",
              label: "Roll back",
              variant: entry.target === "electron" ? ("soft" as const) : ("solid" as const),
              command: {
                type: "runtime.supervision.rollback" as const,
                release: { kind: "app" as const, releaseId: entry.name },
              },
            },
          ]
        : []),
    ];
    this.deps.notificationService?.show({
      type: "info",
      title: targetCopy.title,
      message: `${entry.name}: ${targetCopy.message}`,
      ttl: 0,
      actions: actions.length > 0 ? actions : undefined,
    });
  }

  private notifyAppUpdateError(
    entry: AppRegistryEntry,
    message: string,
    diagnostic?: AppUpdateErrorDiagnostic | null
  ): void {
    const detail = diagnostic
      ? ` (${diagnostic.phase}${diagnostic.target ? `, ${diagnostic.target}` : ""})`
      : "";
    const kept = entry.activeEv ? " The previous version keeps running." : "";
    this.deps.notificationService?.show({
      type: "error",
      title: "Update not adopted",
      message: `${entry.name}: ${message}${detail}.${kept}`,
      ttl: 0,
      actions:
        entry.previousVersions.length > 0
          ? [
              {
                id: "runtime.supervision.rollback",
                label: "Roll back",
                variant: "solid",
                command: {
                  type: "runtime.supervision.rollback",
                  release: { kind: "app", releaseId: entry.name },
                },
              },
            ]
          : undefined,
    });
  }

  private findRegistryEntry(sourceOrName: string): AppRegistryEntry | null {
    return (
      this.registry.get(sourceOrName) ??
      this.registry
        .list()
        .find(
          (candidate) =>
            normalizeRepoPath(candidate.source.repo) === normalizeRepoPath(sourceOrName)
        ) ??
      null
    );
  }

  private async hostTargetCandidate(
    node: AppGraphNode,
    target: HostTarget,
    declared: boolean
  ): Promise<HostTargetCandidate> {
    const entry = this.registry.get(node.name);
    const capabilities = this.appCapabilities(node);
    const reasons: string[] = [];
    if (target === "electron" && !capabilities.includes("panel-hosting")) {
      reasons.push("Electron shell apps must declare the panel-hosting capability");
    }
    const activeBuild = entry?.activeBundleKey
      ? await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey)
      : null;
    if (activeBuild && target !== "electron") {
      try {
        validateAppBuildContract(node.name, target, activeBuild);
      } catch (error) {
        reasons.push(error instanceof Error ? error.message : String(error));
      }
    }
    return {
      name: node.name,
      source: normalizeRepoPath(node.relativePath),
      displayName: node.manifest.displayName ?? node.manifest.title ?? node.name,
      target,
      declared,
      status: entry?.status ?? "not-built",
      activeEv: entry?.activeEv ?? null,
      activeBundleKey: entry?.activeBundleKey ?? null,
      capabilities,
      canRollback: !!entry?.previousVersions.length,
      previousVersions: entry?.previousVersions ?? [],
      lastError: entry?.lastError ?? null,
      lastErrorDetails: entry?.lastErrorDetails ?? null,
      compatibility: {
        selectable: reasons.length === 0,
        reasons,
        recommended: target !== "electron" || capabilities.includes("panel-hosting"),
      },
    };
  }

  private async activateAppEntity(
    entry: AppRegistryEntry,
    selectedBuild?: AppBuildResultLike
  ): Promise<void> {
    if (!this.deps.entityCache || !entry.activeEv) return;
    const activeBuild = await this.resolveActiveAppBuild(entry, selectedBuild);
    const existing = this.deps.entityCache.resolve(entry.name);
    const sourceRepo = normalizeRepoPath(entry.source.repo);
    // WP3 §6: the shared workspace app is ONE instance every member reads and
    // drives (mutual invocation, plan §0.0). The context is keyed on
    // (workspaceId, app, name, source) and is deliberately NOT salted by
    // userId — salting would fragment the shared surface the product wants.
    // Concurrent-session ephemeral view state (cursor/scroll/transient
    // selection) lives per session/runtime — in the panel's per-slot context
    // (`generateContextId(slotId)`) or the device-scoped principal below — not
    // in this shared durable context, so two sessions never clobber.
    // The canonical derived-context format (`ctx-<32 hex>`): a valid context
    // folder and build ref, unlike a bare 64-hex digest.
    const contextId = contextIdForTargetKey(
      `${this.deps.workspaceId}\x00app\x00${entry.name}\x00${sourceRepo}`
    );
    const record: EntityRecord = {
      id: entry.name,
      kind: "app",
      source: { repoPath: sourceRepo, effectiveVersion: entry.activeEv },
      activeBuildKey: activeBuild.buildKey,
      ...activeBuild.identity,
      contextId,
      key: entry.name,
      createdAt: existing?.createdAt ?? Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    this.deps.entityCache._onActivate(record);
  }

  /**
   * Resolve the exact immutable artifact selected by an active app entry and
   * cross the sealed-build → executable-principal boundary. Every app runtime,
   * including device-scoped native principals, uses this same decision.
   */
  private async resolveActiveAppBuild(
    entry: AppRegistryEntry,
    selectedBuild?: AppBuildResultLike
  ): Promise<{
    buildKey: string;
    build: AppBuildResultLike;
    identity: ActiveExecutionIdentity;
  }> {
    this.assertAppHosting();
    if (!entry.activeEv) {
      throw new Error(`Cannot activate app ${entry.name} without an effective version`);
    }
    if (!entry.activeBundleKey) {
      throw new Error(`Cannot activate app ${entry.name} without an immutable build key`);
    }
    const build =
      selectedBuild ?? (await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey));
    if (!build) {
      throw new Error(
        `Cannot activate app ${entry.name}: immutable build ${entry.activeBundleKey} is unavailable`
      );
    }
    if (build.metadata.ev !== entry.activeEv) {
      throw new Error(
        `Cannot activate app ${entry.name}: build ${entry.activeBundleKey} has effective version ${build.metadata.ev}, expected ${entry.activeEv}`
      );
    }
    if (build.buildKey && build.buildKey !== entry.activeBundleKey) {
      throw new Error(
        `Cannot activate app ${entry.name}: build store returned ${build.buildKey} for ${entry.activeBundleKey}`
      );
    }
    if (build.metadata.buildKey && build.metadata.buildKey !== entry.activeBundleKey) {
      throw new Error(
        `Cannot activate app ${entry.name}: build metadata names ${build.metadata.buildKey} instead of ${entry.activeBundleKey}`
      );
    }
    if (build.metadata.execution?.executionDigest !== entry.activeExecutionDigest) {
      throw new Error(
        `Cannot activate app ${entry.name}: build ${entry.activeBundleKey} does not match its registry execution identity`
      );
    }
    if (
      build.metadata.sourcePath &&
      normalizeRepoPath(build.metadata.sourcePath) !== normalizeRepoPath(entry.source.repo)
    ) {
      throw new Error(
        `Cannot activate app ${entry.name}: build ${entry.activeBundleKey} belongs to ${build.metadata.sourcePath}`
      );
    }
    if (!isAppBuildDetailsLike(build.metadata.details)) {
      throw new Error(
        `Cannot activate app ${entry.name}: build ${entry.activeBundleKey} is not an app artifact`
      );
    }
    if (build.metadata.details.target !== entry.target) {
      throw new Error(
        `Cannot activate app ${entry.name}: build ${entry.activeBundleKey} targets ${build.metadata.details.target}, expected ${entry.target}`
      );
    }
    const identity = requireActiveExecutionIdentity(
      {
        executionDigest: build.metadata.execution?.executionDigest,
        authority: build.metadata.authority,
      },
      `app ${entry.name} build ${entry.activeBundleKey}`
    );
    return { buildKey: entry.activeBundleKey, build, identity };
  }

  private retireAppEntity(name: string): boolean {
    const existing = this.deps.entityCache?.resolve(name);
    if (!existing || existing.kind !== "app" || existing.status !== "active") return false;
    this.deps.entityCache?._onRetire({
      ...existing,
      status: "retired",
      retiredAt: Date.now(),
      cleanupComplete: true,
    });
    return true;
  }

  /**
   * Where these units came from, or nothing at all.
   *
   * A host with no resolver (tests, and any embedding without a workspace to
   * read) says nothing rather than claiming provenance it cannot derive.
   */
  private async resolveOriginsFor(
    entries: readonly ReviewedUnit[]
  ): Promise<ReadonlyMap<string, InstallReviewOrigin> | undefined> {
    if (!this.deps.resolveUnitOrigins) return undefined;
    return this.deps.resolveUnitOrigins(entries.map((entry) => entry.source.repo));
  }

  private pendingEntryFor(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration,
    building = false
  ): AppRegistryEntry {
    return {
      ...createPendingUnitRegistryEntry({
        unitKind: "app",
        name: node.name,
        version: readPackageVersion(node.path),
        sourceRepo: node.relativePath,
        ref: decl.ref,
        building,
      }),
      target: this.appTarget(node, decl),
      capabilities: this.appCapabilities(node),
      previousVersions: [],
    };
  }

  private async buildBatchEntry(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): Promise<ReviewedUnit> {
    const candidate = await this.deps.buildSystem.resolveBuildUnitIdentity(
      node.relativePath,
      decl.ref
    );
    if (
      !candidate ||
      candidate.unitName !== node.name ||
      candidate.effectiveVersion !== this.deps.buildSystem.getEffectiveVersion(node.name)
    )
      throw new Error(`Exact review source changed for ${node.relativePath}`);
    const details = await this.appBuildDetails(node.name);
    const active = this.registry.get(node.name);
    return {
      ...createReviewedUnitBase({
        unitKind: "app",
        name: node.name,
        displayName: node.manifest.displayName ?? node.manifest.title,
        ...(node.manifest.icon ? { icon: node.manifest.icon } : {}),
        version: readPackageVersion(node.path),
        sourceRepo: node.relativePath,
        ref: decl.ref,
        effectiveVersion: candidate.effectiveVersion,
        dependencyEvs: candidate.dependencyEvs,
        externalDeps: this.currentExternalDeps(node, decl, active),
      }),
      ...(node.manifest.icon?.trim().startsWith("./") ? { iconState: candidate.stateHash } : {}),
      target: this.appTarget(node, decl),
      capabilities: this.appCapabilities(node),
      authority: {
        ...parseUnitAuthorityManifest(
          candidate.manifest.authority,
          `${node.name} vibestudio.authority`
        ),
        serviceBindings: [...candidate.serviceBindings],
        serviceReviews: [...candidate.serviceReviews],
      },
      integrity: details?.integrity ?? null,
      provider: this.currentBuildProviderDetails(node, decl) ?? details?.provider ?? null,
    };
  }

  private declarationIdentity(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): UnitBuildIdentity<"app"> {
    return createUnitBuildIdentity({
      unitKind: "app" as const,
      name: node.name,
      sourceRepo: node.relativePath,
      ref: decl.ref,
      effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
      dependencyEvs: this.currentDependencyEvs(node),
      externalDeps: this.currentExternalDeps(node, decl, this.registry.get(node.name) ?? null),
      capabilities: this.appCapabilities(node),
    });
  }

  private registryEntryIdentity(entry: AppRegistryEntry): UnitBuildIdentity<"app"> {
    return unitBuildIdentityFromRegistryEntry(entry, entry.capabilities);
  }

  private async appBuildDetails(
    name: string
  ): Promise<Extract<NonNullable<AppBuildMetadataLike["details"]>, { kind: "app" }> | null> {
    const entry = this.registry.get(name);
    const metadata = entry?.activeBundleKey
      ? (await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey))?.metadata
      : null;
    return metadata?.details?.kind === "app"
      ? (metadata.details as Extract<NonNullable<AppBuildMetadataLike["details"]>, { kind: "app" }>)
      : null;
  }

  private async needsBuildRefresh(
    entry: AppRegistryEntry,
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): Promise<boolean> {
    await this.initialize();
    if (entry.status === "error") return true;
    // Registry state is only a durable pointer to an immutable build. The
    // artifact store can be recovered independently (for example after an
    // idle workspace child exits), so matching source/version metadata does
    // not make an absent artifact runnable. Rebuild it through the ordinary
    // declaration path instead of leaving every host launch to retry a dead
    // pointer forever.
    if (
      !entry.activeBundleKey ||
      !(await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey))
    ) {
      return true;
    }
    return this.unitHost.needsBuildRefresh(entry, {
      sourceRepo: node.relativePath,
      ref: decl.ref,
      effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
      dependencyEvs: this.currentDependencyEvs(node),
      externalDeps: this.currentExternalDeps(node, decl, entry),
    });
  }

  private async reconcileAfterProviderChange(_providerName: string): Promise<void> {
    const source = this.deps.getHostTargetDecl?.("react-native")?.appSource;
    if (!source) return;
    const candidate = (await this.listHostTargetCandidates("react-native")).find(
      (item) => item.source === normalizeRepoPath(source) || item.name === source
    );
    // Provider activation invalidates readiness but must not implicitly build
    // the mobile app during a desktop or terminal launch. Active React Native
    // launch sessions are refreshed by the coordinator and explicitly call
    // reactNative.ensureReady() themselves.
    this.emitDevStatusDiagnostic("provider-change");
    const entry = candidate ? this.registry.get(candidate.name) : null;
    if (entry) this.publish(unitSupervisionChange(entry, null), entry);
  }

  private declaredForCandidate(
    candidate: Pick<HostTargetCandidate, "source" | "name">
  ): WorkspaceAppDeclaration | null {
    return (
      this.lastDeclared.find((decl) => {
        const node = this.tryFindAppNode(decl.source);
        return (
          normalizeRepoPath(decl.source) === normalizeRepoPath(candidate.source) ||
          node?.name === candidate.name
        );
      }) ?? null
    );
  }

  private async reconcileHostTargetDeclaration(
    target: HostTarget,
    declared: WorkspaceAppDeclaration,
    opts: { waitForApproval?: boolean } = {}
  ): Promise<void> {
    this.assertAppHosting();
    await this.unitHost.reconcileDeclared([{ ...declared }], {
      trigger: "startup",
      removeUndeclared: false,
      waitFor: opts.waitForApproval === false ? "staged" : "applied",
    });
    if (opts.waitForApproval !== false) {
      await this.whenSettled();
    }
    this.emitDevStatusDiagnostic(`launch:${target}`);
  }

  private async handleChangedAppUnit(event: {
    name: string;
    relativePath: string;
    trigger?: ProtectedPublicationEvent;
  }): Promise<void> {
    const entry =
      this.registry.get(event.name) ??
      this.registry
        .list()
        .find(
          (candidate) =>
            normalizeRepoPath(candidate.source.repo) === normalizeRepoPath(event.relativePath)
        );
    if (!entry) return;
    if (!this.sourceChangeAppliesToEntry(event.trigger, entry)) return;
    await this.handleSourceRebuilt(entry.source.repo, event.trigger);
  }

  private sourceChangeAppliesToEntry(
    trigger: ProtectedPublicationEvent | undefined,
    entry: AppRegistryEntry
  ): boolean {
    if (!trigger) return true;
    return normalizeRef(entry.source.ref) === "main";
  }

  private async handleSourceRebuilt(
    source: string,
    trigger?: ProtectedPublicationEvent
  ): Promise<void> {
    const normalized = normalizeRepoPath(source);
    const entry = this.registry
      .list()
      .find((candidate) => normalizeRepoPath(candidate.source.repo) === normalized);
    if (!entry) return;
    if (!this.sourceChangeAppliesToEntry(trigger, entry)) return;
    const node = this.findAppNode(entry.name);
    try {
      const build = await this.buildAndActivate(node, {
        source: node.relativePath,
        ref: entry.source.ref,
      });
      const prepared = this.registry.get(entry.name);
      if (prepared?.activeBundleKey && prepared.activeBundleKey !== entry.activeBundleKey) {
        await this.adopt(prepared, "adopted", build, { update: true });
        this.notifyAppUpdateAvailable(prepared);
      }
      this.emitDevStatusDiagnostic("source-rebuilt");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const diagnostic =
        err && typeof err === "object"
          ? ((err as { appUpdateDiagnostic?: AppUpdateErrorDiagnostic }).appUpdateDiagnostic ??
            null)
          : null;
      const updated = this.registry.get(entry.name) ?? entry;
      this.publish(
        {
          ...unitSupervisionChange(updated, null, "update-rejected"),
          lastError: message,
        },
        updated
      );
      this.notifyAppUpdateError(updated, message, diagnostic);
    }
  }

  private emitDevStatusDiagnostic(trigger: string): void {
    if (!appDevDiagnosticsEnabled() || this.lastDeclared.length === 0) return;

    const rows: string[] = [];

    for (const decl of this.lastDeclared) {
      try {
        const node = this.findAppNode(decl.source);
        const entry = this.registry.get(node.name);
        const target = this.appTarget(node, decl);
        const activeEv = entry?.activeEv ? shortId(entry.activeEv) : "none";
        const activeBuild = entry?.activeBundleKey ? shortId(entry.activeBundleKey) : "none";
        const error =
          entry?.status === "error" && entry.lastError
            ? ` error=${JSON.stringify(entry.lastError)}`
            : "";

        rows.push(
          `${node.name} target=${target} source=${node.relativePath} ref=${decl.ref} status=${entry?.status ?? "uninstalled"} ev=${activeEv} build=${activeBuild}${error}`
        );
      } catch (error) {
        rows.push(
          `${decl.source} status=unresolved error=${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    const statusKey = `${trigger}\n${rows.join("\n")}`;
    if (statusKey !== this.lastDevStatusDiagnosticKey) {
      this.lastDevStatusDiagnosticKey = statusKey;
      console.info(`[Apps] Dev status (${trigger}):\n  ${rows.join("\n  ")}`);
    }
  }

  private findAppNode(nameOrRepo: string): AppGraphNode {
    return findUnitGraphNode(
      this.deps.buildSystem.getGraph().allNodes(),
      APP_UNIT_DESCRIPTOR,
      nameOrRepo
    );
  }

  private tryFindAppNode(nameOrRepo: string): AppGraphNode | null {
    try {
      return this.findAppNode(nameOrRepo);
    } catch {
      return null;
    }
  }

  private async readDeclaredAppsFromState(stateHash: string): Promise<WorkspaceAppDeclaration[]> {
    if (!this.deps.isSystemWorkspace()) return [];
    try {
      return resolveDeclaredApps(
        await readWorkspaceConfig(
          {
            readText: (filePath) => this.deps.readWorkspaceFileAtState(stateHash, filePath),
          },
          this.deps.workspaceId
        )
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `[AppHost] Cannot read declared apps from workspace state ${stateHash}; treating declarations as empty: ${message}`
      );
      return [];
    }
  }

  private validateAppManifestAtPath(nodePath: string, unitName: string): void {
    try {
      readAndValidateUnitManifest(
        appUnitManifestDescriptor,
        path.join(nodePath, "package.json"),
        { unitName },
        fs.readFileSync as (p: string, encoding: "utf-8") => string
      );
    } catch (err) {
      if (err instanceof UnitManifestError) throw err;
      throw new UnitManifestError(
        `App ${unitName} manifest validation failed: ${err instanceof Error ? err.message : String(err)}`,
        "MANIFEST_INTERNAL"
      );
    }
  }

  private appTarget(node: AppGraphNode, _decl?: WorkspaceAppDeclaration): WorkspaceAppTarget {
    const manifestTarget = node.manifest.app?.target;
    if (!manifestTarget) {
      throw new UnitManifestError(
        `App ${node.name} manifest must declare vibestudio.app.target`,
        "MANIFEST_APP_TARGET"
      );
    }
    return manifestTarget;
  }

  private assertHostTargetMatchesManifest(node: AppGraphNode, target: WorkspaceAppTarget): void {
    const manifestTarget = node.manifest.app?.target;
    if (manifestTarget && target !== manifestTarget) {
      throw new UnitManifestError(
        `App ${node.name} host target "${target}" does not match package manifest target "${manifestTarget}"`,
        "MANIFEST_APP_TARGET_MISMATCH"
      );
    }
  }

  private hostPinnedRefTrustRecord(identity: UnitBuildIdentity<"app">): AppActivationTrustRecord {
    return {
      decision: "host-target-pinned-ref",
      identityKey: canonicalUnitBuildIdentity(identity),
      actor: "shell-host",
      reason: "Host target pinned to an explicit ref selected by a trusted shell/server caller",
      acceptedAt: Date.now(),
    };
  }

  private appCapabilities(node: AppGraphNode): AppCapability[] {
    return [...(node.manifest.app?.capabilities ?? [])].sort();
  }

  private currentDependencyEvs(node: AppGraphNode): Record<string, string> {
    return collectTransitiveUnitDependencyEvs(
      this.deps.buildSystem.getGraph().allNodes(),
      node,
      (name) => this.deps.buildSystem.getEffectiveVersion(name)
    );
  }

  private currentExternalDeps(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration,
    fallbackEntry: AppRegistryEntry | null = null
  ): Record<string, string> {
    const provider = this.currentBuildProviderDetails(node, decl);
    if (!provider && fallbackEntry && this.appTarget(node, decl) === "react-native") {
      return this.externalDepsWithStoredBuildProvider(
        this.deps.buildSystem.getExternalDeps(node.name),
        fallbackEntry
      );
    }
    return this.externalDepsWithProvider(
      this.deps.buildSystem.getExternalDeps(node.name),
      provider
    );
  }

  private externalDepsForBuild(
    node: AppGraphNode,
    metadata: AppBuildMetadataLike,
    decl: WorkspaceAppDeclaration
  ): Record<string, string> {
    const details =
      metadata.details && metadata.details.kind === "app" && "provider" in metadata.details
        ? metadata.details
        : null;
    return this.externalDepsWithProvider(
      this.deps.buildSystem.getExternalDeps(node.name),
      details?.provider ?? this.currentBuildProviderDetails(node, decl)
    );
  }

  private currentBuildProviderDetails(
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): AppBuildProviderDetails | null {
    if (this.appTarget(node, decl) !== "react-native") return null;
    return this.deps.buildSystem.getBuildProviderDetails?.("react-native") ?? null;
  }

  private externalDepsWithProvider(
    externalDeps: Record<string, string>,
    provider: AppBuildProviderDetails | null
  ): Record<string, string> {
    if (!provider) return externalDeps;
    return {
      ...externalDeps,
      [`build-provider:${provider.name}`]: buildProviderIdentityValue(provider),
    };
  }

  private externalDepsWithStoredBuildProvider(
    externalDeps: Record<string, string>,
    entry: AppRegistryEntry
  ): Record<string, string> {
    const providerDeps = Object.fromEntries(
      Object.entries(entry.activeExternalDeps ?? {}).filter(([key]) =>
        key.startsWith("build-provider:")
      )
    );
    if (Object.keys(providerDeps).length === 0) return externalDeps;
    return { ...externalDeps, ...providerDeps };
  }
}

function requireUnitApprovalDecision(
  decision: Awaited<ReturnType<ApprovalQueueLike["request"]>>
): import("@vibestudio/unit-host").UnitApprovalDecision {
  if (decision === "accepted" || decision === "deny" || decision === "dismiss") {
    return decision;
  }
  throw new Error(`Invalid ${decision} decision for a workspace-unit approval`);
}

function buildProviderIdentityValue(provider: AppBuildProviderDetails): string {
  return [provider.activeEv ?? "", provider.activeBuildKey ?? "", provider.contractVersion].join(
    ":"
  );
}

/**
 * How a client runs an app of each target. Electron hosts the artifact in a
 * view, the mobile native host bootstraps its bundle, and `vibestudio terminal`
 * imports the terminal app's ESM module into its own process. No target runs
 * as a server process.
 */
function requireBuildSourceStateHash(unitName: string, build: AppBuildResultLike): string {
  if (build.sourceStateHash) return build.sourceStateHash;
  if (build.metadata.sourceStateHash) return build.metadata.sourceStateHash;
  throw new Error(`Build for ${unitName} is missing workspace source state provenance`);
}

function isCapabilityActiveStatus(status: AppRegistryEntry["status"]): boolean {
  return status === "running" || status === "available";
}

function appBuildMetadataForDist(
  entry: AppRegistryEntry,
  metadata: AppBuildMetadataLike
): BuildMetadata {
  const buildKey = metadata.buildKey ?? entry.activeBundleKey;
  if (!buildKey) {
    throw new Error(`Active build for ${entry.name} has no canonical build key`);
  }
  const details = metadata.details;
  if (!isAppBuildDetailsLike(details)) {
    throw new Error(`Active build for ${entry.name} is not an app build`);
  }
  if (metadata.sourcePath === undefined) {
    throw new Error(`Active build for ${entry.name} is missing its sealed source path`);
  }
  return {
    kind: "app",
    name: entry.name,
    buildKey,
    sourcePath: metadata.sourcePath,
    ev: metadata.ev,
    sourceStateHash: entry.activeSourceHash,
    sourcemap: true,
    ...(metadata.authority ? { authority: metadata.authority } : {}),
    ...(metadata.execution ? { execution: metadata.execution } : {}),
    details: {
      kind: "app",
      target: details.target,
      integrity: details.integrity ?? null,
      rnHostAbi: details.rnHostAbi ?? null,
      provider: details.provider ?? null,
    },
    builtAt: new Date().toISOString(),
  };
}

function isAppBuildDetailsLike(
  details: AppBuildMetadataLike["details"]
): details is Extract<NonNullable<AppBuildMetadataLike["details"]>, { kind: "app" }> {
  return (
    !!details && details.kind === "app" && (details as { target?: unknown }).target !== undefined
  );
}

async function appArtifactsForDist(
  build: AppBuildResultLike,
  entry: AppRegistryEntry,
  artifacts: readonly AppBuildArtifactLike[],
  readArtifactContent: (
    build: AppBuildResultLike,
    artifact: AppBuildArtifactLike
  ) => Promise<string>
): Promise<Array<BuildArtifactManifestEntry & { content: string }>> {
  return Promise.all(
    artifacts.map(async (artifact) => {
      if (!isBuildArtifactRole(artifact.role)) {
        throw new Error(
          `Active build for ${entry.name} has invalid artifact role: ${artifact.role}`
        );
      }
      if (!isBuildArtifactEncoding(artifact.encoding)) {
        throw new Error(
          `Active build for ${entry.name} has invalid artifact encoding: ${artifact.encoding}`
        );
      }
      return {
        path: artifact.path,
        role: artifact.role,
        contentType: artifact.contentType,
        encoding: artifact.encoding,
        ...(artifact.platform ? { platform: artifact.platform } : {}),
        ...(artifact.integrity ? { integrity: artifact.integrity } : {}),
        content: await readArtifactContent(build, artifact),
      };
    })
  );
}

function isBuildArtifactRole(role: string): role is BuildArtifactManifestEntry["role"] {
  return (
    role === "primary" || role === "asset" || role === "html" || role === "css" || role === "map"
  );
}

function isBuildArtifactEncoding(
  encoding: string
): encoding is BuildArtifactManifestEntry["encoding"] {
  return encoding === "utf8" || encoding === "base64";
}

/**
 * Per-target adoption policy. Electron and React Native ask before replacing
 * what is running with an update; a terminal app is fetched by the client each
 * time it launches, so nothing is pushed to it.
 */
function appAdoptionPolicy(target: WorkspaceAppTarget, update: boolean): AppAdoptionPolicy {
  if (target === "terminal") return "artifact-only";
  return update ? "prompt" : "immediate";
}

function appUpdateTargetCopy(target: WorkspaceAppTarget): { title: string; message: string } {
  if (target === "react-native") {
    return {
      title: "Mobile app update available",
      message: "a new trusted bundle is ready. Open the mobile app to install it.",
    };
  }
  if (target === "terminal") {
    return {
      title: "Terminal app update available",
      message: "a new trusted terminal build is ready. Restart `vibestudio terminal` to use it.",
    };
  }
  return {
    title: "Desktop app update available",
    message: "a new trusted build is ready to load.",
  };
}

function readPackageVersion(nodePath: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(nodePath, "package.json"), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

function appDevDiagnosticsEnabled(): boolean {
  const override = process.env["VIBESTUDIO_APP_DEV_STATUS"];
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  return process.env["NODE_ENV"] === "development";
}

function shortId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 12 ? value.slice(0, 12) : value;
}
