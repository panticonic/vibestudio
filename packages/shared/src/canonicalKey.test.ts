import { describe, expect, it } from "vitest";
import { canonicalKey, parseCanonicalKey } from "./canonicalKey.js";

describe("canonicalKey", () => {
  it("round-trips string parts", () => {
    const key = canonicalKey(["userland-grant", "worker:alpha", "team-x:foo"]);
    expect(parseCanonicalKey(key)).toEqual(["userland-grant", "worker:alpha", "team-x:foo"]);
  });

  it("is ordering-sensitive", () => {
    expect(canonicalKey(["a", "b"])).not.toEqual(canonicalKey(["b", "a"]));
  });

  it("normalizes nullish values", () => {
    expect(parseCanonicalKey(canonicalKey(["a", null, undefined]))).toEqual(["a", null, null]);
  });

  it("rejects NUL injection and reserved sentinels", () => {
    expect(() => canonicalKey(["a\x00b"])).toThrow(/NUL/);
    expect(() => canonicalKey(["<null>"])).toThrow(/reserved/);
  });
});
