import * as fs from "node:fs";
import * as path from "node:path";
import { isProductSeedTrusted } from "@vibestudio/shared/productSeedTrust";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
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
  unitBuildIdentityFromRegistryEntry,
  canonicalUnitBuildIdentity,
  readUnitAuthorityReview,
  authorityReviewFromPackageJson,
  type UnitBuildIdentity,
  type UnitDescriptor,
  type UnitApprovalCoordinator,
  type UnitChangeApprovalProvider,
  type UnitReconcileOptions,
  type UnitReconcileTrigger,
  type UnitRegistryEntryBase,
} from "@vibestudio/unit-host";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { EventName, NotificationPayload } from "@vibestudio/shared/events";
import type { ExecutionPublicationPort } from "@vibestudio/shared/execution/retention";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import {
  isAuthorizedChromeAppSource,
  normalizeAppSourcePath,
} from "@vibestudio/shared/chromeTrust";
import type {
  PendingApproval,
  PendingUnitInstallReviewApproval,
  ReviewedUnit,
} from "@vibestudio/shared/approvals";
import type { CapabilityPresentationResolver } from "@vibestudio/shared/authorityPresentation";
import type { UnitAuthorityRequest } from "@vibestudio/shared/authorityManifest";
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
import { appArtifactRoute, appArtifactUrl } from "@vibestudio/shared/appArtifacts";
import { RESUMABLE_GZIP_HEADER } from "@vibestudio/shared/panel/assetHeaders";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { writeAppDistBake, type AppDistBakeManifest } from "./buildV2/distBake.js";
import {
  readArtifactBytesAsync,
  type BuildArtifactManifestEntry,
  type BuildMetadata,
} from "./buildV2/buildStore.js";

const gzipAsync = promisify(gzip);
import {
  createCapabilityAuthorizer,
  type CapabilityAuthorizer,
} from "./services/capabilityAuthorizer.js";
import type { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import { TerminalAppRuntime } from "./terminalAppRuntime.js";
import {
  ReactNativeAppAdapter,
  isBuildProviderDetailsLike,
  type AppBuildProviderDetails,
} from "./reactNativeAppAdapter.js";
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
};
const APP_ROLLBACK_HISTORY_LIMIT = 5;

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
  /** Terminal apps that render an interactive TUI (inherit the real TTY). */
  interactive?: boolean;
  previousVersions: AppVersionRecord[];
  lastErrorDetails?: AppUpdateErrorDiagnostic | null;
  activationTrust?: AppActivationTrustRecord | null;
}

export interface AppVersionRecord {
  version: string;
  target: WorkspaceAppTarget;
  capabilities: AppCapability[];
  activeEv: string | null;
  activeSourceHash: string | null;
  activeBundleKey: string;
  activeDependencyEvs: Record<string, string>;
  activeExternalDeps: Record<string, string>;
  activeRuntimeDepsKey: string | null;
  activatedAt: number;
}

export interface AppActivationTrustRecord {
  decision: "host-target-pinned-ref";
  identityKey: string;
  actor: "shell-host";
  reason: string;
  acceptedAt: number;
}

interface AppAvailablePayload {
  appId: string;
  source: string;
  target: WorkspaceAppTarget;
  launchMode: "hosted-view" | "native-bootstrap" | "terminal-process";
  url?: string;
  artifactRoute: string;
  artifacts: Array<{
    path: string;
    role: string;
    contentType: string;
    encoding: string;
    platform?: string;
    integrity?: string;
    route: string;
    url?: string;
  }>;
  capabilities: AppCapability[];
  buildKey: string | null;
  effectiveVersion: string | null;
  executionDigest: string | null;
  authority: import("@vibestudio/shared/authorityManifest").UnitAuthorityManifest;
  previousBuildKey: string | null;
  previousEffectiveVersion: string | null;
  canRollback: boolean;
  adoptionPolicy: "immediate" | "prompt" | "artifact-only";
  selectedForHost?: boolean;
  integrity?: string | null;
  rnHostAbi?: string | null;
  provider?: AppBuildProviderDetails | null;
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
  getBuild(unitPath: string, ref?: string): Promise<AppBuildResultLike>;
  getBuildByKey?(key: string): AppBuildResultLike | null;
  getEffectiveVersion(unitName: string): string | null;
  listAffectedBuildUnits?(stateHash: string, changedPaths: readonly string[]): Promise<string[]>;
  resolveBuildUnitIdentity?(
    unitPath: string,
    ref?: string
  ): Promise<{
    unitPath: string;
    unitName: string;
    stateHash: string;
    effectiveVersion: string;
    dependencyEvs: Record<string, string>;
    externalDeps: Record<string, string>;
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

interface AppBuildArtifactLike {
  path: string;
  role: BuildArtifactManifestEntry["role"];
  contentType: string;
  encoding: BuildArtifactManifestEntry["encoding"];
  platform?: string;
  integrity?: string;
  content: string;
}

export interface AppBuildResultLike {
  dir: string;
  buildKey?: string;
  sourceStateHash?: string | null;
  metadata: AppBuildMetadataLike;
  artifacts?: AppBuildArtifactLike[];
}

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
  entityCache?: Pick<EntityCache, "resolve" | "listActive" | "_onActivate" | "_onRetire">;
  executionPublicationPort?: ExecutionPublicationPort;
  connectionGrants?: Pick<ConnectionGrantService, "grant" | "revokeForPrincipal">;
  getGatewayUrl(): string;
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
}

export class AppHost implements UnitChangeApprovalProvider<ReviewedUnit> {
  readonly registry: UnitRegistry<AppRegistryEntry>;
  readonly reactNative: ReactNativeAppAdapter;
  readonly terminal: TerminalAppRuntime;
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

