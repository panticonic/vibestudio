import type { ExtensionHost } from "@vibestudio/extension-host";
import type {
  RuntimeSupervisionDescription,
  RuntimeSupervisionLogRecord,
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
  const rows = () =>
    host()
      .listWorkspaceUnits()
      .filter((row) => row.status === "running");
  const describeRow = (row: ReturnType<typeof rows>[number]): RuntimeSupervisionDescription => ({
    identity: { kind: "extension", entityId: row.name },
    release: { kind: "extension", releaseId: row.name },
    source: row.source,
    displayName: row.displayName,
    status: row.lastError ? "error" : "running",
    lastError: row.lastError,
    artifact: {
      effectiveVersion: row.activeEv ?? row.ev ?? null,
      buildKey: row.activeBundleKey ?? null,
      executionDigest: row.activeRuntimeDepsKey ?? null,
    },
    facets: {
      activation: true,
      release: false,
      inspector: row.inspectorUrl !== null,
    },
  });
  const requireRow = (entityId: string) => {
    const row = rows().find((candidate) => candidate.name === entityId);
    if (row) return row;
    throw Object.assign(new Error(`No active extension runtime exists with id ${entityId}`), {
      code: "UNIT_ENTITY_NOT_FOUND",
    });
  };
  const history = (entityId: string, query?: UnitLogQuery) => diagnostics.history(entityId, query);
  const logs = (entityId: string, query?: UnitLogQuery): RuntimeSupervisionLogRecord[] => {
    requireRow(entityId);
    return runtimeDiagnosticHistory({ kind: "extension", entityId }, history(entityId, query)).logs;
  };
  return {
    kind: "extension",
    list: () => rows().map(describeRow),
    describe: (entityId) => {
      const row = rows().find((candidate) => candidate.name === entityId);
      return row ? describeRow(row) : null;
    },
    logs: (entityId, query) => {
      requireRow(entityId);
      return logs(entityId, query);
    },
    health: (entityId, query) => {
      const row = requireRow(entityId);
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
              ? "unhealthy"
              : "unknown",
        summary: row.lastError,
        logs: snapshot.logs,
        errors: snapshot.errors,
        dropped: snapshot.dropped,
        capacity: snapshot.capacity,
      };
    },
    restart: (ctx, entityId) => host().reload(ctx, requireRow(entityId).name),
    retire: (_ctx, entityId) => host().retire(requireRow(entityId).name),
    // Lifecycle reports originate from the starting child itself. The
    // ExtensionHost owns that generation and validates it against its process
    // table; the supervisor's public list intentionally contains only ready
    // entities, so using that projection here creates a startup deadlock.
    reportReady: (ctx, _entityId, report) => host().reportActivation(ctx, report),
    reportHealth: (ctx, _entityId, report) => host().reportHealth(ctx, report.state, report.detail),
    appendLog: (ctx, _entityId, report) =>
      host().appendRuntimeLog(ctx, report.level, report.message, report.fields),
    activation: {
      activate: async (_ctx, releaseId) => {
        // A declared host prerequisite may be dormant until its first launch.
        // Stage that declaration before consulting the runtime registry.
        await ensureDeclaration(releaseId);
        const row = host()
          .listWorkspaceUnits()
          .find((candidate) => candidate.name === releaseId || candidate.source === releaseId);
        if (!row) return { status: "unavailable", reason: `Unknown extension: ${releaseId}` };
        await host().ensureActivated(row.name);
        const entity = describeRow(requireRow(row.name));
        return { status: "ready", entity };
      },
    },
  };
}
