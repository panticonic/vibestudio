import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { z } from "zod";
import type { RpcClient } from "@vibestudio/rpc";
import { schemaRpcCaller, wireCallerFor } from "@vibestudio/rpc/internal";
import {
  createExtensionRpcMethods,
  createLazyRpcMethods,
  createReceiverRpcMethods,
  createRpcMethods,
} from "@vibestudio/shared/rpcMethods";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { mainRpcMethod, mainRpcMethods } from "./mainRpc.js";

function compilationContract(rpc: RpcClient) {
  const wire = wireCallerFor(rpc);
  // @ts-expect-error Names alone cannot manufacture a receiver's method signatures.
  createReceiverRpcMethods(["inspect"]);
  // @ts-expect-error Descriptor names must come from the loaded receiver schema.
  createLazyRpcMethods("probe", ["unknownMethod"], async () => methods);
  const receiverMethods = createReceiverRpcMethods<{
    inspect(value: string): Promise<string>;
  }>(["inspect"]);
  // @ts-expect-error Canonical method tables cannot be reassigned.
  receiverMethods.inspect = mainRpcMethods["workers.resolveService"];
  expectTypeOf(wire.call("main", "workers.resolveService", ["vibestudio.models.v1"])).toEqualTypeOf<
    Promise<unknown>
  >();
  // @ts-expect-error Transport callers cannot invent a decoded result type either.
  wire.call<string>("main", "workers.resolveService", ["vibestudio.models.v1"]);
  const resolution = rpc.call("main", mainRpcMethods["workers.resolveService"], [
    "vibestudio.models.v1",
  ]);
  expectTypeOf(resolution).toEqualTypeOf<
    Promise<
      import("@vibestudio/workspace-contracts/workspaceConfigSchema").ResolvedWorkspaceService
    >
  >();
  rpc.call("main", mainRpcMethods["workers.resolveService"], [
    // @ts-expect-error The receiver requires a positional query string.
    { protocol: "vibestudio.models.v1" },
  ]);
  // @ts-expect-error Account-wide device inspection is served by the hub, not workspace main.
  rpc.call("main", mainRpcMethods["hubControl.listDevices"], []);
  // @ts-expect-error Public RPC calls require an owned method contract.
  rpc.call("main", "workers.resolveService", ["vibestudio.models.v1"]);
  // @ts-expect-error Callers cannot declare arbitrary return types.
  rpc.call<string>("main", mainRpcMethods["workers.resolveService"], ["vibestudio.models.v1"]);
  // @ts-expect-error Untyped peers cannot acquire a caller-invented method signature.
  rpc.peer<{ inspect: () => string }>("main");
}
void compilationContract;

const methods = defineServiceMethods({
  inspect: {
    website: { kind: "closed", reason: "Contract test receiver." },
    args: z.tuple([z.string().transform((value) => `parsed:${value}`)]),
    returns: z.string(),
  },
});

function transport(
  call = vi.fn(
    async (_target: string, _method: string, _args: unknown[]): Promise<unknown> => "received"
  )
) {
  return { call, stream: vi.fn(async () => new Response("received")) };
}

describe("receiver-owned RPC contracts", () => {
  it("freezes canonical method descriptors and tables", () => {
    const receiver = createReceiverRpcMethods<{
      inspect(value: string): Promise<string>;
    }>(["inspect"], "probe");
    const tables = [
      createRpcMethods("probe", methods),
      createLazyRpcMethods("probe", ["inspect"], async () => methods),
      receiver,
      createExtensionRpcMethods("probe-extension", receiver),
    ];

    for (const table of tables) {
      expect(Object.isFrozen(table)).toBe(true);
      expect(Object.isFrozen(table.inspect)).toBe(true);
      expect(Reflect.set(table, "inspect", mainRpcMethods["workers.resolveService"])).toBe(false);
      expect(Reflect.set(table.inspect, "name", "other.method")).toBe(false);
    }

    expect(Object.isFrozen(mainRpcMethods["workers.resolveService"])).toBe(true);
    expect(Reflect.set(mainRpcMethods, "workers.resolveService", receiver.inspect)).toBe(false);
    expect(mainRpcMethods["workers.resolveService"].name).toBe("workers.resolveService");
  });

  it("parses input once and validates the transport result", async () => {
    const wire = transport();
    const caller = schemaRpcCaller(wire);
    const descriptor = createRpcMethods("probe", methods).inspect;
    await expect(caller.call("worker", descriptor, ["input"])).resolves.toBe("received");
    expect(wire.call).toHaveBeenCalledWith("worker", "probe.inspect", ["parsed:input"], undefined);
    wire.call.mockResolvedValueOnce(123);
    await expect(caller.call("worker", descriptor, ["input"])).rejects.toThrow(
      "return value failed schema validation"
    );
  });

  it("retains the transport owner when a schema call closure is borrowed", async () => {
    const wire = transport();
    const caller = schemaRpcCaller(wire);
    expect(wireCallerFor({ call: caller.call })).toBe(wire);
    const forwarding: typeof caller.call = (target, method, args, options) =>
      caller.call(target, method, args, options);
    expect(() => wireCallerFor({ call: forwarding })).toThrow("no registered transport owner");
  });

  it("routes an extension's owned contract without losing validation", async () => {
    const wire = transport();
    const descriptor = createExtensionRpcMethods(
      "probe-extension",
      createRpcMethods("probe", methods, "")
    ).inspect;
    await expect(schemaRpcCaller(wire).call("main", descriptor, ["input"])).resolves.toBe(
      "received"
    );
    expect(wire.call).toHaveBeenCalledWith(
      "main",
      "extensions.invoke",
      ["probe-extension", "inspect", ["parsed:input"]],
      undefined
    );
    wire.call.mockResolvedValueOnce(123);
    await expect(schemaRpcCaller(wire).call("main", descriptor, ["input"])).rejects.toThrow(
      "return value failed schema validation"
    );
  });

  it("validates runtime-selected methods against the same receiver schema", async () => {
    const wire = transport();
    await expect(
      schemaRpcCaller(wire).call("main", mainRpcMethod("workers.resolveService"), [
        { protocol: "models" },
      ])
    ).rejects.toThrow("arguments failed schema validation");
    expect(wire.call).not.toHaveBeenCalled();
  });

  it("does not dispatch work cancelled while its contract is loading", async () => {
    let load!: (value: typeof methods) => void;
    const loading = new Promise<typeof methods>((resolve) => {
      load = resolve;
    });
    const descriptor = createLazyRpcMethods("probe", ["inspect"], () => loading).inspect;
    const controller = new AbortController();
    const wire = transport();
    const pending = schemaRpcCaller(wire).call("worker", descriptor, ["input"], {
      signal: controller.signal,
    });
    const cancellation = new Error("Owner cancelled");
    controller.abort(cancellation);
    load(methods);
    await expect(pending).rejects.toBe(cancellation);
    expect(wire.call).not.toHaveBeenCalled();
  });
});

it("rejects hub-only operations before sending them to the workspace receiver", async () => {
  const wire = transport();
  await expect(
    schemaRpcCaller(wire).call("main", mainRpcMethod("hubControl.listDevices"), [])
  ).rejects.toThrow();
  expect(wire.call).not.toHaveBeenCalled();
});
