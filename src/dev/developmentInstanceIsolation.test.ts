import { describe, expect, it } from "vitest";
import { resolveDevelopmentInstanceIsolation } from "./developmentInstanceIsolation.js";

describe("development instance isolation", () => {
  it("keeps ordinary ephemeral state disposable while retaining the shared cache", () => {
    expect(resolveDevelopmentInstanceIsolation(["--ephemeral", "--workspace", "demo"])).toEqual({
      cleanRoom: false,
      disposable: true,
      forwarded: ["--workspace", "demo"],
    });
  });

  it("makes clean-room runs disposable and consumes the cache-isolation selector", () => {
    expect(resolveDevelopmentInstanceIsolation(["--clean-room", "--workspace", "demo"])).toEqual({
      cleanRoom: true,
      disposable: true,
      forwarded: ["--workspace", "demo"],
    });
  });
});
