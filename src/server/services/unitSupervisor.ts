import type {
  RuntimeSupervisionDescription,
  RuntimeSupervisionActivationKey,
  RuntimeSupervisionActivationResult,
  RuntimeSupervisionPreparedRelease,
  RuntimeSupervisionEntityKey,
  RuntimeSupervisionHealth,
  RuntimeSupervisionKind,
  RuntimeSupervisionLogRecord,
  RuntimeSupervisionLogReport,
  RuntimeSupervisionHealthReport,
  RuntimeSupervisionReadyReport,
  RuntimeSupervisionReleaseKey,
  RuntimeSupervisionReleaseVersions,
  RuntimeSupervisionTarget,
} from "@vibestudio/service-schemas/runtime";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";

export interface UnitLogQuery {
  since?: number;
  sinceSeq?: number;
  level?: RuntimeSupervisionLogRecord["level"];
  limit?: number;
  errorLimit?: number;
}

export interface UnitReleaseDriver {
  versions(
    releaseId: string
  ): Promise<RuntimeSupervisionReleaseVersions> | RuntimeSupervisionReleaseVersions;
  rollback(
    ctx: ServiceContext,
    releaseId: string,
    buildKey?: string
  ):
    | Promise<{ releaseId: string; activeBuildKey: string }>
    | { releaseId: string; activeBuildKey: string };
}

export interface UnitActivationDriver {
  activate(
    ctx: ServiceContext,
    releaseId: string
  ): Promise<RuntimeSupervisionActivationResult> | RuntimeSupervisionActivationResult;
  prepare?(
    ctx: ServiceContext,
    releaseId: string,
    ref: string
  ): Promise<RuntimeSupervisionPreparedRelease> | RuntimeSupervisionPreparedRelease;
}

/**
 * One executable-kind adapter. Kind mechanics stay in the adapter; the
 * supervisor only indexes exact identities and delegates the common contract.
 */
export interface UnitDriver {
  readonly kind: RuntimeSupervisionKind;
  list(): Promise<RuntimeSupervisionDescription[]> | RuntimeSupervisionDescription[];
  describe(
    entityId: string
  ): Promise<RuntimeSupervisionDescription | null> | RuntimeSupervisionDescription | null;
  health(
    entityId: string,
    query?: UnitLogQuery
  ): Promise<RuntimeSupervisionHealth> | RuntimeSupervisionHealth;
  logs(
    entityId: string,
    query?: UnitLogQuery
  ): Promise<RuntimeSupervisionLogRecord[]> | RuntimeSupervisionLogRecord[];
  restart(ctx: ServiceContext, entityId: string): Promise<void> | void;
  retire(ctx: ServiceContext, entityId: string): Promise<void> | void;
  reportReady?(
    ctx: ServiceContext,
    entityId: string,
    report: RuntimeSupervisionReadyReport
  ): Promise<void> | void;
  reportHealth?(
    ctx: ServiceContext,
    entityId: string,
    report: RuntimeSupervisionHealthReport
  ): Promise<void> | void;
  appendLog?(
    ctx: ServiceContext,
    entityId: string,
    report: RuntimeSupervisionLogReport
  ): Promise<void> | void;
  readonly releases?: UnitReleaseDriver;
  readonly activation?: UnitActivationDriver;
}

export class UnitSupervisor {
  private readonly drivers = new Map<RuntimeSupervisionKind, UnitDriver>();

  register(driver: UnitDriver): void {
    if (this.drivers.has(driver.kind)) {
      throw new Error(`Unit driver already registered for ${driver.kind}`);
    }
    this.drivers.set(driver.kind, driver);
  }

  async list(kind?: RuntimeSupervisionKind): Promise<RuntimeSupervisionDescription[]> {
    const drivers = kind ? [this.requireDriver(kind)] : [...this.drivers.values()];
    return (await Promise.all(drivers.map((driver) => driver.list())))
      .flat()
      .sort((left, right) =>
        `${left.identity.kind}:${left.identity.entityId}`.localeCompare(
          `${right.identity.kind}:${right.identity.entityId}`
        )
      );
  }

  async describe(target: RuntimeSupervisionTarget): Promise<RuntimeSupervisionDescription[]> {
    if ("entityId" in target) {
      const entity = await this.requireDriver(target.kind).describe(target.entityId);
      return entity ? [entity] : [];
    }
    return (await this.list(target.kind)).filter(
      (entity) =>
        entity.release?.kind === target.kind && entity.release.releaseId === target.releaseId
    );
  }

  health(key: RuntimeSupervisionEntityKey, query?: UnitLogQuery) {
    return this.requireDriver(key.kind).health(key.entityId, query);
  }