  constructor(private readonly deps: AppHostDeps) {
    this.registry = new UnitRegistry<AppRegistryEntry>({
      statePath: deps.statePath,
      unitKind: "app",
      normalizeEntry: (entry) => ({
        ...entry,
        activeDependencyEvs: entry.activeDependencyEvs ?? {},
        activeExternalDeps: entry.activeExternalDeps ?? {},
        capabilities: entry.capabilities ?? [],
        previousVersions: entry.previousVersions ?? [],
        lastErrorDetails: entry.lastErrorDetails ?? null,
        activationTrust: entry.activationTrust ?? null,
      }),
      publicationPort: deps.executionPublicationPort,
      publicationKeyForEntry: (entry) =>
        JSON.stringify([
          entry.activeBundleKey,
          ...entry.previousVersions.map((version) => version.activeBundleKey),
        ]),
      publicationForEntry: (entry) => {
        const buildKeys = [
          ...(entry.activeBundleKey ? [entry.activeBundleKey] : []),
          ...entry.previousVersions.map((version) => version.activeBundleKey),
        ];
        return {
          owner: entry.target === "terminal" ? "terminal-app" : "app-generation",
          ownerId: entry.name,
          artifacts: buildKeys.map((buildKey) => {
            const executionDigest =
              deps.buildSystem.getBuildByKey?.(buildKey)?.metadata.execution?.executionDigest;
            if (!executionDigest) {
              throw new Error(`App ${entry.name} references unverifiable build ${buildKey}`);
            }
            return { buildKey, executionDigest };
          }),
        };
      },
    });
    this.trustResolver = new UnitTrustResolver<AppRegistryEntry>({
      entryIdentity: (entry) => this.registryEntryIdentity(entry),
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
      // The desktop, mobile, and terminal apps that ARE Vibestudio ship with a
      // signed record over their own source. The user decided about them by
      // installing Vibestudio; asking again on a surface one of them renders
      // would be a question that cannot be answered (§7.6).
      isSeedTrusted: (node, identity) =>
        isProductSeedTrusted({
          unitDir: path.join(deps.workspacePath, node.relativePath),
          identity: {
            unitKind: "app",
            name: identity.name,
            source: identity.source,
            effectiveVersion: identity.effectiveVersion,
          },
        }),
      makePendingEntry: (node, decl, building) => this.pendingEntryFor(node, decl, building),
      applyTrusted: (node, decl) => this.applyDeclared(node, decl),
      removeUndeclared: async (entry) => {
        await this.terminal.stop(entry.name);
        this.reactNative.retirePrincipalsForEntry(entry);
        this.retireAppEntity(entry.name);
        this.emitStatus(entry.name, "stopped", null);
      },
      emitRemoved: (entry) => {
        this.deps.eventService.emit("apps:status" as EventName, {
          name: entry.name,
          status: "stopped",
          error: null,
        });
      },
      notifyUnresolved: (sources) => {
        this.deps.notificationService?.show({
          type: "error",
          title: "Unknown apps declared",
          message: `meta/vibestudio.yml declares apps that don't exist: ${sources.join(", ")}.`,
        });
      },
      validateBeforeApproval: (node) => this.validateAppManifestAtPath(node.path, node.name),
      onApprovalCandidateError: (node, _decl, message) =>
        this.emitStatus(node.name, "error", message),
      approvalEntry: (node, decl) => this.buildBatchEntry(node, decl),
      approvalOrigins: (entries) => this.resolveOriginsFor(entries),
      approvalBatchKey: (entry) => entry.target ?? undefined,
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
      onApprovalDenied: (items) => {
        for (const { node } of items) this.emitStatus(node.name, "pending-approval", null);
      },
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
      entityCache: deps.entityCache,
      getArtifactBaseUrl: () => deps.getReactNativeAppArtifactBaseUrl(),
      selectedSource: () => deps.getHostTargetDecl?.("react-native")?.appSource ?? null,
      listCandidates: () => this.listHostTargetCandidates("react-native"),
      declaredForCandidate: (candidate) => this.declaredForCandidate(candidate),
      requiredExtensions: () => deps.getHostTargetDecl?.("react-native")?.requiresExtensions ?? [],
      whenDeclarationsStaged: () => this.unitHost.whenDeclarationsStaged(),
      whenReconciled: () => this.unitHost.whenReconciled(),
      reconcileDeclaration: (declaration, options) =>
        this.reconcileHostTargetDeclaration("react-native", declaration, options),
      approvalForDeclarations: (declarations) =>
        this.unitHost.approvalForDeclarations(declarations),
      acceptPreapprovedTrust: (keys) => this.unitHost.acceptPreapprovedTrust(keys),
      emitStatus: (appId, status, error) => this.emitStatus(appId, status, error),
    });
    this.terminal = new TerminalAppRuntime({
      workspaceId: deps.workspaceId,
      registry: this.registry,
      buildSystem: deps.buildSystem,
      connectionGrants: deps.connectionGrants,
      entityCache: deps.entityCache,
      getGatewayUrl: () => deps.getGatewayUrl(),
      validateBuild: (appId, build) => this.validateBuildForTarget(appId, "terminal", build),
      emitStatus: (appId, status, error) => this.emitStatus(appId, status, error),
    });
    deps.buildSystem.onPushBuild((source, trigger) => {
      this.handleSourceRebuilt(source, trigger).catch((err) => {
        console.error(
          `[AppHost] Failed to reload rebuilt app source ${source}:`,
          err instanceof Error ? err.message : String(err)
        );
      });
    });
    deps.buildSystem.onUnitChange?.((event) => {
      if (event.kind !== "app") return;
      this.handleChangedAppUnit(event).catch((err) => {
        console.error(
          `[AppHost] Failed to reconcile changed app unit ${event.relativePath}:`,
          err instanceof Error ? err.message : String(err)
        );
      });
    });
    deps.buildSystem.onBuildProviderChange?.((event) => {
      if (event.target !== "react-native") return;
      this.reconcileAfterProviderChange(event.provider.name).catch((err) => {
        console.error(
          `[AppHost] Failed to reconcile apps after provider change ${event.provider.name}:`,
          err instanceof Error ? err.message : String(err)
        );
      });
    });
  }

  async reconcileDeclared(
    declared: WorkspaceAppDeclaration[],
    opts: UnitReconcileOptions = {}
  ): Promise<void> {
    this.lastDeclared = declared.map((decl) => ({ ...decl }));
    await this.unitHost.reconcileDeclared(declared, opts);
    this.emitDevStatusDiagnostic(opts.trigger ?? "startup");
  }

