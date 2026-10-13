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
  diagnostics: Pick<RuntimeDiagnosticsStore, "history">,
  workspaceLabel = "unknown"
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
              ? "unhealthy"
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
    reportReady: (ctx, _entityId, report) => host().reportActivation(ctx, report),
    reportHealth: (ctx, _entityId, report) => host().reportHealth(ctx, report.state, report.detail),
    appendLog: (ctx, _entityId, report) =>
      host().appendRuntimeLog(ctx, report.level, report.message, report.fields),
    activation: {
      activate: async (_ctx, releaseId) => {
        console.info("[RuntimeSupervision] Extension activation", {
          phase: "start",
          workspace: workspaceLabel,
          releaseId,
        });
        // A declared host prerequisite may be dormant until its first launch.
        // Stage that declaration before consulting the runtime registry.
        const runtimeHost = host();
        let phase = "ensure-declaration";
        try {
          await ensureDeclaration(releaseId);
          const rows = await runtimeHost.listWorkspaceUnits();
          console.info("[RuntimeSupervision] Extension activation", {
            phase: "declaration-staged",
            workspace: workspaceLabel,
            releaseId,
            units: rows
              .filter((candidate) => candidate.name === releaseId || candidate.source === releaseId)
              .map(({ name, source, status }) => ({ name, source, status })),
          });
          const row = rows.find(
            (candidate) => candidate.name === releaseId || candidate.source === releaseId
          );
          if (!row) return { status: "unavailable", reason: `Unknown extension: ${releaseId}` };
          phase = "ensure-activation";
          await runtimeHost.ensureActivated(row.name);
          const processRunningAtActivationSettlement = runtimeHost.processes.isRunning(row.name);
          const afterActivation = await runtimeHost.listWorkspaceUnits();
          console.info("[RuntimeSupervision] Extension activation", {
            phase: "activation-settled",
            workspace: workspaceLabel,
            releaseId,
            units: afterActivation
              .filter((candidate) => candidate.name === row.name)
              .map(({ name, source, status }) => ({ name, source, status })),
            processRunningAtActivationSettlement,
            processRunningAfterProjection: runtimeHost.processes.isRunning(row.name),
          });
          phase = "require-running-row";
          const entity = describeRow(await requireRow(row.name));
          return { status: "ready", entity };
        } catch (error) {
          const candidate = (
            await runtimeHost
              .listWorkspaceUnits()
              .catch(() => [] as Awaited<ReturnType<typeof runtimeHost.listWorkspaceUnits>>)
          ).find((item) => item.name === releaseId || item.source === releaseId);
          console.error("[RuntimeSupervision] Extension activation failed", {
            phase,
            workspace: workspaceLabel,
            releaseId,
            unit: candidate
              ? { name: candidate.name, source: candidate.source, status: candidate.status }
              : null,
            processRunning: candidate ? runtimeHost.processes.isRunning(candidate.name) : null,
            errorType: error instanceof Error ? error.name : typeof error,
            errorCode:
              error && typeof error === "object" && "code" in error
                ? String((error as { code: unknown }).code)
                : null,
          });
          throw error;
        }
      },
    },
  };
}
