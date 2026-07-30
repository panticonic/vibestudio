import type { AppHost } from "../appHost.js";
import type {
  RuntimeSupervisionDescription,
  RuntimeSupervisionLogRecord,
  RuntimeSupervisionReleaseVersion,
} from "@vibestudio/service-schemas/runtime";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { UnitDriver, UnitLogQuery } from "./unitSupervisor.js";

export function createAppUnitDriver(input: {
  getHost(): AppHost | null;
  entityCache: Pick<EntityCache, "listActive" | "resolveActive">;
}): UnitDriver {
  const host = () => {
    const value = input.getHost();
    if (!value) throw new Error("App runtime is not available");
    return value;
  };
  const activeRecords = () => input.entityCache.listActive().filter((row) => row.kind === "app");
  const rowFor = (entityId: string) =>
    host()
      .listWorkspaceUnits()
      .find((row) => row.name === entityId);
  const describe = (entityId: string): RuntimeSupervisionDescription | null => {
    const record = input.entityCache.resolveActive(entityId);
    if (record?.kind !== "app") return null;
    const row = rowFor(entityId);
    return {
      identity: { kind: "app", entityId },
      source: record.source.repoPath,
      ...(row?.displayName ? { displayName: row.displayName } : {}),
      status: row?.lastError ? "error" : "running",
      lastError: row?.lastError ?? record.error ?? null,
      artifact: {
        effectiveVersion: record.source.effectiveVersion,
        buildKey: record.activeBuildKey ?? null,
        executionDigest: record.activeExecutionDigest ?? null,
      },
      facets: { activation: true, release: true, inspector: false },
    };
  };
  const requireDescription = (entityId: string) => {
    const value = describe(entityId);
    if (value) return value;
    throw Object.assign(new Error(`No active app runtime exists with id ${entityId}`), {
      code: "UNIT_ENTITY_NOT_FOUND",
    });
  };
  const logs = (entityId: string, _query?: UnitLogQuery): RuntimeSupervisionLogRecord[] =>
    host()
      .listWorkspaceUnitLogs(entityId)
      .map((entry) => ({
        identity: { kind: "app", entityId },
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        source: "runner" as const,
      }));
  const releaseVersion = (
    releaseId: string,
    value: ReturnType<AppHost["listAppVersions"]>["previous"][number]
  ): RuntimeSupervisionReleaseVersion => ({
    releaseId,
    version: value.version,
    buildKey: value.activeBundleKey,
    effectiveVersion: value.activeEv,
    activatedAt: value.activatedAt,
  });
  return {
    kind: "app",
    list: () =>
      activeRecords()
        .map((record) => describe(record.id))
        .filter((entry): entry is RuntimeSupervisionDescription => entry !== null),
    describe,
    logs: (entityId, query) => {
      requireDescription(entityId);
      return logs(entityId, query);
    },
    health: (entityId, query) => {
      const entity = requireDescription(entityId);
      const entries = logs(entityId, query);
      const errors = entries.filter((entry) => entry.level === "error");
      return {
        entity,
        state: entity.lastError ? "unhealthy" : "healthy",
        summary: entity.lastError,
        logs: entries,
        errors,
        dropped: { entries: 0, errors: 0 },
        capacity: { entries: entries.length, errors: errors.length },
      };
    },
    restart: (_ctx, entityId) => host().restart(requireDescription(entityId).identity.entityId),
    retire: (_ctx, entityId) => host().retire(requireDescription(entityId).identity.entityId),
    releases: {
      versions: (releaseId) => {
        const versions = host().listAppVersions(releaseId);
        return {
          current: versions.current ? releaseVersion(releaseId, versions.current) : null,
          previous: versions.previous.map((value) => releaseVersion(releaseId, value)),
          retentionLimit: versions.retentionLimit,
        };
      },
      rollback: async (_ctx, releaseId, buildKey) => {
        const entry = await host().rollbackAppVersion(releaseId, buildKey);
        if (!entry.activeBundleKey) {
          throw new Error(`Rolled-back app ${releaseId} has no active build`);
        }
        return { releaseId, activeBuildKey: entry.activeBundleKey };
      },
    },
    activation: {
      activate: async (_ctx, releaseId) => {
        const row = rowFor(releaseId);
        if (!row) return { status: "unavailable", reason: `Unknown app: ${releaseId}` };
        if (row.status === "pending-approval") return { status: "approval-required" };
        if (row.status === "building") {
          return { status: "preparing", reason: `${row.name} is building` };
        }
        if (!row.activeBundleKey) {
          return { status: "unavailable", reason: row.lastError ?? `${row.name} has no build` };
        }
        await host().activateRelease(row.name);
        return { status: "ready", entity: requireDescription(row.name) };
      },
      prepare: async (_ctx, releaseId, ref) => {
        const prepared = await host().prepareRelease(releaseId, ref);
        return {
          releaseId: prepared.appId,
          buildKey: prepared.buildKey,
          effectiveVersion: prepared.effectiveVersion,
        };
      },
    },
  };
}
