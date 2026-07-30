import { describe, expect, it, vi } from "vitest";
import type { RuntimeSupervisionDescription } from "@vibestudio/service-schemas/runtime";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { createHostCaller, createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { UnitSupervisor, type UnitDriver } from "./unitSupervisor.js";

const ctx: ServiceContext = { caller: createHostCaller("server") };

function description(
  kind: RuntimeSupervisionDescription["identity"]["kind"],
  entityId: string
): RuntimeSupervisionDescription {
  return {
    identity: { kind, entityId },
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
