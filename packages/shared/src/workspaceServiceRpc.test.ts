import { schemaRpcCaller, type RpcWireCaller } from "@vibestudio/rpc/internal";
import { createRpcMethods } from "./rpcMethods";
import { z } from "zod";
import { defineServiceMethods } from "./typedServiceClient";
import { describe, expect, it, vi } from "vitest";
import { createDurableObjectServiceClient } from "@vibestudio/service-schemas/clients/durableObjectServiceClient";
import type { RpcCallerLike } from "./workspaceServiceRpc";

const testMethods = defineServiceMethods({
  search: {
    website: { kind: "closed", reason: "Test receiver." },
    args: z.tuple([z.string(), z.number(), z.unknown().optional()]),
    returns: z.array(z.unknown()),
  },
  ping: {
    website: { kind: "closed", reason: "Test receiver." },
    args: z.tuple([]),
    returns: z.string(),
  },
  read: {
    website: { kind: "closed", reason: "Test receiver." },
    args: z.tuple([]),
    returns: z.string(),
  },
});

function rpcCall(
  mock: (...args: Parameters<RpcWireCaller["call"]>) => Promise<unknown>
): RpcCallerLike["call"] {
  return schemaRpcCaller({
    call: mock,
    stream: async () => {
      throw new Error("Unexpected stream");
    },
  }).call;
}
function resolvedTarget(targetId: string) {
  return {
    kind: "durable-object",
    targetId,
    source: "workers/test",
    name: "test",
    className: "TestDO",
    objectKey: "workspace",
    action: "test",
    presentation: { domain: "automation", verb: "act" },
    authority: { principals: ["code"], binding: "declared" },
    origin: "workspace",
    protocols: ["test.v1"],
  };
}

