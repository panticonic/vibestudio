import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { ServiceContext } from "./serviceDispatcher.js";
import { defineServiceHandler } from "./serviceHandlers.js";
import { defineServiceMethods } from "./typedServiceClient.js";

const methods = defineServiceMethods({
  greet: {
    args: z.tuple([z.string(), z.number().optional()]),
    returns: z.string(),
  },
  count: {
    args: z.tuple([]),
    returns: z.number(),
  },
});

describe("defineServiceHandler", () => {
  it("derives arguments from the schema table", async () => {
    const handler = defineServiceHandler("example", methods, {
      greet: (_ctx, [name, repetitions]) => {
        expectTypeOf(name).toEqualTypeOf<string>();
        expectTypeOf(repetitions).toEqualTypeOf<number | undefined>();
        return name.repeat(repetitions ?? 1);
      },
      count: () => 2,
    });

    await expect(handler({} as ServiceContext, "greet", ["hi", 2])).resolves.toBe("hihi");
    await expect(handler({} as ServiceContext, "greet", ["hi"])).resolves.toBe("hi");
  });

  it("rejects method names outside the schema table", async () => {
    const handler = defineServiceHandler("example", methods, {
      greet: (_ctx, [name]) => name,
      count: () => 2,
    });

    await expect(handler({} as ServiceContext, "missing", [])).rejects.toThrow(
      "Unknown example method: missing"
    );
  });
});