  setDeclared(
    declared: WorkspaceAppDeclaration[],
    opts: { trigger?: UnitReconcileTrigger } = {}
  ): void {
    this.lastDeclared = declared.map((decl) => ({ ...decl }));
    this.emitDevStatusDiagnostic(opts.trigger ?? "startup");
  }

  /** Plan exact-version trust without starting a target-specific app build. */
  reviewDeclared(declared: WorkspaceAppDeclaration[] = this.lastDeclared): {
    units: ReviewedUnit[];
    identityKeys: string[];
  } {
    const review = this.unitHost.approvalForDeclarations(declared);
    return { units: review.entries, identityKeys: review.identityKeys };
  }

  /** Declared apps that ship in the host build, for the server to admit. */
  seedTrustedDeclared(declared: WorkspaceAppDeclaration[] = this.lastDeclared): ReviewedUnit[] {
    return this.unitHost.seedTrustedDeclarations(declared);
  }

  async whenSettled(): Promise<void> {
    await this.unitHost.whenSettled();
    // Reconcile returns once work is staged, so the line it prints is all
    // `status=building ev=none` — true, and useless. The line a developer reads
    // is this one: what each app actually settled on.
    this.emitDevStatusDiagnostic("settled");
  }

  async whenReconciled(): Promise<void> {
    await this.unitHost.whenReconciled();
  }

  /** Declared apps are classified (entries + staged approvals); builds may still run. */
  async whenDeclarationsStaged(): Promise<void> {
    await this.unitHost.whenDeclarationsStaged();
  }

  async shutdown(): Promise<void> {
    await this.terminal.shutdown();
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
      const candidate = await this.deps.buildSystem.resolveBuildUnitIdentity?.(
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
        ? await this.deps.buildSystem.resolveBuildUnitIdentity?.(
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
        ? authorityReviewFromPackageJson(
            previousPackageJson,
            current?.unitName ?? candidate.unitName
          )
        : { requests: [], provides: [] };
      const authority = authorityReviewFromPackageJson(
        packageJsonSource,
        candidate.unitName,
        previousAuthority,
        this.deps.describeCapability,
        "app"
      );
      identityKeys.push(identityKey);
      identityKeysByRepo.set(candidate.unitPath, identityKey);
      if (
        current &&
        !providerChanged &&
        canonicalAuthority(previousAuthority) ===
          canonicalAuthority({ requests: authority.requests, provides: authority.provides })
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
          version: typeof packageJson.version === "string" ? packageJson.version : "unknown",
          sourceRepo: candidate.unitPath,
          ref: declaration.ref,
          effectiveVersion: candidate.effectiveVersion,
          dependencyEvs: candidate.dependencyEvs,
          externalDeps,
        }),
        target,
        capabilities,
        authority,
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
        rollbackRetentionLimit: APP_ROLLBACK_HISTORY_LIMIT,
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
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) return { current: null, previous: [], retentionLimit: APP_ROLLBACK_HISTORY_LIMIT };
    return {
      current: appVersionRecordFromEntry(entry),
      previous: [...entry.previousVersions],
      retentionLimit: APP_ROLLBACK_HISTORY_LIMIT,
    };
  }

  listHostTargetCandidates(target: HostTarget): HostTargetCandidate[] {
    const declaredNames = new Set(
      this.lastDeclared
        .map((decl) => this.tryFindAppNode(decl.source)?.name)
        .filter((name): name is string => typeof name === "string")
    );
    return this.deps.buildSystem
      .getGraph()
      .allNodes()
      .filter(
        (node) => node.kind === "app" && normalizeRepoPath(node.relativePath).startsWith("apps/")
      )
      .filter((node) => this.appTarget(node) === target)
      .map((node) => this.hostTargetCandidate(node, target, declaredNames.has(node.name)))
      .sort((a, b) => Number(b.declared) - Number(a.declared) || a.source.localeCompare(b.source));
  }

