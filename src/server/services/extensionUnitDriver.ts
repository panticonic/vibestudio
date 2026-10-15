import type { ExtensionHost } from "@vibestudio/extension-host";
import type {
  RuntimeSupervisionDescription,
  RuntimeSupervisionLogRecord,
  RuntimeSupervisionReleaseVersion,
} from "@vibestudio/service-schemas/runtime";
import type { UnitDriver, UnitLogQuery } from "./unitSupervisor.js";
import type { RuntimeDiagnosticsStore } from "../runtimeDiagnosticsStore.js";
import { runtimeDiagnosticHistory } from "./runtimeDiagnosticProjection.js";

export function createExtensionUnitDriver(
  getHost: () => ExtensionHost | null,
  ensureDeclaration: (releaseId: string) => Promise<void>,
  diagnostics: Pick<RuntimeDiagnosticsStore, "history">
): UnitDriver {
  const host = () => {
    const value = getHost();
    if (!value) throw new Error("Extension runtime is not available");
    return value;
  };
  const rows = async () =>
    (await host().listWorkspaceUnits()).filter((row) => row.status === "running");
  const describeRow = (
    row: Awaited<ReturnType<typeof rows>>[number]
  ): RuntimeSupervisionDescription => ({
    identity: { kind: "extension", entityId: row.name },
    release: { kind: "extension", releaseId: row.name },
    source: row.source,
    displayName: row.displayName,
    // A running extension with an error is still running its adopted build; the
    // error belongs to a newer build that was not adopted.
    status: "running",
    lastError: row.lastError,
    artifact: {
      effectiveVersion: row.activeEv ?? row.ev ?? null,
      buildKey: row.activeBundleKey ?? null,
      executionDigest: row.activeRuntimeDepsKey ?? null,
    },
    facets: {
      activation: true,
      release: true,
      inspector: row.inspectorUrl !== null,
    },
  });
  const requireRow = async (entityId: string) => {
    const row = (await rows()).find((candidate) => candidate.name === entityId);
    if (row) return row;
    throw Object.assign(new Error(`No active extension runtime exists with id ${entityId}`), {
      code: "UNIT_ENTITY_NOT_FOUND",
    });
  };
  const history = (entityId: string, query?: UnitLogQuery) => diagnostics.history(entityId, query);
  const logs = (entityId: string, query?: UnitLogQuery): RuntimeSupervisionLogRecord[] => {
    return runtimeDiagnosticHistory({ kind: "extension", entityId }, history(entityId, query)).logs;
  };
  return {
    kind: "extension",
    list: async () => (await rows()).map(describeRow),
    describe: async (entityId) => {
      const row = (await rows()).find((candidate) => candidate.name === entityId);
      return row ? describeRow(row) : null;
    },
    logs: (entityId, query) => {
      return requireRow(entityId).then(() => logs(entityId, query));
    },
    health: async (entityId, query) => {
      const row = await requireRow(entityId);
      const description = describeRow(row);
      const snapshot = runtimeDiagnosticHistory(
        { kind: "extension", entityId },
        history(entityId, query)
      );
      const reported =
        row.health && typeof row.health === "object" && "state" in row.health
          ? String((row.health as { state?: unknown }).state)
          : null;
      return {
        entity: description,
        state:
          reported === "healthy" || reported === "degraded" || reported === "unhealthy"
            ? reported
            : row.lastError
              ? "degraded"
              : "unknown",
        summary: row.lastError,
        logs: snapshot.logs,
        errors: snapshot.errors,
        dropped: snapshot.dropped,
        capacity: snapshot.capacity,
      };
    },
    restart: async (ctx, entityId) => host().reload(ctx, (await requireRow(entityId)).name),
    retire: async (_ctx, entityId) => host().retire((await requireRow(entityId)).name),
    // Lifecycle reports originate from the starting child itself. The
    // ExtensionHost owns that generation and validates it against its process
    // table; the supervisor's public list intentionally contains only ready
    // entities, so using that projection here creates a startup deadlock.
    releases: {
      versions: (releaseId) => {
        const versions = host().listVersions(releaseId);
        const version = (
          value: NonNullable<typeof versions.current>
        ): RuntimeSupervisionReleaseVersion => ({
          releaseId,
          version: value.version,
          buildKey: value.activeBundleKey,
          effectiveVersion: value.activeEv,
          activatedAt: value.activatedAt,
        });
        return {
          current: versions.current ? version(versions.current) : null,
          previous: versions.previous.map(version),
          retentionLimit: versions.retentionLimit,
        };
      },
      rollback: async (_ctx, releaseId, buildKey) => {
        const entry = await host().rollback(releaseId, buildKey);
        if (!entry.activeBundleKey) {
          throw new Error(`Rolled-back extension ${releaseId} has no active build`);
        }
        return { releaseId, activeBuildKey: entry.activeBundleKey };
      },
    },
    reportReady: (ctx, _entityId, report) => host().reportActivation(ctx, report),
    reportHealth: (ctx, _entityId, report) => host().reportHealth(ctx, report.state, report.detail),
    appendLog: (ctx, _entityId, report) =>
      host().appendRuntimeLog(ctx, report.level, report.message, report.fields),
    activation: {
      activate: async (_ctx, releaseId) => {
        // A declared host prerequisite may be dormant until its first launch.
        // Stage that declaration before consulting the runtime registry.
        await ensureDeclaration(releaseId);
        const row = (await host().listWorkspaceUnits()).find(
          (candidate) => candidate.name === releaseId || candidate.source === releaseId
        );
        if (!row) return { status: "unavailable", reason: `Unknown extension: ${releaseId}` };
        await host().ensureActivated(row.name);
        const entity = describeRow(await requireRow(row.name));
        return { status: "ready", entity };
      },
    },
  };
}
