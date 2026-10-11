import { expect, it, vi } from "vitest";
import { z } from "zod";
import { defineServiceMethods } from "./typedServiceClient.js";

it("validates portable service calls through the original transport owner across module copies", async () => {
  const owner = await import("../../rpc/src/schemaClient.js");
  const wireCall = vi.fn(async () => "accepted");
  const rpc = owner.schemaRpcCaller({
    call: wireCall,
    stream: async () => {
      throw new Error("Unexpected stream");
    },
  });

  vi.resetModules();
  const consumer = await import("../../rpc/src/schemaClient.js");
  expect(consumer.schemaRpcCaller).not.toBe(owner.schemaRpcCaller);
  expect(() => consumer.wireCallerFor(rpc)).toThrow("no registered transport owner");

  const { createLazyTypedRpcServiceClient } = await import("./typedRpcServiceClient.js");
  const load = vi.fn(async () =>
    defineServiceMethods({
      accept: {
        args: z.tuple([z.string()]),
        returns: z.literal("accepted"),
        website: { kind: "eligible", rationale: "Portable client boundary fixture." },
      },
    })
  );
  const client = createLazyTypedRpcServiceClient(
    rpc,
    { targetId: "main", namespace: "portable" },
    ["accept"],
    load
  );

  await expect(client.accept("input")).resolves.toBe("accepted");
  expect(wireCall).toHaveBeenCalledWith("main", "portable.accept", ["input"], undefined);
  await expect(Reflect.apply(client.accept, client, [42])).rejects.toThrow();
  expect(wireCall).toHaveBeenCalledTimes(1);
  wireCall.mockResolvedValueOnce("invalid result");
  await expect(client.accept("input")).rejects.toThrow();
  expect(load).toHaveBeenCalledTimes(1);
});
