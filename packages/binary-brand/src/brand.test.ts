import { describe, expect, it } from "vitest";
import { runInNewContext } from "node:vm";
import { isArrayBuffer as native } from "./native.js";
import { isArrayBuffer as browser } from "./browser.js";

for (const [name, isArrayBuffer] of [
  ["native", native],
  ["browser", browser],
] as const) {
  describe(`${name} ArrayBuffer brand`, () => {
    it("recognizes internal slots independently of realm, tag, and prototype", () => {
      const foreign = runInNewContext("new Uint8Array([4, 5]).buffer");
      const altered = new ArrayBuffer(2);
      Object.setPrototypeOf(altered, null);
      Object.defineProperty(altered, Symbol.toStringTag, { value: "OrdinaryObject" });
      expect(isArrayBuffer(foreign)).toBe(true);
      expect(isArrayBuffer(altered)).toBe(true);
      expect(isArrayBuffer(new ArrayBuffer(0))).toBe(true);
    });
    it("rejects objects that imitate the tag or prototype without invoking user getters", () => {
      expect(isArrayBuffer({ [Symbol.toStringTag]: "ArrayBuffer" })).toBe(false);
      expect(isArrayBuffer(Object.create(ArrayBuffer.prototype))).toBe(false);
      expect(isArrayBuffer(new Uint8Array(1))).toBe(false);
      expect(isArrayBuffer(new SharedArrayBuffer(1))).toBe(false);
      expect(
        isArrayBuffer({
          get byteLength() {
            throw new Error("user getter");
          },
        })
      ).toBe(false);
    });
  });
}
