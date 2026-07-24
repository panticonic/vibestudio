import { describe, expect, it } from "vitest";
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
