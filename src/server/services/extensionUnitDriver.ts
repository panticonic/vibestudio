import type { ExtensionHost } from "@vibestudio/extension-host";
import type {
  RuntimeSupervisionDescription,
  RuntimeSupervisionLogRecord,
} from "@vibestudio/service-schemas/runtime";
import type { UnitDriver, UnitLogQuery } from "./unitSupervisor.js";

export function createExtensionUnitDriver(getHost: () => ExtensionHost | null): UnitDriver {
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
  const logs = (entityId: string, query?: UnitLogQuery): RuntimeSupervisionLogRecord[] =>
    host()
      .listWorkspaceUnitLogs(entityId, query)
      .map((entry) => ({
        identity: { kind: "extension", entityId },
        timestamp: entry.timestamp,
        level: entry.level,
        message: entry.message,
        ...(entry.fields ? { fields: entry.fields } : {}),
        source:
          entry.source === "ctx.log"
            ? ("structured" as const)
            : entry.source === "stdout" || entry.source === "stderr"
              ? entry.source
              : ("system" as const),
      }));
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
      const entries = logs(entityId, query);
      const errors = entries.filter((entry) => entry.level === "error");
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
        logs: entries,
        errors,
        dropped: { entries: 0, errors: 0 },
        capacity: { entries: entries.length, errors: errors.length },
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
        const row = host()
          .listWorkspaceUnits()
          .find((candidate) => candidate.name === releaseId || candidate.source === releaseId);
        if (!row) return { status: "unavailable", reason: `Unknown extension: ${releaseId}` };
        if (row.status === "pending-approval") return { status: "approval-required" };
        if (row.status === "building") {
          return { status: "preparing", reason: `${row.name} is building` };
        }
        if (row.status === "error" && !row.activeBundleKey) {
          return { status: "unavailable", reason: row.lastError ?? `${row.name} failed` };
        }
        await host().activate(row.name);
        const entity = describeRow(requireRow(row.name));
        return { status: "ready", entity };
      },
    },
  };
}