  async logs(
    target: RuntimeSupervisionTarget,
    query?: UnitLogQuery
  ): Promise<RuntimeSupervisionLogRecord[]> {
    if ("entityId" in target) {
      return await this.requireDriver(target.kind).logs(target.entityId, query);
    }
    const entities = await this.describe(target);
    if (entities.length === 0) {
      throw Object.assign(
        new Error(`No live ${target.kind} entity belongs to release ${target.releaseId}`),
        { code: "UNIT_ENTITY_NOT_FOUND" }
      );
    }
    const records = (
      await Promise.all(
        entities.map(({ identity }) =>
          this.requireDriver(identity.kind).logs(identity.entityId, query)
        )
      )
    )
      .flat()
      .sort((left, right) => left.timestamp - right.timestamp);
    return query?.limit === undefined ? records : records.slice(-query.limit);
  }

  async restart(ctx: ServiceContext, key: RuntimeSupervisionEntityKey): Promise<void> {
    await this.requireDriver(key.kind).restart(ctx, key.entityId);
  }

  async retire(ctx: ServiceContext, key: RuntimeSupervisionEntityKey): Promise<void> {
    await this.requireDriver(key.kind).retire(ctx, key.entityId);
  }

  async activate(
    ctx: ServiceContext,
    key: RuntimeSupervisionActivationKey
  ): Promise<RuntimeSupervisionActivationResult> {
    const activation = this.requireDriver(key.kind).activation;
    if (!activation) throw this.unsupportedReport(key.kind, "activation");
    return await activation.activate(ctx, key.releaseId);
  }

  async prepare(
    ctx: ServiceContext,
    key: RuntimeSupervisionActivationKey,
    ref: string
  ): Promise<RuntimeSupervisionPreparedRelease> {
    const activation = this.requireDriver(key.kind).activation;
    if (!activation?.prepare) throw this.unsupportedReport(key.kind, "release preparation");
    return await activation.prepare(ctx, key.releaseId, ref);
  }

  async reportReady(ctx: ServiceContext, report: RuntimeSupervisionReadyReport): Promise<void> {
    const { driver, entityId } = this.callerDriver(ctx);
    if (!driver.reportReady) throw this.unsupportedReport(driver.kind, "activation");
    await driver.reportReady(ctx, entityId, report);
  }

  async reportHealth(ctx: ServiceContext, report: RuntimeSupervisionHealthReport): Promise<void> {
    const { driver, entityId } = this.callerDriver(ctx);
    if (!driver.reportHealth) throw this.unsupportedReport(driver.kind, "health");
    await driver.reportHealth(ctx, entityId, report);
  }

  async appendLog(ctx: ServiceContext, report: RuntimeSupervisionLogReport): Promise<void> {
    const { driver, entityId } = this.callerDriver(ctx);
    if (!driver.appendLog) throw this.unsupportedReport(driver.kind, "log");
    await driver.appendLog(ctx, entityId, report);
  }

  async versions(key: RuntimeSupervisionReleaseKey): Promise<RuntimeSupervisionReleaseVersions> {
    return await this.requireReleaseDriver(key.kind).versions(key.releaseId);
  }

  async rollback(
    ctx: ServiceContext,
    key: RuntimeSupervisionReleaseKey,
    buildKey?: string
  ): Promise<{ releaseId: string; activeBuildKey: string }> {
    return await this.requireReleaseDriver(key.kind).rollback(ctx, key.releaseId, buildKey);
  }

  private requireDriver(kind: RuntimeSupervisionKind): UnitDriver {
    const driver = this.drivers.get(kind);
    if (!driver) {
      throw Object.assign(new Error(`No executable-unit driver is registered for ${kind}`), {
        code: "UNIT_DRIVER_NOT_FOUND",
      });
    }
    return driver;
  }

  private requireReleaseDriver(kind: RuntimeSupervisionReleaseKey["kind"]): UnitReleaseDriver {
    const driver = this.requireDriver(kind).releases;
    if (!driver) {
      throw Object.assign(new Error(`No release exists for supervised kind ${kind}`), {
        code: "UNIT_RELEASE_NOT_FOUND",
      });
    }
    return driver;
  }

  private callerDriver(ctx: ServiceContext): { driver: UnitDriver; entityId: string } {
    const kind = ctx.caller.runtime.kind;
    if (
      kind !== "panel" &&
      kind !== "worker" &&
      kind !== "do" &&
      kind !== "app" &&
      kind !== "extension"
    ) {
      throw Object.assign(new Error(`${kind} is not a supervised executable caller`), {
        code: "UNIT_CALLER_NOT_SUPERVISED",
      });
    }
    return { driver: this.requireDriver(kind), entityId: ctx.caller.runtime.id };
  }

  private unsupportedReport(kind: RuntimeSupervisionKind, report: string): Error {
    return Object.assign(new Error(`${kind} does not accept ${report} reports`), {
      code: "UNIT_REPORT_UNSUPPORTED",
    });
  }
}
