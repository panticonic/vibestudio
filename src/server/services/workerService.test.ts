import { describe, expect, it, vi } from "vitest";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { authorizeVerifiedCaller } from "./authorityRuntime.js";
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

function ungrantedExtensionCaller() {
  return createVerifiedCaller("extension:test", "extension", {
    callerId: "extension:test",
    callerKind: "extension",
    repoPath: "extensions/test",
    effectiveVersion: "ev-test",
    executionDigest: "0".repeat(64),
    requested: [],
    delegations: [],
  });
}

function createProductionAuthorityDispatcher(deps: ReturnType<typeof createDeps>) {
  const dispatcher = new ServiceDispatcher();
  dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) =>
    authorizeVerifiedCaller(caller, {
      workspaceId: "workspace-test",
      workspaceMember: true,
      sessionId: "session-test",
      audience: "service:workers",
      capability,
      resourceKey,
    })
  );
  dispatcher.registerService(createWorkerService(deps as never));
  dispatcher.markInitialized();
  return dispatcher;
}

function browserDataExtensionCaller() {
  return createVerifiedCaller("extension:browser-data", "extension", {
    callerId: "extension:browser-data",
    callerKind: "extension",
    repoPath: "extensions/browser-data",
    effectiveVersion: "browser-data-test",
    executionDigest: "b".repeat(64),
    requested: [
      {
        capability: "service:workers.resolveDurableObject",
        resource: { kind: "prefix", prefix: "" },
      },
    ],
    delegations: [],
  });
}

