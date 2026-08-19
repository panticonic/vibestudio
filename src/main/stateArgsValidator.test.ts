import { validateStateArgs } from "@vibestudio/shared/stateArgsValidator";

describe("validateStateArgs", () => {
  it("rejects non-JSON-serializable input (function)", () => {
    const result = validateStateArgs(() => {}, undefined);
    expect(result).toEqual({ success: false, error: "stateArgs must be JSON-serializable" });
  });

  it("rejects non-JSON-serializable input (circular reference)", () => {
    const obj: Record<string, unknown> = {};
    obj["self"] = obj;
    const result = validateStateArgs(obj, undefined);
    expect(result).toEqual({ success: false, error: "stateArgs must be JSON-serializable" });
  });

  it("accepts any JSON-serializable value when schema is undefined", () => {
    const result = validateStateArgs({ foo: 123, bar: "hello" }, undefined);
    expect(result).toEqual({ success: true, data: { foo: 123, bar: "hello" } });
  });

  it("treats null args as empty object", () => {
    const result = validateStateArgs(null, undefined);
    expect(result).toEqual({ success: true, data: {} });
  });

  it("treats undefined args as empty object", () => {
    const result = validateStateArgs(undefined, undefined);
    expect(result).toEqual({ success: true, data: {} });
  });

  it("validates against schema and accepts valid data", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" as const },
        age: { type: "number" as const },
      },
      required: ["name"],
    };
    const result = validateStateArgs({ name: "Alice", age: 30 }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Alice", age: 30 });
    }
  });

  it("rejects data that fails schema validation", () => {
    const schema = {
      type: "object" as const,
      properties: {
        name: { type: "string" as const },
      },
      required: ["name"],
    };
    const result = validateStateArgs({}, schema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("name");
      expect(result.error).toContain("required");
    }
  });

  it("applies defaults from schema", () => {
    const schema = {
      type: "object" as const,
      properties: {
        color: { type: "string" as const, default: "blue" },
      },
    };
    const result = validateStateArgs({}, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ color: "blue" });
    }
  });

  it("coerces types when coerceTypes is enabled (string to number)", () => {
    const schema = {
      type: "object" as const,
      properties: {
        count: { type: "number" as const },
      },
    };
    const result = validateStateArgs({ count: "42" }, schema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ count: 42 });
    }
  });
});

describe("validateStateArgs (interpreted draft-07 subset)", () => {
  it("coerces booleans, nulls and nested values the way Ajv coerceTypes does", () => {
    const schema = {
      type: "object" as const,
      properties: {
        open: { type: "boolean" as const },
        label: { type: "string" as const },
        id: { type: ["string", "null"] as ("string" | "null")[] },
        tags: { type: "array" as const, items: { type: "number" as const } },
      },
    };
    const result = validateStateArgs({ open: "true", label: 7, id: "", tags: ["1", 2] }, schema);
    expect(result).toEqual({
      success: true,
      data: { open: true, label: "7", id: "", tags: [1, 2] },
    });
  });

  it("rejects additional properties and enum violations with Ajv-shaped messages", () => {
    const schema = {
      type: "object" as const,
      properties: { scene: { type: "string" as const, enum: ["a", "b"] } },
      additionalProperties: false,
    };
    expect(validateStateArgs({ scene: "c" }, schema)).toEqual({
      success: false,
      error: "/scene must be equal to one of the allowed values",
    });
    expect(validateStateArgs({ other: 1 }, schema)).toEqual({
      success: false,
      error: " must NOT have additional properties",
    });
  });

  it("applies nested defaults and honors combinators", () => {
    const schema = {
      type: "object" as const,
      properties: {
        view: {
          type: "object" as const,
          properties: { zoom: { type: "number" as const, default: 1 } },
          default: {},
        },
        mode: { oneOf: [{ const: "edit" }, { const: "read" }] },
      },
      required: ["view"],
    };
    expect(validateStateArgs({ mode: "edit" }, schema)).toEqual({
      success: true,
      data: { view: { zoom: 1 }, mode: "edit" },
    });
    expect(validateStateArgs({ mode: "x" }, schema).success).toBe(false);
  });

  it("refuses schemas that use keywords outside the supported subset", () => {
    expect(() => validateStateArgs({}, { $ref: "#/definitions/x" } as never)).toThrow(
      /unsupported keyword "\$ref"/
    );
  });

  it("does not mutate the caller's input", () => {
    const input = { count: "3" };
    const schema = { type: "object" as const, properties: { count: { type: "number" as const } } };
    const result = validateStateArgs(input, schema);
    expect(result).toEqual({ success: true, data: { count: 3 } });
    expect(input).toEqual({ count: "3" });
  });
});
