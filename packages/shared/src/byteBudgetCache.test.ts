import { describe, expect, it } from "vitest";
import { ByteBudgetCache } from "./byteBudgetCache.js";

describe("byte-budget residency", () => {
  it("evicts by byte weight and read recency, including replacements", () => {
    const cache = new ByteBudgetCache<string, string>(6, (value) => value.length);
    cache.set("a", "aaa").set("b", "bbb");
    expect(cache.get("a")).toBe("aaa");
    cache.set("c", "cc");
    expect([...cache.keys()]).toEqual(["a", "c"]);
    expect(cache.bytes).toBe(5);
    cache.set("a", "aaaaa");
    expect([...cache.keys()]).toEqual(["a"]);
    expect(cache.bytes).toBe(5);
    cache.set("a", "oversized");
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    cache.set("d", "dd");
    cache.clear();
    expect(cache.bytes).toBe(0);
  });
  it("rejects invalid weights without changing residency", () => {
    const cache = new ByteBudgetCache<string, number>(8, (value) => value);
    cache.set("a", 3);
    expect(() => cache.set("a", NaN)).toThrow();
    expect(cache.get("a")).toBe(3);
    expect(cache.bytes).toBe(3);
  });
});
