import type { RuntimeSupervisionLogRecord } from "@vibestudio/service-schemas/runtime";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { RuntimeDiagnosticsStore } from "../runtimeDiagnosticsStore.js";
import { createEntityUnitDriver } from "./entityUnitDriver.js";
import type { UnitLogQuery, UnitSupervisor } from "./unitSupervisor.js";

export function registerEntityUnitDrivers(input: {
  supervisor: UnitSupervisor;
  entityCache: EntityCache;
  diagnostics: RuntimeDiagnosticsStore;
  titleFor(entityId: string): string | undefined;
  restartPanel(ctx: ServiceContext, entity: EntityRecord): Promise<void>;
  restartWorker(ctx: ServiceContext, entity: EntityRecord): Promise<void>;
  restartDurableObject(ctx: ServiceContext, entity: EntityRecord): Promise<void>;
  retire(ctx: ServiceContext, entity: EntityRecord): Promise<void>;
}): void {
  const logs = (entity: EntityRecord, query?: UnitLogQuery): RuntimeSupervisionLogRecord[] => {
    const exact = input.diagnostics.history(entity.id, query);
    const history =
      exact.entries.length > 0 ? exact : input.diagnostics.history(entity.source.repoPath, query);
    return history.entries.map((entry) => ({
      identity: { kind: entity.kind as "panel" | "worker" | "do", entityId: entity.id },
      timestamp: entry.timestamp,
      level: entry.level,
      message: entry.message,
      ...(entry.fields ? { fields: entry.fields } : {}),
      ...(entry.source
        ? {
            source:
              entry.source === "ctx.log"
                ? ("structured" as const)
                : entry.source === "system" ||
                    entry.source === "console" ||
                    entry.source === "lifecycle"
                  ? entry.source
                  : entry.source === "stdout" || entry.source === "stderr"
                    ? entry.source
                    : ("structured" as const),
          }
        : {}),
      ...(entry.seq === undefined ? {} : { seq: entry.seq }),
    }));
  };
  const common = {
    entityCache: input.entityCache,
    titleFor: input.titleFor,
    logs,
    retire: input.retire,
  };
  input.supervisor.register(
    createEntityUnitDriver({ ...common, kind: "panel", restart: input.restartPanel })
  );
  input.supervisor.register(
    createEntityUnitDriver({ ...common, kind: "worker", restart: input.restartWorker })
  );
  input.supervisor.register(
    createEntityUnitDriver({ ...common, kind: "do", restart: input.restartDurableObject })
  );
}