describe("createDurableObjectServiceClient", () => {
  it("omits trailing undefined arguments before JSON transport", async () => {
    const call = vi.fn(async (target: string, method: string, _args: unknown[]): Promise<unknown> => {
      if (target === "main" && method === "workers.resolveService") {
        return resolvedTarget("do:vcs");
      }
      if (target === "do:vcs" && method === "search") return [];
      throw new Error(`unexpected call ${target}.${method}`);
    });
    const client = createDurableObjectServiceClient(
      { call: rpcCall(call) },
      "vcs",
      createRpcMethods("test", testMethods, "")
    );

    await client.call("search", "taskflow", 20, undefined);

    expect(call).toHaveBeenLastCalledWith("do:vcs", "search", ["taskflow", 20], undefined);
  });

  it("retries service resolution after a transient failure", async () => {
    let fail = true;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = vi.fn(async (target: string, method: string, args: unknown[]): Promise<any> => {
      if (target === "main" && method === "workers.resolveService") {
        expect(args).toEqual(["vcs", null]);
        if (fail) throw new Error("resolver unavailable");
        return resolvedTarget("do:vcs");
      }
      if (target === "do:vcs" && method === "ping") return "pong";
      throw new Error(`unexpected call ${target}.${method}`);
    });
    const client = createDurableObjectServiceClient(
      { call: rpcCall(call) },
      "vcs",
      createRpcMethods("test", testMethods, "")
    );

    await expect(client.call("ping")).rejects.toThrow("resolver unavailable");
    fail = false;
    await expect(client.call("ping")).resolves.toBe("pong");

    const resolveCalls = call.mock.calls.filter(
      ([target, method]) => target === "main" && method === "workers.resolveService"
    );
    expect(resolveCalls).toHaveLength(2);
  });

  it("binds cached resolution and receiver calls to one exact destination", async () => {
    const call = vi.fn(
      async (
        target: string,
        method: string,
        _args: unknown[],
        options?: import("@vibestudio/rpc").RpcCallOptions
      ): Promise<unknown> => {
        const workspaceId =
          options?.destination?.kind === "workspace" ? options.destination.workspaceId : undefined;
        if (target === "main" && method === "workers.resolveService") {
          return resolvedTarget(`do:notes:${workspaceId}`);
        }
        return `${target}:${workspaceId}`;
      }
    );
    const destinationA = { kind: "workspace" as const, workspaceId: "workspace:a" };
    const destinationB = { kind: "workspace" as const, workspaceId: "workspace:b" };
    const client = createDurableObjectServiceClient(
      { call: rpcCall(call) },
      "notes",
      createRpcMethods("test", testMethods, ""),
      null,
      {
        destination: destinationA,
      }
    );

    await expect(client.call("read")).resolves.toBe("do:notes:workspace:a:workspace:a");
    await expect(client.callWithOptions("read", [], { destination: destinationB })).resolves.toBe(
      "do:notes:workspace:b:workspace:b"
    );
    await expect(client.call("read")).resolves.toBe("do:notes:workspace:a:workspace:a");

    const resolutions = call.mock.calls.filter(([, method]) => method === "workers.resolveService");
    expect(resolutions).toHaveLength(2);
    expect(resolutions.map((entry) => entry[3]?.destination)).toEqual([destinationA, destinationB]);
  });

  it("cancels service resolution and retries cleanly", async () => {
    let resolutionAttempts = 0;
    let enterResolution!: () => void;
    const resolutionEntered = new Promise<void>((resolve) => {
      enterResolution = resolve;
    });
    const call = vi.fn(
      async (
        target: string,
        method: string,
        _args: unknown[],
        options?: { signal?: AbortSignal }
      ): Promise<unknown> => {
        if (target === "main" && method === "workers.resolveService") {
          resolutionAttempts += 1;
          enterResolution();
          if (resolutionAttempts === 1) {
            return new Promise<unknown>((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
              });
            });
          }
          return resolvedTarget("do:vcs");
        }
        if (target === "do:vcs" && method === "ping") return "pong";
        throw new Error(`unexpected call ${target}.${method}`);
      }
    );
    const client = createDurableObjectServiceClient(
      { call: rpcCall(call) },
      "vcs",
      createRpcMethods("test", testMethods, "")
    );
    const controller = new AbortController();
    const first = client.callWithOptions("ping", [], { signal: controller.signal });

    await resolutionEntered;
    controller.abort(new Error("discovery deadline exceeded"));
    await expect(first).rejects.toThrow("discovery deadline exceeded");
    await expect(client.call("ping")).resolves.toBe("pong");
    expect(resolutionAttempts).toBe(2);
  });

  it("does not let one caller's cancellation poison a concurrent resolution", async () => {
    let enterResolution!: () => void;
    const resolutionEntered = new Promise<void>((resolve) => {
      enterResolution = resolve;
    });
    const call = vi.fn(
      async (
        target: string,
        method: string,
        _args: unknown[],
        options?: { signal?: AbortSignal }
      ): Promise<unknown> => {
        if (target === "main" && method === "workers.resolveService") {
          if (options?.signal) {
            enterResolution();
            return new Promise<unknown>((_resolve, reject) => {
              options.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
                once: true,
              });
            });
          }
          return resolvedTarget("do:vcs");
        }
        if (target === "do:vcs" && method === "ping") return "pong";
        throw new Error(`unexpected call ${target}.${method}`);
      }
    );
    const client = createDurableObjectServiceClient(
      { call: rpcCall(call) },
      "vcs",
      createRpcMethods("test", testMethods, "")
    );
    const controller = new AbortController();
    const cancelled = client.callWithOptions("ping", [], { signal: controller.signal });
    const concurrent = client.call("ping");

    await resolutionEntered;
    controller.abort(new Error("cancel only this caller"));
    await expect(cancelled).rejects.toThrow("cancel only this caller");
    await expect(concurrent).resolves.toBe("pong");
  });

  it("passes call options to the resolved service", async () => {
    const call = vi.fn(async (target: string, method: string): Promise<unknown> => {
      if (target === "main" && method === "workers.resolveService") {
        return resolvedTarget("do:vcs");
      }
      if (target === "do:vcs" && method === "ping") return "pong";
      throw new Error(`unexpected call ${target}.${method}`);
    });
    const client = createDurableObjectServiceClient(
      { call: rpcCall(call) },
      "vcs",
      createRpcMethods("test", testMethods, "")
    );
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
