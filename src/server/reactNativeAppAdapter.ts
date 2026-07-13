import { createHash } from "node:crypto";
import type { UnitApprovalCoordinator } from "@vibestudio/unit-host";
import { normalizeUnitRepoPath as normalizeRepoPath } from "@vibestudio/unit-host";
import type { UnitBatchEntry } from "@vibestudio/shared/approvals";
import type { HostTargetCandidate } from "@vibestudio/shared/hostTargets";
import { appArtifactRoute, appArtifactUrl } from "@vibestudio/shared/appArtifacts";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { AppRegistryEntry, WorkspaceAppDeclaration } from "./appHost.js";

export interface AppBuildProviderDetails {
  name: string;
  activeEv: string | null;
  activeBuildKey: string | null;
  contractVersion: string;
}

interface ReactNativeBuildArtifact {
  path: string;
  role: string;
  contentType: string;
  encoding: string;
  platform?: string;
  integrity?: string;
}

interface ReactNativeBuild {
  metadata: {
    details?:
      | {
          kind: "app";
          rnHostAbi?: string | null;
          integrity?: string | null;
          provider?: AppBuildProviderDetails | null;
        }
      | { kind: string };
  };
  artifacts?: ReactNativeBuildArtifact[];
}

interface ReactNativeRegistry {
  get(name: string): AppRegistryEntry | null;
  list(): AppRegistryEntry[];
}

type ReactNativeEntityCache = Pick<
  EntityCache,
  "resolve" | "listActive" | "_onActivate" | "_onRetire"
>;

export interface ReactNativeAppBootstrap {
  appId: string;
  buildKey: string;
  effectiveVersion: string | null;
  capabilities: AppRegistryEntry["capabilities"];
  rnHostAbi: string;
  integrity: string;
  artifacts: Array<{
    path: string;
    role: string;
    contentType: string;
    encoding: string;
    platform?: string;
    integrity: string;
    route: string;
    url: string;
  }>;
  provider?: AppBuildProviderDetails | null;
}

export type ReactNativeHostReadiness =
  | {
      ready: true;
      source: string;
      appId: string;
      buildKey: string;
      bootstrap: ReactNativeAppBootstrap;
    }
  | {
      ready: false;
      source: string | null;
      appId?: string | null;
      reason: string;
      details: string[];
    };

export interface ReactNativeAppAdapterDeps {
  workspaceId: string;
  registry: ReactNativeRegistry;
  buildSystem: {
    getBuildByKey?(key: string): ReactNativeBuild | null;
    getBuildProviderDetails?(target: "react-native"): AppBuildProviderDetails | null;
  };
  approvalCoordinator?: UnitApprovalCoordinator<UnitBatchEntry>;
  entityCache?: ReactNativeEntityCache;
  getArtifactBaseUrl(): string;
  selectedSource(): string | null;
  listCandidates(): HostTargetCandidate[];
  declaredForCandidate(candidate: HostTargetCandidate): WorkspaceAppDeclaration | null;
  requiredExtensions(): string[];
  whenDeclarationsStaged(): Promise<void>;
  whenReconciled(): Promise<void>;
  reconcileDeclaration(
    declaration: WorkspaceAppDeclaration,
    options: { waitForApproval?: boolean }
  ): Promise<void>;
  approvalForDeclarations(declarations: WorkspaceAppDeclaration[]): {
    entries: UnitBatchEntry[];
    identityKeys: string[];
  };
  acceptPreapprovedTrust(keys: Iterable<string>): void;
  emitStatus(appId: string, status: AppRegistryEntry["status"], error: string | null): void;
}

/** Owns the native-host artifact, readiness, approval, and device-principal lifecycle. */
export class ReactNativeAppAdapter {
  private readonly pendingLaunchPreflightKeys = new Set<string>();
  private readonly approvedLaunchPreflights = new Map<string, WorkspaceAppDeclaration>();

  constructor(private readonly deps: ReactNativeAppAdapterDeps) {}

