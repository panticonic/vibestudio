import { describe, expect, it } from "vitest";
import { bindVerifiedExternalContext, verifiedExternalContextFor } from "./internal-types.js";

describe("verified external RPC context", () => {
  it("seals an immutable out-of-band fact that JSON cannot carry", () => {
    const source = {
      class: "external" as const,
      latchEpoch: 4,
      externalKeys: ["api:webhook:" + "a".repeat(64)],
    };
    const options = bindVerifiedExternalContext({}, source);
    const sealed = verifiedExternalContextFor(options)!;

    source.externalKeys[0] = "api:webhook:" + "b".repeat(64);
    expect(sealed).toEqual({
      class: "external",
      latchEpoch: 4,
      externalKeys: ["api:webhook:" + "a".repeat(64)],
    });
    expect(Object.isFrozen(sealed)).toBe(true);
    expect(Object.isFrozen(sealed.externalKeys)).toBe(true);
    expect(JSON.parse(JSON.stringify(options))).toEqual({});
    expect(verifiedExternalContextFor(JSON.parse(JSON.stringify(options)))).toBeNull();
  });

  it("fails closed for internal, empty, or unbounded claimed lineage", () => {
    expect(() =>
      bindVerifiedExternalContext({}, { class: "internal", latchEpoch: 0, externalKeys: [] })
    ).toThrow(/bounded external lineage/);
    expect(() =>
      bindVerifiedExternalContext({}, { class: "external", latchEpoch: 0, externalKeys: [] })
    ).toThrow(/bounded external lineage/);
    expect(() =>
      bindVerifiedExternalContext(
        {},
        {
          class: "external",
          latchEpoch: 0,
          externalKeys: Array.from({ length: 257 }, (_, index) => `api:test:${index}`),
        }
      )
    ).toThrow(/bounded external lineage/);
  });
});
