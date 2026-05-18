import { describe, expect, it } from "vitest";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "@natstack/shared/serviceDispatcher";
import { createWorkerService } from "./workerService.js";

const panelCtx: ServiceContext = { caller: createVerifiedCaller("panel-test", "panel") };

function createDeps() {
  return {
    buildSystem: {
      getGraph: () => ({
        allNodes: () => [
          {
            kind: "worker",
            name: "pubsub-channel",
            relativePath: "workers/pubsub-channel",
            manifest: {
              durable: { classes: [{ className: "PubSubChannel" }] },
              services: [
                {
                  name: "channel",
                  protocols: ["natstack.channel.v1"],
                  policy: { allowed: ["panel", "worker", "shell"] },
                  durableObject: { className: "PubSubChannel" },
                },
              ],
            },
          },
          {
            kind: "worker",
            name: "stateless-api",
            relativePath: "workers/stateless-api",
            manifest: {
              routes: [{ path: "/api", methods: ["POST"] }],
              services: [
                {
                  name: "stateless-api",
                  protocols: ["example.stateless.v1"],
                  policy: { allowed: ["shell"] },
                  worker: { routePath: "/api" },
                },
              ],
            },
          },
        ],
      }),
    },
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
        protocols: ["natstack.channel.v1"],
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
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
      dispatcher.dispatch(panelCtx, "workers", "resolveService", ["natstack.channel.v1", "chat-1"])
    ).resolves.toMatchObject({
      kind: "durable-object",
      name: "channel",
      source: "workers/pubsub-channel",
      className: "PubSubChannel",
      objectKey: "chat-1",
      targetId: "do:workers/pubsub-channel:PubSubChannel:chat-1",
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
        "workers/pubsub-channel",
        "PubSubChannel",
        "chat-1",
      ])
    ).resolves.toMatchObject({
      kind: "durable-object",
      source: "workers/pubsub-channel",
      className: "PubSubChannel",
      objectKey: "chat-1",
      targetId: "do:workers/pubsub-channel:PubSubChannel:chat-1",
    });

    await expect(
      dispatcher.dispatch(panelCtx, "workers", "resolveDurableObject", [
        "workers/missing",
        "MissingDO",
        "key",
      ])
    ).rejects.toThrow("No Durable Object class registered");
  });
});