  private async prepareReleaseAtRef(
    target: HostTarget,
    sourceOrName: string,
    ref: string
  ): Promise<{ buildKey: string; effectiveVersion: string; appId: string; source: string }> {
    const candidate = this.listHostTargetCandidates(target).find(
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
    const build = await this.deps.buildSystem.getBuild(candidate.name, ref);
    this.validateBuildForTarget(candidate.name, target, build);
    const activeSourceHash = requireBuildSourceStateHash(node.name, build);
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
    let entry = this.unitHost.activateBuild({
      name: node.name,
      version: readPackageVersion(node.path),
      sourceRepo: node.relativePath,
      ref,
      buildDir: build.dir,
      effectiveVersion: build.metadata.ev,
      activeSourceHash,
      dependencyEvs,
      externalDeps,
      runtimeDepsKey: null,
      status: appRegistryStatusForTarget(),
      extra: {
        target,
        capabilities: this.appCapabilities(node),
        activationTrust: trust,
      },
    });
    const previousRecord =
      previous && previous.activeBundleKey && previous.activeBundleKey !== entry.activeBundleKey
        ? appVersionRecordFromEntry(previous)
        : null;
    if (previousRecord) {
      entry = this.registry.patch(entry.name, {
        previousVersions: appVersionHistory([
          previousRecord,
          ...(previous?.previousVersions ?? []),
        ]),
        lastErrorDetails: null,
        activationTrust: trust,
      });
    } else {
      entry = this.registry.patch(entry.name, { lastErrorDetails: null, activationTrust: trust });
    }
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
    for (const target of ["electron", "react-native", "terminal"] as const) {
      const candidate = this.listHostTargetCandidates(target).find(
        (item) => item.name === sourceOrName || item.source === normalizeRepoPath(sourceOrName)
      );
      if (candidate) return this.prepareReleaseAtRef(target, candidate.name, ref);
    }
    throw new Error(`Unknown app release: ${sourceOrName}`);
  }

  async rollbackAppVersion(sourceOrName: string, buildKey?: string): Promise<AppRegistryEntry> {
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
    const build = this.deps.buildSystem.getBuildByKey?.(selected.activeBundleKey);
    if (!build)
      throw new Error(
        `Rollback app build is missing from the build store: ${selected.activeBundleKey}`
      );
    this.validateBuildForTarget(entry.name, selected.target, build);

    const current = appVersionRecordFromEntry(entry);
    const remaining = entry.previousVersions.filter(
      (candidate) => candidate.activeBundleKey !== selected.activeBundleKey
    );
    const updated = this.registry.patch(entry.name, {
      version: selected.version,
      target: selected.target,
      capabilities: selected.capabilities,
      activeEv: selected.activeEv,
      activeSourceHash: selected.activeSourceHash,
      activeBundleKey: selected.activeBundleKey,
      activeDependencyEvs: selected.activeDependencyEvs,
      activeExternalDeps: selected.activeExternalDeps,
      activeRuntimeDepsKey: selected.activeRuntimeDepsKey,
      status: "running",
      lastError: null,
      lastErrorDetails: null,
      activationTrust: null,
      previousVersions: current
        ? appVersionHistory([current, ...remaining])
        : appVersionHistory(remaining),
    });
    this.activateAppEntity(updated, build);
    await this.terminal.sync(updated, entry);
    const activated = this.registry.get(updated.name) ?? updated;
    this.emitAvailable(
      activated,
      {
        lifecycleType: "rolled-back",
        previousBuildKey: entry.activeBundleKey ?? null,
        notify: true,
      },
      build
    );
    return activated;
  }

  async restart(sourceOrName: string): Promise<void> {
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown app: ${sourceOrName}`);
    if (entry.target === "terminal") {
      await this.terminal.restart(entry.name);
      return;
    }
    if (!entry.activeBundleKey) throw new Error(`App ${entry.name} has no active build`);
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) throw new Error(`Active app build is missing: ${entry.activeBundleKey}`);
    this.validateBuildForTarget(entry.name, entry.target, build);
    this.emitAvailable(entry, { lifecycleType: "available" }, build);
  }

  async activateRelease(sourceOrName: string): Promise<void> {
    const prepared = this.findRegistryEntry(sourceOrName);
    if (!prepared) throw new Error(`Unknown app: ${sourceOrName}`);
    if (!prepared.activeBundleKey) throw new Error(`App ${prepared.name} has no active build`);
    const build = this.deps.buildSystem.getBuildByKey?.(prepared.activeBundleKey);
    if (!build) throw new Error(`Active app build is missing: ${prepared.activeBundleKey}`);
    this.validateBuildForTarget(prepared.name, prepared.target, build);
    const entry = this.registry.patch(prepared.name, { status: "running", lastError: null });
    this.activateAppEntity(entry, build);
    if (entry.target === "terminal") {
      if (this.terminal.isRunningBuild(entry.name, prepared.activeBundleKey)) {
        return;
      } else {
        await this.terminal.start(entry);
      }
    }
    this.emitAvailable(entry, { lifecycleType: "available" }, build);
  }

  async retire(sourceOrName: string): Promise<void> {
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown app: ${sourceOrName}`);
    await this.terminal.stop(entry.name);
    this.retireAppEntity(entry.name);
    this.registry.patch(entry.name, { status: "stopped", lastError: null });
    this.emitStatus(entry.name, "stopped", null);
  }