  getBootstrap(source?: string | null): ReactNativeAppBootstrap | null {
    const resolvedSource = source ?? this.deps.selectedSource();
    if (!resolvedSource) return null;
    const normalizedSource = normalizeRepoPath(resolvedSource);
    const entry = this.deps.registry
      .list()
      .find(
        (candidate) =>
          candidate.target === "react-native" &&
          candidate.status === "running" &&
          normalizeRepoPath(candidate.source.repo) === normalizedSource &&
          candidate.activeBundleKey
      );
    if (!entry?.activeBundleKey) return null;
    const build = this.deps.buildSystem.getBuildByKey?.(entry.activeBundleKey);
    const details =
      build?.metadata.details &&
      build.metadata.details.kind === "app" &&
      "rnHostAbi" in build.metadata.details
        ? build.metadata.details
        : null;
    const rnHostAbi = details?.rnHostAbi;
    const integrity = details?.integrity;
    if (
      !build ||
      !details ||
      typeof rnHostAbi !== "string" ||
      rnHostAbi.length === 0 ||
      typeof integrity !== "string" ||
      integrity.length === 0 ||
      !isBuildProviderDetailsLike(details.provider)
    ) {
      return null;
    }
    const primaryArtifacts = (build.artifacts ?? []).filter(
      (artifact) => artifact.role === "primary"
    );
    if (!hasMobilePrimaryArtifacts(primaryArtifacts)) return null;
    if (
      primaryArtifacts.some(
        (artifact) => typeof artifact.integrity !== "string" || artifact.integrity.length === 0
      )
    ) {
      return null;
    }
    const buildKey = entry.activeBundleKey;
    const artifacts = primaryArtifacts.map((artifact) => ({
      path: artifact.path,
      role: artifact.role,
      contentType: artifact.contentType,
      encoding: artifact.encoding,
      platform: artifact.platform,
      integrity: artifact.integrity ?? "",
      route: appArtifactRoute(buildKey, artifact.path),
      url: appArtifactUrl(this.deps.getArtifactBaseUrl(), buildKey, artifact.path),
    }));
    return {
      appId: entry.name,
      buildKey,
      effectiveVersion: entry.activeEv,
      capabilities: entry.capabilities,
      rnHostAbi,
      integrity,
      artifacts,
      provider: details.provider,
    };
  }

  async ensureReady(
    source?: string | null,
    options: { waitForApproval?: boolean } = {}
  ): Promise<ReactNativeHostReadiness> {
    const nonBlocking = options.waitForApproval === false;
    if (nonBlocking) await this.deps.whenDeclarationsStaged();
    else await this.deps.whenReconciled();

    const first = this.readinessSnapshot(source);
    if (first.ready) return first;

    const resolvedSource = first.source ?? source ?? this.deps.selectedSource();
    if (!resolvedSource) return first;
    const candidate = this.deps
      .listCandidates()
      .find(
        (item) =>
          item.source === normalizeRepoPath(resolvedSource) ||
          item.name === resolvedSource ||
          item.name === first.appId
      );
    if (!candidate) return first;
    const declared = this.deps.declaredForCandidate(candidate);
    if (!declared) {
      return {
        ready: false,
        source: candidate.source,
        appId: candidate.name,
        reason: "React Native app is not declared in meta/vibestudio.yml",
        details: [`Declare ${candidate.source} under apps: before mobile clients can pair.`],
      };
    }

    const provider = this.deps.buildSystem.getBuildProviderDetails?.("react-native") ?? null;
    if (!provider) {
      this.stageLaunchPreflightApproval(candidate, declared);
      const missingProvider = this.readinessSnapshot(candidate.source);
      if (missingProvider.ready) return missingProvider;
      const requiredExtensions = this.deps.requiredExtensions();
      const orderingDetail =
        requiredExtensions.length > 0
          ? `The declared extensions must start ${requiredExtensions.join(", ")} before ${candidate.source} can build.`
          : `A React Native build-provider extension must be declared (meta/vibestudio.yml hostTargets.react-native.requiresExtensions) and running before ${candidate.source} can build.`;
      return {
        ...missingProvider,
        reason: "React Native build provider is not active",
        details: [...missingProvider.details, orderingDetail],
      };
    }

    this.acceptLaunchPreflight(candidate, declared);
    if (nonBlocking) {
      const entry = this.deps.registry.get(candidate.name);
      if (entry && (entry.status === "building" || entry.status === "pending-approval")) {
        return this.readinessSnapshot(candidate.source);
      }
    }
    await this.deps.reconcileDeclaration(declared, options);
    return this.readinessSnapshot(candidate.source);
  }

