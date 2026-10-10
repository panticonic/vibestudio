import { describe, expect, it, vi } from "vitest";
import type { RuntimeSupervisionDescription } from "@vibestudio/service-schemas/runtime";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createHostCaller, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { UnitSupervisor, type UnitDriver } from "./unitSupervisor.js";
import { createEntityUnitDriver } from "./entityUnitDriver.js";
import { registerEntityUnitDrivers } from "./registerEntityUnitDrivers.js";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { RuntimeDiagnosticsStore } from "../runtimeDiagnosticsStore.js";

const ctx: ServiceContext = { caller: createHostCaller("server") };

function description(
  kind: RuntimeSupervisionDescription["identity"]["kind"],
  entityId: string
): RuntimeSupervisionDescription {
  return {
    identity: { kind, entityId },
    release: null,
    source: `workers/${entityId}`,
    status: "running",
    lastError: null,
    artifact: {
      effectiveVersion: "ev-1",
      buildKey: "build-1",
      executionDigest: "exec-1",
    },
    facets: { activation: false, release: false, inspector: false },
  };
}

function driver(
  kind: UnitDriver["kind"],
  entityId: string,
  overrides: Partial<UnitDriver> = {}
): UnitDriver {
  const row = description(kind, entityId);
  return {
    kind,
    list: vi.fn(() => [row]),
    describe: vi.fn((id) => (id === entityId ? row : null)),
    health: vi.fn(() => ({
      entity: row,
      state: "healthy" as const,
      summary: null,
      logs: [],
      errors: [],
      dropped: { entries: 0, errors: 0 },
      capacity: { entries: 0, errors: 0 },
    })),
    logs: vi.fn(() => []),
    restart: vi.fn(),
    retire: vi.fn(),
    ...overrides,
  };
}

