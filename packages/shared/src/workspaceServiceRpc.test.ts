import { describe, expect, it, vi } from "vitest";
import {
  createDurableObjectServiceClient,
  type RpcCallerLike,
} from "./workspaceServiceRpc";

function rpcCall(mock: unknown): RpcCallerLike["call"] {
  return mock as RpcCallerLike["call"];
}

describe("createDurableObjectServiceClient", () => {
  it("retries service resolution after a transient failure", async () => {
    let fail = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = vi.fn(async (target: string, method: string, args: unknown[]): Promise<any> => {
      if (target === "main" && method === "workers.resolveService") {
        expect(args).toEqual(["vcs", null]);
        if (fail) throw new Error("resolver unavailable");
        return { kind: "durable-object", targetId: "do:vcs" };
      }
      if (target === "do:vcs" && method === "ping") return "pong";
      throw new Error(`unexpected call ${target}.${method}`);
    });
    const client = createDurableObjectServiceClient({ call: rpcCall(call) }, "vcs");

    await expect(client.call("ping")).rejects.toThrow("resolver unavailable");
    fail = false;
    await expect(client.call("ping")).resolves.toBe("pong");

    const resolveCalls = call.mock.calls.filter(
      ([target, method]) => target === "main" && method === "workers.resolveService"
    );
    expect(resolveCalls).toHaveLength(2);
  });

  it("cancels service resolution and retries cleanly", async () => {
    let resolutionAttempts = 0;
    const call = vi.fn(
      async <T = unknown>(
        target: string,
        method: string,
        _args: unknown[],
        options?: { signal?: AbortSignal }
      ): Promise<T> => {
        if (target === "main" && method === "workers.resolveService") {
          resolutionAttempts += 1;
          if (resolutionAttempts === 1) {
            return new Promise<T>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
              });
            });
          }
          return { kind: "durable-object", targetId: "do:vcs" } as T;
        }
        if (target === "do:vcs" && method === "ping") return "pong" as T;
        throw new Error(`unexpected call ${target}.${method}`);
      }
    );
    const client = createDurableObjectServiceClient({ call: rpcCall(call) }, "vcs");
    const controller = new AbortController();
    const first = client.callWithOptions("ping", [], { signal: controller.signal });

    controller.abort(new Error("discovery deadline exceeded"));
    await expect(first).rejects.toThrow("discovery deadline exceeded");
    await expect(client.call("ping")).resolves.toBe("pong");
    expect(resolutionAttempts).toBe(2);
  });

  it("does not let one caller's cancellation poison a concurrent resolution", async () => {
    const call = vi.fn(
      async <T = unknown>(
        target: string,
        method: string,
        _args: unknown[],
        options?: { signal?: AbortSignal }
      ): Promise<T> => {
        if (target === "main" && method === "workers.resolveService") {
          if (options?.signal) {
            return new Promise<T>((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
              });
            });
          }
          return { kind: "durable-object", targetId: "do:vcs" } as T;
        }
        if (target === "do:vcs" && method === "ping") return "pong" as T;
        throw new Error(`unexpected call ${target}.${method}`);
      }
    );
    const client = createDurableObjectServiceClient({ call: rpcCall(call) }, "vcs");
    const controller = new AbortController();
    const cancelled = client.callWithOptions("ping", [], { signal: controller.signal });
    const concurrent = client.call("ping");

    controller.abort(new Error("cancel only this caller"));
    await expect(cancelled).rejects.toThrow("cancel only this caller");
    await expect(concurrent).resolves.toBe("pong");
  });

  it("passes call options to the resolved service", async () => {
    const call = vi.fn(async <T = unknown>(target: string, method: string): Promise<T> => {
      if (target === "main" && method === "workers.resolveService") {
        return { kind: "durable-object", targetId: "do:vcs" } as T;
      }
      if (target === "do:vcs" && method === "ping") return "pong" as T;
      throw new Error(`unexpected call ${target}.${method}`);
    });
    const client = createDurableObjectServiceClient({ call: rpcCall(call) }, "vcs");
    const controller = new AbortController();

    await expect(
      client.callWithOptions("ping", [], { signal: controller.signal, timeoutMs: 1_000 })
    ).resolves.toBe("pong");
    expect(call).toHaveBeenLastCalledWith("do:vcs", "ping", [], {
      signal: controller.signal,
      timeoutMs: 1_000,
    });
  });
});