  listWorkspaceUnitLogs(name: string): Array<{
    workspaceId: string;
    unitName: string;
    kind: "app";
    timestamp: number;
    level: "info" | "error";
    message: string;
  }> {
    return this.unitHost
      .listWorkspaceUnitLogs(this.deps.workspaceId, name)
      .concat(this.terminal.logsFor(name))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  hasAppCapability(callerId: string, capability: AppCapability): boolean {
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
      if (isAuthorizedChromeAppSource(repo)) return true;
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
   * projected onto client-facing surfaces (e.g. the `apps:available` event), so
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

  bakeDist(sourceOrName: string, outDir: string): AppDistBakeManifest {
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
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build) {
      throw new Error(`Active app build is missing from the build store: ${entry.activeBundleKey}`);
    }
    return writeAppDistBake({
      entry,
      build: {
        metadata: appBuildMetadataForDist(entry, build.metadata),
        artifacts: appArtifactsForDist(entry, build.artifacts ?? []),
      },
      outDir,
      buildKey: entry.activeBundleKey,
    });
  }

  async handleAppArtifactRequest(
    req: IncomingMessage,
    res: ServerResponse,
    buildKey: string,
    remainderPath: string
  ): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "Content-Type": "text/plain" });
      res.end("Method Not Allowed");
      return;
    }
    if (
      !this.registry
        .list()
        .some(
          (entry) =>
            entry.activeBundleKey === buildKey ||
            entry.previousVersions.some((version) => version.activeBundleKey === buildKey)
        )
    ) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("App artifact not active");
      return;
    }
    const build = this.deps.buildSystem.getBuildByKey?.(buildKey);
    const artifactPath = normalizeArtifactPath(remainderPath || "index.html");
    const artifact = build?.artifacts?.find((entry) => entry.path === artifactPath);
    if (!build || !artifact) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("App artifact not found");
      return;
    }
    const headers: Record<string, string> = {
      "Content-Type": artifact.contentType,
      "Cache-Control": "no-store",
    };
    if (artifact.role === "html") {
      headers["Content-Security-Policy"] =
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss: http: https:";
    }
    const identityBody = await readArtifactBytesAsync(build, artifact);
    const requestHeaders = req.headers ?? {};
    const resumableGzip = requestHeaders[RESUMABLE_GZIP_HEADER] === "1";
    const body = resumableGzip ? await gzipAsync(identityBody, { level: 6 }) : identityBody;
    if (resumableGzip) {
      headers["Content-Encoding"] = "gzip";
      headers["Accept-Ranges"] = "bytes";
      headers["X-Vibestudio-Resumable-Gzip"] = "1";
      if (artifact.integrity) headers["X-Vibestudio-Artifact-Integrity"] = artifact.integrity;
    }

    const rangeHeader = resumableGzip ? requestHeaders.range : undefined;
    const rawRange = typeof rangeHeader === "string" ? rangeHeader : undefined;
    if (rawRange) {
      const match = /^bytes=(\d+)-(\d*)$/u.exec(rawRange);
      const start = match ? Number(match[1]) : Number.NaN;
      const requestedEnd = match?.[2] ? Number(match[2]) : body.byteLength - 1;
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(requestedEnd) ||
        start < 0 ||
        requestedEnd < start ||
        start >= body.byteLength
      ) {
        headers["Content-Range"] = `bytes */${body.byteLength}`;
        headers["Content-Length"] = "0";
        res.writeHead(416, headers);
        res.end();
        return;
      }
      const end = Math.min(requestedEnd, body.byteLength - 1);
      const partial = body.subarray(start, end + 1);
      headers["Content-Range"] = `bytes ${start}-${end}/${body.byteLength}`;
      headers["Content-Length"] = String(partial.byteLength);
      res.writeHead(206, headers);
      if (req.method === "HEAD") res.end();
      else res.end(partial);
      return;
    }

    headers["Content-Length"] = String(body.byteLength);
    res.writeHead(200, headers);
    if (req.method === "HEAD") res.end();
    else res.end(body);
  }

  async ensureElectronReady(
    source?: string | null,
    opts: { waitForApproval?: boolean } = {}
  ): Promise<ElectronHostReadiness> {
    // Launch-gate polls (waitForApproval: false) must not block on the full
    // unit reconcile — that made desktop readiness wait for every declared
    // unit to finish building. Wait only until declarations are classified,
    // then report an in-flight build as not-ready ("building" details map to
    // a preparing launch state); app status events re-poll until ready.
    const nonBlocking = opts.waitForApproval === false;
    if (nonBlocking) await this.unitHost.whenDeclarationsStaged();
    else await this.whenReconciled();

    const first = this.electronReadinessSnapshot(source);
    if (first.ready) return first;

    const resolvedSource =
      first.source ?? source ?? this.deps.getHostTargetDecl?.("electron")?.appSource;
    if (!resolvedSource) return first;
    const candidate = this.listHostTargetCandidates("electron").find(
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

  private electronReadinessSnapshot(source?: string | null): ElectronHostReadiness {
    const resolvedSource = source ?? this.deps.getHostTargetDecl?.("electron")?.appSource;
    const candidates = this.listHostTargetCandidates("electron");
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
          item.status === "running" &&
          normalizeRepoPath(item.source.repo) === normalizeRepoPath(candidate.source) &&
          item.activeBundleKey
      );
    const build = entry?.activeBundleKey
      ? this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey)
      : null;
    const htmlArtifact = build?.artifacts?.find((artifact) => artifact.role === "html");
    if (!entry?.activeBundleKey || !build || !htmlArtifact) {
      return {
        ready: false,
        source: candidate.source,
        appId: candidate.name,
        reason: "Selected Electron app does not have an active HTML build",
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
      const deferred = this.registry.patch(node.name, {
        status: existing?.activeBundleKey ? "running" : "stopped",
        lastError: null,
        lastErrorDetails: null,
      });
      this.emitStatus(deferred.name, deferred.status, null);
      return;
    }
    await this.unitHost.applyRuntimeDeclaration({
      node,
      decl,
      validateBeforeApply: () => this.validateAppManifestAtPath(node.path, node.name),
      needsBuildRefresh: (entry) => this.needsBuildRefresh(entry, node, decl),
      buildAndActivate: (n, d) => this.buildAndActivate(n, d),
      validateBeforeActivateCurrent: (entry) => this.validateActiveBuild(entry),
      activateCurrent: async (entry) => {
        this.emitStatus(entry.name, entry.status, null);
      },
      onError: (_node, _decl, message) => this.emitStatus(node.name, "error", message),
    });
  }

  private async buildAndActivate(node: AppGraphNode, decl: WorkspaceAppDeclaration): Promise<void> {
    const previous = this.registry.get(node.name) ?? null;
    const diagnostic: AppUpdateErrorDiagnostic = { phase: "build", source: node.relativePath };
    try {
      if (!previous) this.registry.upsert(this.pendingEntryFor(node, decl, true));
      else this.unitHost.markBuilding(node.name);
      const build = await this.deps.buildSystem.getBuild(node.name, decl.ref);
      diagnostic.buildKey = path.basename(build.dir);
      diagnostic.phase = "target-validation";
      const target = this.appTarget(node, decl);
      diagnostic.target = target;
      this.validateBuildForTarget(node.name, target, build);
      const activeSourceHash = requireBuildSourceStateHash(node.name, build);
      diagnostic.phase = "activation";
      const capabilities = this.appCapabilities(node);
      let entry = this.unitHost.activateBuild({
        name: node.name,
        version: readPackageVersion(node.path),
        sourceRepo: node.relativePath,
        ref: decl.ref,
        buildDir: build.dir,
        effectiveVersion: build.metadata.ev,
        activeSourceHash,
        dependencyEvs: this.currentDependencyEvs(node),
        externalDeps: this.externalDepsForBuild(node, build.metadata, decl),
        runtimeDepsKey: null,
        status: appRegistryStatusForTarget(),
        extra: {
          target,
          capabilities,
          interactive: this.appInteractive(node),
          activationTrust: null,
        },
      });
      const previousRecord =
        previous && previous.activeBundleKey && previous.activeBundleKey !== entry.activeBundleKey
          ? appVersionRecordFromEntry(previous)
          : null;
      if (previousRecord) {
        entry = this.registry.patch(entry.name, {
          previousVersions: appVersionHistory([
            previousRecord,
            ...(previous?.previousVersions ?? []),
          ]),
          lastErrorDetails: null,
          activationTrust: null,
        });
      } else {
        entry = this.registry.patch(entry.name, { lastErrorDetails: null, activationTrust: null });
      }
      this.emitStatus(entry.name, entry.status, null);
    } catch (err) {
      if (err && typeof err === "object") {
        (err as { appUpdateDiagnostic?: AppUpdateErrorDiagnostic }).appUpdateDiagnostic =
          diagnostic;
      }
      this.restorePreviousBuildAfterActivationError(
        node.name,
        previous,
        err instanceof Error ? err.message : String(err),
        diagnostic
      );
      throw err;
    }
  }

  private emitAvailable(
    entry: AppRegistryEntry,
    opts: {
      lifecycleType?: "available" | "update-available" | "rolled-back";
      previousBuildKey?: string | null;
      previousEffectiveVersion?: string | null;
      notify?: boolean;
    } = {},
    activatedBuild?: AppBuildResultLike
  ): AppAvailablePayload {
    this.activateAppEntity(entry, activatedBuild);
    const buildKey = entry.activeBundleKey ?? "";
    const build =
      activatedBuild ?? (buildKey ? this.deps.buildSystem.getBuildByKey?.(buildKey) : null);
    const artifactRefs = (build?.artifacts ?? []).map((artifact) => {
      const url = this.getAppArtifactUrl(buildKey, entry.target, artifact.path);
      return {
        path: artifact.path,
        role: artifact.role,
        contentType: artifact.contentType,
        encoding: artifact.encoding,
        platform: artifact.platform,
        integrity: artifact.integrity,
        route: appArtifactRoute(buildKey, artifact.path),
        ...(url ? { url } : {}),
      };
    });
    const primaryArtifact =
      artifactRefs.find((artifact) => entry.target === "electron" && artifact.role === "html") ??
      artifactRefs.find((artifact) => artifact.role === "primary") ??
      artifactRefs[0];
    const selectedForHost = true;
    const details =
      build?.metadata.details &&
      build.metadata.details.kind === "app" &&
      "integrity" in build.metadata.details
        ? build.metadata.details
        : null;
    if (!build?.metadata.authority) {
      throw new Error(`Active app ${entry.name} build is missing sealed authority metadata`);
    }
    const artifactRoute = primaryArtifact?.route ?? appArtifactRoute(buildKey, "index.html");
    const url =
      primaryArtifact?.url ?? this.getAppArtifactUrl(buildKey, entry.target, "index.html");
    const payload: AppAvailablePayload = {
      appId: entry.name,
      source: normalizeRepoPath(entry.source.repo),
      target: entry.target,
      launchMode: appLaunchMode(entry.target),
      artifactRoute,
      artifacts: artifactRefs,
      capabilities: this.effectiveCapabilities(entry),
      buildKey: entry.activeBundleKey,
      effectiveVersion: entry.activeEv,
      executionDigest: build?.metadata.execution?.executionDigest ?? null,
      authority: build.metadata.authority,
      previousBuildKey: opts.previousBuildKey ?? null,
      previousEffectiveVersion: opts.previousEffectiveVersion ?? null,
      canRollback: entry.previousVersions.length > 0,
      adoptionPolicy: appAdoptionPolicy(entry.target, opts.lifecycleType ?? "available"),
      selectedForHost,
      integrity: details?.integrity ?? null,
      rnHostAbi: details?.rnHostAbi ?? null,
      provider: details?.provider ?? null,
    };
    if (url) payload.url = url;
    this.deps.eventService.emit("apps:available" as EventName, payload);
    this.emitAppLifecycle({
      type: opts.lifecycleType ?? "available",
      appId: entry.name,
      source: normalizeRepoPath(entry.source.repo),
      target: entry.target,
      buildKey: entry.activeBundleKey,
      effectiveVersion: entry.activeEv,
      previousBuildKey: opts.previousBuildKey ?? null,
      previousEffectiveVersion: opts.previousEffectiveVersion ?? null,
      canRollback: entry.previousVersions.length > 0,
      requiresReload: entry.target !== "terminal",
      adoptionPolicy: appAdoptionPolicy(entry.target, opts.lifecycleType ?? "available"),
      ...(selectedForHost === undefined ? {} : { selectedForHost }),
    });
    if (opts.notify) this.notifyAppUpdateAvailable(entry);
    this.emitStatus(entry.name, entry.status, entry.lastError ?? null);
    return payload;
  }

  private getAppArtifactUrl(
    buildKey: string,
    target: WorkspaceAppTarget,
    artifactPath: string
  ): string | undefined {
    if (target === "electron") return undefined;
    if (target === "react-native") {
      return appArtifactUrl(this.deps.getReactNativeAppArtifactBaseUrl(), buildKey, artifactPath);
    }
    return appArtifactUrl(this.deps.getTerminalAppArtifactBaseUrl(), buildKey, artifactPath);
  }

  private validateActiveBuild(entry: AppRegistryEntry): void {
    if (!entry.activeBundleKey) throw new Error(`Active app ${entry.name} has no active build key`);
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    if (!build)
      throw new Error(`Active app build is missing from the build store: ${entry.activeBundleKey}`);
    this.validateBuildForTarget(entry.name, entry.target, build);
  }

  private validateBuildForTarget(
    appName: string,
    target: WorkspaceAppTarget,
    build: Awaited<ReturnType<BuildSystemLike["getBuild"]>>
  ): void {
    if (target === "terminal") {
      const details = build.metadata.details;
      if (!isAppBuildDetailsLike(details) || details.target !== "terminal") {
        throw new Error(`Terminal app ${appName} build is missing terminal app metadata`);
      }
      const primaryArtifacts = (build.artifacts ?? []).filter(
        (artifact) => artifact.role === "primary"
      );
      if (primaryArtifacts.length !== 1) {
        throw new Error(
          `Terminal app ${appName} build must include exactly one primary entry artifact`
        );
      }
      if (!primaryArtifacts[0]?.path.endsWith(".mjs")) {
        throw new Error(`Terminal app ${appName} primary artifact must be an ESM .mjs entry`);
      }
      return;
    }
    if (target !== "react-native") return;
    const details = build.metadata.details;
    if (
      !isAppBuildDetailsLike(details) ||
      details.target !== "react-native" ||
      typeof details.rnHostAbi !== "string" ||
      details.rnHostAbi.length === 0 ||
      typeof details.integrity !== "string" ||
      details.integrity.length === 0 ||
      !isBuildProviderDetailsLike(details.provider)
    ) {
      throw new Error(
        `React Native app ${appName} build is missing signed RN metadata or provider identity`
      );
    }
    const primaryArtifacts = (build.artifacts ?? []).filter(
      (artifact) => artifact.role === "primary"
    );
    if (primaryArtifacts.length === 0) {
      throw new Error(`React Native app ${appName} build has no primary mobile artifact`);
    }
    const seenPlatforms = new Set<"android" | "ios">();
    for (const artifact of primaryArtifacts) {
      if (artifact.platform !== "android" && artifact.platform !== "ios") {
        throw new Error(
          `React Native app ${appName} primary artifact ${artifact.path} is missing a mobile platform`
        );
      }
      if (seenPlatforms.has(artifact.platform)) {
        throw new Error(
          `React Native app ${appName} has multiple primary artifacts for ${artifact.platform}`
        );
      }
      if (typeof artifact.integrity !== "string" || artifact.integrity.length === 0) {
        throw new Error(
          `React Native app ${appName} primary artifact ${artifact.path} is missing integrity`
        );
      }
      seenPlatforms.add(artifact.platform);
    }
  }

  private emitStatus(
    name: string,
    status: AppRegistryEntry["status"],
    error: string | null,
    errorDetails?: AppUpdateErrorDiagnostic | null
  ): void {
    const entry = this.registry.get(name);
    this.deps.eventService.emit("apps:status" as EventName, {
      name,
      status,
      error,
      errorDetails: errorDetails ?? entry?.lastErrorDetails ?? null,
      buildKey: entry?.activeBundleKey ?? null,
      effectiveVersion: entry?.activeEv ?? null,
      canRollback: !!entry?.previousVersions?.length,
      target: entry?.target,
    });
  }

  private emitAppLifecycle(payload: {
    type: "available" | "update-available" | "update-error" | "rolled-back";
    appId: string;
    source: string;
    target?: WorkspaceAppTarget;
    buildKey?: string | null;
    effectiveVersion?: string | null;
    previousBuildKey?: string | null;
    previousEffectiveVersion?: string | null;
    error?: string;
    errorDetails?: AppUpdateErrorDiagnostic | null;
    canRollback: boolean;
    requiresReload?: boolean;
    adoptionPolicy?: "immediate" | "prompt";
    selectedForHost?: boolean;
  }): void {
    this.deps.eventService.emit("apps:lifecycle" as EventName, {
      ...payload,
      emittedAt: Date.now(),
    });
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
      ...(entry.target === "terminal"
        ? [
            {
              id: "runtime.supervision.restart",
              label: entry.status === "running" ? "Restart" : "Start",
              variant: "solid" as const,
              command: {
                type: "runtime.supervision.restart" as const,
                identity: { kind: "app" as const, entityId: entry.name },
              },
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
    this.deps.notificationService?.show({
      type: "error",
      title: "App update failed",
      message: `${entry.name}: ${message}${detail}`,
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

  private restorePreviousBuildAfterActivationError(
    name: string,
    previous: AppRegistryEntry | null,
    message: string,
    diagnostic: AppUpdateErrorDiagnostic
  ): void {
    if (!previous?.activeBundleKey) {
      this.unitHost.markError(name, message);
      this.registry.patch(name, { lastErrorDetails: diagnostic });
      return;
    }
    this.registry.patch(name, {
      activeEv: previous.activeEv,
      activeSourceHash: previous.activeSourceHash,
      activeBundleKey: previous.activeBundleKey,
      activeDependencyEvs: previous.activeDependencyEvs ?? {},
      activeExternalDeps: previous.activeExternalDeps ?? {},
      activeRuntimeDepsKey: previous.activeRuntimeDepsKey ?? null,
      target: previous.target,
      capabilities: previous.capabilities,
      previousVersions: previous.previousVersions ?? [],
      status: "error",
      lastError: message,
      lastErrorDetails: diagnostic,
      activationTrust: previous.activationTrust ?? null,
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

  private hostTargetCandidate(
    node: AppGraphNode,
    target: HostTarget,
    declared: boolean
  ): HostTargetCandidate {
    const entry = this.registry.get(node.name);
    const capabilities = this.appCapabilities(node);
    const reasons: string[] = [];
    if (target === "electron" && !capabilities.includes("panel-hosting")) {
      reasons.push("Electron shell apps must declare the panel-hosting capability");
    }
    const activeBuild = entry?.activeBundleKey
      ? this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey)
      : null;
    if (target === "react-native" && activeBuild) {
      const details = activeBuild.metadata.details;
      if (
        !isAppBuildDetailsLike(details) ||
        details.target !== "react-native" ||
        typeof details.rnHostAbi !== "string" ||
        !details.rnHostAbi ||
        typeof details.integrity !== "string" ||
        !details.integrity ||
        !isBuildProviderDetailsLike(details.provider)
      ) {
        reasons.push("Active React Native build is missing signed native metadata");
      }
    }
    if (target === "terminal" && activeBuild) {
      const details = activeBuild.metadata.details;
      const primaryArtifacts = (activeBuild.artifacts ?? []).filter(
        (artifact) => artifact.role === "primary"
      );
      if (!isAppBuildDetailsLike(details) || details.target !== "terminal") {
        reasons.push("Active terminal build is missing terminal metadata");
      } else if (primaryArtifacts.length !== 1 || !primaryArtifacts[0]?.path.endsWith(".mjs")) {
        reasons.push("Terminal builds need exactly one primary .mjs artifact");
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

  private activateAppEntity(entry: AppRegistryEntry, selectedBuild?: AppBuildResultLike): void {
    if (!this.deps.entityCache || !entry.activeEv) return;
    const activeBuild = this.resolveActiveAppBuild(entry, selectedBuild);
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
    const contextId = createHash("sha256")
      .update(`${this.deps.workspaceId}\x00app\x00${entry.name}\x00${sourceRepo}`)
      .digest("hex");
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
  private resolveActiveAppBuild(
    entry: AppRegistryEntry,
    selectedBuild?: AppBuildResultLike
  ): {
    buildKey: string;
    build: AppBuildResultLike;
    identity: ActiveExecutionIdentity;
  } {
    if (!entry.activeEv) {
      throw new Error(`Cannot activate app ${entry.name} without an effective version`);
    }
    if (!entry.activeBundleKey) {
      throw new Error(`Cannot activate app ${entry.name} without an immutable build key`);
    }
    const build = selectedBuild ?? this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
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

  private buildBatchEntry(node: AppGraphNode, decl: WorkspaceAppDeclaration): ReviewedUnit {
    const details = this.appBuildDetails(node.name);
    const active = this.registry.get(node.name);
    const previousAuthority = active?.activeBundleKey
      ? (this.deps.buildSystem.getBuildByKey?.(active.activeBundleKey)?.metadata.authority ?? {
          requests: [],
          provides: [],
        })
      : { requests: [], provides: [] };
    return {
      ...createReviewedUnitBase({
        unitKind: "app",
        name: node.name,
        displayName: node.manifest.displayName ?? node.manifest.title,
        ...(node.manifest.icon ? { icon: node.manifest.icon } : {}),
        version: readPackageVersion(node.path),
        sourceRepo: node.relativePath,
        ref: decl.ref,
        effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
        dependencyEvs: this.currentDependencyEvs(node),
        externalDeps: this.currentExternalDeps(node, decl, this.registry.get(node.name) ?? null),
      }),
      target: this.appTarget(node, decl),
      capabilities: this.appCapabilities(node),
      authority: readUnitAuthorityReview(
        node.path,
        node.name,
        previousAuthority,
        this.deps.describeCapability,
        "app"
      ),
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

  private appBuildDetails(
    name: string
  ): Extract<NonNullable<AppBuildMetadataLike["details"]>, { kind: "app" }> | null {
    const entry = this.registry.get(name);
    const metadata = entry?.activeBundleKey
      ? this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey)?.metadata
      : null;
    return metadata?.details?.kind === "app"
      ? (metadata.details as Extract<NonNullable<AppBuildMetadataLike["details"]>, { kind: "app" }>)
      : null;
  }

  private needsBuildRefresh(
    entry: AppRegistryEntry,
    node: AppGraphNode,
    decl: WorkspaceAppDeclaration
  ): boolean {
    if (entry.status === "error") return true;
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
    const candidate = this.listHostTargetCandidates("react-native").find(
      (item) => item.source === normalizeRepoPath(source) || item.name === source
    );
    // Provider activation invalidates readiness but must not implicitly build
    // the mobile app during a desktop or terminal launch. Active React Native
    // launch sessions are refreshed by the coordinator and explicitly call
    // reactNative.ensureReady() themselves.
    this.emitDevStatusDiagnostic("provider-change");
    const entry = candidate ? this.registry.get(candidate.name) : null;
    if (entry) this.emitStatus(entry.name, entry.status, entry.lastError);
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
      await this.buildAndActivate(node, {
        source: node.relativePath,
        ref: entry.source.ref,
      });
      const prepared = this.registry.get(entry.name);
      if (prepared?.activeBundleKey && prepared.activeBundleKey !== entry.activeBundleKey) {
        this.emitAppLifecycle({
          type: "update-available",
          appId: prepared.name,
          source: normalizeRepoPath(prepared.source.repo),
          target: prepared.target,
          buildKey: prepared.activeBundleKey,
          effectiveVersion: prepared.activeEv,
          previousBuildKey: entry.activeBundleKey,
          previousEffectiveVersion: entry.activeEv,
          canRollback: prepared.previousVersions.length > 0,
          requiresReload: prepared.target !== "terminal",
          adoptionPolicy: appAdoptionPolicy(prepared.target, "update-available"),
        });
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
      this.emitStatus(entry.name, "error", message, diagnostic);
      this.emitAppLifecycle({
        type: "update-error",
        appId: entry.name,
        source: normalizeRepoPath(entry.source.repo),
        target: entry.target,
        buildKey: updated.activeBundleKey,
        effectiveVersion: updated.activeEv,
        error: message,
        errorDetails: diagnostic,
        canRollback: updated.previousVersions.length > 0,
        requiresReload: false,
      });
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

  private appInteractive(node: AppGraphNode): boolean {
    return (node.manifest.app as { interactive?: unknown } | undefined)?.interactive === true;
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

function appLaunchMode(
  target: WorkspaceAppTarget
): "hosted-view" | "native-bootstrap" | "terminal-process" {
  if (target === "electron") return "hosted-view";
  if (target === "react-native") return "native-bootstrap";
  return "terminal-process";
}

function appRegistryStatusForTarget(): AppRegistryEntry["status"] {
  return "available";
}

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

function appArtifactsForDist(
  entry: AppRegistryEntry,
  artifacts: Array<{
    path: string;
    role: string;
    contentType: string;
    encoding: string;
    platform?: string;
    integrity?: string;
    content: string;
  }>
): Array<BuildArtifactManifestEntry & { content: string }> {
  return artifacts.map((artifact) => {
    if (!isBuildArtifactRole(artifact.role)) {
      throw new Error(`Active build for ${entry.name} has invalid artifact role: ${artifact.role}`);
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
      content: artifact.content,
    };
  });
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

function normalizeArtifactPath(remainderPath: string): string {
  const clean = decodeURIComponent(remainderPath.replace(/^\/+/, "")) || "index.html";
  if (path.isAbsolute(clean) || clean.split(/[\\/]/).includes("..")) return "__invalid__";
  return clean.replace(/\\/g, "/");
}

function appVersionRecordFromEntry(entry: AppRegistryEntry): AppVersionRecord | null {
  if (!entry.activeBundleKey) return null;
  return {
    version: entry.version,
    target: entry.target,
    capabilities: [...entry.capabilities],
    activeEv: entry.activeEv,
    activeSourceHash: entry.activeSourceHash,
    activeBundleKey: entry.activeBundleKey,
    activeDependencyEvs: { ...(entry.activeDependencyEvs ?? {}) },
    activeExternalDeps: { ...(entry.activeExternalDeps ?? {}) },
    activeRuntimeDepsKey: entry.activeRuntimeDepsKey ?? null,
    activatedAt: Date.now(),
  };
}

function appVersionHistory(
  records: Array<AppVersionRecord | null | undefined>,
  limit = 5
): AppVersionRecord[] {
  const history: AppVersionRecord[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!record || seen.has(record.activeBundleKey)) continue;
    seen.add(record.activeBundleKey);
    history.push(record);
    if (history.length >= limit) break;
  }
  return history;
}

function appAdoptionPolicy(
  target: WorkspaceAppTarget,
  lifecycleType: "available" | "update-available" | "rolled-back"
): "immediate" | "prompt" {
  if (target === "terminal") return "immediate";
  if (lifecycleType === "update-available") return "prompt";
  return "immediate";
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
      message: "a new trusted terminal build is ready.",
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
