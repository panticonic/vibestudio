import type { UnitApprovalCoordinator } from "@vibestudio/unit-host";
import { normalizeUnitRepoPath as normalizeRepoPath } from "@vibestudio/unit-host";
import type { ReviewedUnit } from "@vibestudio/shared/approvals";
import type { HostTargetCandidate } from "@vibestudio/shared/hostTargets";
import { appArtifactRoute, appArtifactUrl } from "@vibestudio/shared/appArtifacts";
import type { ActiveExecutionIdentity } from "./runtimeExecutionIdentity.js";
import {
  isBuildProviderDetailsLike,
  type AppBuildProviderDetails,
} from "./buildV2/appBuildContract.js";
import type { AppBuildResultLike, AppRegistryEntry, WorkspaceAppDeclaration } from "./appHost.js";

interface ReactNativeRegistry {
  get(name: string): AppRegistryEntry | null;
  list(): AppRegistryEntry[];
}

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
    getBuildProviderDetails?(target: "react-native"): AppBuildProviderDetails | null;
  };
  resolveActiveBuild(entry: AppRegistryEntry): Promise<{
    buildKey: string;
    build: AppBuildResultLike;
    identity: ActiveExecutionIdentity;
  }>;
  approvalCoordinator?: UnitApprovalCoordinator<ReviewedUnit>;
  getArtifactBaseUrl(): string;
  selectedSource(): string | null;
  listCandidates(): Promise<HostTargetCandidate[]>;
  declaredForCandidate(candidate: HostTargetCandidate): WorkspaceAppDeclaration | null;
  requiredExtensions(): string[];
  ensureRequiredExtensions(): Promise<void>;
  whenDeclarationsStaged(): Promise<void>;
  whenReconciled(): Promise<void>;
  reconcileDeclaration(
    declaration: WorkspaceAppDeclaration,
    options: { waitForApproval?: boolean }
  ): Promise<void>;
  approvalForDeclarations(declarations: WorkspaceAppDeclaration[]): Promise<{
    entries: ReviewedUnit[];
    identityKeys: string[];
  }>;
  acceptPreapprovedTrust(keys: Iterable<string>): void;
  emitStatus(appId: string, status: AppRegistryEntry["status"], error: string | null): void;
}

/** Owns the native-host artifact, readiness, and launch-approval lifecycle. */
export class ReactNativeAppAdapter {
  private readonly pendingLaunchPreflightKeys = new Set<string>();
  private readonly approvedLaunchPreflights = new Map<string, WorkspaceAppDeclaration>();

  constructor(private readonly deps: ReactNativeAppAdapterDeps) {}

  async getBootstrap(source?: string | null): Promise<ReactNativeAppBootstrap | null> {
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
    const activeBuild = await this.deps.resolveActiveBuild(entry);
    const build = activeBuild.build;
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
    const platformArtifacts = (build.artifacts ?? []).filter(
      (artifact) => artifact.role === "primary" || artifact.role === "asset"
    );
    if (
      platformArtifacts.some(
        (artifact) =>
          typeof artifact.integrity !== "string" ||
          artifact.integrity.length === 0 ||
          (artifact.platform !== "android" && artifact.platform !== "ios")
      )
    ) {
      return null;
    }
    const buildKey = entry.activeBundleKey;
    const artifacts = platformArtifacts.map((artifact) => ({
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
    await this.deps.ensureRequiredExtensions();

    const first = await this.readinessSnapshot(source);
    const provider = this.deps.buildSystem.getBuildProviderDetails?.("react-native") ?? null;
    if (first.ready && provider && sameBuildProvider(first.bootstrap.provider, provider))
      return first;

    const resolvedSource = first.source ?? source ?? this.deps.selectedSource();
    if (!resolvedSource) return first;
    const candidate = (await this.deps.listCandidates()).find(
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

    if (!provider) {
      await this.stageLaunchPreflightApproval(candidate, declared);
      const missingProvider = await this.readinessSnapshot(candidate.source);
      const requiredExtensions = this.deps.requiredExtensions();
      const orderingDetail =
        requiredExtensions.length > 0
          ? `The declared extensions must start ${requiredExtensions.join(", ")} before ${candidate.source} can build.`
          : `A React Native build-provider extension must be declared (meta/vibestudio.yml hostTargets.react-native.requiresExtensions) and running before ${candidate.source} can build.`;
      return {
        ready: false,
        source: candidate.source,
        appId: candidate.name,
        reason: "React Native build provider is not active",
        details: [
          ...(missingProvider.ready
            ? [`The active ${candidate.source} bundle has no matching active build provider.`]
            : missingProvider.details),
          orderingDetail,
        ],
      };
    }

    await this.acceptLaunchPreflight(candidate, declared);
    if (nonBlocking) {
      const entry = this.deps.registry.get(candidate.name);
      if (entry && (entry.status === "building" || entry.status === "pending-approval")) {
        return this.readinessSnapshot(candidate.source);
      }
    }
    await this.deps.reconcileDeclaration(declared, options);
    return this.readinessSnapshot(candidate.source);
  }

  private async readinessSnapshot(source?: string | null): Promise<ReactNativeHostReadiness> {
    const resolvedSource = source ?? this.deps.selectedSource();
    const candidates = await this.deps.listCandidates();
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
    const bootstrap = await this.getBootstrap(normalizedSource);
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

  private async stageLaunchPreflightApproval(
    candidate: HostTargetCandidate,
    declared: WorkspaceAppDeclaration
  ): Promise<void> {
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

    const approval = await this.deps.approvalForDeclarations([declared]);
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

  private async acceptLaunchPreflight(
    candidate: HostTargetCandidate,
    declared: WorkspaceAppDeclaration
  ): Promise<void> {
    const sourceKey = normalizeRepoPath(candidate.source);
    const approved = this.approvedLaunchPreflights.get(sourceKey);
    if (
      !approved ||
      normalizeRepoPath(approved.source) !== sourceKey ||
      approved.ref !== declared.ref
    ) {
      return;
    }

    const approval = await this.deps.approvalForDeclarations([declared]);
    if (approval.identityKeys.length > 0) this.deps.acceptPreapprovedTrust(approval.identityKeys);
    this.approvedLaunchPreflights.delete(sourceKey);
  }
}

function sameBuildProvider(
  left: AppBuildProviderDetails | null | undefined,
  right: AppBuildProviderDetails
): boolean {
  return (
    left?.name === right.name &&
    left.activeEv === right.activeEv &&
    left.activeBuildKey === right.activeBuildKey &&
    left.contractVersion === right.contractVersion
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
