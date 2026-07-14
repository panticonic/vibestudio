import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  SingletonRegistry,
  type WorkspaceDeclarations,
} from "@vibestudio/workspace/singletonRegistry";
import { createWorkerService } from "./workerService.js";

const panelCtx: ServiceContext = { caller: createVerifiedCaller("panel-test", "panel") };
const ownedPanelCtx: ServiceContext = {
  caller: createVerifiedCaller("panel-owned", "panel", null, null, {
    userId: "usr_alice",
    handle: "alice",
  }),
};

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
        authority: { principals: ["code", "user"] },
        durableObject: { className: "ExampleStoreDO" },
      },
      {
        source: "workers/example-store",
        name: "panel-channel",
        protocols: ["example.panel-store.v1"],
        authority: { principals: ["code"] },
        durableObject: { className: "ExampleStoreDO" },
      },
      {
        source: "workers/stateless-api",
        name: "stateless-api",
        protocols: ["example.stateless.v1"],
        authority: { principals: ["user"] },
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
            manifest: { entry: "worker.ts" },
          },
        ],
      }),
    },
    workspaceDecls,
  };
}

describe("workerService userland service resolution", () => {
  it("lists every launchable worker with its real manifest entry point", async () => {
    const deps = createDeps();
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(createWorkerService(deps as never));
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch(panelCtx, "workers", "listSources", [])).resolves.toEqual([
      expect.objectContaining({
        name: "example-store",
        source: "workers/example-store",
        classes: [{ className: "ExampleStoreDO" }],
      }),
      expect.objectContaining({
        name: "stateless-api",
        source: "workers/stateless-api",
        entry: "worker.ts",
        classes: [],
      }),
    ]);
  });

  it("lists and resolves manifest-declared services", async () => {
    const deps = createDeps();
    const dispatcher = createTestServiceDispatcher();
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
        name: "panel-channel",
        kind: "durable-object",
        protocols: ["example.panel-store.v1"],
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

  it("uses workspace declarations added after the service is constructed", async () => {
    const deps = createDeps();
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(createWorkerService(deps as never));
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(panelCtx, "workers", "resolveService", ["poem.store.v1"])
    ).rejects.toThrow("No userland service registered");

    deps.workspaceDecls.singletons.replaceAll([
      ...deps.workspaceDecls.singletons.all(),
      { source: "workers/poem-store", className: "PoemStoreDO", key: "workspace-poem-store" },
    ]);
    deps.workspaceDecls.services = [
      ...deps.workspaceDecls.services,
      {
        source: "workers/poem-store",
        name: "poem-store",
        protocols: ["poem.store.v1"],
        authority: { principals: ["code", "user"] },
        durableObject: { className: "PoemStoreDO" },
      },
    ];

    await expect(
      dispatcher.dispatch(panelCtx, "workers", "resolveService", ["poem.store.v1"])
    ).resolves.toMatchObject({
      kind: "durable-object",
      name: "poem-store",
      source: "workers/poem-store",
      className: "PoemStoreDO",
      objectKey: "workspace-poem-store",
      targetId: "do:workers/poem-store:PoemStoreDO:workspace-poem-store",
    });
  });

  it("resolves services declared only in the caller context", async () => {
    const deps = createDeps();
    const contextDecls: WorkspaceDeclarations = {
      singletons: new SingletonRegistry([
        { source: "workers/poem-collection-store", className: "PoemStore", key: "mother-poems" },
      ]),
      services: [
        {
          source: "workers/poem-collection-store",
          name: "poem-collection",
          protocols: ["poems.collection.v1"],
          authority: { principals: ["code"] },
          durableObject: { className: "PoemStore" },
        },
      ],
      routes: [],
    };
    const activateDurableObject = vi.fn(async () => {});
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(
      createWorkerService({
        ...(deps as object),
        getCallerContextId: (callerId: string) => (callerId === "panel-test" ? "ctx-poems" : null),
        loadContextDeclarations: async (contextId: string) =>
          contextId === "ctx-poems" ? contextDecls : null,
        activateDurableObject,
      } as never)
    );
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(panelCtx, "workers", "resolveService", ["poems.collection.v1"])
    ).resolves.toMatchObject({
      kind: "durable-object",
      name: "poem-collection",
      source: "workers/poem-collection-store",
      className: "PoemStore",
      objectKey: "mother-poems",
      targetId: "do:workers/poem-collection-store:PoemStore:mother-poems",
    });
    expect(activateDurableObject).toHaveBeenCalledWith({
      source: "workers/poem-collection-store",
      className: "PoemStore",
      objectKey: "mother-poems",
      contextId: "ctx-poems",
      buildRef: "ctx:ctx-poems",
    });
  });

  it("does not use a context duplicate to bypass a main service policy", async () => {
    const deps = createDeps();
    deps.workspaceDecls.services.find((service) => service.name === "panel-channel")!.authority = {
      principals: ["host"],
    };
    const contextDecls: WorkspaceDeclarations = {
      singletons: new SingletonRegistry([
        { source: "workers/example-store", className: "ExampleStoreDO", key: "channel" },
      ]),
      services: [
        {
          source: "workers/example-store",
          name: "panel-channel",
          protocols: ["example.panel-store.v1"],
          authority: { principals: ["code"] },
          durableObject: { className: "ExampleStoreDO" },
        },
      ],
      routes: [],
    };
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(
      createWorkerService({
        ...(deps as object),
        getCallerContextId: () => "ctx-agent",
        loadContextDeclarations: async () => contextDecls,
      } as never)
    );
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("extension:test", "extension") },
        "workers",
        "resolveService",
        ["example.panel-store.v1", "chat-1"]
      )
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("resolves concrete durable object targets", async () => {
    const deps = createDeps();
    const dispatcher = createTestServiceDispatcher();
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

  it("resolves concrete durable object targets declared only in the caller context", async () => {
    const deps = createDeps();
    const contextDecls: WorkspaceDeclarations = {
      singletons: new SingletonRegistry([
        { source: "workers/poem-collection-store", className: "PoemStore", key: "mother-poems" },
      ]),
      services: [
        {
          source: "workers/poem-collection-store",
          name: "poem-collection",
          protocols: ["poems.collection.v1"],
          authority: { principals: ["code"] },
          durableObject: { className: "PoemStore" },
        },
      ],
      routes: [],
    };
    const activateDurableObject = vi.fn(async () => {});
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(
      createWorkerService({
        ...(deps as object),
        getCallerContextId: (callerId: string) => (callerId === "panel-test" ? "ctx-poems" : null),
        loadContextDeclarations: async (contextId: string) =>
          contextId === "ctx-poems" ? contextDecls : null,
        activateDurableObject,
      } as never)
    );
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(panelCtx, "workers", "resolveDurableObject", [
        "workers/poem-collection-store",
        "PoemStore",
        "mother-poems",
      ])
    ).resolves.toMatchObject({
      kind: "durable-object",
      source: "workers/poem-collection-store",
      className: "PoemStore",
      objectKey: "mother-poems",
      targetId: "do:workers/poem-collection-store:PoemStore:mother-poems",
    });
    expect(activateDurableObject).toHaveBeenCalledWith({
      source: "workers/poem-collection-store",
      className: "PoemStore",
      objectKey: "mother-poems",
      contextId: "ctx-poems",
      buildRef: "ctx:ctx-poems",
    });
  });

  it("does not use a context duplicate to bypass a main direct DO policy", async () => {
    const deps = createDeps();
    deps.workspaceDecls.services.find((service) => service.name === "panel-channel")!.authority = {
      principals: ["host"],
    };
    const contextDecls: WorkspaceDeclarations = {
      singletons: new SingletonRegistry([
        { source: "workers/example-store", className: "ExampleStoreDO", key: "channel" },
      ]),
      services: [
        {
          source: "workers/example-store",
          name: "panel-channel",
          protocols: ["example.panel-store.v1"],
          authority: { principals: ["code"] },
          durableObject: { className: "ExampleStoreDO" },
        },
      ],
      routes: [],
    };
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(
      createWorkerService({
        ...(deps as object),
        getCallerContextId: () => "ctx-agent",
        loadContextDeclarations: async () => contextDecls,
      } as never)
    );
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("extension:test", "extension") },
        "workers",
        "resolveDurableObject",
        ["workers/example-store", "ExampleStoreDO", "chat-1"]
      )
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("activates resolved durable object services and lets DO callers use worker-allowed services", async () => {
    const deps = createDeps();
    const activateDurableObject = vi.fn(async () => {});
    const dispatcher = createTestServiceDispatcher();
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
      buildRef: "main",
    });
  });

  it("stamps an on-demand durable object with the resolving caller's owner", async () => {
    const deps = createDeps();
    const activateDurableObject = vi.fn(async () => {});
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(
      createWorkerService({ ...(deps as object), activateDurableObject } as never)
    );
    dispatcher.markInitialized();

    await dispatcher.dispatch(ownedPanelCtx, "workers", "resolveService", [
      "example.store.v1",
      "owned-channel",
    ]);

    expect(activateDurableObject).toHaveBeenCalledWith({
      source: "workers/example-store",
      className: "ExampleStoreDO",
      objectKey: "owned-channel",
      buildRef: "main",
      ownerUserId: "usr_alice",
    });
  });

  it("lets DO callers use panel-allowed durable services", async () => {
    const deps = createDeps();
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(createWorkerService(deps as never));
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(
        { caller: createVerifiedCaller("do:workers/agent-worker:AiChatWorker:agent-1", "do") },
        "workers",
        "resolveService",
        ["example.panel-store.v1", "chat-1"]
      )
    ).resolves.toMatchObject({
      kind: "durable-object",
      targetId: "do:workers/example-store:ExampleStoreDO:chat-1",
    });
  });
});
