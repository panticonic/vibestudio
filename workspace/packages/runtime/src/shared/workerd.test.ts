/**
 * Tests for the typed workerd client.
 */

import { createWorkerdClient, type WorkerdClient, type WorkerCreateOptions } from "./workerd.js";

function createMockRpc() {
  const calls: Array<{ target: string; method: string; args: unknown[] }> = [];

  return {
    rpc: {
      call: vi.fn(async (target: string, method: string, args: unknown[]) => {
        calls.push({ target, method, args });
        return undefined;
      }),
    } as any,
    calls,
  };
}

describe("createWorkerdClient", () => {
  let client: WorkerdClient;
  let mock: ReturnType<typeof createMockRpc>;

  beforeEach(() => {
    mock = createMockRpc();
    client = createWorkerdClient(mock.rpc);
  });

  it("create calls workerd.createInstance with options", async () => {
    const opts: WorkerCreateOptions = {
      source: "workers/hello",
      contextId: "ctx-1",
    };
    await client.create(opts);

    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.createInstance", [opts]);
  });

  it("adds parent defaults when creating workers from a runtime", async () => {
    client = createWorkerdClient(mock.rpc, {
      parentId: "parent-slot",
      parentEntityId: "panel:parent-entity",
      parentKind: "panel",
    });

    await client.create({
      source: "workers/child",
      contextId: "ctx-1",
    });

    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.createInstance", [
      {
        source: "workers/child",
        contextId: "ctx-1",
        parentId: "parent-slot",
        parentEntityId: "panel:parent-entity",
        parentKind: "panel",
      },
    ]);
  });

  it("destroy calls workerd.destroyInstance", async () => {
    await client.destroy("hello");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.destroyInstance", ["hello"]);
  });

  it("update calls workerd.updateInstance", async () => {
    await client.update("hello", { env: { X: "1" } });
    expect(mock.rpc.call).toHaveBeenCalledWith(
      "main",
      "workerd.updateInstance",
      ["hello", { env: { X: "1" } }],
    );
  });

  it("list calls workerd.listInstances", async () => {
    await client.list();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.listInstances", []);
  });

  it("status calls workerd.getInstanceStatus", async () => {
    await client.status("hello");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.getInstanceStatus", ["hello"]);
  });

  it("listInstanceSources calls workerd.listInstanceSources", async () => {
    await client.listInstanceSources();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.listInstanceSources", []);
  });

  it("listServices calls workers.listServices", async () => {
    await client.listServices();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.listServices", []);
  });

  it("resolveService calls workers.resolveService", async () => {
    await client.resolveService("natstack.channel.v1", "chat-1");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.resolveService", ["natstack.channel.v1", "chat-1"]);
  });

  it("durableObjectService resolves then calls the service target through unified RPC", async () => {
    mock.rpc.call.mockImplementation(async (target: string, method: string) => {
      if (target === "main" && method === "workers.resolveService") {
        return {
          kind: "durable-object",
          targetId: "do:workers/example:ExampleDO:key-1",
        };
      }
      return "ok";
    });

    await expect(client.durableObjectService("example.service.v1", "key-1").call("ping")).resolves.toBe("ok");
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workers.resolveService", [
      "example.service.v1",
      "key-1",
    ]);
    expect(mock.rpc.call).toHaveBeenCalledWith("do:workers/example:ExampleDO:key-1", "ping", []);
  });

  it("resolveDurableObject calls workers.resolveDurableObject", async () => {
    await client.resolveDurableObject("workers/example", "ExampleDO", "key-1");
    expect(mock.rpc.call).toHaveBeenCalledWith(
      "main",
      "workers.resolveDurableObject",
      ["workers/example", "ExampleDO", "key-1"],
    );
  });

  it("getPort calls workerd.getPort", async () => {
    await client.getPort();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.getPort", []);
  });

  it("restartAll calls workerd.restartAll", async () => {
    await client.restartAll();
    expect(mock.rpc.call).toHaveBeenCalledWith("main", "workerd.restartAll", []);
  });
});
