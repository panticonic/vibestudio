import * as fs from "node:fs";
import * as path from "node:path";
import { createHostBuildUnitGate } from "@vibestudio/shared/hostBuildUnits";
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
import type { NotificationPayload, SupervisionChange } from "@vibestudio/shared/events";
import type { ExecutionPublicationPort } from "@vibestudio/shared/execution/retention";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import type {
  ClientTrustChange,
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
import {
  readWorkspaceConfig,
  resolveDeclaredClients,
  resolveWorkspaceTrustGrants,
} from "@vibestudio/workspace/configParser";
import {
  UnitManifestError,
  clientUnitManifestDescriptor,
  readAndValidateUnitManifest,
  validateUnitManifest,
} from "@vibestudio/shared/unitManifest";
import {
  CLIENT_CAPABILITY_CATALOG,
  HOST_RUNTIME,
  clientIntents,
  isClientCapability,
  isDeviceLevelCapability,
  parseClientPrincipalId,
  type ClientCapability,
  type ClientIntentDecl,
  type ClientLaunchResult,
  type ClientListing,
  type ClientManifestBlock,
  type ClientRuntime,
  type ClientSelection,
  type HostDescriptor,
  type HostKind,
  type ReadyClient,
} from "@vibestudio/workspace-contracts/clients";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import {
  type BuildArtifactManifestEntry,
  type BuildMetadata,
  type StoredBuildArtifact,
  type StoredBuildResult,
} from "../buildV2/buildStore.js";
import {
  createCapabilityAuthorizer,
  type CapabilityAuthorizer,
} from "../services/capabilityAuthorizer.js";
import type { RuntimeDiagnosticsStore } from "../runtimeDiagnosticsStore.js";
import {
  validateClientBuildContract,
  type ClientBuildProviderDetails,
} from "./clientBuildContract.js";
import { ClientPrincipals, type ClientPrincipal } from "./clientPrincipals.js";
import {
  requireActiveExecutionIdentity,
  type ActiveExecutionIdentity,
} from "../runtimeExecutionIdentity.js";

function canonicalAuthority(value: unknown): string {
  return sha256Canonical(value);
}

const CLIENT_UNIT_DESCRIPTOR: UnitDescriptor<"client"> = {
  kind: "client",
  sourceRoot: "clients",
  buildKind: "client",
  approvalFraming: {
    serviceName: "clients",
    unitLabel: "client",
    unitLabelPlural: "clients",
    nativeCode: false,
  },
  seedTrustEligible: true,
  versionedFields: ["runtime", "capabilities"],
};

export interface ClientUpdateErrorDiagnostic {
  phase: "build" | "contract" | "activation";
  runtime?: ClientRuntime;
  buildKey?: string | null;
  source: string;
}

export interface WorkspaceClientDeclaration {
  source: string;
  ref: string;
}

export interface ClientRegistryEntry extends UnitRegistryEntryBase {
  unitKind: "client";
  runtime: ClientRuntime;
  /** Every capability the client declares, required and optional, sorted. */
  capabilities: ClientCapability[];
  previousVersions: ClientVersionRecord[];
  lastErrorDetails?: ClientUpdateErrorDiagnostic | null;
  activationTrust?: ClientActivationTrustRecord | null;
}

export interface ClientVersionRecord extends UnitVersionRecord {
  runtime: ClientRuntime;
  capabilities: ClientCapability[];
}

export interface ClientActivationTrustRecord {
  decision: "release-pinned-ref";
  identityKey: string;
  actor: "host";
  reason: string;
  acceptedAt: number;
}

export type ClientBuildArtifactLike = StoredBuildArtifact;
export type ClientBuildResultLike = StoredBuildResult;

interface BuildSystemLike {
  getStoredBuild(unitPath: string, ref?: string): Promise<ClientBuildResultLike>;
  getBuildByKey(key: string): Promise<ClientBuildResultLike | null>;
  readBuildArtifactBytes(
    build: Pick<ClientBuildResultLike, "dir">,
    artifact: BuildArtifactManifestEntry
  ): Promise<Buffer>;
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
  getBuildProviderDetails?(runtime: "react-native"): ClientBuildProviderDetails | null;
  onBuildProviderChange?(
    callback: (event: {
      type: "registered" | "unregistered";
      target: "react-native";
      provider: ClientBuildProviderDetails;
    }) => void
  ): () => void;
  getGraph(): {
    allNodes(): ClientGraphNode[];
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

interface ClientGraphNode {
  name: string;
  kind: string;
  relativePath: string;
  path: string;
  internalDeps: string[];
  manifest: {
    displayName?: string;
    title?: string;
    icon?: string;
    client?: ClientManifestBlock;
  };
}

interface ApprovalQueueLike {
  request(req: {
    kind: "unit-install-review";
    callerId: string;
    callerKind: "panel" | "client" | "worker" | "do" | "system";
    requestedByUserId?: string;
    repoPath: string;
    effectiveVersion: string;
    dedupKey?: string | null;
    mode: PendingUnitInstallReviewApproval["mode"];
    title: string;
    description: string;
    units: ReviewedUnit[];
    origins?: ReadonlyMap<string, InstallReviewOrigin>;
    configWrite?: PendingUnitInstallReviewApproval["configWrite"];
  }): Promise<"accepted" | "deny" | "dismiss">;
  listPending(): PendingApproval[];
}

interface NotificationServiceLike {
  show(notification: Omit<NotificationPayload, "id">): string;
}

/** What preparing a runtime's build prerequisites (its `runtimeExtensions`) reached. */
export type RuntimePreparation =
  | { state: "ready" }
  | { state: "approval-required"; sources: string[] }
  | { state: "preparing"; reason: string }
  | { state: "unavailable"; reason: string };

export interface ClientHostDeps {
  statePath: string;
  workspacePath: string;
  workspaceId: string;
  diagnostics: Pick<RuntimeDiagnosticsStore, "record" | "history">;
  /** Protected hub designation, never workspace-authored client or trust configuration. */
  isSystemWorkspace(): boolean;
  /** `trust.clients` of the current manifest, as canonical `clients/<name>` paths. */
  getTrustedClients(): readonly string[];
  /** `clientDefaults.<host>` of the current manifest, as a canonical `clients/<name>` path. */
  getClientDefault(host: HostKind): string | null;
  /** Admit and start the extensions clients of a runtime need to build. */
  prepareRuntime(runtime: ClientRuntime): Promise<RuntimePreparation>;
  readWorkspaceFileAtState(stateHash: string, filePath: string): Promise<string | null>;
  describeCapability?: CapabilityPresentationResolver;
  buildSystem: BuildSystemLike;
  eventService: EventService;
  approvalQueue: ApprovalQueueLike;
  notificationService?: NotificationServiceLike;
  approvalCoordinator?: UnitApprovalCoordinator<ReviewedUnit>;
  /**
   * Where these units' bytes came from, derived by the server from workspace
   * state it reads itself. The launch gate is organized on origin, so a
   * client review without this cannot answer the only question it asks.
   * Absent in tests, where every unit reads as the host's own build.
   */
  resolveUnitOrigins?(
    repoPaths: readonly string[]
  ): Promise<ReadonlyMap<string, InstallReviewOrigin>>;
  /** Whether this exact client version's declared authority has been admitted. */
  isAdmitted?(repoPath: string, effectiveVersion: string): boolean;
  openUnitReviewFor?(code: {
    repoPath: string;
    effectiveVersion: string;
  }): ExactUnitAdmissionReview | null;
  entityCache?: Pick<EntityCache, "resolve" | "listActive" | "_onActivate" | "_onRetire">;
  executionPublicationPort?: ExecutionPublicationPort;
  /** Invalidate every outstanding connection grant and open session of a principal. */
  revokePrincipalSessions?(principalId: string, reason: "trust-revoked" | "retired"): void;
}

/**
 * The server's registry of clients (docs/client-hosts-and-clients-plan.md §4.8):
 * declarations, candidates, admission, release and rollback, launch
 * resolution and device principals — one runtime-agnostic path for every
 * host. Clients live only in the System workspace.
 */
export class ClientHost implements UnitChangeApprovalProvider<ReviewedUnit> {
  readonly registry: UnitRegistry<ClientRegistryEntry>;
  readonly principals: ClientPrincipals;
  private readonly trustResolver: UnitTrustResolver<ClientRegistryEntry>;
  private readonly unitHost: UnitHost<
    ClientRegistryEntry,
    WorkspaceClientDeclaration,
    ClientGraphNode,
    ReviewedUnit
  >;
  private lastDeclared: WorkspaceClientDeclaration[] = [];
  /** Device-level capabilities each client held at the last trust evaluation. */
  private trustedDeviceCapabilities = new Map<string, readonly ClientCapability[]>();
  private lastDevStatusDiagnosticKey: string | null = null;
  private readonly activationFlights = new Map<string, Promise<"ready" | "approval-required">>();
  private readonly eventFlights = new Set<Promise<void>>();
  private eventFailures: unknown[] = [];
  private initialization: Promise<void> | null = null;
  private initializationComplete = false;
  private retiring = false;

  constructor(private readonly deps: ClientHostDeps) {
    this.registry = new UnitRegistry<ClientRegistryEntry>({
      statePath: deps.statePath,
      unitKind: "client",
      normalizeEntry: (entry) => ({
        ...entry,
        capabilities: entry.capabilities ?? [],
        lastErrorDetails: entry.lastErrorDetails ?? null,
        activationTrust: entry.activationTrust ?? null,
      }),
      publicationPort: deps.executionPublicationPort,
    });
    observeUnitSupervision(this.registry, (change, entry) => this.publish(change, entry));
    this.trustResolver = new UnitTrustResolver<ClientRegistryEntry>({
      entryIdentity: (entry) => this.registryEntryIdentity(entry),
    });
    const isHostBuildUnit = createHostBuildUnitGate({
      statePath: deps.statePath,
      workspacePath: deps.workspacePath,
    });
    this.unitHost = new UnitHost({
      descriptor: CLIENT_UNIT_DESCRIPTOR,
      registry: this.registry,
      resolveNode: (source) => this.findClientNode(source),
      candidateIdentity: (node, decl) => this.declarationIdentity(node, decl),
      trustResolver: this.trustResolver,
      approvalStore: new FileUnitIdentityApprovalStore({
        statePath: deps.statePath,
        unitKind: "client",
      }),
      ...(deps.isAdmitted
        ? {
            isAdmitted: (identity) =>
              identity.effectiveVersion !== null &&
              deps.isAdmitted!(identity.source.repo, identity.effectiveVersion),
          }
        : {}),
      // The clients that ARE Vibestudio arrived unmodified in the template this
      // build designates. The person decided about them by installing
      // Vibestudio; asking again on a surface one of them renders would be a
      // question that cannot be answered (§7.6).
      isSeedTrusted: (node, identity) =>
        identity.effectiveVersion !== null && isHostBuildUnit(node.relativePath),
      makePendingEntry: (node, decl, building) => this.pendingEntryFor(node, decl, building),
      applyTrusted: (node, decl) => this.applyDeclared(node, decl),
      removeUndeclared: async (entry) => {
        this.retirePrincipals(entry, "retired");
        this.deps.eventService.emit("clients:changed", { reason: "retired" });
      },
      notifyUnresolved: (sources) => {
        this.deps.notificationService?.show({
          type: "error",
          title: "Unknown clients declared",
          message: `meta/vibestudio.yml declares clients that don't exist: ${sources.join(", ")}.`,
        });
      },
      validateBeforeApproval: (node) => this.validateClientManifestAtPath(node.path, node.name),
      approvalEntry: (node, decl) => this.buildBatchEntry(node, decl),
      approvalOrigins: (entries) => this.resolveOriginsFor(entries),
      requestApproval: async (entries, trigger) => {
        const origins = await this.resolveOriginsFor(entries);
        return requestUnitInstallReview<
          "client",
          ReviewedUnit,
          InstallReviewOrigin,
          NonNullable<PendingUnitInstallReviewApproval["configWrite"]>
        >({
          descriptor: CLIENT_UNIT_DESCRIPTOR,
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
          "[ClientHost] Background client approval flow failed:",
          err instanceof Error ? err.message : String(err)
        );
      },
    });
    this.principals = new ClientPrincipals({
      workspaceId: deps.workspaceId,
      entityCache: deps.entityCache,
    });
    deps.buildSystem.onPushBuild((source, trigger) => {
      this.admitEventWork(() => this.handleSourceRebuilt(source, trigger));
    });
    deps.buildSystem.onUnitChange?.((event) => {
      if (event.kind !== "client") return;
      this.admitEventWork(() => this.handleChangedClientUnit(event));
    });
    deps.buildSystem.onBuildProviderChange?.(() => {
      this.admitEventWork(async () => {
        this.emitDevStatusDiagnostic("provider-change");
        this.deps.eventService.emit("clients:changed", { reason: "build" });
      });
    });
  }

  /** Backfill durable execution identities before any unit reconciliation is admitted. */
  initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.backfillExecutionIdentities().then(() => {
        this.trustedDeviceCapabilities = this.deviceCapabilitySnapshot();
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
        throw new AggregateError(
          previousVersionFailures,
          "Client history identity backfill failed",
          {
            cause: previousVersionFailures[0],
          }
        );
      }
      const previousVersions = previousVersionReads.map((result) => {
        if (result.status !== "fulfilled") {
          throw new Error("Client history identity backfill lost a settled result");
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

  private async resolveStoredExecutionDigest(name: string, buildKey: string): Promise<string> {
    const build = await this.deps.buildSystem.getBuildByKey(buildKey);
    const executionDigest = build?.metadata.execution?.executionDigest;
    if (
      !build ||
      build.buildKey !== buildKey ||
      build.metadata.buildKey !== buildKey ||
      typeof executionDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(executionDigest)
    ) {
      throw new Error(`Client ${name} references unverifiable build ${buildKey}`);
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
      throw new AggregateError(failures, "ClientHost event work failed", { cause: failures[0] });
    }
  }

  // ---------------------------------------------------------------------------
  // Declarations and reconciliation
  // ---------------------------------------------------------------------------

  async reconcileDeclared(
    declared: WorkspaceClientDeclaration[],
    opts: UnitReconcileOptions = {}
  ): Promise<void> {
    await this.initialize();
    this.lastDeclared = this.hostedDeclarations(declared);
    await this.unitHost.reconcileDeclared(this.lastDeclared, opts);
    this.deps.eventService.emit("clients:changed", { reason: "declared" });
    this.emitDevStatusDiagnostic(opts.trigger ?? "startup");
  }

  setDeclared(
    declared: WorkspaceClientDeclaration[],
    opts: { trigger?: UnitReconcileTrigger } = {}
  ): void {
    this.lastDeclared = this.hostedDeclarations(declared);
    this.emitDevStatusDiagnostic(opts.trigger ?? "startup");
  }

  /** Plan exact-version trust without starting a build. */
  async reviewDeclared(declared: WorkspaceClientDeclaration[] = this.lastDeclared): Promise<{
    units: ReviewedUnit[];
    identityKeys: string[];
  }> {
    await this.initialize();
    const review = await this.unitHost.approvalForDeclarations(this.hostedDeclarations(declared));
    return { units: review.entries, identityKeys: review.identityKeys };
  }

  /** Declared clients that ship in the host build, for the server to admit. */
  seedTrustedDeclared(
    declared: WorkspaceClientDeclaration[] = this.lastDeclared
  ): Promise<ReviewedUnit[]> {
    return this.initialize().then(() =>
      this.unitHost.seedTrustedDeclarations(this.hostedDeclarations(declared))
    );
  }

  /** Clients exist only in the System workspace: declarations anywhere else are dropped. */
  private hostedDeclarations(declared: WorkspaceClientDeclaration[]): WorkspaceClientDeclaration[] {
    return this.deps.isSystemWorkspace() ? declared.map((decl) => ({ ...decl })) : [];
  }

  private assertInitialized(): void {
    if (!this.initializationComplete) {
      throw new Error("ClientHost must be initialized before reading client version history");
    }
  }

  private assertClientHosting(): void {
    if (!this.deps.isSystemWorkspace())
      throw new Error("Clients run only from a designated System workspace");
  }

  async whenSettled(): Promise<void> {
    await this.initialize();
    await this.unitHost.whenSettled();
    await this.joinEventWork();
    this.emitDevStatusDiagnostic("settled");
  }

  async whenReconciled(): Promise<void> {
    await this.initialize();
    await this.unitHost.whenReconciled();
    await this.joinEventWork();
  }

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
      throw new AggregateError(failures, "ClientHost shutdown failed", { cause: failures[0] });
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
    for (const declaration of await this.readDeclaredClientsFromState(commit)) {
      const candidate = await this.deps.buildSystem.resolveBuildUnitIdentity(
        declaration.source,
        commit
      );
      if (!candidate) {
        throw new Error(`Cannot resolve client ${declaration.source} at ${commit}`);
      }
      if (affected && !affected.has(candidate.unitName)) continue;
      const packageJsonSource = await this.deps.readWorkspaceFileAtState(
        commit,
        `${candidate.unitPath}/package.json`
      );
      if (!packageJsonSource) {
        throw new Error(
          `Candidate client manifest is missing at ${candidate.unitPath}/package.json`
        );
      }
      const packageJson = JSON.parse(packageJsonSource) as {
        name?: unknown;
        version?: unknown;
        vibestudio?: Record<string, unknown> & {
          displayName?: unknown;
          title?: unknown;
          icon?: unknown;
          client?: ClientManifestBlock;
        };
      };
      if (packageJson.name !== candidate.unitName) {
        throw new Error(`Candidate client package name does not match ${candidate.unitName}`);
      }
      validateUnitManifest(clientUnitManifestDescriptor, packageJson.vibestudio, {
        unitName: candidate.unitName,
      });
      const block = packageJson.vibestudio!.client!;
      const runtime = block.runtime;
      const capabilities = declaredCapabilities(block);
      const provider = this.providerFor(runtime);
      const externalDeps = this.externalDepsWithProvider(candidate.externalDeps, provider);
      const identity = createUnitBuildIdentity({
        unitKind: "client" as const,
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
        provider !== null &&
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
            unitKind: "client" as const,
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
      const vibestudio = packageJson.vibestudio!;
      const icon = typeof vibestudio.icon === "string" ? vibestudio.icon : undefined;
      units.push({
        ...createReviewedUnitBase({
          unitKind: "client",
          name: candidate.unitName,
          displayName:
            block.title ??
            (typeof vibestudio.displayName === "string"
              ? vibestudio.displayName
              : typeof vibestudio.title === "string"
                ? vibestudio.title
                : candidate.unitName),
          ...(icon ? { icon } : {}),
          ...(icon?.trim().startsWith("./") ? { iconState: candidate.stateHash } : {}),
          version: typeof packageJson.version === "string" ? packageJson.version : "unknown",
          sourceRepo: candidate.unitPath,
          ref: declaration.ref,
          effectiveVersion: candidate.effectiveVersion,
          dependencyEvs: candidate.dependencyEvs,
          externalDeps,
        }),
        runtime,
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
    kind: "client";
    source: string;
    displayName: string;
    status: ClientRegistryEntry["status"];
    version: string;
    ev: string | null;
    activeEv: string | null;
    activeBundleKey: string | null;
    activeRuntimeDepsKey: string | null;
    lastError: string | null;
    lastErrorDetails?: ClientUpdateErrorDiagnostic | null;
    runtime: ClientRuntime;
    canRollback: boolean;
    rollbackRetentionLimit: number;
    previousVersions: ClientVersionRecord[];
  }> {
    return this.unitHost.listWorkspaceUnits().flatMap((row) => {
      const entry = this.registry.get(row.name);
      if (!entry) return [];
      return [
        {
          ...row,
          runtime: entry.runtime,
          canRollback: entry.previousVersions.length > 0,
          rollbackRetentionLimit: UNIT_ROLLBACK_HISTORY_LIMIT,
          lastErrorDetails: entry.lastErrorDetails ?? null,
          previousVersions: entry.previousVersions,
        },
      ];
    });
  }

  listClientVersions(sourceOrName: string): {
    current: ClientVersionRecord | null;
    previous: ClientVersionRecord[];
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

  // ---------------------------------------------------------------------------
  // Hosts: listing and launch
  // ---------------------------------------------------------------------------

  /**
   * The declared clients, as one host sees them: whether it can run each, and
   * which is its default. A host never reads the manifest itself.
   */
  async listClients(host: HostDescriptor): Promise<ClientListing[]> {
    if (!this.deps.isSystemWorkspace()) return [];
    await this.initialize();
    const defaultSource = this.deps.getClientDefault(host.host);
    const listings: ClientListing[] = [];
    for (const decl of this.lastDeclared) {
      const node = this.tryFindClientNode(decl.source);
      const block = node?.manifest.client;
      if (!node || !block) continue;
      const entry = this.registry.get(node.name);
      const compatibility = this.compatibility(node, block, host);
      const source = normalizeRepoPath(node.relativePath);
      const terminalCommand = block.integration?.terminal?.command;
      listings.push({
        source,
        id: block.id,
        runtime: block.runtime,
        title: clientTitle(node, block),
        ...(node.manifest.icon ? { icon: node.manifest.icon } : {}),
        hostAbi: block.hostAbi,
        status: entry?.status ?? "not-built",
        isDefault: defaultSource !== null && normalizeRepoPath(defaultSource) === source,
        trusted: this.isTrustedSource(source),
        ...(compatibility.ok ? {} : { unavailableReason: compatibility.reason }),
        intents: clientIntents(block),
        ...(terminalCommand ? { terminalCommand } : {}),
        activeBuildKey: entry?.activeBundleKey ?? null,
        canRollback: (entry?.previousVersions.length ?? 0) > 0,
      });
    }
    return listings.sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.id.localeCompare(b.id) ||
        a.source.localeCompare(b.source)
    );
  }

  /**
   * Resolve, prepare and admit the client a host asked for (§4.5). One state
   * machine for every runtime: required extensions, then review, then the
   * build, then the verified artifact set the host fetches by integrity.
   */
  async launch(request: {
    host: HostDescriptor;
    select: ClientSelection;
    rollbackTo?: string;
  }): Promise<ClientLaunchResult> {
    if (!this.deps.isSystemWorkspace()) {
      return { state: "unavailable", reason: "Clients run only from the System workspace" };
    }
    await this.initialize();
    await this.unitHost.whenDeclarationsStaged();
    const resolved = this.resolveSelection(request.host, request.select);
    if ("unavailable" in resolved) return { state: "unavailable", reason: resolved.unavailable };
    const { node, block, intent } = resolved;
    const compatibility = this.compatibility(node, block, request.host);
    if (!compatibility.ok) {
      return {
        state: "unavailable",
        reason: compatibility.reason,
        ...(compatibility.missing ? { missing: compatibility.missing } : {}),
      };
    }
    const runtimeReady = await this.deps.prepareRuntime(block.runtime);
    if (runtimeReady.state === "approval-required") {
      return {
        state: "approval-required",
        approvals: this.pendingApprovalsFor(runtimeReady.sources),
      };
    }
    if (runtimeReady.state === "preparing") {
      return { state: "preparing", phase: "extensions", reason: runtimeReady.reason };
    }
    if (runtimeReady.state === "unavailable") {
      return { state: "unavailable", reason: runtimeReady.reason };
    }
    if (request.rollbackTo) await this.rollbackClientVersion(node.name, request.rollbackTo);
    let activation: "ready" | "approval-required";
    try {
      activation = await this.ensureActivated(node.name);
    } catch (error) {
      const entry = this.registry.get(node.name);
      if (entry?.status === "building") {
        return { state: "preparing", phase: "build", reason: errorMessage(error) };
      }
      return { state: "unavailable", reason: errorMessage(error) };
    }
    if (activation === "approval-required") {
      return {
        state: "approval-required",
        approvals: this.pendingApprovalsFor([normalizeRepoPath(node.relativePath)]),
      };
    }
    const entry = this.registry.get(node.name);
    if (!entry?.activeBundleKey) {
      return {
        state: "preparing",
        phase: "build",
        reason: `${node.name} has no prepared build yet`,
      };
    }
    const active = await this.resolveActiveClientBuild(entry);
    const granted = this.grantedCapabilities(entry, block, request.host);
    const client: ReadyClient = {
      source: normalizeRepoPath(entry.source.repo),
      id: block.id,
      runtime: block.runtime,
      title: clientTitle(node, block),
      ...(node.manifest.icon ? { icon: node.manifest.icon } : {}),
      buildKey: active.buildKey,
      executionDigest: active.identity.activeExecutionDigest,
      effectiveVersion: entry.activeEv ?? active.build.metadata.ev,
      hostAbi: block.hostAbi,
      artifacts: active.build.artifacts.map((artifact) => ({
        path: artifact.path,
        role: artifact.role,
        contentType: artifact.contentType,
        ...(artifact.platform ? { platform: artifact.platform } : {}),
        integrity: artifact.integrity!,
      })),
      grantedCapabilities: granted.granted,
      deniedOptional: granted.deniedOptional,
      ...(intent ? { intent } : {}),
    };
    return { state: "ready", client };
  }

  /**
   * Build and prove the default client of a host without admitting or
   * activating it. Server readiness uses this so the first host to connect
   * never becomes the build scheduler; launch owns admission and activation.
   */
  async prepareDefault(
    host: HostKind
  ): Promise<
    | { ready: true; source: string; buildKey: string }
    | { ready: false; source: string | null; reason: string }
  > {
    await this.initialize();
    await this.unitHost.whenDeclarationsStaged();
    const source = this.deps.getClientDefault(host);
    if (!source) {
      return { ready: false, source: null, reason: `No default client is declared for ${host}` };
    }
    const declared = this.lastDeclared.find(
      (decl) => normalizeRepoPath(decl.source) === normalizeRepoPath(source)
    );
    const node = this.tryFindClientNode(source);
    if (!declared || !node?.manifest.client) {
      return { ready: false, source, reason: `${source} is not declared under clients:` };
    }
    const block = node.manifest.client;
    if (HOST_RUNTIME[host] !== block.runtime) {
      return {
        ready: false,
        source,
        reason: `${source} is a ${block.runtime} client; ${host} hosts run ${HOST_RUNTIME[host]} clients`,
      };
    }
    const runtime = await this.deps.prepareRuntime(block.runtime);
    if (runtime.state === "approval-required") {
      return {
        ready: false,
        source,
        reason: `Waiting for review of ${runtime.sources.join(", ")}`,
      };
    }
    if (runtime.state !== "ready") return { ready: false, source, reason: runtime.reason };
    try {
      const build = await this.deps.buildSystem.getStoredBuild(node.name, declared.ref);
      validateClientBuildContract(node.name, block, build);
      return { ready: true, source, buildKey: path.basename(build.dir) };
    } catch (error) {
      return { ready: false, source, reason: errorMessage(error) };
    }
  }

  /**
   * Exchange an authenticated device for the principal of the exact client
   * build it verified and is about to run. The grant is bound to that build: a
   * host that fetched anything else cannot obtain a principal for it.
   */
  async grantPrincipal(
    deviceId: string,
    expected: { source: string; buildKey: string; executionDigest: string }
  ): Promise<ClientPrincipal> {
    this.assertClientHosting();
    await this.initialize();
    const entry = this.findRegistryEntry(expected.source);
    if (!entry || !isCapabilityActiveStatus(entry.status) || !entry.activeBundleKey) {
      throw new Error(`Client ${expected.source} is not running`);
    }
    if (
      entry.activeBundleKey !== expected.buildKey ||
      entry.activeExecutionDigest !== expected.executionDigest
    ) {
      throw new Error(
        `Client ${expected.source} build ${expected.buildKey} is not the build it runs (${entry.activeBundleKey})`
      );
    }
    this.requireAdmission(entry.name, entry.source.repo, entry.activeEv!);
    const active = await this.resolveActiveClientBuild(entry);
    const node = this.findClientNode(entry.name);
    const block = requireClientBlock(node);
    return this.principals.register({
      id: block.id,
      runtime: entry.runtime,
      deviceId,
      source: normalizeRepoPath(entry.source.repo),
      buildKey: active.buildKey,
      effectiveVersion: entry.activeEv!,
      identity: active.identity,
    });
  }

  /**
   * The principal a background intent runs as: the device's principal for the
   * client's current build, activated without any client code on the device
   * (§4.7.2). The handler's authority is that principal's.
   */
  async intentPrincipal(deviceId: string, source: string): Promise<ClientPrincipal> {
    const entry = this.findRegistryEntry(source);
    if (!entry?.activeBundleKey || !entry.activeExecutionDigest) {
      throw new Error(`Client ${source} has no running build to act for`);
    }
    return this.grantPrincipal(deviceId, {
      source,
      buildKey: entry.activeBundleKey,
      executionDigest: entry.activeExecutionDigest,
    });
  }

  /** Retire every client principal of one device (the device was unpaired). */
  retireDevice(deviceId: string): number {
    return this.principals.retireDevice(deviceId);
  }

  /** Launch surfaces every host projects onto its OS: intents per runnable client. */
  async integrationSnapshot(host: HostDescriptor): Promise<{
    clients: Array<{
      id: string;
      title: string;
      icon?: string;
      intents: ClientIntentDecl[];
      terminalCommand?: string;
    }>;
  }> {
    const listings = await this.listClients(host);
    return {
      clients: listings
        .filter((listing) => listing.unavailableReason === undefined)
        .map((listing) => ({
          id: listing.id,
          title: listing.title,
          ...(listing.icon ? { icon: listing.icon } : {}),
          intents: listing.intents,
          ...(listing.terminalCommand ? { terminalCommand: listing.terminalCommand } : {}),
        })),
    };
  }

  /** The declared background intent of a client that runs on this host, with its declaration. */
  resolveBackgroundIntent(
    host: HostDescriptor,
    request: { id: string; intent: string }
  ): { source: string; intent: ClientIntentDecl } {
    const resolved = this.resolveSelection(host, { id: request.id });
    if ("unavailable" in resolved) throw new Error(resolved.unavailable);
    const intent = clientIntents(resolved.block).find((item) => item.name === request.intent);
    if (!intent) throw new Error(`Client ${request.id} has no intent ${request.intent}`);
    if (intent.kind !== "background" || !intent.handler) {
      throw new Error(`Intent ${request.id}/${request.intent} is not a background intent`);
    }
    return { source: normalizeRepoPath(resolved.node.relativePath), intent };
  }

  private resolveSelection(
    host: HostDescriptor,
    select: ClientSelection
  ):
    | { node: ClientGraphNode; block: ClientManifestBlock; intent?: ReadyClient["intent"] }
    | { unavailable: string } {
    const runtime = HOST_RUNTIME[host.host];
    const declaredNodes = this.lastDeclared.flatMap((decl) => {
      const node = this.tryFindClientNode(decl.source);
      return node?.manifest.client ? [{ node, block: node.manifest.client }] : [];
    });
    if ("default" in select) {
      const source = this.deps.getClientDefault(host.host);
      if (!source) return { unavailable: `No default client is declared for ${host.host} hosts` };
      const match = declaredNodes.find(
        ({ node }) => normalizeRepoPath(node.relativePath) === normalizeRepoPath(source)
      );
      return match ?? { unavailable: `The default ${host.host} client ${source} is not declared` };
    }
    if ("source" in select) {
      const match = declaredNodes.find(
        ({ node }) =>
          normalizeRepoPath(node.relativePath) === normalizeRepoPath(select.source) ||
          node.name === select.source
      );
      return match ?? { unavailable: `Client ${select.source} is not declared` };
    }
    const match = declaredNodes.find(
      ({ block }) => block.id === select.id && block.runtime === runtime
    );
    if (!match) return { unavailable: `No ${runtime} client with id ${select.id} is declared` };
    if (!select.intent) return match;
    const intent = clientIntents(match.block).find((item) => item.name === select.intent);
    if (!intent || intent.kind !== "foreground") {
      return { unavailable: `Client ${select.id} has no foreground intent ${select.intent}` };
    }
    const params = select.params ?? {};
    for (const name of Object.keys(params)) {
      if (!intent.params || !(name in intent.params)) {
        return { unavailable: `Intent ${select.id}/${select.intent} has no parameter ${name}` };
      }
    }
    return { ...match, intent: { name: intent.name, params } };
  }

  private compatibility(
    node: ClientGraphNode,
    block: ClientManifestBlock,
    host: HostDescriptor
  ):
    | { ok: true }
    | { ok: false; reason: string; missing?: { capabilities?: string[]; hostAbi?: string } } {
    const hostAbi = host.runtimes[block.runtime];
    if (!hostAbi) {
      return { ok: false, reason: `${host.host} hosts do not run ${block.runtime} clients` };
    }
    if (hostAbi !== block.hostAbi) {
      return {
        ok: false,
        reason: `${clientTitle(node, block)} needs ${block.hostAbi}; this host implements ${hostAbi}. Update the host or the client.`,
        missing: { hostAbi: block.hostAbi },
      };
    }
    const missing = (block.capabilities?.required ?? []).filter(
      (capability) => !host.capabilities.includes(capability)
    );
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `${clientTitle(node, block)} requires ${missing.join(", ")}, which this host does not implement`,
        missing: { capabilities: missing },
      };
    }
    const untrusted = (block.capabilities?.required ?? []).filter(
      (capability) =>
        isDeviceLevelCapability(capability) &&
        !this.isTrustedSource(normalizeRepoPath(node.relativePath))
    );
    if (untrusted.length > 0) {
      return {
        ok: false,
        reason: `${clientTitle(node, block)} requires ${untrusted.join(", ")}, which only clients listed in trust.clients receive`,
        missing: { capabilities: untrusted },
      };
    }
    return { ok: true };
  }

  private grantedCapabilities(
    entry: ClientRegistryEntry,
    block: ClientManifestBlock,
    host: HostDescriptor
  ): { granted: ClientCapability[]; deniedOptional: ClientCapability[] } {
    const effective = new Set(this.effectiveCapabilities(entry));
    const granted: ClientCapability[] = [];
    const deniedOptional: ClientCapability[] = [];
    for (const capability of block.capabilities?.required ?? []) granted.push(capability);
    for (const capability of block.capabilities?.optional ?? []) {
      if (effective.has(capability) && host.capabilities.includes(capability)) {
        granted.push(capability);
      } else {
        deniedOptional.push(capability);
      }
    }
    return { granted: granted.sort(), deniedOptional: deniedOptional.sort() };
  }

  /** Pending reviews that concern these sources, and this workspace's creation review. */
  private pendingApprovalsFor(sources: readonly string[]): PendingUnitInstallReviewApproval[] {
    const relevant = new Set(sources.map((source) => normalizeRepoPath(source)));
    return this.deps.approvalQueue
      .listPending()
      .filter(
        (approval): approval is PendingUnitInstallReviewApproval =>
          approval.kind === "unit-install-review" &&
          approval.parts.some((part) => relevant.has(normalizeRepoPath(part.repoPath)))
      );
  }

  // ---------------------------------------------------------------------------
  // Release, rollback, activation
  // ---------------------------------------------------------------------------

  /** Prepare and adopt one client at an explicit ref selected by a trusted caller. */
  async prepareRelease(
    sourceOrName: string,
    ref: string
  ): Promise<{ buildKey: string; effectiveVersion: string; clientName: string; source: string }> {
    await this.initialize();
    this.assertClientHosting();
    const node = this.findClientNode(sourceOrName);
    const block = requireClientBlock(node);
    const previous = this.registry.get(node.name) ?? null;
    const decl: WorkspaceClientDeclaration = { source: node.relativePath, ref };
    const build = await this.deps.buildSystem.getStoredBuild(node.name, ref);
    validateClientBuildContract(node.name, block, build);
    const result = {
      buildKey: path.basename(build.dir),
      effectiveVersion: build.metadata.ev,
      clientName: node.name,
      source: normalizeRepoPath(node.relativePath),
    };
    // Building and inspecting an exact candidate remains available while
    // its review is pending; only promotion requires acceptance.
    if (this.deps.isAdmitted && !this.deps.isAdmitted(node.relativePath, build.metadata.ev)) {
      return result;
    }
    const externalDeps = this.externalDepsForBuild(node, build.metadata);
    const dependencyEvs = this.currentDependencyEvs(node);
    const trust = this.pinnedRefTrustRecord(
      createUnitBuildIdentity({
        unitKind: "client",
        name: node.name,
        sourceRepo: node.relativePath,
        ref,
        effectiveVersion: build.metadata.ev,
        dependencyEvs,
        externalDeps,
        capabilities: declaredCapabilities(block),
      })
    );
    if (!previous) this.registry.upsert(this.pendingEntryFor(node, decl, true));
    this.adoptBuild(node, ref, build, { dependencyEvs, externalDeps }, trust);
    return result;
  }

  async rollbackClientVersion(
    sourceOrName: string,
    buildKey?: string
  ): Promise<ClientRegistryEntry> {
    await this.initialize();
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown client: ${sourceOrName}`);
    if (buildKey && entry.activeBundleKey === buildKey) return entry;
    const selected = buildKey
      ? entry.previousVersions.find((candidate) => candidate.activeBundleKey === buildKey)
      : entry.previousVersions[0];
    if (!selected) {
      throw new Error(
        buildKey
          ? `No rollback version ${buildKey} is available for client ${entry.name}`
          : `No rollback version is available for client ${entry.name}`
      );
    }
    const build = await this.deps.buildSystem.getBuildByKey(selected.activeBundleKey);
    if (!build)
      throw new Error(
        `Rollback client build is missing from the build store: ${selected.activeBundleKey}`
      );
    this.validateBuild(entry.name, build);
    const updated = this.unitHost.selectVersion(entry.name, selected, {
      status: "running",
      lastErrorDetails: null,
      activationTrust: null,
    });
    const activated = this.registry.get(updated.name) ?? updated;
    this.announceAdopted(activated, "rolled-back", build);
    return activated;
  }

  /** Ensure the declared release has an owned preparation and activation. */
  ensureActivated(sourceOrName: string): Promise<"ready" | "approval-required"> {
    if (this.retiring) return Promise.reject(new Error("Client host is retiring"));
    this.assertClientHosting();
    const node = this.findClientNode(sourceOrName);
    const pending = this.activationFlights.get(node.name);
    if (pending) return pending;
    const flight = Promise.resolve()
      .then(async () => {
        await this.initialize();
        await this.unitHost.whenDeclarationsStaged();
        await this.unitHost.whenApplied(node.name);
        const declared = this.lastDeclared.find(
          (item) => normalizeRepoPath(item.source) === normalizeRepoPath(node.relativePath)
        );
        if (!declared) throw new Error(`Client is not declared: ${node.relativePath}`);
        // A client the person has not reviewed does not run. Launching it
        // brings up its review (or joins the one already open); the review's
        // resolution applies an accepted build, and launching again then
        // finds it admitted.
        if ((await this.unitHost.requestReview(node, declared)) === "reviewing") {
          return "approval-required" as const;
        }
        const entry = this.findRegistryEntry(node.name);
        if (
          !entry ||
          !isCapabilityActiveStatus(entry.status) ||
          !entry.activeBundleKey ||
          !(await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey))
        ) {
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
    if (!prepared) throw new Error(`Unknown client: ${sourceOrName}`);
    let build = prepared.activeBundleKey
      ? await this.deps.buildSystem.getBuildByKey(prepared.activeBundleKey)
      : null;
    if (!build) {
      const preparedSourceRepo = prepared.source.repo;
      const declared = this.lastDeclared.find(
        (entry) => normalizeRepoPath(entry.source) === normalizeRepoPath(preparedSourceRepo)
      );
      if (declared) {
        // Activation is the final race-free readiness boundary: a workspace
        // child can recover its durable registry before the artifact store
        // has settled, so recover the exact approved declaration here too.
        await this.applyDeclared(this.findClientNode(declared.source), declared);
        prepared = this.findRegistryEntry(sourceOrName);
        build = prepared?.activeBundleKey
          ? await this.deps.buildSystem.getBuildByKey(prepared.activeBundleKey)
          : null;
      }
    }
    if (!prepared?.activeBundleKey) throw new Error(`Client ${sourceOrName} has no active build`);
    if (!build) throw new Error(`Active client build is missing: ${prepared.activeBundleKey}`);
    this.validateBuild(prepared.name, build);
    this.requireAdmission(prepared.name, prepared.source.repo, build.metadata.ev);
    if (prepared.status !== "running") {
      this.announceAdopted(
        this.registry.patch(prepared.name, { status: "running" }),
        "adopted",
        build
      );
    }
  }

  /** Announce the current build again; hosts restart running instances under their policy. */
  async reannounce(sourceOrName: string): Promise<void> {
    await this.initialize();
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry?.activeBundleKey) throw new Error(`Client ${sourceOrName} has no active build`);
    const build = await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey);
    if (!build) throw new Error(`Active client build is missing: ${entry.activeBundleKey}`);
    this.validateBuild(entry.name, build);
    this.announceAdopted(entry, "adopted", build);
  }

  async retire(sourceOrName: string): Promise<void> {
    const entry = this.findRegistryEntry(sourceOrName);
    if (!entry) throw new Error(`Unknown client: ${sourceOrName}`);
    this.retirePrincipals(entry, "retired");
    this.registry.patch(entry.name, { status: "stopped", lastError: null });
    this.deps.eventService.emit("clients:changed", { reason: "retired" });
  }

  listWorkspaceUnitLogs(name: string): Array<{
    workspaceId: string;
    unitName: string;
    kind: "client";
    timestamp: number;
    level: "info" | "error";
    message: string;
  }> {
    return this.deps.diagnostics.history(name).entries.map((entry) => ({
      workspaceId: entry.workspaceId ?? this.deps.workspaceId,
      unitName: entry.entityId,
      kind: "client",
      timestamp: entry.timestamp,
      level: entry.level === "error" ? "error" : "info",
      message: entry.message,
    }));
  }

  /** Whether this exact build is active or retained for rollback. */
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

  // ---------------------------------------------------------------------------
  // Capabilities and trust
  // ---------------------------------------------------------------------------

  /**
   * Whether the running client principal `callerId` holds `capability`. A
   * device-level capability is held only while the client is listed in
   * `trust.clients`; every other capability is held when declared.
   */
  hasClientCapability(callerId: string, capability: ClientCapability): boolean {
    if (!this.deps.isSystemWorkspace()) return false;
    const principal = parseClientPrincipalId(callerId);
    if (!principal) return false;
    const entry = this.registry.list().find((candidate) => {
      if (candidate.runtime !== principal.runtime) return false;
      const node = this.tryFindClientNode(candidate.name);
      return node?.manifest.client?.id === principal.id;
    });
    return (
      !!entry &&
      isCapabilityActiveStatus(entry.status) &&
      this.effectiveCapabilities(entry).includes(capability)
    );
  }

  /**
   * The server-vetted capability set for a client: its declared capabilities
   * with every device-level one removed unless the client is trusted. This is
   * the set projected onto every client-facing surface, so a client can never
   * treat an untrusted self-declaration as granted.
   */
  effectiveCapabilities(entry: ClientRegistryEntry): ClientCapability[] {
    const trusted = this.isTrustedSource(normalizeRepoPath(entry.source.repo));
    return entry.capabilities.filter(
      (capability) => trusted || !isDeviceLevelCapability(capability)
    );
  }

  capabilityAuthorizer(): CapabilityAuthorizer {
    return createCapabilityAuthorizer({
      hasClientCapability: (callerId, capability) => this.hasClientCapability(callerId, capability),
    });
  }

  private isTrustedSource(source: string): boolean {
    return this.deps
      .getTrustedClients()
      .some((trusted) => normalizeRepoPath(trusted) === normalizeRepoPath(source));
  }

  /**
   * Apply a newly published `trust.clients`. Grants take effect at once:
   * running instances observe their widened set through `supervision:changed`
   * and re-request their principal. A withdrawal is an authoritative terminal
   * event for the affected sessions: the client's principals are retired, its
   * outstanding grants invalidated and its sessions closed as `trust-revoked`.
   */
  applyTrust(): void {
    const next = this.deviceCapabilitySnapshot();
    let changed = false;
    for (const entry of this.registry.list()) {
      const before = this.trustedDeviceCapabilities.get(entry.name) ?? [];
      const after = next.get(entry.name) ?? [];
      if (before.length === after.length && before.every((item) => after.includes(item))) continue;
      changed = true;
      if (before.some((capability) => !after.includes(capability))) {
        this.retirePrincipals(entry, "trust-revoked");
      }
      this.publish(unitSupervisionChange(entry, null), entry);
    }
    this.trustedDeviceCapabilities = next;
    if (changed) this.deps.eventService.emit("clients:changed", { reason: "trust" });
  }

  /**
   * The trust delta of a candidate state (§4.4.1): every client whose
   * effective device-level capability set — `trust.clients` membership ×
   * declared device-level capabilities — differs from current main's.
   */
  async trustDeltaForCommit(stateHash: string): Promise<ClientTrustChange[]> {
    if (!this.deps.isSystemWorkspace()) return [];
    await this.initialize();
    const config = await readWorkspaceConfig(
      { readText: (filePath) => this.deps.readWorkspaceFileAtState(stateHash, filePath) },
      this.deps.workspaceId
    );
    const candidateTrust = new Set(
      resolveWorkspaceTrustGrants(config).clients.map((source) => normalizeRepoPath(source))
    );
    const candidate = new Map<
      string,
      { block: ClientManifestBlock; icon?: string; ev: string | null }
    >();
    for (const decl of resolveDeclaredClients(config)) {
      const identity = await this.deps.buildSystem.resolveBuildUnitIdentity(decl.source, stateHash);
      if (!identity) continue;
      const packageJson = await this.deps.readWorkspaceFileAtState(
        stateHash,
        `${identity.unitPath}/package.json`
      );
      if (!packageJson) continue;
      const vibestudio = (JSON.parse(packageJson) as { vibestudio?: Record<string, unknown> })
        .vibestudio;
      validateUnitManifest(clientUnitManifestDescriptor, vibestudio, {
        unitName: identity.unitName,
      });
      candidate.set(normalizeRepoPath(identity.unitPath), {
        block: vibestudio!["client"] as ClientManifestBlock,
        ...(typeof vibestudio!["icon"] === "string" ? { icon: vibestudio!["icon"] } : {}),
        ev: identity.effectiveVersion,
      });
    }
    const current = new Map<string, { block: ClientManifestBlock; icon?: string }>();
    for (const decl of this.lastDeclared) {
      const node = this.tryFindClientNode(decl.source);
      if (node?.manifest.client) {
        current.set(normalizeRepoPath(node.relativePath), {
          block: node.manifest.client,
          ...(node.manifest.icon ? { icon: node.manifest.icon } : {}),
        });
      }
    }
    const deviceLevel = (block: ClientManifestBlock | undefined, trusted: boolean) =>
      trusted && block ? declaredCapabilities(block).filter(isDeviceLevelCapability) : [];
    const changes: ClientTrustChange[] = [];
    for (const source of new Set([...candidate.keys(), ...current.keys()])) {
      const next = candidate.get(source);
      const now = current.get(source);
      const after = deviceLevel(next?.block, candidateTrust.has(source));
      const before = deviceLevel(now?.block, this.isTrustedSource(source));
      const gained = after.filter((capability) => !before.includes(capability));
      const lost = before.filter((capability) => !after.includes(capability));
      if (gained.length === 0 && lost.length === 0) continue;
      const block = (next ?? now)!.block;
      const icon = next?.icon ?? now?.icon;
      changes.push({
        source,
        title: block.title ?? source,
        ...(icon ? { icon } : {}),
        runtime: block.runtime,
        gained: gained.map((capability) => ({
          capability,
          summary: CLIENT_CAPABILITY_CATALOG[capability].summary,
        })),
        lost: lost.map((capability) => ({
          capability,
          summary: CLIENT_CAPABILITY_CATALOG[capability].summary,
        })),
        effectiveVersion: next?.ev ?? null,
      });
    }
    return changes.sort((a, b) => a.source.localeCompare(b.source));
  }

  private deviceLevelCapabilities(entry: ClientRegistryEntry): readonly ClientCapability[] {
    return this.effectiveCapabilities(entry).filter((capability) =>
      isDeviceLevelCapability(capability)
    );
  }

  private deviceCapabilitySnapshot(): Map<string, readonly ClientCapability[]> {
    return new Map(
      this.registry.list().map((entry) => [entry.name, this.deviceLevelCapabilities(entry)])
    );
  }

  private retirePrincipals(entry: ClientRegistryEntry, reason: "trust-revoked" | "retired"): void {
    const node = this.tryFindClientNode(entry.name);
    const id = node?.manifest.client?.id;
    if (!id) return;
    for (const principalId of this.principals.retireClient(id, entry.runtime)) {
      this.deps.revokePrincipalSessions?.(principalId, reason);
    }
  }

  // ---------------------------------------------------------------------------
  // Supervision projection
  // ---------------------------------------------------------------------------

  private clientInfo(entry: ClientRegistryEntry): NonNullable<SupervisionChange["client"]> {
    const id = this.tryFindClientNode(entry.name)?.manifest.client?.id ?? entry.name;
    return { id, runtime: entry.runtime, grantedCapabilities: this.effectiveCapabilities(entry) };
  }

  /** The one place a client's state leaves the host: diagnostics, then hosts. */
  private publish(change: SupervisionChange, entry: ClientRegistryEntry): void {
    const name = change.identity.entityId;
    // What a client held when hosts first heard of it is the baseline a later
    // trust change is measured against; a client adopted after startup would
    // otherwise read as having held nothing when its trust is withdrawn.
    if (!this.trustedDeviceCapabilities.has(name)) {
      this.trustedDeviceCapabilities.set(name, this.deviceLevelCapabilities(entry));
    }
    this.deps.diagnostics.record({
      workspaceId: this.deps.workspaceId,
      entityId: name,
      kind: "client",
      level: change.status === "error" || change.lastError ? "error" : "info",
      message: change.lastError ?? `Client ${name} is ${change.status}`,
      source: "lifecycle",
      fields: { status: change.status, errorDetails: entry.lastErrorDetails ?? null },
    });
    this.deps.eventService.emit("supervision:changed", {
      ...change,
      client: { ...this.clientInfo(entry), ...change.client },
    });
  }

  /** Announce a build that became the one in use; each host decides when to take it. */
  private announceAdopted(
    entry: ClientRegistryEntry,
    change: "adopted" | "rolled-back",
    build: ClientBuildResultLike
  ): void {
    if (!build.metadata.authority) {
      throw new Error(`Client ${entry.name} build is missing sealed authority metadata`);
    }
    this.publish(
      {
        ...unitSupervisionChange(entry, null, change),
        previousBuildKey: entry.previousVersions[0]?.activeBundleKey ?? null,
        previousEffectiveVersion: entry.previousVersions[0]?.activeEv ?? null,
        client: { ...this.clientInfo(entry), authority: build.metadata.authority },
      },
      entry
    );
  }

  /** Current state of every client, for hosts that start watching late. */
  supervisionSnapshot(): SupervisionChange[] {
    return this.registry.list().map((entry) => ({
      ...unitSupervisionChange(entry, null),
      client: this.clientInfo(entry),
    }));
  }

  // ---------------------------------------------------------------------------
  // Build application
  // ---------------------------------------------------------------------------

  private async applyDeclared(
    node: ClientGraphNode,
    decl: WorkspaceClientDeclaration
  ): Promise<void> {
    await this.initialize();
    await this.unitHost.applyRuntimeDeclaration({
      node,
      decl,
      validateBeforeApply: () => this.validateClientManifestAtPath(node.path, node.name),
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
    node: ClientGraphNode,
    decl: WorkspaceClientDeclaration
  ): Promise<ClientBuildResultLike> {
    this.assertClientHosting();
    const previous = this.registry.get(node.name) ?? null;
    const block = requireClientBlock(node);
    const diagnostic: ClientUpdateErrorDiagnostic = {
      phase: "build",
      runtime: block.runtime,
      source: node.relativePath,
    };
    try {
      if (!previous) this.registry.upsert(this.pendingEntryFor(node, decl, true));
      else this.unitHost.markBuilding(node.name);
      const build = await this.deps.buildSystem.getStoredBuild(node.name, decl.ref);
      diagnostic.buildKey = path.basename(build.dir);
      diagnostic.phase = "contract";
      validateClientBuildContract(node.name, block, build);
      this.requireAdmission(node.name, node.relativePath, build.metadata.ev);
      diagnostic.phase = "activation";
      this.adoptBuild(
        node,
        decl.ref,
        build,
        {
          dependencyEvs: this.currentDependencyEvs(node),
          externalDeps: this.externalDepsForBuild(node, build.metadata),
        },
        null
      );
      return build;
    } catch (err) {
      if (err && typeof err === "object") {
        (err as { clientUpdateDiagnostic?: ClientUpdateErrorDiagnostic }).clientUpdateDiagnostic =
          diagnostic;
      }
      // The running build stays; the failed update is recorded, never promoted.
      this.unitHost.rejectUpdate(node.name, previous, errorMessage(err), {
        lastErrorDetails: diagnostic,
      });
      throw err;
    }
  }

  private async validateActiveBuild(entry: ClientRegistryEntry): Promise<void> {
    if (!entry.activeBundleKey)
      throw new Error(`Active client ${entry.name} has no active build key`);
    const build = await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey);
    if (!build)
      throw new Error(
        `Active client build is missing from the build store: ${entry.activeBundleKey}`
      );
    this.validateBuild(entry.name, build);
  }

  /** Adopt a proven build; the unit host records what it supersedes for rollback. */
  private adoptBuild(
    node: ClientGraphNode,
    ref: string,
    build: ClientBuildResultLike,
    deps: { dependencyEvs: Record<string, string>; externalDeps: Record<string, string> },
    trust: ClientActivationTrustRecord | null
  ): ClientRegistryEntry {
    const block = requireClientBlock(node);
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
        runtime: block.runtime,
        capabilities: declaredCapabilities(block),
        activeExecutionDigest: build.metadata.execution?.executionDigest ?? null,
        activationTrust: trust,
        lastErrorDetails: null,
      },
    });
  }

  /** Every client runs only an exact build the person has accepted to run. */
  private requireAdmission(name: string, repoPath: string, effectiveVersion: string): void {
    requireExactUnitAdmission({
      service: "runtime.supervision",
      operation: "activate",
      unitLabel: "client",
      name,
      repoPath,
      effectiveVersion,
      isAdmitted: this.deps.isAdmitted,
      openReviewFor: this.deps.openUnitReviewFor,
    });
  }

  /** Validate a stored build against its client's current manifest. */
  private validateBuild(name: string, build: ClientBuildResultLike): void {
    this.assertClientHosting();
    const details = build.metadata.details;
    if (details.kind !== "client") throw new Error(`Build for ${name} is not a client build`);
    validateClientBuildContract(
      name,
      { runtime: details.runtime, hostAbi: details.hostAbi },
      build
    );
  }

  /**
   * Resolve the exact immutable artifact selected by an active client entry
   * and cross the sealed-build → executable-principal boundary.
   */
  private async resolveActiveClientBuild(entry: ClientRegistryEntry): Promise<{
    buildKey: string;
    build: ClientBuildResultLike;
    identity: ActiveExecutionIdentity;
  }> {
    this.assertClientHosting();
    if (!entry.activeEv) {
      throw new Error(`Cannot activate client ${entry.name} without an effective version`);
    }
    if (!entry.activeBundleKey) {
      throw new Error(`Cannot activate client ${entry.name} without an immutable build key`);
    }
    const build = await this.deps.buildSystem.getBuildByKey(entry.activeBundleKey);
    if (!build) {
      throw new Error(
        `Cannot activate client ${entry.name}: immutable build ${entry.activeBundleKey} is unavailable`
      );
    }
    if (build.metadata.ev !== entry.activeEv) {
      throw new Error(
        `Cannot activate client ${entry.name}: build ${entry.activeBundleKey} has effective version ${build.metadata.ev}, expected ${entry.activeEv}`
      );
    }
    if (build.buildKey && build.buildKey !== entry.activeBundleKey) {
      throw new Error(
        `Cannot activate client ${entry.name}: build store returned ${build.buildKey} for ${entry.activeBundleKey}`
      );
    }
    if (build.metadata.buildKey && build.metadata.buildKey !== entry.activeBundleKey) {
      throw new Error(
        `Cannot activate client ${entry.name}: build metadata names ${build.metadata.buildKey} instead of ${entry.activeBundleKey}`
      );
    }
    if (build.metadata.execution?.executionDigest !== entry.activeExecutionDigest) {
      throw new Error(
        `Cannot activate client ${entry.name}: build ${entry.activeBundleKey} does not match its registry execution identity`
      );
    }
    if (
      build.metadata.sourcePath &&
      normalizeRepoPath(build.metadata.sourcePath) !== normalizeRepoPath(entry.source.repo)
    ) {
      throw new Error(
        `Cannot activate client ${entry.name}: build ${entry.activeBundleKey} belongs to ${build.metadata.sourcePath}`
      );
    }
    const details = build.metadata.details;
    if (details.kind !== "client" || details.runtime !== entry.runtime) {
      throw new Error(
        `Cannot activate client ${entry.name}: build ${entry.activeBundleKey} is not a ${entry.runtime} client build`
      );
    }
    this.validateBuild(entry.name, build);
    const identity = requireActiveExecutionIdentity(
      {
        executionDigest: build.metadata.execution?.executionDigest,
        authority: build.metadata.authority,
      },
      `client ${entry.name} build ${entry.activeBundleKey}`
    );
    return { buildKey: entry.activeBundleKey, build, identity };
  }

  private notifyClientUpdateError(
    entry: ClientRegistryEntry,
    message: string,
    diagnostic?: ClientUpdateErrorDiagnostic | null
  ): void {
    const detail = diagnostic ? ` (${diagnostic.phase})` : "";
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
                  release: { kind: "client", releaseId: entry.name },
                },
              },
            ]
          : undefined,
    });
  }

  private findRegistryEntry(sourceOrName: string): ClientRegistryEntry | null {
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

  private async resolveOriginsFor(
    entries: readonly ReviewedUnit[]
  ): Promise<ReadonlyMap<string, InstallReviewOrigin> | undefined> {
    if (!this.deps.resolveUnitOrigins) return undefined;
    return this.deps.resolveUnitOrigins(entries.map((entry) => entry.source.repo));
  }

  private pendingEntryFor(
    node: ClientGraphNode,
    decl: WorkspaceClientDeclaration,
    building = false
  ): ClientRegistryEntry {
    const block = requireClientBlock(node);
    return {
      ...createPendingUnitRegistryEntry({
        unitKind: "client",
        name: node.name,
        version: readPackageVersion(node.path),
        sourceRepo: node.relativePath,
        ref: decl.ref,
        building,
      }),
      runtime: block.runtime,
      capabilities: declaredCapabilities(block),
      previousVersions: [],
    };
  }

  private async buildBatchEntry(
    node: ClientGraphNode,
    decl: WorkspaceClientDeclaration
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
    const block = requireClientBlock(node);
    const active = this.registry.get(node.name);
    return {
      ...createReviewedUnitBase({
        unitKind: "client",
        name: node.name,
        displayName: clientTitle(node, block),
        ...(node.manifest.icon ? { icon: node.manifest.icon } : {}),
        version: readPackageVersion(node.path),
        sourceRepo: node.relativePath,
        ref: decl.ref,
        effectiveVersion: candidate.effectiveVersion,
        dependencyEvs: candidate.dependencyEvs,
        externalDeps: this.currentExternalDeps(node, active),
      }),
      ...(node.manifest.icon?.trim().startsWith("./") ? { iconState: candidate.stateHash } : {}),
      runtime: block.runtime,
      capabilities: declaredCapabilities(block),
      authority: {
        ...parseUnitAuthorityManifest(
          candidate.manifest.authority,
          `${node.name} vibestudio.authority`
        ),
        serviceBindings: [...candidate.serviceBindings],
        serviceReviews: [...candidate.serviceReviews],
      },
      integrity: null,
      provider: this.providerFor(block.runtime),
    };
  }

  private declarationIdentity(
    node: ClientGraphNode,
    decl: WorkspaceClientDeclaration
  ): UnitBuildIdentity<"client"> {
    return createUnitBuildIdentity({
      unitKind: "client" as const,
      name: node.name,
      sourceRepo: node.relativePath,
      ref: decl.ref,
      effectiveVersion: this.deps.buildSystem.getEffectiveVersion(node.name),
      dependencyEvs: this.currentDependencyEvs(node),
      externalDeps: this.currentExternalDeps(node, this.registry.get(node.name) ?? null),
      capabilities: declaredCapabilities(requireClientBlock(node)),
    });
  }

  private registryEntryIdentity(entry: ClientRegistryEntry): UnitBuildIdentity<"client"> {
    return unitBuildIdentityFromRegistryEntry(entry, entry.capabilities);
  }

  private async needsBuildRefresh(
    entry: ClientRegistryEntry,
    node: ClientGraphNode,
    decl: WorkspaceClientDeclaration
  ): Promise<boolean> {
    await this.initialize();
    if (entry.status === "error") return true;
    // Registry state is only a durable pointer to an immutable build; the
    // artifact store can be recovered independently, so matching metadata does
    // not make an absent artifact runnable. Rebuild it through the ordinary
    // declaration path.
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
      externalDeps: this.currentExternalDeps(node, entry),
    });
  }

  private async handleChangedClientUnit(event: {
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
    entry: ClientRegistryEntry
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
    const node = this.findClientNode(entry.name);
    try {
      const build = await this.buildAndActivate(node, {
        source: node.relativePath,
        ref: entry.source.ref,
      });
      const prepared = this.registry.get(entry.name);
      if (prepared?.activeBundleKey && prepared.activeBundleKey !== entry.activeBundleKey) {
        this.announceAdopted(prepared, "adopted", build);
      }
      this.emitDevStatusDiagnostic("source-rebuilt");
    } catch (err) {
      const message = errorMessage(err);
      const diagnostic =
        err && typeof err === "object"
          ? ((err as { clientUpdateDiagnostic?: ClientUpdateErrorDiagnostic })
              .clientUpdateDiagnostic ?? null)
          : null;
      const updated = this.registry.get(entry.name) ?? entry;
      this.publish(
        {
          ...unitSupervisionChange(updated, null, "update-rejected"),
          lastError: message,
        },
        updated
      );
      this.notifyClientUpdateError(updated, message, diagnostic);
    }
  }

  private emitDevStatusDiagnostic(trigger: string): void {
    if (!clientDevDiagnosticsEnabled() || this.lastDeclared.length === 0) return;
    const rows: string[] = [];
    for (const decl of this.lastDeclared) {
      try {
        const node = this.findClientNode(decl.source);
        const entry = this.registry.get(node.name);
        const activeEv = entry?.activeEv ? shortId(entry.activeEv) : "none";
        const activeBuild = entry?.activeBundleKey ? shortId(entry.activeBundleKey) : "none";
        const error =
          entry?.status === "error" && entry.lastError
            ? ` error=${JSON.stringify(entry.lastError)}`
            : "";
        rows.push(
          `${node.name} runtime=${node.manifest.client?.runtime ?? "?"} source=${node.relativePath} ref=${decl.ref} status=${entry?.status ?? "uninstalled"} ev=${activeEv} build=${activeBuild}${error}`
        );
      } catch (error) {
        rows.push(`${decl.source} status=unresolved error=${errorMessage(error)}`);
      }
    }
    const statusKey = `${trigger}\n${rows.join("\n")}`;
    if (statusKey !== this.lastDevStatusDiagnosticKey) {
      this.lastDevStatusDiagnosticKey = statusKey;
      console.info(`[Clients] Dev status (${trigger}):\n  ${rows.join("\n  ")}`);
    }
  }

  private findClientNode(nameOrRepo: string): ClientGraphNode {
    return findUnitGraphNode(
      this.deps.buildSystem.getGraph().allNodes(),
      CLIENT_UNIT_DESCRIPTOR,
      nameOrRepo
    );
  }

  private tryFindClientNode(nameOrRepo: string): ClientGraphNode | null {
    try {
      return this.findClientNode(nameOrRepo);
    } catch {
      return null;
    }
  }

  private async readDeclaredClientsFromState(
    stateHash: string
  ): Promise<WorkspaceClientDeclaration[]> {
    if (!this.deps.isSystemWorkspace()) return [];
    return resolveDeclaredClients(
      await readWorkspaceConfig(
        { readText: (filePath) => this.deps.readWorkspaceFileAtState(stateHash, filePath) },
        this.deps.workspaceId
      )
    );
  }

  private validateClientManifestAtPath(nodePath: string, unitName: string): void {
    try {
      readAndValidateUnitManifest(
        clientUnitManifestDescriptor,
        path.join(nodePath, "package.json"),
        { unitName },
        fs.readFileSync as (p: string, encoding: "utf-8") => string
      );
    } catch (err) {
      if (err instanceof UnitManifestError) throw err;
      throw new UnitManifestError(
        `Client ${unitName} manifest validation failed: ${errorMessage(err)}`,
        "MANIFEST_INTERNAL"
      );
    }
  }

  private pinnedRefTrustRecord(identity: UnitBuildIdentity<"client">): ClientActivationTrustRecord {
    return {
      decision: "release-pinned-ref",
      identityKey: canonicalUnitBuildIdentity(identity),
      actor: "host",
      reason: "Release pinned to an explicit ref selected by a trusted host or server caller",
      acceptedAt: Date.now(),
    };
  }

  private currentDependencyEvs(node: ClientGraphNode): Record<string, string> {
    return collectTransitiveUnitDependencyEvs(
      this.deps.buildSystem.getGraph().allNodes(),
      node,
      (name) => this.deps.buildSystem.getEffectiveVersion(name)
    );
  }

  /** The build provider whose identity is part of a runtime's build identity, if any. */
  private providerFor(runtime: ClientRuntime): ClientBuildProviderDetails | null {
    if (runtime !== "react-native") return null;
    return this.deps.buildSystem.getBuildProviderDetails?.("react-native") ?? null;
  }

  private currentExternalDeps(
    node: ClientGraphNode,
    fallbackEntry: ClientRegistryEntry | null
  ): Record<string, string> {
    const runtime = requireClientBlock(node).runtime;
    const provider = this.providerFor(runtime);
    const externalDeps = this.deps.buildSystem.getExternalDeps(node.name);
    if (!provider && fallbackEntry && runtime === "react-native") {
      // Without an active provider, the identity of the adopted build is the
      // one it was produced with, not an unprovided one.
      const providerDeps = Object.fromEntries(
        Object.entries(fallbackEntry.activeExternalDeps ?? {}).filter(([key]) =>
          key.startsWith("build-provider:")
        )
      );
      return { ...externalDeps, ...providerDeps };
    }
    return this.externalDepsWithProvider(externalDeps, provider);
  }

  private externalDepsForBuild(
    node: ClientGraphNode,
    metadata: ClientBuildResultLike["metadata"]
  ): Record<string, string> {
    const details = metadata.details.kind === "client" ? metadata.details : null;
    return this.externalDepsWithProvider(
      this.deps.buildSystem.getExternalDeps(node.name),
      details?.provider ?? this.providerFor(requireClientBlock(node).runtime)
    );
  }

  private externalDepsWithProvider(
    externalDeps: Record<string, string>,
    provider: ClientBuildProviderDetails | null
  ): Record<string, string> {
    if (!provider) return externalDeps;
    return {
      ...externalDeps,
      [`build-provider:${provider.name}`]: [
        provider.activeEv ?? "",
        provider.activeBuildKey ?? "",
        provider.contractVersion,
      ].join(":"),
    };
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

function requireClientBlock(node: ClientGraphNode): ClientManifestBlock {
  const block = node.manifest.client;
  if (!block) {
    throw new UnitManifestError(
      `Client ${node.name} manifest must declare vibestudio.client`,
      "MANIFEST_CLIENT_BLOCK"
    );
  }
  return block;
}

function declaredCapabilities(block: ClientManifestBlock): ClientCapability[] {
  return [
    ...new Set([...(block.capabilities?.required ?? []), ...(block.capabilities?.optional ?? [])]),
  ]
    .filter(isClientCapability)
    .sort((left, right) => left.localeCompare(right));
}

function clientTitle(node: ClientGraphNode, block: ClientManifestBlock): string {
  return block.title ?? node.manifest.displayName ?? node.manifest.title ?? node.name;
}

function requireBuildSourceStateHash(unitName: string, build: ClientBuildResultLike): string {
  if (build.sourceStateHash) return build.sourceStateHash;
  if (build.metadata.sourceStateHash) return build.metadata.sourceStateHash;
  throw new Error(`Build for ${unitName} is missing workspace source state provenance`);
}

export function isCapabilityActiveStatus(status: ClientRegistryEntry["status"]): boolean {
  return status === "running" || status === "available";
}

function readPackageVersion(nodePath: string): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(nodePath, "package.json"), "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}

function clientDevDiagnosticsEnabled(): boolean {
  const override = process.env["VIBESTUDIO_CLIENT_DEV_STATUS"];
  if (override === "0" || override === "false") return false;
  if (override === "1" || override === "true") return true;
  return process.env["NODE_ENV"] === "development";
}

function shortId(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 12 ? value.slice(0, 12) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { BuildMetadata };
