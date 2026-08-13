import { describe, expect, it } from "vitest";
import { resolveRequiredAppRoot } from "./appRoot.js";

describe("resolveRequiredAppRoot", () => {
  it("prefers the exact command argument", () => {
    expect(
      resolveRequiredAppRoot({
        argument: "/candidate/host",
        env: { VIBESTUDIO_APP_ROOT: "/installed/host" },
      })
    ).toBe("/candidate/host");
  });

  it("accepts an exact launcher environment", () => {
    expect(resolveRequiredAppRoot({ env: { VIBESTUDIO_APP_ROOT: "/installed/host" } })).toBe(
      "/installed/host"
    );
  });

  it("never infers artifact identity from cwd", () => {
    expect(() => resolveRequiredAppRoot({ env: {} })).toThrow(
      "process working directory is not an execution input"
    );
  });
});
