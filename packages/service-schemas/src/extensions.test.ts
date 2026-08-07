import { describe, expect, it } from "vitest";
import { extensionsMethods } from "./extensions.js";

describe("extension invocation documentation", () => {
  it("demonstrates an open read-only operation", () => {
    expect(extensionsMethods.invoke.examples).toEqual([{ args: ["shell", "list", []] }]);
  });
});
