import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { mapEvalResultLeaves } from "./resultTree.js";

describe("eval result projection", () => {
  it("projects repeated nested leaves once without mutating the heap", async () => {
    const image = { image: true };
    const input = { checks: { passed: true }, images: [image, image] };
    let count = 0;
    const result = await mapEvalResultLeaves(input, async (value) => {
      if (value !== image) return undefined;
      count++;
      return { value: { attached: true } };
    });
    expect(result).toEqual({
      checks: { passed: true },
      images: [{ attached: true }, { attached: true }],
    });
    expect(count).toBe(1);
    expect(input.images[0]).toBe(image);
  });

  it("preserves cycles, opaque objects, and dangerous property names", async () => {
    const input = JSON.parse('{"__proto__":{"polluted":true}}');
    input.self = input;
    input.date = new Date(0);
    const result = (await mapEvalResultLeaves(input, async () => undefined)) as typeof input;
    expect(result.self).toBe(result);
    expect(result.date).toBe(input.date);
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.polluted).toBeUndefined();
  });

  it("visits plain records from a guest realm", async () => {
    const input = runInNewContext("({nested: {image: true}})");
    const result = await mapEvalResultLeaves(input, async (value) =>
      (value as { image?: boolean }).image ? { value: "attached" } : undefined
    );
    expect(result).toEqual({ nested: "attached" });
  });
});
