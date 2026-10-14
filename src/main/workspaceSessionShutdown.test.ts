import { describe, expect, it } from "vitest";
import { closeWorkspaceSession } from "./workspaceSessionShutdown.js";

describe("workspace session shutdown", () => {
  it("joins RPC producers before closing transports and retiring the owned server", async () => {
    const order: string[] = [];
    let release!: () => void;
    const executor = new Promise<void>((resolve) => (release = resolve));
    const closing = closeWorkspaceSession({
      joinCatalog: () => {
        order.push("catalog");
      },
      joinExecutor: async () => {
        order.push("executor");
        await executor;
      },
      closeRuntimes: () => {
        order.push("runtimes");
      },
      closeTransport: () => {
        order.push("transport");
      },
      retireServer: () => {
        order.push("server");
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["catalog", "executor"]);
    release();
    await closing;
    expect(order).toEqual(["catalog", "executor", "runtimes", "transport", "server"]);
  });

  it("does not strand the owned server when executor registration or cleanup fails", async () => {
    const failure = new Error("Workspace semantic main has no durable host launch record");
    const order: string[] = [];
    await expect(
      closeWorkspaceSession({
        joinCatalog: () => {
          order.push("catalog");
        },
        joinExecutor: () => {
          throw failure;
        },
        closeRuntimes: () => {
          order.push("runtimes");
        },
        closeTransport: () => {
          order.push("transport");
        },
        retireServer: () => {
          order.push("server");
        },
      })
    ).rejects.toBe(failure);
    expect(order).toEqual(["catalog", "runtimes", "transport", "server"]);
  });

  it("attempts every retirement and preserves independent failures", async () => {
    const failures = [
      new Error("catalog"),
      new Error("executor"),
      new Error("runtimes"),
      new Error("transport"),
      new Error("server"),
    ];
    const order: number[] = [];
    const fail = (index: number) => () => {
      order.push(index);
      throw failures[index];
    };
    await expect(
      closeWorkspaceSession({
        joinCatalog: fail(0),
        joinExecutor: fail(1),
        closeRuntimes: fail(2),
        closeTransport: fail(3),
        retireServer: fail(4),
      })
    ).rejects.toMatchObject({ errors: failures });
    expect(order).toEqual([0, 1, 2, 3, 4]);
  });
});
