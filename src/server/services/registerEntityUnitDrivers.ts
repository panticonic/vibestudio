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
  restartPanel(ctx: ServiceContext, entity: EntityRecord): Promise<void>;
  restartWorker(ctx: ServiceContext, entity: EntityRecord): Promise<void>;
  restartDurableObject(ctx: ServiceContext, entity: EntityRecord): Promise<void>;
  retire(ctx: ServiceContext, entity: EntityRecord): Promise<void>;
}): void {
  const history = (entity: EntityRecord, query?: UnitLogQuery) =>
    input.diagnostics.history(entity.id, query);
  const common = {
    entityCache: input.entityCache,
    history,
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
