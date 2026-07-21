/**
 * Tests for ServiceContainer — topological lifecycle management.
 */

import { describe, it, expect, vi } from "vitest";
import { ServiceContainer } from "./serviceContainer.js";
import type { ManagedService } from "./managedService.js";

vi.mock("./devLog.js", () => ({
  createDevLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    verbose: vi.fn(),
    error: vi.fn(),
  }),
}));

function createService(
  name: string,
  deps: string[] = [],
  value: unknown = name,
  hooks?: { onStart?: () => void; onStop?: () => void }
): ManagedService {
  return {
    name,
    dependencies: deps,
    start: vi.fn(async () => {
      hooks?.onStart?.();
      return value;
    }),
    stop: vi.fn(async (_instance: unknown) => {
      hooks?.onStop?.();
    }),
  };
}

describe("ServiceContainer", () => {
  it("starts services in dependency order", async () => {
    const container = new ServiceContainer();
    const order: string[] = [];

    container.registerManaged(
      createService("c", ["a", "b"], "c", { onStart: () => order.push("c") })
    );
    container.registerManaged(createService("a", [], "a", { onStart: () => order.push("a") }));
    container.registerManaged(createService("b", ["a"], "b", { onStart: () => order.push("b") }));

    await container.startAll();

    expect(order).toEqual(["a", "b", "c"]);
  });

  it("starts independent services in the same dependency layer concurrently", async () => {
    const container = new ServiceContainer();
    const started: string[] = [];
    let releaseA!: () => void;
    let releaseB!: () => void;

    container.registerManaged({
      name: "a",
      start: vi.fn(async () => {
        started.push("a");
        await new Promise<void>((resolve) => {
          releaseA = resolve;
        });
        return "a";
      }),
    });
    container.registerManaged({
      name: "b",
      start: vi.fn(async () => {
        started.push("b");
        await new Promise<void>((resolve) => {
          releaseB = resolve;
        });
        return "b";
      }),
    });
    container.registerManaged(createService("c", ["a", "b"]));

    const start = container.startAll();
    await Promise.resolve();

    expect(started).toEqual(["a", "b"]);
    expect(container.has("c")).toBe(false);

    releaseA();
    releaseB();
    await start;

    expect(container.has("c")).toBe(true);
  });

  it("resolves dependency instances in start()", async () => {
    const container = new ServiceContainer();

    container.registerManaged(createService("db", [], { connection: "sqlite" }));
    container.registerManaged({
      name: "repo",
      dependencies: ["db"],
      start: vi.fn(async (resolve: <D>(name: string) => D) => {
        const db = resolve<{ connection: string }>("db");
        return { dbType: db.connection };
      }),
    });

    await container.startAll();

    expect(container.get("repo")).toEqual({ dbType: "sqlite" });
  });

  it("stops services in reverse dependency order", async () => {
    const container = new ServiceContainer();
    const order: string[] = [];

    container.registerManaged(createService("a", [], "a", { onStop: () => order.push("a") }));
    container.registerManaged(createService("b", ["a"], "b", { onStop: () => order.push("b") }));
    container.registerManaged(createService("c", ["b"], "c", { onStop: () => order.push("c") }));

    await container.startAll();
    await container.stopAll();

    expect(order).toEqual(["c", "b", "a"]);
  });

  it("cleans up on partial startup failure", async () => {
    const container = new ServiceContainer();
    const stopped: string[] = [];

    container.registerManaged(createService("a", [], "a", { onStop: () => stopped.push("a") }));
    container.registerManaged({
      name: "b",
      dependencies: ["a"],
      start: vi.fn(async () => {
        throw new Error("boom");
      }),
      stop: vi.fn(),
    });

    await expect(container.startAll()).rejects.toThrow("boom");
    expect(stopped).toEqual(["a"]);
  });

  it("fails fast when one service in a parallel layer rejects while another hangs", async () => {
    const container = new ServiceContainer();
    let releaseSlow!: (value: string) => void;
    const slowStop = vi.fn();

    container.registerManaged({
      name: "slow",
      start: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            releaseSlow = resolve;
          })
      ),
      stop: slowStop,
    });
    container.registerManaged({
      name: "fail",
      start: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(container.startAll()).rejects.toThrow("boom");
    expect(container.has("slow")).toBe(false);

    releaseSlow("slow-instance");
    await vi.waitFor(() => {
      expect(slowStop).toHaveBeenCalledWith("slow-instance");
    });
    expect(container.has("slow")).toBe(false);
  });

  it("detects dependency cycles", async () => {
    const container = new ServiceContainer();

    container.registerManaged(createService("a", ["b"]));
    container.registerManaged(createService("b", ["a"]));

    await expect(container.startAll()).rejects.toThrow(/cycle/i);
  });

  it("detects missing dependencies", async () => {
    const container = new ServiceContainer();

    container.registerManaged(createService("a", ["missing"]));

    await expect(container.startAll()).rejects.toThrow(/missing/i);
  });

  it("throws on duplicate registration", () => {
    const container = new ServiceContainer();

    container.registerManaged(createService("a"));
    expect(() => container.registerManaged(createService("a"))).toThrow(/already registered/);
  });

  it("get() throws for unknown services", async () => {
    const container = new ServiceContainer();
    container.registerManaged(createService("a"));
    await container.startAll();

    expect(() => container.get("unknown")).toThrow(/not available/);
  });

  it("has() returns correct values", async () => {
    const container = new ServiceContainer();
    container.registerManaged(createService("a"));
    await container.startAll();

    expect(container.has("a")).toBe(true);
    expect(container.has("b")).toBe(false);
  });

  it("auto-registers service definitions on dispatcher", async () => {
    const registerService = vi.fn();
    const dispatcher = { registerService } as any;
    const container = new ServiceContainer(dispatcher);

    const serviceDef = {
      name: "myRpc",
      methods: {},
      handler: vi.fn(),
      authority: { principals: ["user" as const] },
    };
    container.registerManaged({
      name: "a",
      start: vi.fn(async () => "a"),
      getServiceDefinition: () => serviceDef,
    });

    await container.startAll();

    expect(registerService).toHaveBeenCalledWith(serviceDef);
  });

  it("skips dispatcher registration when no getServiceDefinition", async () => {
    const registerService = vi.fn();
    const dispatcher = { registerService } as any;
    const container = new ServiceContainer(dispatcher);

    container.registerManaged(createService("a"));
    await container.startAll();

    expect(registerService).not.toHaveBeenCalled();
  });

  it("works without a dispatcher", async () => {
    const container = new ServiceContainer();

    container.registerManaged({
      name: "a",
      start: vi.fn(async () => "a"),
      getServiceDefinition: () => ({ name: "rpc", methods: {}, handler: vi.fn() }) as any,
    });

    await container.startAll();
    expect(container.get("a")).toBe("a");
  });

  it("handles services without start() (definition-only)", async () => {
    const registerService = vi.fn();
    const dispatcher = { registerService } as any;
    const container = new ServiceContainer(dispatcher);

    const serviceDef = {
      name: "myRpc",
      methods: {},
      handler: vi.fn(),
      authority: { principals: ["user" as const] },
    };
    container.registerManaged({
      name: "noStart",
      getServiceDefinition: () => serviceDef,
    });

    await container.startAll();

    expect(container.has("noStart")).toBe(true);
    expect(container.get("noStart")).toBeUndefined();
    expect(registerService).toHaveBeenCalledWith(serviceDef);
  });

  it("handles optional dependencies — present", async () => {
    const container = new ServiceContainer();
    const order: string[] = [];

    container.registerManaged(createService("a", [], "a", { onStart: () => order.push("a") }));
    container.registerManaged({
      name: "b",
      optionalDependencies: ["a"],
      start: vi.fn(async (resolve: <D>(name: string, optional?: boolean) => D | undefined) => {
        order.push("b");
        const a = resolve<string>("a", true);
        return `b+${a}`;
      }),
    });

    await container.startAll();

    // "a" should start before "b" (ordering respected)
    expect(order).toEqual(["a", "b"]);
    // "b" should have received "a"'s instance
    expect(container.get("b")).toBe("b+a");
  });

  it("handles optional dependencies — absent", async () => {
    const container = new ServiceContainer();
    const order: string[] = [];

    container.registerManaged({
      name: "b",
      optionalDependencies: ["a"],
      start: vi.fn(async (resolve: <D>(name: string, optional?: boolean) => D | undefined) => {
        order.push("b");
        const a = resolve<string>("a", true);
        return `b+${a}`;
      }),
    });

    await container.startAll();

    // "b" should start even though "a" is absent
    expect(order).toEqual(["b"]);
    // "a" resolved as undefined
    expect(container.get("b")).toBe("b+undefined");
  });

  it("clears instances after partial startup failure", async () => {
    const container = new ServiceContainer();

    container.registerManaged(createService("a", [], "a-value"));
    container.registerManaged({
      name: "b",
      dependencies: ["a"],
      start: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    await expect(container.startAll()).rejects.toThrow("boom");
    expect(container.has("a")).toBe(false);
    expect(() => container.get("a")).toThrow(/not available/);
  });

  it("passes instance to stop()", async () => {
    const container = new ServiceContainer();
    const stoppedInstances: unknown[] = [];

    container.registerManaged({
      name: "a",
      start: vi.fn(async () => ({ id: "instance-a" })),
      stop: vi.fn(async (instance: unknown) => {
        stoppedInstances.push(instance);
      }),
    });

    await container.startAll();
    await container.stopAll();

    expect(stoppedInstances).toEqual([{ id: "instance-a" }]);
  });

  it("registerRpc() registers the RPC definition with the dispatcher", async () => {
    const registerService = vi.fn();
    const dispatcher = { registerService } as any;
    const container = new ServiceContainer(dispatcher);

    const def = {
      name: "events",
      methods: {},
      handler: vi.fn(),
      authority: { principals: ["user" as const] },
    };

    // registerRpc orders the service after its declared dependency and
    // auto-registers the definition on the dispatcher at startAll() time.
    container.registerManaged(createService("db"));
    container.registerRpc(def, ["db"]);
    await container.startAll();

    expect(container.has("events")).toBe(true);
    expect(registerService).toHaveBeenCalledWith(def);
  });
});
