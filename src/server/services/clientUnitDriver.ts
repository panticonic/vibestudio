import type { ClientHost } from "../clients/clientRegistry.js";
import { isCapabilityActiveStatus } from "../clients/clientRegistry.js";
import type {
  RuntimeSupervisionDescription,
  RuntimeSupervisionLogRecord,
  RuntimeSupervisionReleaseVersion,
} from "@vibestudio/service-schemas/runtime";
import type { UnitDriver, UnitLogQuery } from "./unitSupervisor.js";
import type { RuntimeDiagnosticsStore } from "../runtimeDiagnosticsStore.js";
import { runtimeDiagnosticHistory } from "./runtimeDiagnosticProjection.js";

/**
 * Supervision of clients (§4.8). A client runs on devices, not on the server,
 * so its supervised identity is its release: the registry entry and the build
 * every host is told to run. Its per-device principals are not units.
 */
export function createClientUnitDriver(input: {
  getHost(): ClientHost | null;
  diagnostics: Pick<RuntimeDiagnosticsStore, "history">;
}): UnitDriver {
  const host = () => {
    const value = input.getHost();
    if (!value) throw new Error("Clients run only from the System workspace");
    return value;
  };
  // A workspace without a ClientHost holds no clients: nothing to list or describe.
  const describe = (entityId: string): RuntimeSupervisionDescription | null => {
    const clients = input.getHost();
    if (!clients) return null;
    const row = clients.listWorkspaceUnits().find((candidate) => candidate.name === entityId);
    if (!row || !isCapabilityActiveStatus(row.status) || !row.activeBundleKey) return null;
    const entry = clients.registry.get(entityId);
    return {
      identity: { kind: "client", entityId },
      release: { kind: "client", releaseId: entityId },
      source: row.source,
      ...(row.displayName ? { displayName: row.displayName } : {}),
      // A client with a recorded error still runs its adopted build; the error
      // belongs to a newer build that was not adopted.
      status: "running",
      lastError: row.lastError,
      artifact: {
        effectiveVersion: row.activeEv,
        buildKey: row.activeBundleKey,
        executionDigest: entry?.activeExecutionDigest ?? null,
      },
      facets: { activation: true, release: true, inspector: false },
    };
  };
  const requireDescription = (entityId: string) => {
    const value = describe(entityId);
    if (value) return value;
    throw Object.assign(new Error(`No running client exists with id ${entityId}`), {
      code: "UNIT_ENTITY_NOT_FOUND",
    });
  };
  const logs = (entityId: string, query?: UnitLogQuery): RuntimeSupervisionLogRecord[] => {
    requireDescription(entityId);
    return runtimeDiagnosticHistory(
      { kind: "client", entityId },
      input.diagnostics.history(entityId, query)
    ).logs;
  };
  const releaseVersion = (
    releaseId: string,
    value: ReturnType<ClientHost["listClientVersions"]>["previous"][number]
  ): RuntimeSupervisionReleaseVersion => ({
    releaseId,
    version: value.version,
    buildKey: value.activeBundleKey,
    effectiveVersion: value.activeEv,
    activatedAt: value.activatedAt,
  });
  return {
    kind: "client",
    list: () =>
      (input.getHost()?.listWorkspaceUnits() ?? [])
        .map((row) => describe(row.name))
        .filter((entry): entry is RuntimeSupervisionDescription => entry !== null),
    describe,
    logs,
    health: (entityId, query) => {
      const entity = requireDescription(entityId);
      const snapshot = runtimeDiagnosticHistory(
        { kind: "client", entityId },
        input.diagnostics.history(entityId, query)
      );
      return {
        entity,
        state: entity.lastError ? "degraded" : "healthy",
        summary: entity.lastError,
        logs: snapshot.logs,
        errors: snapshot.errors,
        dropped: snapshot.dropped,
        capacity: snapshot.capacity,
      };
    },
    // Hosts restart their running instances when the current build is
    // announced again; each host applies its own policy (§4.6).
    restart: (_ctx, entityId) => host().reannounce(requireDescription(entityId).identity.entityId),
    retire: (_ctx, entityId) => host().retire(requireDescription(entityId).identity.entityId),
    releases: {
      versions: (releaseId) => {
        const versions = host().listClientVersions(releaseId);
        return {
          current: versions.current ? releaseVersion(releaseId, versions.current) : null,
          previous: versions.previous.map((value) => releaseVersion(releaseId, value)),
          retentionLimit: versions.retentionLimit,
        };
      },
      rollback: async (_ctx, releaseId, buildKey) => {
        const entry = await host().rollbackClientVersion(releaseId, buildKey);
        if (!entry.activeBundleKey) {
          throw new Error(`Rolled-back client ${releaseId} has no active build`);
        }
        return { releaseId, activeBuildKey: entry.activeBundleKey };
      },
    },
    activation: {
      activate: async (_ctx, releaseId) => {
        // An unreviewed client has its review open by now; the host shows it
        // and activates again once it resolves.
        if ((await host().ensureActivated(releaseId)) === "approval-required") {
          return { status: "approval-required" };
        }
        return { status: "ready", entity: requireDescription(releaseId) };
      },
      prepare: async (_ctx, releaseId, ref) => {
        const prepared = await host().prepareRelease(releaseId, ref);
        return {
          releaseId: prepared.clientName,
          buildKey: prepared.buildKey,
          effectiveVersion: prepared.effectiveVersion,
        };
      },
    },
  };
}