describe("UnitSupervisor", () => {
  it("returns one exact diagnostic snapshot with independent error metadata", async () => {
    const entity = {
      id: "worker:one",
      kind: "worker",
      source: { repoPath: "workers/one", effectiveVersion: "ev" },
      contextId: "main",
      key: "one",
      createdAt: 1,
      status: "active",
    } as EntityRecord;
    const identity = { kind: "worker" as const, entityId: entity.id };
    const history = vi.fn(() => ({
      entries: [
        {
          entityId: entity.id,
          kind: "worker" as const,
          timestamp: 1,
          level: "info" as const,
          message: "ready",
          source: "console" as const,
        },
      ],
      errors: [
        {
          entityId: entity.id,
          kind: "worker" as const,
          timestamp: 2,
          level: "error" as const,
          message: "failed",
          source: "stderr" as const,
        },
      ],
      dropped: { entries: 7, errors: 2 },
      capacity: { entries: 1000, errors: 500 },
    }));
    const unit = createEntityUnitDriver({
      kind: "worker",
      entityCache: {
        listActive: () => [entity],
        resolveActive: (id) => (id === entity.id ? entity : null),
      },
      history,
      restart: () => {},
      retire: () => {},
    });

    expect(unit.health(entity.id)).toMatchObject({
      entity: { identity },
      logs: [{ identity, message: "ready", source: "console" }],
      errors: [{ identity, message: "failed", source: "stderr" }],
      dropped: { entries: 7, errors: 2 },
      capacity: { entries: 1000, errors: 500 },
    });
    expect(history).toHaveBeenCalledExactlyOnceWith(entity, undefined);
    expect(unit.logs(entity.id)).toMatchObject([{ identity, message: "ready", source: "console" }]);
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("does not substitute release-level diagnostics when the exact entity snapshot is empty", async () => {
    const entity = {
      id: "worker:incarnation",
      kind: "worker",
      source: { repoPath: "workers/example", effectiveVersion: "ev" },
      contextId: "main",
      key: "one",
      createdAt: 1,
      status: "active",
    } as EntityRecord;
    const history = vi.fn((entityId: string) =>
      entityId === entity.id
        ? {
            entries: [],
            errors: [],
            dropped: { entries: 2, errors: 1 },
            capacity: { entries: 1000, errors: 500 },
          }
        : {
            entries: [
              {
                entityId,
                kind: "worker" as const,
                timestamp: 1,
                level: "info" as const,
                message: "release build",
                source: "lifecycle" as const,
              },
            ],
            errors: [],
            dropped: { entries: 0, errors: 0 },
            capacity: { entries: 1000, errors: 500 },
          }
    );
    const supervisor = new UnitSupervisor();
    registerEntityUnitDrivers({
      supervisor,
      entityCache: {
        listActive: () => [entity],
        resolveActive: (id: string) => (id === entity.id ? entity : null),
      } as unknown as EntityCache,
      diagnostics: { history } as unknown as RuntimeDiagnosticsStore,
      restartPanel: async () => {},
      restartWorker: async () => {},
      restartDurableObject: async () => {},
      retire: async () => {},
    });

    expect(supervisor.health({ kind: "worker", entityId: entity.id })).toMatchObject({
      logs: [],
      errors: [],
      dropped: { entries: 2, errors: 1 },
    });
    expect(history).toHaveBeenCalledExactlyOnceWith(entity.id, undefined);
  });

  it("groups worker and Durable Object incarnations by their source release", async () => {
    const records = ["worker", "do", "panel"].map((kind) => ({
      id: `${kind}:one`,
      kind,
      source: {
        repoPath: kind === "panel" ? "panels/example" : "workers/example",
        effectiveVersion: "ev",
      },
      contextId: "main",
      key: "one",
      createdAt: 1,
      status: "active",
    })) as EntityRecord[];
    const supervisor = new UnitSupervisor();
    for (const kind of ["worker", "do", "panel"] as const) {
      supervisor.register(
        createEntityUnitDriver({
          kind,
          entityCache: {
            listActive: () => records,
            resolveActive: (id) => records.find((row) => row.id === id) ?? null,
          },
          history: () => ({
            entries: [],
            errors: [],
            dropped: { entries: 0, errors: 0 },
            capacity: { entries: 1000, errors: 500 },
          }),
          restart: () => {},
          retire: () => {},
        })
      );
    }
    expect(
      (await supervisor.describe({ kind: "worker", releaseId: "workers/example" })).map(
        (row) => row.identity.kind
      )
    ).toEqual(["do", "worker"]);
    expect(
      (await supervisor.describe({ kind: "panel", releaseId: "panels/example" })).map(
        (row) => row.identity.kind
      )
    ).toEqual(["panel"]);
  });
  it("routes exact entity keys to one registered kind driver", async () => {
    const panels = driver("panel", "panel:one");
    const workers = driver("worker", "worker:one");
    const supervisor = new UnitSupervisor();
    supervisor.register(workers);
    supervisor.register(panels);

    await expect(supervisor.list()).resolves.toEqual([
      description("panel", "panel:one"),
      description("worker", "worker:one"),
    ]);
    await supervisor.restart(ctx, { kind: "worker", entityId: "worker:one" });

    expect(workers.restart).toHaveBeenCalledWith(ctx, "worker:one");
    expect(panels.restart).not.toHaveBeenCalled();
  });

  it("fans describe and logs out from a release key to that release's live entities", async () => {
    const release = { kind: "app" as const, releaseId: "remote-cli" };
    const first = { ...description("app", "remote-cli#a"), release };
    const second = { ...description("app", "remote-cli#b"), release };
    const other = {
      ...description("app", "shell"),
      release: { kind: "app" as const, releaseId: "shell" },
    };
    const record = (entityId: string, timestamp: number, message: string) => ({
      identity: { kind: "app" as const, entityId },
      timestamp,
      level: "info" as const,
      message,
    });
    const logs = vi.fn((entityId: string) =>
      entityId === "remote-cli#a"
        ? [record(entityId, 1, "a1"), record(entityId, 3, "a3")]
        : [record(entityId, 2, "b2")]
    );
    const supervisor = new UnitSupervisor();
    supervisor.register(
      driver("app", "unused", { list: vi.fn(() => [other, first, second]), logs })
    );

    await expect(supervisor.describe(release)).resolves.toEqual([first, second]);
    await expect(supervisor.logs(release, { limit: 2 })).resolves.toEqual([
      record("remote-cli#b", 2, "b2"),
      record("remote-cli#a", 3, "a3"),
    ]);
    expect(logs).not.toHaveBeenCalledWith("shell", expect.anything());
    await expect(supervisor.describe({ kind: "app", releaseId: "missing" })).resolves.toEqual([]);
    await expect(supervisor.logs({ kind: "app", releaseId: "missing" })).rejects.toMatchObject({
      code: "UNIT_ENTITY_NOT_FOUND",
    });
    await expect(supervisor.describe({ kind: "app", entityId: "gone" })).resolves.toEqual([]);
  });

  it("addresses rollback only through a release identity and release facet", async () => {
    const rollback = vi.fn(() => ({ releaseId: "apps/shell", activeBuildKey: "build-old" }));
    const apps = driver("app", "app:running", {
      releases: {
        versions: vi.fn(() => ({ current: null, previous: [], retentionLimit: 5 })),
        rollback,
      },
    });
    const supervisor = new UnitSupervisor();
    supervisor.register(apps);

    await expect(
      supervisor.rollback(ctx, { kind: "app", releaseId: "apps/shell" }, "build-old")
    ).resolves.toEqual({ releaseId: "apps/shell", activeBuildKey: "build-old" });
    expect(rollback).toHaveBeenCalledWith(ctx, "apps/shell", "build-old");
  });

  it("fails closed when a kind has no driver or release facet", async () => {
    const supervisor = new UnitSupervisor();
    supervisor.register(driver("panel", "panel:one"));

    await expect(
      supervisor.restart(ctx, { kind: "worker", entityId: "worker:missing" })
    ).rejects.toMatchObject({ code: "UNIT_DRIVER_NOT_FOUND" });
    await expect(
      supervisor.versions({ kind: "worker", releaseId: "workers/example" })
    ).rejects.toMatchObject({ code: "UNIT_DRIVER_NOT_FOUND" });
  });

  it("routes reports only to the verified caller's exact driver identity", async () => {
    const reportReady = vi.fn();
    const appendLog = vi.fn();
    const extensions = driver("extension", "@workspace-extensions/example", {
      reportReady,
      appendLog,
    });
    const workers = driver("worker", "worker:one", {
      reportReady: vi.fn(),
      appendLog: vi.fn(),
    });
    const supervisor = new UnitSupervisor();
    supervisor.register(extensions);
    supervisor.register(workers);
    const extensionCtx: ServiceContext = {
      caller: createVerifiedCaller("@workspace-extensions/example", "extension"),
    };

    await supervisor.reportReady(extensionCtx, {
      methods: ["status"],
      providerMethods: {},
      hasFetch: false,
    });
    await supervisor.appendLog(extensionCtx, { level: "info", message: "ready" });

    expect(reportReady).toHaveBeenCalledWith(
      extensionCtx,
      "@workspace-extensions/example",
      expect.objectContaining({ methods: ["status"] })
    );
    expect(appendLog).toHaveBeenCalledWith(
      extensionCtx,
      "@workspace-extensions/example",
      expect.objectContaining({ message: "ready" })
    );
    expect(workers.reportReady).not.toHaveBeenCalled();
    expect(workers.appendLog).not.toHaveBeenCalled();
  });
});
