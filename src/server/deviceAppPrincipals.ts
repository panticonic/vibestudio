import { contextIdForTargetKey } from "@vibestudio/shared/runtime/contextIdentity";
import { normalizeUnitRepoPath as normalizeRepoPath } from "@vibestudio/unit-host";
import { appArtifactRoute } from "@vibestudio/shared/appArtifacts";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { WorkspaceAppTarget } from "@vibestudio/shared/unitManifest";
import type { ActiveExecutionIdentity } from "./runtimeExecutionIdentity.js";
import type { AppBuildResultLike, AppRegistryEntry } from "./appHost.js";

interface DeviceAppPrincipalRegistry {
  list(): AppRegistryEntry[];
}

export interface DeviceAppPrincipalsDeps {
  workspaceId: string;
  registry: DeviceAppPrincipalRegistry;
  entityCache?: Pick<EntityCache, "resolve" | "listActive" | "_onActivate" | "_onRetire">;
  resolveActiveBuild(entry: AppRegistryEntry): Promise<{
    buildKey: string;
    build: AppBuildResultLike;
    identity: ActiveExecutionIdentity;
  }>;
}

/**
 * The exact app incarnation a device-scoped principal was activated for. A
 * client that runs the app on the device (the mobile native host, the
 * `vibestudio terminal` CLI) must run exactly these artifacts: connection
 * grants for the principal are bound to this execution identity.
 */
export interface DeviceAppPrincipal {
  principalId: string;
  appId: string;
  source: string;
  target: WorkspaceAppTarget;
  buildKey: string;
  effectiveVersion: string;
  artifacts: Array<{ path: string; role: string; contentType: string; route: string }>;
}

/**
 * Device-scoped principals for workspace apps that run on a client device.
 *
 * Each (app source, device) pair gets its own runtime principal
 * `app:<source>:<deviceId>` with its own context, so two devices running the
 * same app never share routed callbacks or ephemeral state. The principal is
 * activated from the app's current active build and carries that build's
 * sealed execution identity; capability checks resolve it back to the app
 * registry entry by source.
 */
export class DeviceAppPrincipals {
  constructor(private readonly deps: DeviceAppPrincipalsDeps) {}

  /**
   * Activate the device principal for the running app of `target` at `source`.
   * Returns null when no running build of that app exists.
   */
  async register(
    target: WorkspaceAppTarget,
    deviceId: string,
    source: string
  ): Promise<DeviceAppPrincipal | null> {
    const normalizedSource = normalizeRepoPath(source);
    if (!this.deps.entityCache) return null;
    const entry = this.deps.registry
      .list()
      .find(
        (candidate) =>
          candidate.target === target &&
          candidate.status === "running" &&
          !!candidate.activeEv &&
          !!candidate.activeBundleKey &&
          normalizeRepoPath(candidate.source.repo) === normalizedSource
      );
    if (!entry?.activeEv) return null;
    const activeBuild = await this.deps.resolveActiveBuild(entry);
    const principalId = this.activate(entry, entry.activeEv, deviceId, activeBuild);
    return {
      principalId,
      appId: entry.name,
      source: normalizedSource,
      target,
      buildKey: activeBuild.buildKey,
      effectiveVersion: entry.activeEv,
      artifacts: (activeBuild.build.artifacts ?? []).map((artifact) => ({
        path: artifact.path,
        role: artifact.role,
        contentType: artifact.contentType,
        route: appArtifactRoute(activeBuild.buildKey, artifact.path),
      })),
    };
  }

  /** Retire every device principal of one device. */
  retireDevice(deviceId: string): number {
    let retired = 0;
    for (const entry of this.deps.registry.list()) {
      if (this.retireEntity(deviceAppPrincipalId(entry.source.repo, deviceId))) retired++;
    }
    return retired;
  }

  /** Retire every device principal of one app (the app was undeclared). */
  retireForEntry(entry: AppRegistryEntry): void {
    if (!this.deps.entityCache) return;
    const prefix = `app:${normalizeRepoPath(entry.source.repo)}:`;
    for (const record of this.deps.entityCache.listActive()) {
      if (record.kind === "app" && record.id.startsWith(prefix)) this.retireEntity(record.id);
    }
  }

  private activate(
    entry: AppRegistryEntry,
    effectiveVersion: string,
    deviceId: string,
    activeBuild: { buildKey: string; identity: ActiveExecutionIdentity }
  ): string {
    const entityCache = this.deps.entityCache;
    if (!entityCache) {
      throw new Error("Cannot activate device-scoped app principal without an entity cache");
    }
    const sourceRepo = normalizeRepoPath(entry.source.repo);
    const principalId = deviceAppPrincipalId(sourceRepo, deviceId);
    const existing = entityCache.resolve(principalId);
    // The canonical derived-context format (`ctx-<32 hex>`): a valid context
    // folder and build ref, unlike a bare 64-hex digest.
    const contextId = contextIdForTargetKey(
      `${this.deps.workspaceId}\x00app-device\x00${sourceRepo}\x00${deviceId}`
    );
    const record: EntityRecord = {
      id: principalId,
      kind: "app",
      source: { repoPath: sourceRepo, effectiveVersion },
      activeBuildKey: activeBuild.buildKey,
      ...activeBuild.identity,
      contextId,
      key: principalId,
      createdAt: existing?.createdAt ?? Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    entityCache._onActivate(record);
    return principalId;
  }

  private retireEntity(id: string): boolean {
    const existing = this.deps.entityCache?.resolve(id);
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

export function deviceAppPrincipalId(repoPath: string, deviceId: string): string {
  return `app:${normalizeRepoPath(repoPath)}:${deviceId}`;
}
