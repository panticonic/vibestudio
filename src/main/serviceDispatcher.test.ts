import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
/**
 * Tests for ServiceDispatcher and parseServiceMethod.
 */

import { z } from "zod";
import {
  createVerifiedCaller,
  ServiceError,
  parseServiceMethod,
} from "@vibestudio/shared/serviceDispatcher";
import { fsMethods } from "@vibestudio/service-schemas/fs";
import { RemoteRpcError, RpcBoundaryError } from "@vibestudio/rpc";
import type { ServiceContext, ServiceHandler } from "@vibestudio/shared/serviceDispatcher";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";

const ctx: ServiceContext = { caller: createVerifiedCaller("test", "shell") };

function makeService(name: string, handler: ServiceHandler): ServiceDefinition {
  return {
    name,
    authority: { principals: ["user", "code", "host"] },
    methods: {
      hello: { args: z.tuple([]).rest(z.unknown()) },
      run: { args: z.tuple([]).rest(z.unknown()) },
    },
    handler,
  };
}

describe("ServiceDispatcher", () => {
  it("dispatch before markInitialized: registered services work, unknown services get the retryable not-initialized error", async () => {
    const sd = createTestServiceDispatcher();
    sd.registerService(makeService("echo", async (_ctx, method, args) => ({ method, args })));

    // A registered service is fully wired and may be called during boot
    // (e.g. singleton DOs dispatching back into the server mid-startup).
    await expect(sd.dispatch(ctx, "echo", "hello", [])).resolves.toEqual({
      method: "hello",
      args: [],
    });
    // A not-yet-registered service signals "retry later", not "unknown".
    await expect(sd.dispatch(ctx, "later", "foo", [])).rejects.toThrow(
      "Services not yet initialized"
    );
  });

  it("dispatch throws ServiceError for unknown service", async () => {
    const sd = createTestServiceDispatcher();
    sd.markInitialized();

    await expect(sd.dispatch(ctx, "nope", "foo", [])).rejects.toThrow("Unknown service");
  });

  it("dispatch calls registered handler and returns result", async () => {
    const sd = createTestServiceDispatcher();
    sd.registerService(makeService("echo", async (_ctx, method, args) => ({ method, args })));
    sd.markInitialized();

    const result = await sd.dispatch(ctx, "echo", "hello", ["world"]);
    expect(result).toEqual({ method: "hello", args: ["world"] });
  });

  it("dispatch wraps non-ServiceError exceptions in ServiceError", async () => {
    const sd = createTestServiceDispatcher();
    sd.registerService(
      makeService("fail", async () => {
        throw new Error("boom");
      })
    );
    sd.markInitialized();

    try {
      await sd.dispatch(ctx, "fail", "run", []);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ServiceError);
      const serviceError = err as ServiceError;
      expect(serviceError.service).toBe("fail");
      expect(serviceError.method).toBe("run");
      expect(serviceError.message).toContain("boom");
    }
  });

  const boundaryCause = new Error("policy source");

  it.each([
    {
      label: "RpcBoundaryError",
      error: new RpcBoundaryError("permission denied", "access", "EACCES", boundaryCause),
      errorKind: "access" as const,
      code: "EACCES",
      sourceCause: boundaryCause,
    },
    {
      label: "RemoteRpcError",
      error: new RemoteRpcError("upstream unavailable", "transport", "ECONNRESET"),
      errorKind: "transport" as const,
      code: "ECONNRESET",
      sourceCause: undefined,
    },
  ])(
    "preserves $label provenance when wrapping it",
    async ({ error, errorKind, code, sourceCause }) => {
      const sd = createTestServiceDispatcher();
      sd.registerService(
        makeService("fail", async () => {
          throw error;
        })
      );
      sd.markInitialized();

      const rejected = await sd.dispatch(ctx, "fail", "run", []).catch((caught) => caught);

      expect(rejected).toBeInstanceOf(ServiceError);
      expect(rejected).toMatchObject({
        service: "fail",
        method: "run",
        errorKind,
        code,
        cause: error,
      });
      if (sourceCause) {
        expect((error as Error & { cause?: unknown }).cause).toBe(sourceCause);
      }
    }
  );

  it("registerService warns on overwrite", async () => {
    const sd = createTestServiceDispatcher();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    sd.registerService(makeService("svc", async () => {}));
    sd.registerService(makeService("svc", async () => {}));

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Overwriting handler for service: svc")
    );
    warnSpy.mockRestore();
  });

  it("hasService and getServices reflect registrations", async () => {
    const sd = createTestServiceDispatcher();
    sd.registerService(makeService("alpha", async () => {}));
    sd.registerService(makeService("beta", async () => {}));

    expect(sd.hasService("alpha")).toBe(true);
    expect(sd.hasService("gamma")).toBe(false);
    expect(sd.getServices()).toEqual(expect.arrayContaining(["alpha", "beta"]));
  });

  it("getServiceDefinitions returns all definitions", () => {
    const sd = createTestServiceDispatcher();
    sd.registerService(makeService("a", async () => {}));
    sd.registerService(makeService("b", async () => {}));

    const defs = sd.getServiceDefinitions();
    expect(defs).toHaveLength(2);
    expect(defs.map((d) => d.name).sort()).toEqual(["a", "b"]);
  });

  it("keeps authority declarations on the registered definition", () => {
    const sd = createTestServiceDispatcher();
    sd.registerService({
      name: "restricted",
      authority: { principals: ["user"] },
      methods: {},
      handler: async () => {},
    });

    expect(
      sd.getServiceDefinitions().find((service) => service.name === "restricted")?.authority
    ).toEqual({ principals: ["user"] });
  });

  it("validates args against Zod schema when method is defined", async () => {
    const sd = createTestServiceDispatcher();
    sd.registerService({
      name: "typed",
      authority: { principals: ["user"] },
      methods: {
        greet: { args: z.tuple([z.string()]) },
      },
      handler: async (_ctx, _method, args) => `hello ${args[0]}`,
    });
    sd.markInitialized();

    // Valid args
    const result = await sd.dispatch(ctx, "typed", "greet", ["world"]);
    expect(result).toBe("hello world");

    // Invalid args
    await expect(sd.dispatch(ctx, "typed", "greet", [42])).rejects.toThrow("Invalid args");
  });

  it("validates declared return schemas in dev/test", async () => {
    const sd = createTestServiceDispatcher();
    sd.registerService({
      name: "typedReturn",
      authority: { principals: ["user"] },
      methods: {
        ok: { args: z.tuple([]), returns: z.object({ count: z.number() }) },
        bad: { args: z.tuple([]), returns: z.object({ count: z.number() }) },
      },
      handler: async (_ctx, method) => (method === "ok" ? { count: 1 } : { count: "one" }),
    });
    sd.markInitialized();

    await expect(sd.dispatch(ctx, "typedReturn", "ok", [])).resolves.toEqual({ count: 1 });
    await expect(sd.dispatch(ctx, "typedReturn", "bad", [])).rejects.toThrow(
      "Invalid return: invalid return count — expected number, received string"
    );
  });

  it("accepts null as the wire representation of declared void returns", async () => {
    const sd = createTestServiceDispatcher();
    sd.registerService({
      name: "voidReturn",
      authority: { principals: ["user"] },
      methods: {
        okNull: { args: z.tuple([]), returns: z.void() },
        okUndefined: { args: z.tuple([]), returns: z.void() },
        badObject: { args: z.tuple([]), returns: z.object({ count: z.number() }) },
      },
      handler: async (_ctx, method) => {
        if (method === "okUndefined") return undefined;
        return null;
      },
    });
    sd.markInitialized();

    await expect(sd.dispatch(ctx, "voidReturn", "okNull", [])).resolves.toBeUndefined();
    await expect(sd.dispatch(ctx, "voidReturn", "okUndefined", [])).resolves.toBeUndefined();
    await expect(sd.dispatch(ctx, "voidReturn", "badObject", [])).rejects.toThrow(
      "Invalid return: invalid return (return) — expected object, received null"
    );
  });

  it("reports service, method, argument path, and a readable summary on validation failure", async () => {
    const sd = createTestServiceDispatcher();
    sd.registerService({
      name: "workspace",
      authority: { principals: ["user"] },
      methods: {
        logs: { args: z.tuple([z.string(), z.object({ limit: z.number() })]) },
      },
      handler: async () => {},
    });
    sd.markInitialized();

    try {
      await sd.dispatch(ctx, "workspace", "logs", ["unit-1", { limit: "ten" }]);
      expect.fail("should have thrown");
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(ServiceError);
      const serviceError = err as ServiceError;
      expect(serviceError.service).toBe("workspace");
      expect(serviceError.method).toBe("logs");
      expect(serviceError.message).toContain("[workspace.logs]");
      expect(serviceError.message).toContain(
        "Invalid args: invalid argument [1].limit — expected number, received string"
      );
    }
  });

  it("normalizes wire args: pads omitted trailing optionals and maps null→undefined", async () => {
    const sd = createTestServiceDispatcher();
    let seen: unknown[] = [];
    sd.registerService({
      name: "norm",
      authority: { principals: ["user"] },
      methods: {
        m: { args: z.tuple([z.string(), z.number().optional(), z.boolean().optional()]) },
      },
      handler: async (_ctx, _method, args) => {
        seen = args;
      },
    });
    sd.markInitialized();

    // Short array: trailing optionals padded with undefined
    await sd.dispatch(ctx, "norm", "m", ["a"]);
    expect(seen).toEqual(["a", undefined, undefined]);

    // null (JSON round-trip of undefined) becomes undefined at optional positions
    await sd.dispatch(ctx, "norm", "m", ["a", null, true]);
    expect(seen).toEqual(["a", undefined, true]);

    // null at a required position is left alone (and fails validation)
    await expect(sd.dispatch(ctx, "norm", "m", [null])).rejects.toThrow("Invalid args");
  });

  it("normalizes wire args for tuple overload unions", async () => {
    const sd = createTestServiceDispatcher();
    let seen: unknown[] = [];
    sd.registerService({
      name: "overloaded",
      authority: { principals: ["user"] },
      methods: {
        readFile: {
          args: z.union([
            z.tuple([z.string(), z.string().optional()]),
            z.tuple([z.string(), z.string(), z.string().optional()]),
          ]),
        },
      },
      handler: async (_ctx, _method, args) => {
        seen = args;
      },
    });
    sd.markInitialized();

    await sd.dispatch(ctx, "overloaded", "readFile", ["skills/system-testing/SKILL.md"]);
    expect(seen).toEqual(["skills/system-testing/SKILL.md", undefined]);

    await sd.dispatch(ctx, "overloaded", "readFile", ["skills/system-testing/SKILL.md", null]);
    expect(seen).toEqual(["skills/system-testing/SKILL.md", undefined]);

    await sd.dispatch(ctx, "overloaded", "readFile", [
      "ctx-1",
      "skills/system-testing/SKILL.md",
      null,
    ]);
    expect(seen).toEqual(["ctx-1", "skills/system-testing/SKILL.md", undefined]);

    // Already-valid overload calls keep their original arity so service
    // handlers can continue applying caller-kind-specific conventions.
    await sd.dispatch(ctx, "overloaded", "readFile", ["ctx-1", "skills/system-testing/SKILL.md"]);
    expect(seen).toEqual(["ctx-1", "skills/system-testing/SKILL.md"]);

    await expect(sd.dispatch(ctx, "overloaded", "readFile", ["path", 42])).rejects.toThrow(
      "Invalid args"
    );
  });

  it("normalizes the real fs overloaded schemas", async () => {
    const sd = createTestServiceDispatcher();
    const seen = new Map<string, unknown[]>();
    sd.registerService({
      name: "realFs",
      authority: { principals: ["user"] },
      methods: {
        readFile: fsMethods.readFile,
        glob: fsMethods.glob,
      },
      handler: async (_ctx, method, args) => {
        seen.set(`fs.${method}`, args);
        if (method === "glob") return [];
        return "";
      },
    });
    sd.markInitialized();

    await sd.dispatch(ctx, "realFs", "readFile", ["skills/system-testing/SKILL.md"]);
    expect(seen.get("fs.readFile")).toEqual(["skills/system-testing/SKILL.md", undefined]);

    await sd.dispatch(ctx, "realFs", "glob", ["skills", null]);
    expect(seen.get("fs.glob")).toEqual(["skills", undefined]);
  });

  it("getMethodSchema returns method definition", () => {
    const sd = createTestServiceDispatcher();
    sd.registerService({
      name: "svc",
      authority: { principals: ["user"] },
      methods: {
        doStuff: { args: z.tuple([z.string()]), description: "does stuff" },
      },
      handler: async () => {},
    });

    const schema = sd.getMethodSchema("svc", "doStuff");
    expect(schema).toBeDefined();
    expect(schema?.description).toBe("does stuff");
    expect(sd.getMethodSchema("svc", "nope")).toBeUndefined();
  });
});

describe("parseServiceMethod", () => {
  it("parses 'service.method' format", () => {
    expect(parseServiceMethod("bridge.createPanel")).toEqual({
      service: "bridge",
      method: "createPanel",
    });
  });

  it("returns null for input without a dot", () => {
    expect(parseServiceMethod("nomethod")).toBeNull();
  });
});
