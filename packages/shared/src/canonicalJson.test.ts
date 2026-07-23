import { describe, expect, it } from "vitest";
import { canonicalJson } from "./canonicalJson.js";

describe("canonicalJson", () => {
  it("sorts object keys, preserves array order, omits object undefined, and normalizes strings", () => {
    expect(canonicalJson({ z: undefined, b: [2, undefined, 1], a: "e\u0301" })).toBe(
      '{"a":"é","b":[2,null,1]}'
    );
  });

  it("canonicalizes negative zero and rejects non-finite/cyclic values", () => {
    expect(canonicalJson({ value: -0 })).toBe('{"value":0}');
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cyclic/);
  });
});