  registerPrincipal(deviceId: string, source?: string | null): string | null {
    const resolvedSource = source ?? this.deps.selectedSource();
    if (!resolvedSource) return null;
    const normalizedSource = normalizeRepoPath(resolvedSource);
    const entry = this.deps.registry
      .list()
      .find(
        (candidate) =>
          candidate.target === "react-native" &&
          candidate.status === "running" &&
          !!candidate.activeEv &&
          !!candidate.activeBundleKey &&
          normalizeRepoPath(candidate.source.repo) === normalizedSource
      );
    if (!entry || !this.deps.entityCache) return null;
    return this.activatePrincipal(entry, deviceId);
  }

  retirePrincipal(deviceId: string): number {
    let retired = 0;
    for (const entry of this.deps.registry.list()) {
      if (entry.target !== "react-native") continue;
      if (this.retireEntity(mobileAppPrincipalId(entry.source.repo, deviceId))) retired++;
    }
    return retired;
  }

  retirePrincipalsForEntry(entry: AppRegistryEntry): void {
    if (!this.deps.entityCache) return;
    const prefix = `app:${normalizeRepoPath(entry.source.repo)}:`;
    for (const record of this.deps.entityCache.listActive()) {
      if (record.kind === "app" && record.id.startsWith(prefix)) this.retireEntity(record.id);
    }
  }

  private readinessSnapshot(source?: string | null): ReactNativeHostReadiness {
    const resolvedSource = source ?? this.deps.selectedSource();
    const candidates = this.deps.listCandidates();
    if (!resolvedSource) {
      return {
        ready: false,
        source: null,
        reason: "No React Native workspace app is selected",
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
            : ["No apps with vibestudio.app.target: react-native were found."],
      };
    }
    const normalizedSource = normalizeRepoPath(resolvedSource);
    const candidate = candidates.find(
      (item) => item.source === normalizedSource || item.name === resolvedSource
    );
    const bootstrap = this.getBootstrap(normalizedSource);
    if (bootstrap) {
      return {
        ready: true,
        source: normalizedSource,
        appId: bootstrap.appId,
        buildKey: bootstrap.buildKey,
        bootstrap,
      };
    }
    const entry = this.deps.registry
      .list()
      .find(
        (item) =>
          item.target === "react-native" && normalizeRepoPath(item.source.repo) === normalizedSource
      );
    const details: string[] = [];
    if (candidate) {
      details.push(`${candidate.name} (${candidate.source}) status: ${candidate.status}`);
      if (candidate.compatibility.reasons.length > 0)
        details.push(...candidate.compatibility.reasons);
    }
    if (entry?.lastError) details.push(entry.lastError);
    if (entry?.lastErrorDetails) {
      details.push(
        `Last failure phase: ${entry.lastErrorDetails.phase}${
          entry.lastErrorDetails.target ? ` (${entry.lastErrorDetails.target})` : ""
        }`
      );
      if (entry.lastErrorDetails.buildKey) {
        details.push(`Last build key: ${entry.lastErrorDetails.buildKey}`);
      }
    }
    if (!entry) details.push("No active registry entry exists for the selected React Native app.");
    else if (!entry.activeBundleKey)
      details.push("The selected React Native app has no active build.");
    else details.push("The selected React Native app build is not bootstrap-ready.");
    return {
      ready: false,
      source: normalizedSource,
      appId: candidate?.name ?? entry?.name ?? null,
      reason: "React Native workspace app is not ready",
      details,
    };
  }