describe("workerService workspace service resolution", () => {
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
      {
        origin: "product",
        name: "gad.workspace",
        title: "GAD workspace graph",
        description: "Product-sealed semantic workspace authority",
        protocols: ["vibestudio.gad.workspace.v1"],
        source: "vibestudio/internal",
        kind: "durable-object",
        className: "GadWorkspaceDO",
        defaultObjectKey: "workspace-semantic-control-plane",
      },
      expect.objectContaining({
        origin: "workspace",
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
    ).rejects.toThrow("No workspace service registered");

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
      dispatcher.dispatch({ caller: ungrantedExtensionCaller() }, "workers", "resolveService", [
        "example.panel-store.v1",
        "chat-1",
      ])
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

  it("resolves the exact reviewed GAD singleton for an authenticated user", async () => {
    const dispatcher = createProductionAuthorityDispatcher(createDeps());
    const caller = createVerifiedCaller("panel:gad", "panel", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });

    await expect(
      dispatcher.dispatch({ caller }, "workers", "resolveDurableObject", [
        "vibestudio/internal",
        "GadWorkspaceDO",
        "workspace-semantic-control-plane",
      ])
    ).resolves.toEqual({
      kind: "durable-object",
      source: "vibestudio/internal",
      className: "GadWorkspaceDO",
      objectKey: "workspace-semantic-control-plane",
      targetId: "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane",
    });
  });

  it("resolves BrowserDataDO only for its reviewed broker code and exact key", async () => {
    const dispatcher = createProductionAuthorityDispatcher(createDeps());
    const caller = browserDataExtensionCaller();

    await expect(
      dispatcher.dispatch({ caller }, "workers", "resolveDurableObject", [
        "vibestudio/internal",
        "BrowserDataDO",
        "global",
      ])
    ).resolves.toMatchObject({
      targetId: "do:vibestudio/internal:BrowserDataDO:global",
    });

    await expect(
      dispatcher.dispatch({ caller }, "workers", "resolveDurableObject", [
        "vibestudio/internal",
        "BrowserDataDO",
        "guessed",
      ])
    ).rejects.toThrow("No Durable Object class registered");
  });

  it("does not expose arbitrary internal classes or let users bypass broker authority", async () => {
    const dispatcher = createProductionAuthorityDispatcher(createDeps());
    const user = createVerifiedCaller("panel:internal", "panel", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });

    await expect(
      dispatcher.dispatch({ caller: user }, "workers", "resolveDurableObject", [
        "vibestudio/internal",
        "WorkspaceDO",
        "workspace-test",
      ])
    ).rejects.toThrow("No Durable Object class registered");

    await expect(
      dispatcher.dispatch({ caller: user }, "workers", "resolveDurableObject", [
        "vibestudio/internal",
        "BrowserDataDO",
        "global",
      ])
    ).rejects.toMatchObject({ code: "EACCES" });
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
        { caller: ungrantedExtensionCaller() },
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

  it("lets an entity-bound agent resolve a service that explicitly admits entities", async () => {
    const deps = createDeps();
    deps.workspaceDecls.services = deps.workspaceDecls.services.map((service) =>
      service.name === "channel"
        ? { ...service, authority: { principals: ["code", "user", "entity"] } }
        : service
    );
    const dispatcher = new ServiceDispatcher();
    dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) =>
      authorizeVerifiedCaller(caller, {
        workspaceId: "workspace-test",
        workspaceMember: true,
        sessionId: "session-test",
        audience: "service:workers",
        capability,
        resourceKey,
      })
    );
    dispatcher.registerService(createWorkerService(deps as never));
    dispatcher.markInitialized();
    const caller = createVerifiedCaller(
      "do:workers/agent-worker:AiChatWorker:agent-1",
      "do",
      null,
      {
        entityId: "agent-1",
        contextId: "ctx-1",
        channelId: "channel-1",
        agentId: "agent-1",
      }
    );

    await expect(
      dispatcher.dispatch({ caller }, "workers", "resolveService", ["example.store.v1", "chat-1"])
    ).resolves.toMatchObject({
      name: "channel",
      targetId: "do:workers/example-store:ExampleStoreDO:chat-1",
    });
  });

  it("does not treat resolving users as owners of a shared durable object", async () => {
    const deps = createDeps();
    const activateDurableObject = vi.fn(async () => {});
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(
      createWorkerService({ ...(deps as object), activateDurableObject } as never)
    );
    dispatcher.markInitialized();

    await dispatcher.dispatch(ownedPanelCtx, "workers", "resolveService", [
      "example.store.v1",
      "shared-channel",
    ]);
    await dispatcher.dispatch(
      {
        caller: createVerifiedCaller("panel-owned-bob", "panel", null, null, {
          userId: "usr_bob",
          handle: "bob",
        }),
      },
      "workers",
      "resolveDurableObject",
      ["workers/example-store", "ExampleStoreDO", "shared-channel"]
    );

    const expectedActivation = {
      source: "workers/example-store",
      className: "ExampleStoreDO",
      objectKey: "shared-channel",
      buildRef: "main",
    };
    expect(activateDurableObject).toHaveBeenNthCalledWith(1, expectedActivation);
    expect(activateDurableObject).toHaveBeenNthCalledWith(2, expectedActivation);
  });

  it("resolves the system-owned model-settings singleton without reattributing ownership", async () => {
    const deps = createDeps();
    deps.workspaceDecls.singletons.replaceAll([
      ...deps.workspaceDecls.singletons.all(),
      {
        source: "workers/model-settings",
        className: "ModelSettingsDO",
        key: "workspace-model-settings",
      },
    ]);
    deps.workspaceDecls.services = [
      ...deps.workspaceDecls.services,
      {
        source: "workers/model-settings",
        name: "models",
        protocols: ["vibestudio.models.v1"],
        authority: { principals: ["host", "user", "code"] },
        durableObject: { className: "ModelSettingsDO" },
      },
    ];
    const activateDurableObject = vi.fn(async () => {});
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(
      createWorkerService({ ...(deps as object), activateDurableObject } as never)
    );
    dispatcher.markInitialized();

    await expect(
      dispatcher.dispatch(ownedPanelCtx, "workers", "resolveService", [
        "vibestudio.models.v1",
        null,
      ])
    ).resolves.toMatchObject({
      targetId: "do:workers/model-settings:ModelSettingsDO:workspace-model-settings",
    });
    expect(activateDurableObject).toHaveBeenCalledWith({
      source: "workers/model-settings",
      className: "ModelSettingsDO",
      objectKey: "workspace-model-settings",
      buildRef: "main",
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
