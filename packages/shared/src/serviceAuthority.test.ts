import { describe, expect, it } from "vitest";
import { methodTier } from "./authority/tierTable.js";
import { resolveMethodTierPolicy, type MethodTierPolicy } from "./serviceAuthority.js";

const declared: MethodTierPolicy = {
  tier: "gated",
  session: "family",
  rationale: "Dynamic service contract",
};
const censused: MethodTierPolicy = {
  tier: "open",
  session: "codeOnly",
  rationale: "Static host census",
};

describe("resolveMethodTierPolicy", () => {
  it("accepts exactly one reviewed source", () => {
    expect(resolveMethodTierPolicy("dynamic.call", declared, null)).toBe(declared);
    expect(resolveMethodTierPolicy("host.call", undefined, censused)).toBe(censused);
  });

  it("rejects duplicate and missing authority sources", () => {
    expect(() => resolveMethodTierPolicy("duplicate.call", declared, censused)).toThrow(
      /already owned by the host census/
    );
    expect(() => resolveMethodTierPolicy("missing.call", undefined, null)).toThrow(
      /no reviewed tier decision/
    );
  });
});

describe("extension caller sessions", () => {
  it("admits temporary execution sessions to public installed-extension surfaces", () => {
    expect(methodTier("extensions.list")?.session).toBe("family");
    expect(methodTier("extensions.invoke")?.session).toBe("family");
    expect(methodTier("extensions.invokeStream")?.session).toBe("family");
    expect(methodTier("extensions.invokeProvider")?.session).toBe("codeOnly");
  });
});
