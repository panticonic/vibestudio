import { describe, expect, it } from "vitest";
import { extensionsMethods } from "./extensions.js";

describe("extension invocation documentation", () => {
  it("demonstrates an open read-only operation", () => {
    expect(extensionsMethods.invoke.examples).toEqual([{ args: ["shell", "list", []] }]);
  });
});

describe("extension RPC results", () => {
  for (const method of ["invoke", "invokeProvider"] as const) {
    it(`retains nested byte values when validating ${method}`, () => {
      const value = { mimeType: "image/png", artifacts: [{ bytes: new Uint8Array([137, 80]) }] };
      const parsed = extensionsMethods[method].returns.parse(value);
      expect(parsed).toEqual(value);
      expect(parsed).toMatchObject({ artifacts: [{ bytes: expect.any(Uint8Array) }] });
    });
  }
});
