import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTypedServiceClient, defineServiceMethods } from "./typedServiceClient.js";

const methods = defineServiceMethods({
  ping: { args: z.tuple([]), returns: z.literal("pong") },
  echo: { args: z.tuple([z.string(), z.number().optional()]) },
  "units.list": { args: z.tuple([]), returns: z.array(z.object({ name: z.string() })) },
  "units.logs": {
    args: z.tuple([z.string(), z.object({ limit: z.number() }).optional()]),
  },
  "hostTargets.selection.get": { args: z.tuple([z.string()]) },
  voidResult: { args: z.tuple([]), returns: z.void() },
  nullableResult: { args: z.tuple([]), returns: z.string().nullable() },
});

describe("createTypedServiceClient", () => {
  it("forwards flat and dotted methods with the full method name", async () => {
    const call = vi.fn(async (_s: string, method: string) => (method === "ping" ? "pong" : null));
    const client = createTypedServiceClient("demo", methods, call);

    await expect(client.ping()).resolves.toBe("pong");
    await client.units.logs("workers/foo", { limit: 5 });
    await client.hostTargets.selection.get("electron");

    expect(call).toHaveBeenCalledWith("demo", "ping", []);
    expect(call).toHaveBeenCalledWith("demo", "units.logs", ["workers/foo", { limit: 5 }]);
    expect(call).toHaveBeenCalledWith("demo", "hostTargets.selection.get", ["electron"]);
  });

  it("allows omitting trailing optional arguments", async () => {
    const call = vi.fn(async () => null);
    const client = createTypedServiceClient("demo", methods, call);
    await client.echo("hello");
    expect(call).toHaveBeenCalledWith("demo", "echo", ["hello"]);
  });

  it("rejects invalid outbound arguments before invoking the transport", async () => {
    const call = vi.fn(async () => null);
    const client = createTypedServiceClient("demo", methods, call);

    await expect(client.echo(42 as never)).rejects.toThrow(
      'method "echo" arguments failed schema validation'
    );
    expect(call).not.toHaveBeenCalled();
  });

  it("rejects invalid inbound return values with the service and method name", async () => {
    const client = createTypedServiceClient("demo", methods, async () => "not-pong");

    await expect(client.ping()).rejects.toThrow(
      'method "ping" return value failed schema validation'
    );
  });

  it("decodes wire null as logical void without changing nullable domain results", async () => {
    const client = createTypedServiceClient("demo", methods, async () => null);

    await expect(client.voidResult()).resolves.toBeUndefined();
    await expect(client.nullableResult()).resolves.toBeNull();
  });

  it("rejects method names that collide with a group prefix", () => {
    const colliding = defineServiceMethods({
      "units.list": { args: z.tuple([]) },
      units: { args: z.tuple([]) },
    });
    expect(() => createTypedServiceClient("demo", colliding, async () => null)).toThrow(/collides/);
  });
});
