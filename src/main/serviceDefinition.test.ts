/**
 * Tests for ServiceDefinition integration with ServiceDispatcher.
 */

import { z } from "zod";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  type ServiceContext,
} from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";

const ctx: ServiceContext = { caller: createVerifiedCaller("test", "shell") };

describe("ServiceDispatcher.registerService", () => {
  it("requires a colocated semantic capability for promptable methods outside the static census", () => {
    const sd = new ServiceDispatcher({ tierLookup: () => null, capabilityLookup: () => null });
    const definition: ServiceDefinition = {
      name: "dynamic",
      authority: { principals: ["user"] },
      methods: {
        inspect: {
          args: z.tuple([]),
          tier: {
            tier: "gated",
            session: "family",
            rationale: "Private metadata needs an explicit grant.",
          },
        },
      },
      handler: async () => "ok",
    };

    expect(() => sd.registerService(definition)).toThrow(
      "Promptable service method dynamic.inspect has no reviewed semantic capability"
    );

    definition.methods["inspect"]!.capability = "private-metadata.read";
    expect(() => sd.registerService(definition)).not.toThrow();
  });

  it("accepts a colocated reviewed tier without a global census entry", () => {
    const sd = new ServiceDispatcher({ tierLookup: () => null });
    sd.registerService({
      name: "dynamic",
      authority: { principals: ["user"] },
      methods: {
        inspect: {
          args: z.tuple([]),
          tier: {
            tier: "open",
            session: "family",
            rationale: "Pure inspection of a dynamically registered service.",
          },
        },
      },
      handler: async () => "ok",
    });
    expect(sd.getMethodSchema("dynamic", "inspect")?.tier?.tier).toBe("open");
  });

  it("registers and dispatches a service definition", async () => {
    const sd = createTestServiceDispatcher({ openMethods: ["echo.greet"] });

    const def: ServiceDefinition = {
      name: "echo",
      authority: { principals: ["user", "code"] },
      methods: {
        greet: { args: z.tuple([z.string()]) },
      },
      handler: async (_ctx, method, args) => {
        if (method === "greet") return `hello ${args[0]}`;
        throw new Error(`Unknown method: ${method}`);
      },
    };

    sd.registerService(def);
    sd.markInitialized();

    const result = await sd.dispatch(ctx, "echo", "greet", ["world"]);
    expect(result).toBe("hello world");
  });

  it("validates args against Zod schema and rejects invalid args", async () => {
    const sd = createTestServiceDispatcher({ openMethods: ["math.add"] });

    const def: ServiceDefinition = {
      name: "math",
      authority: { principals: ["user"] },
      methods: {
        add: { args: z.tuple([z.number(), z.number()]) },
      },
      handler: async (_ctx, _method, args) => (args[0] as number) + (args[1] as number),
    };

    sd.registerService(def);
    sd.markInitialized();

    // Valid args
    const result = await sd.dispatch(ctx, "math", "add", [1, 2]);
    expect(result).toBe(3);

    // Invalid args (strings instead of numbers)
    await expect(sd.dispatch(ctx, "math", "add", ["a", "b"])).rejects.toThrow("Invalid args");
  });

  it("denies unknown methods before handler entry", async () => {
    const sd = createTestServiceDispatcher({ openMethods: ["flex.known"] });

    const def: ServiceDefinition = {
      name: "flex",
      authority: { principals: ["user"] },
      methods: {
        known: { args: z.tuple([z.string()]) },
      },
      handler: async (_ctx, method, args) => ({ method, args }),
    };

    sd.registerService(def);
    sd.markInitialized();

    await expect(sd.dispatch(ctx, "flex", "unknown", [42])).rejects.toThrow("Unknown method");
  });

  it("exposes registered service authority through the canonical definition", () => {
    const sd = createTestServiceDispatcher({ openMethods: ["svc.foo"] });

    const def: ServiceDefinition = {
      name: "secret",
      authority: { principals: ["host"] },
      methods: {},
      handler: async () => {},
    };

    sd.registerService(def);

    expect(sd.getServiceDefinitions().find((entry) => entry.name === "secret")?.authority).toEqual({
      principals: ["host"],
    });
    expect(
      sd.getServiceDefinitions().find((entry) => entry.name === "nonexistent")
    ).toBeUndefined();
  });

  it("getServiceDefinitions returns all registered definitions", () => {
    const sd = new ServiceDispatcher();

    sd.registerService({
      name: "a",
      authority: { principals: ["user"] },
      methods: {},
      handler: async () => {},
    });

    sd.registerService({
      name: "b",
      authority: { principals: ["code"] },
      methods: {},
      handler: async () => {},
    });

    const defs = sd.getServiceDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name).sort()).toEqual(["a", "b"]);
  });

  it("getMethodSchema returns schema for known methods", () => {
    const sd = createTestServiceDispatcher({ openMethods: ["svc.foo"] });
    const argsSchema = z.tuple([z.string()]);

    sd.registerService({
      name: "svc",
      authority: { principals: ["user"] },
      methods: {
        foo: { args: argsSchema, description: "test method" },
      },
      handler: async () => {},
    });

    const schema = sd.getMethodSchema("svc", "foo");
    expect(schema).toBeDefined();
    expect(schema!.description).toBe("test method");

    expect(sd.getMethodSchema("svc", "bar")).toBeUndefined();
    expect(sd.getMethodSchema("nonexistent", "foo")).toBeUndefined();
  });
});
