import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  createWorkerdInspectorService,
  type WorkerdInspectorServiceDeps,
} from "./workerdInspectorService.js";

function panelCtx(): ServiceContext {
  return {
    caller: createVerifiedCaller("panel:panels/chat:1", "panel", {
      callerId: "panel:panels/chat:1",
      callerKind: "panel",
      repoPath: "panels/chat",
      effectiveVersion: "ev-test",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "runtime.inspect",
          resource: { kind: "prefix", prefix: "caller:" },
        },
      ],
    }),
  };
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
  it("keeps target discovery open", async () => {
    const deps = makeDeps();
    const service = createWorkerdInspectorService(deps);
    await expect(service.handler(panelCtx(), "listTargets", [])).resolves.toEqual([
      expect.objectContaining({ targetPath: "core:user:worker-host" }),
    ]);
  });

  it("selects one runtime.inspect leaf before issuing an endpoint", async () => {
    const service = createWorkerdInspectorService(makeDeps());
    const prepare = service.authorityPreparation?.["workerdInspector.getEndpoint.target"];
    expect(prepare?.(panelCtx(), ["core:user:worker-host"])).toEqual([
      expect.objectContaining({
        capability: "runtime.inspect",
        resourceKey: "caller:panel:panels/chat:1",
      }),
    ]);
  });

  it("reports unavailability only after authority has passed", async () => {
    const service = createWorkerdInspectorService(makeDeps({ getEndpoint: vi.fn(() => null) }));
    await expect(
      service.handler(panelCtx(), "getEndpoint", ["core:user:worker-host"])
    ).rejects.toThrow(/unavailable/i);
  });

  it("does not prepare a code grant for shell callers", async () => {
    const service = createWorkerdInspectorService(makeDeps());
    const prepare = service.authorityPreparation?.["workerdInspector.getEndpoint.target"];
    expect(
      prepare?.({ caller: createVerifiedCaller("shell:main", "shell") }, ["core:user:worker-host"])
    ).toEqual([]);
  });
});
