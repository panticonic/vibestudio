import type {
  RuntimeSupervisionDescription,
  RuntimeSupervisionKind,
  RuntimeSupervisionLogRecord,
} from "@vibestudio/service-schemas/runtime";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { UnitDriver, UnitLogQuery } from "./unitSupervisor.js";

type EntityDriverKind = Extract<RuntimeSupervisionKind, "panel" | "worker" | "do">;

export function createEntityUnitDriver(input: {
  kind: EntityDriverKind;
  entityCache: Pick<EntityCache, "listActive" | "resolveActive">;
  hasInspector?(entityId: string): boolean;
  logs(entity: EntityRecord, query?: UnitLogQuery): RuntimeSupervisionLogRecord[];
  restart(ctx: ServiceContext, entity: EntityRecord): Promise<void> | void;
  retire(ctx: ServiceContext, entity: EntityRecord): Promise<void> | void;
}): UnitDriver {
  const resolve = (entityId: string): EntityRecord | null => {
    const record = input.entityCache.resolveActive(entityId);
    return record?.kind === input.kind ? record : null;
  };
  const describe = (record: EntityRecord): RuntimeSupervisionDescription => ({
    identity: { kind: input.kind, entityId: record.id },
    source: record.source.repoPath,
    status: record.error ? "error" : "running",
    lastError: record.error ?? null,
    artifact: {
      effectiveVersion: record.source.effectiveVersion,
      buildKey: record.activeBuildKey ?? null,
      executionDigest: record.activeExecutionDigest ?? null,
    },
    facets: {
      activation: false,
      release: false,
      inspector: input.hasInspector?.(record.id) ?? false,
    },
  });
  const requireEntity = (entityId: string): EntityRecord => {
    const entity = resolve(entityId);
    if (entity) return entity;
    throw Object.assign(
      new Error(`No active ${input.kind} runtime entity exists with id ${entityId}`),
      { code: "UNIT_ENTITY_NOT_FOUND" }
    );
  };
  return {
    kind: input.kind,
    list: () =>
      input.entityCache
        .listActive()
        .filter((record) => record.kind === input.kind)
        .map(describe),
    describe: (entityId) => {
      const record = resolve(entityId);
      return record ? describe(record) : null;
    },
    logs: (entityId, query) => input.logs(requireEntity(entityId), query),
    health: (entityId, query) => {
      const entity = requireEntity(entityId);
      const description = describe(entity);
      const logs = input.logs(entity, query);
      const errors = logs.filter((entry) => entry.level === "error");
      return {
        entity: description,
        state: entity.error ? "unhealthy" : "healthy",
        summary: entity.error ?? null,
        logs,
        errors,
        dropped: { entries: 0, errors: 0 },
        capacity: { entries: logs.length, errors: errors.length },
      };
    },
    restart: (ctx, entityId) => input.restart(ctx, requireEntity(entityId)),
    retire: (ctx, entityId) => input.retire(ctx, requireEntity(entityId)),
  };
}