  private stageLaunchPreflightApproval(
    candidate: HostTargetCandidate,
    declared: WorkspaceAppDeclaration
  ): void {
    const coordinator = this.deps.approvalCoordinator;
    if (!coordinator) return;
    const sourceKey = normalizeRepoPath(candidate.source);
    const approved = this.approvedLaunchPreflights.get(sourceKey);
    if (
      approved &&
      normalizeRepoPath(approved.source) === sourceKey &&
      approved.ref === declared.ref
    ) {
      return;
    }

    const approval = this.deps.approvalForDeclarations([declared]);
    if (approval.entries.length === 0 || approval.identityKeys.length === 0) return;
    const keys = approval.identityKeys.filter((key) => !this.pendingLaunchPreflightKeys.has(key));
    if (keys.length === 0) return;
    for (const key of keys) this.pendingLaunchPreflightKeys.add(key);

    void coordinator
      .enqueue({
        entries: approval.entries,
        trigger: "startup",
        applyApproved: async () => {
          this.approvedLaunchPreflights.set(sourceKey, { ...declared });
        },
        applyDenied: () => {
          this.deps.emitStatus(candidate.name, "pending-approval", null);
        },
      })
      .catch((error) => {
        console.error(
          "[AppHost] React Native launch preflight approval failed:",
          error instanceof Error ? error.message : String(error)
        );
      })
      .finally(() => {
        for (const key of keys) this.pendingLaunchPreflightKeys.delete(key);
      });
  }

  private acceptLaunchPreflight(
    candidate: HostTargetCandidate,
    declared: WorkspaceAppDeclaration
  ): void {
    const sourceKey = normalizeRepoPath(candidate.source);
    const approved = this.approvedLaunchPreflights.get(sourceKey);
    if (
      !approved ||
      normalizeRepoPath(approved.source) !== sourceKey ||
      approved.ref !== declared.ref
    ) {
      return;
    }

    const approval = this.deps.approvalForDeclarations([declared]);
    if (approval.identityKeys.length > 0) this.deps.acceptPreapprovedTrust(approval.identityKeys);
    this.approvedLaunchPreflights.delete(sourceKey);
  }

  private activatePrincipal(entry: AppRegistryEntry, deviceId: string): string {
    const entityCache = this.deps.entityCache;
    if (!entityCache || !entry.activeEv) {
      throw new Error("Cannot activate device-scoped app principal without an active app entity");
    }
    const sourceRepo = normalizeRepoPath(entry.source.repo);
    const principalId = mobileAppPrincipalId(sourceRepo, deviceId);
    const existing = entityCache.resolve(principalId);
    const contextId = createHash("sha256")
      .update(`${this.deps.workspaceId}\x00app-device\x00${sourceRepo}\x00${deviceId}`)
      .digest("hex");
    const record: EntityRecord = {
      id: principalId,
      kind: "app",
      source: { repoPath: sourceRepo, effectiveVersion: entry.activeEv },
      contextId,
      key: principalId,
      createdAt: existing?.createdAt ?? Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    entityCache._onActivate(record);
    return principalId;
  }

  private retireEntity(name: string): boolean {
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
}

export function isBuildProviderDetailsLike(value: unknown): value is AppBuildProviderDetails {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<AppBuildProviderDetails>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    (typeof candidate.activeEv === "string" || candidate.activeEv === null) &&
    (typeof candidate.activeBuildKey === "string" || candidate.activeBuildKey === null) &&
    typeof candidate.contractVersion === "string" &&
    candidate.contractVersion.length > 0
  );
}

function hasMobilePrimaryArtifacts(artifacts: Array<{ platform?: string }>): boolean {
  const seenPlatforms = new Set<string>();
  for (const artifact of artifacts) {
    if (artifact.platform !== "android" && artifact.platform !== "ios") return false;
    if (seenPlatforms.has(artifact.platform)) return false;
    seenPlatforms.add(artifact.platform);
  }
  return seenPlatforms.size > 0;
}

function mobileAppPrincipalId(repoPath: string, deviceId: string): string {
  return `app:${normalizeRepoPath(repoPath)}:${deviceId}`;
}
