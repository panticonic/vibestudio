import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServiceContainer } from "@vibestudio/shared/serviceContainer";
import { assertPresent } from "../../lintHelpers";
import type { BuildSystemV2 } from "../buildV2/index.js";
import { RuntimeDiagnosticsStore, type RuntimeDiagnosticKind } from "../runtimeDiagnosticsStore.js";
import { createPanelLogService } from "../services/panelLogService.js";
import { createWorkerLogService } from "../services/workerLogService.js";
import type { WorkspaceUnitLogRecord } from "../services/workspaceService.js";

export interface RuntimeObservabilityBootstrapDeps {
  container: Pick<ServiceContainer, "registerManaged" | "registerRpc" | "get" | "has">;
  statePath: string;
  workspaceId: string;
  eventService: Pick<EventService, "emit">;
}

/**
 * Register the server's runtime-observability pipeline in dependency order.
 *
 * The diagnostics store is the single sink for build lifecycle, worker console,
 * and panel console records. Only the build bridge has a lifecycle dependency;
 * the two log services are direct RPC ingress points into the same store.
 */
export function wireRuntimeObservability(
  deps: RuntimeObservabilityBootstrapDeps
): RuntimeDiagnosticsStore {
  const diagnostics = new RuntimeDiagnosticsStore({ statePath: deps.statePath });

  deps.container.registerManaged({
    name: "buildDiagnosticsBridge",
    dependencies: ["buildSystem"],
    start: async (resolve) => {
      const buildSystem = assertPresent(resolve<BuildSystemV2>("buildSystem"));
      const kindMap: Record<string, RuntimeDiagnosticKind> = {
        panel: "panel",
        worker: "worker",
        extension: "extension",
        app: "app",
      };
      return buildSystem.onBuildEvent((event) => {
        if (event.type === "build-started") return;
        const node = buildSystem.getGraph().tryGet(event.name);
        const kind = kindMap[node?.kind ?? ""] ?? "worker";
        const entityId = node?.kind === "worker" ? (node.relativePath ?? event.name) : event.name;
        diagnostics.record({
          workspaceId: deps.workspaceId,
          entityId,
          kind,
          level: event.type === "build-error" ? "error" : "info",
          message:
            event.type === "build-error"
              ? `Build failed: ${event.error ?? "unknown error"}`
              : `Build complete (${event.buildKey ?? "no key"})`,
          source: "lifecycle",
          fields: {
            buildEvent: event.type,
            ...(event.buildKey ? { buildKey: event.buildKey } : {}),
            ...(event.trigger
              ? { head: event.trigger.head, stateHash: event.trigger.stateHash }
              : {}),
          },
        });
      });
    },
    stop: async (unsubscribe: () => void) => {
      unsubscribe?.();
    },
  });

  deps.container.registerRpc(
    createWorkerLogService({
      onLog: (entry) => {
        if (!entry.source) return;
        diagnostics.record({
          workspaceId: deps.workspaceId,
          entityId: entry.callerId,
          kind: entry.callerId.startsWith("do:") ? "do" : "worker",
          timestamp: entry.timestamp,
          level: entry.level === "warn" ? "warn" : entry.level,
          message: entry.message,
          source: "console",
          fields: { source: entry.source },
        });
        diagnostics.record({
          workspaceId: deps.workspaceId,
          entityId: entry.source,
          kind: "worker",
          timestamp: entry.timestamp,
          level: entry.level === "warn" ? "warn" : entry.level,
          message: entry.message,
          source: "console",
          fields: { callerId: entry.callerId },
        });
        deps.eventService.emit("workspace:unit-log", {
          workspaceId: deps.workspaceId,
          unitName: entry.source,
          kind: "worker",
          timestamp: entry.timestamp,
          level: entry.level,
          message: entry.message,
          source: "console",
        } satisfies WorkspaceUnitLogRecord);
      },
    })
  );

  deps.container.registerRpc(
    createPanelLogService({
      onRecords: (records) => {
        const buildSystem = deps.container.has("buildSystem")
          ? deps.container.get<BuildSystemV2>("buildSystem")
          : null;
        for (const entry of records) {
          const node = buildSystem
            ?.getGraph()
            .allNodes()
            .find((candidate) => candidate.relativePath === entry.unitSource);
          const entityId = node?.name ?? entry.unitSource;
          diagnostics.record({
            workspaceId: deps.workspaceId,
            entityId,
            kind: "panel",
            timestamp: entry.timestamp,
            level: entry.level,
            message: entry.message,
            source: entry.source,
            fields: { panelId: entry.panelId, ...entry.fields },
            url: entry.url,
            line: entry.line,
          });
          deps.eventService.emit("workspace:unit-log", {
            workspaceId: deps.workspaceId,
            unitName: entityId,
            kind: "panel",
            timestamp: entry.timestamp,
            level: entry.level,
            message: entry.message,
            source: entry.source === "lifecycle" ? "console" : entry.source,
          } satisfies WorkspaceUnitLogRecord);
        }
      },
    })
  );

  return diagnostics;
}
