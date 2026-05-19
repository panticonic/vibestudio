import { describe, expect, it, vi } from "vitest";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "@natstack/shared/serviceDispatcher";
import {
  SingletonRegistry,
  type WorkspaceDeclarations,
} from "@natstack/shared/workspace/singletonRegistry";
import { createWorkerService } from "./workerService.js";

const panelCtx: ServiceContext = { caller: createVerifiedCaller("panel-test", "panel") };

function createDeps() {
  const workspaceDecls: WorkspaceDeclarations = {
    singletons: new SingletonRegistry([
      { source: "workers/example-store", className: "ExampleStoreDO", key: "channel" },
    ]),
    services: [
      {
        source: "workers/example-store",
        name: "channel",
        protocols: ["example.store.v1"],
        policy: { allowed: ["panel", "worker", "shell"] },
        durableObject: { className: "ExampleStoreDO" },
      },
      {
        source: "workers/stateless-api",
        name: "stateless-api",
        protocols: ["example.stateless.v1"],
        policy: { allowed: ["shell"] },
        worker: { routePath: "/api" },
      },
    ],
    routes: [
      {
        source: "workers/stateless-api",
        path: "/api",
        methods: ["POST"],
        worker: true,
      },
    ],
  };
  return {
    buildSystem: {
      getGraph: () => ({
        allNodes: () => [
          {
            kind: "worker",
            name: "example-store",
            relativePath: "workers/example-store",
            manifest: {
              durable: { classes: [{ className: "ExampleStoreDO" }] },
            },
          },
          {
            kind: "worker",
            name: "stateless-api",
            relativePath: "workers/stateless-api",
            manifest: {},
          },
        ],
      }),
    },
    workspaceDecls,
  };
}

describe("workerService userland service resolution", () => {
  it("lists and resolves manifest-declared services", async () => {
    const deps = createDeps();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(createWorkerService(deps as never));
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch(panelCtx, "workers", "listServices", [])).resolves.toEqual([
      expect.objectContaining({
        name: "channel",
        kind: "durable-object",
        protocols: ["example.store.v1"],
        source: "workers/example-store",
        className: "ExampleStoreDO",
      }),
      expect.objectContaining({
        name: "stateless-api",
        kind: "worker",
        protocols: ["example.stateless.v1"],
        source: "workers/stateless-api",
        routePath: "/api",
      }),
    ]);

    await expect(
      dispatcher.dispatch(panelCtx, "workers", "resolveService", ["example.store.v1", "chat-1"])
    ).resolves.toMatchObject({
      kind: "durable-object",
      name: "channel",
      source: "workers/example-store",
      className: "ExampleStoreDO",
      objectKey: "chat-1",
      targetId: "do:workers/example-store:ExampleStoreDO:chat-1",
    });

    await expect(
      dispatcher.dispatch(panelCtx, "workers", "resolveService", ["example.stateless.v1"])
    ).rejects.toMatchObject({ code: "EACCES" });

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("shell", "shell") },
        "workers",
        "resolveService",
        ["example.stateless.v1"]
      )
    ).resolves.toMatchObject({
      kind: "worker",
      name: "stateless-api",
      source: "workers/stateless-api",
      routePath: "/api",
      routeBasePath: "/_r/w/workers/stateless-api/api",
    });
  });

  it("resolves concrete durable object targets", async () => {
    const deps = createDeps();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(createWorkerService(deps as never));
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(panelCtx, "workers", "resolveDurableObject", [
        "workers/example-store",
        "ExampleStoreDO",
        "chat-1",
      ])
    ).resolves.toMatchObject({
      kind: "durable-object",
      source: "workers/example-store",
      className: "ExampleStoreDO",
      objectKey: "chat-1",
      targetId: "do:workers/example-store:ExampleStoreDO:chat-1",
    });

    await expect(
      dispatcher.dispatch(panelCtx, "workers", "resolveDurableObject", [
        "workers/missing",
        "MissingDO",
        "key",
      ])
    ).rejects.toThrow("No Durable Object class registered");
  });

  it("activates resolved durable object services and lets DO callers use worker-allowed services", async () => {
    const deps = createDeps();
    const activateDurableObject = vi.fn(async () => {});
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(
      createWorkerService({ ...(deps as object), activateDurableObject } as never)
    );
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("do:workers/agent-worker:AiChatWorker:agent-1", "do") },
        "workers",
        "resolveService",
        ["example.store.v1", "chat-1"]
      )
    ).resolves.toMatchObject({
      kind: "durable-object",
      targetId: "do:workers/example-store:ExampleStoreDO:chat-1",
    });

    expect(activateDurableObject).toHaveBeenCalledWith({
      source: "workers/example-store",
      className: "ExampleStoreDO",
      objectKey: "chat-1",
    });
  });
});
