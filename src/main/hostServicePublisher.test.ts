import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RpcClient, RpcRequestContext } from "@vibestudio/rpc";
import { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { testAuthority } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { publishHostService } from "./hostServicePublisher.js";
import { exposeServerOriginatedHostMethod } from "./serverClient.js";

describe("desktop host-service publication", () => {
  it("publishes host-owned service methods through the local dispatcher", async () => {
    const dispatcher = new ServiceDispatcher({
      tierLookup: () => null,
      capabilityLookup: () => null,
    });
    dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) =>
      testAuthority(caller, capability, resourceKey)
    );
    const definition: ServiceDefinition = {
      name: "desktopProbe",
      description: "test",
      authority: { principals: ["host"] },
      methods: {
        inspect: {
          description: "test",
          args: z.tuple([z.string()]),
          returns: z.string(),
          access: { sensitivity: "read" },
          capability: "test.host",
          tier: {
            tier: "gated",
            session: "family",
            rationale: "Test-only host service.",
          },
        },
      },
      handler: async (ctx, _method, args) =>
        `${ctx.caller.hostOriginated === true}:${String(args[0])}`,
    };
    dispatcher.registerService(definition);
    dispatcher.markInitialized();
    const exposed = new Map<
      string,
      (request: { args: unknown[]; signal: AbortSignal }) => unknown
    >();

    publishHostService(
      {
        exposeHostMethod: (method, handler) => exposed.set(method, handler),
      },
      dispatcher,
      definition
    );

    await expect(
      exposed.get("desktopProbe.inspect")?.({
        args: ["ready"],
        signal: new AbortController().signal,
      })
    ).resolves.toBe("true:ready");
  });

  it("rejects direct workspace callers before entering a published host method", async () => {
    let exposed: ((request: RpcRequestContext) => unknown | Promise<unknown>) | undefined;
    const rpc = {
      expose: (_method: string, handler: typeof exposed) => {
        exposed = handler;
      },
    } as unknown as RpcClient;
    const handler = vi.fn(() => "ok");
    exposeServerOriginatedHostMethod(rpc, "desktopProbe.inspect", handler);

    const request = (callerId: string, callerKind: "server" | "worker") =>
      ({
        caller: { callerId, callerKind },
        origin: { callerId, callerKind },
        method: "desktopProbe.inspect",
        args: [],
        signal: new AbortController().signal,
        rpc,
      }) satisfies RpcRequestContext;

    expect(() => exposed?.(request("worker:untrusted", "worker"))).toThrow("authenticated server");
    expect(() => exposed?.(request("main", "worker"))).toThrow("authenticated server");
    expect(() => exposed?.(request("server", "worker"))).toThrow("authenticated server");
    expect(() => exposed?.(request("other", "server"))).toThrow("authenticated server");
    await expect(Promise.resolve(exposed?.(request("main", "server")))).resolves.toBe("ok");
    await expect(Promise.resolve(exposed?.(request("server", "server")))).resolves.toBe("ok");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("refuses to publish services that are not host-owned", () => {
    expect(() =>
      publishHostService({ exposeHostMethod: vi.fn() }, new ServiceDispatcher(), {
        name: "workspaceService",
        description: "test",
        authority: { principals: ["code"] },
        methods: {},
        handler: vi.fn(),
      })
    ).toThrow("Cannot publish non-host service");
  });
});
