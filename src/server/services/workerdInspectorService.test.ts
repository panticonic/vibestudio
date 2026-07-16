import { describe, expect, it, vi } from "vitest";
import {
  createVerifiedCaller,
  ServiceAccessError,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import {
  createTestServiceContext,
  withTestServiceDispatcher,
} from "@vibestudio/shared/serviceDispatcherTestUtils";
import {
  createWorkerdInspectorService as createRawWorkerdInspectorService,
  type WorkerdInspectorServiceDeps,
} from "./workerdInspectorService.js";

const createWorkerdInspectorService = (deps: WorkerdInspectorServiceDeps) =>
  withTestServiceDispatcher(createRawWorkerdInspectorService(deps));

function panelCtx(decision: "session" | "deny" = "session"): ServiceContext {
  const ctx = createTestServiceContext(
    createVerifiedCaller("panel:panels/chat:1", "panel", {
      callerId: "panel:panels/chat:1",
      callerKind: "panel",
      repoPath: "panels/chat",
      executionDigest: "a".repeat(64),
      delegations: [],
      requested: [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
        { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
      ],
    })
  );
  ctx.authority = {
    assert: vi.fn(async () => {
      if (decision === "deny") {
        throw new ServiceAccessError(
          "workerdInspector",
          "getEndpoint",
          "Workerd inspector access denied",
          "EACCES"
        );
      }
    }),
    allows: vi.fn(async () => false),
  };
  return ctx;
}

function makeDeps(overrides?: Partial<WorkerdInspectorServiceDeps>): WorkerdInspectorServiceDeps {
  return {
    listTargets: vi.fn(async () => [
      {
        id: "core:user:worker-host",
        title: "worker-host",
        type: "node",
        targetPath: "core:user:worker-host",
      },
    ]),
    getEndpoint: vi.fn((targetPath: string) => ({
      wsEndpoint: `ws://127.0.0.1:1234/workerd-inspector/${encodeURIComponent(targetPath)}`,
      token: "tok",
    })),
    ...overrides,
  };
}

describe("workerdInspectorService", () => {
  it("lists targets without approval", async () => {
    const deps = makeDeps();
    const service = createWorkerdInspectorService(deps);
    const ctx = panelCtx();
    const targets = await service.handler(ctx, "listTargets", []);
    expect(targets).toEqual([expect.objectContaining({ targetPath: "core:user:worker-host" })]);
    expect(ctx.authority?.assert).not.toHaveBeenCalled();
  });

  it("gates getEndpoint behind the workerd.inspector capability approval", async () => {
    const deps = makeDeps();
    const service = createWorkerdInspectorService(deps);
    const ctx = panelCtx();
    const endpoint = await service.handler(ctx, "getEndpoint", ["core:user:worker-host"]);
    expect(endpoint).toEqual({
      wsEndpoint: expect.stringContaining("/workerd-inspector/"),
      token: "tok",
    });
    expect(ctx.authority?.assert).toHaveBeenCalledTimes(1);
    expect(ctx.authority?.assert).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "workerd.inspector" })
    );
  });

  it("denies getEndpoint when approval is rejected", async () => {
    const deps = makeDeps();
    const service = createWorkerdInspectorService(deps);
    await expect(
      service.handler(panelCtx("deny"), "getEndpoint", ["core:user:worker-host"])
    ).rejects.toThrow(/denied/i);
    expect(deps.getEndpoint).not.toHaveBeenCalled();
  });

  it("reports unavailability when the bridge has no inspector", async () => {
    const deps = makeDeps({ getEndpoint: vi.fn(() => null) });
    const service = createWorkerdInspectorService(deps);
    await expect(
      service.handler(panelCtx(), "getEndpoint", ["core:user:worker-host"])
    ).rejects.toThrow(/unavailable/i);
  });

  it("skips approval for shell callers", async () => {
    const deps = makeDeps();
    const service = createWorkerdInspectorService(deps);
    const ctx = createTestServiceContext(createVerifiedCaller("shell:main", "shell"));
    await service.handler(ctx, "getEndpoint", ["core:user:worker-host"]);
    expect(deps.getEndpoint).toHaveBeenCalledTimes(1);
  });
});
