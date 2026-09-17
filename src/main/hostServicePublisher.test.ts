import { StreamResponseSchema } from "@vibestudio/shared/streamResponse";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { RpcClient, RpcRequestContext } from "@vibestudio/rpc";
import { ServiceDispatcher } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { testAuthority } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { publishHostService } from "./hostServicePublisher.js";
import {
  exposeServerOriginatedHostMethod,
  exposeServerOriginatedHostStream,
} from "./serverClient.js";

describe("desktop host-service publication", () => {
  it("publishes host-owned service methods through the local dispatcher", async () => {
    const dispatcher = new ServiceDispatcher();
    dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) =>
      testAuthority(caller, capability, resourceKey)
    );
    const definition: ServiceDefinition = {
      name: "desktopProbe",
      description: "test",
      authority: { principals: ["host"] },
      methods: {
        inspect: {
          website: {
            kind: "eligible",
            rationale: "Explicit receiver policy for this test fixture.",
          } as const,
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
        exposeHostStream: vi.fn(),
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
      publishHostService(
        { exposeHostStream: vi.fn(), exposeHostMethod: vi.fn() },
        new ServiceDispatcher(),
        {
          name: "workspaceService",
          description: "test",
          authority: { principals: ["code"] },
          methods: {},
          handler: vi.fn(),
        }
      )
    ).toThrow("Cannot publish non-host service");
  });
  it("publishes Response schemas as streams and preserves the trusted boundary", async () => {
    const dispatcher = new ServiceDispatcher();
    dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) =>
      testAuthority(caller, capability, resourceKey)
    );
    const definition: ServiceDefinition = {
      name: "desktopProgress",
      description: "test",
      authority: { principals: ["host"] },
      methods: {
        watch: {
          website: { kind: "closed", reason: "Host-owned progress" },
          description: "test",
          args: z.tuple([]),
          returns: StreamResponseSchema,
          access: { sensitivity: "read" },
          tier: { tier: "open", session: "family", rationale: "Host test" },
        },
      },
      handler: async () => new Response("installing\npaired\n"),
    };
    dispatcher.registerService(definition);
    dispatcher.markInitialized();
    let stream!: import("@vibestudio/rpc").RpcContextStreamingHandler;
    const rpc = {
      exposeStreaming: (_method: string, handler: typeof stream) => {
        stream = handler;
      },
    } as unknown as RpcClient;
    const exposeHostMethod = vi.fn();
    publishHostService(
      {
        exposeHostMethod,
        exposeHostStream: (method, handler) =>
          exposeServerOriginatedHostStream(rpc, method, handler),
      },
      dispatcher,
      definition
    );
    expect(exposeHostMethod).not.toHaveBeenCalled();
    const frames: import("@vibestudio/rpc").StreamingMethodFrame[] = [];
    const request: RpcRequestContext = {
      origin: { callerId: "main", callerKind: "server" },
      method: "progress",
      rpc,
      args: [],
      caller: { callerId: "worker:untrusted", callerKind: "worker" },
      signal: new AbortController().signal,
    };
    await expect(
      stream(request, (frame) => {
        frames.push(frame);
      })
    ).rejects.toThrow("authenticated server");
    expect(frames).toEqual([]);
    await stream({ ...request, caller: { callerId: "main", callerKind: "server" } }, (frame) => {
      frames.push(frame);
    });
    expect(frames.map((frame) => frame.kind)).toEqual(["head", "chunk", "end"]);
    const chunk = frames.find((frame) => frame.kind === "chunk");
    expect(chunk?.kind === "chunk" && new TextDecoder().decode(chunk.bytes)).toBe(
      "installing\npaired\n"
    );
  });

  it("cancels the underlying progress stream on transport cancellation", async () => {
    let stream!: import("@vibestudio/rpc").RpcContextStreamingHandler;
    const rpc = {
      exposeStreaming: (_method: string, handler: typeof stream) => {
        stream = handler;
      },
    } as unknown as RpcClient;
    const cancel = vi.fn();
    exposeServerOriginatedHostStream(
      rpc,
      "progress",
      () => new Response(new ReadableStream({ cancel }))
    );
    const abort = new AbortController();
    const request: RpcRequestContext = {
      origin: { callerId: "main", callerKind: "server" },
      method: "progress",
      rpc,
      args: [],
      caller: { callerId: "main", callerKind: "server" },
      signal: abort.signal,
    };
    const pending = stream(request, (frame) => {
      if (frame.kind === "head") abort.abort();
    });
    await expect(pending).rejects.toThrow();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
