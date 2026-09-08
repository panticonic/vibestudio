import { describe, expect, it } from "vitest";
import { resolveRequiredAppRoot, resolveRequiredHostArtifactRoot } from "./appRoot.js";

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

describe("resolveRequiredHostArtifactRoot", () => {
  it("accepts only the exact launcher generation", () => {
    expect(
      resolveRequiredHostArtifactRoot({ VIBESTUDIO_HOST_ARTIFACT_ROOT: "/host/generation" })
    ).toBe("/host/generation");
    expect(() =>
      resolveRequiredHostArtifactRoot({ VIBESTUDIO_APP_ROOT: "/installed/host" })
    ).toThrow("VIBESTUDIO_HOST_ARTIFACT_ROOT");
  });
});
