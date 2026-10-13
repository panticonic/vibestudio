import { describe, expect, it } from "vitest";
import { validateAppBuildContract } from "./appBuildContract.js";

type Build = Parameters<typeof validateAppBuildContract>[2];

function terminalBuild(artifacts: Array<{ path: string; role: string }>): Build {
  return {
    metadata: {
      execution: { executionDigest: "a".repeat(64) },
      details: { kind: "app", target: "terminal" },
    },
    artifacts,
  } as unknown as Build;
}

describe("validateAppBuildContract", () => {
  it("accepts a terminal build with one primary .mjs entry", () => {
    expect(() =>
      validateAppBuildContract(
        "@apps/term",
        "terminal",
        terminalBuild([{ path: "index.mjs", role: "primary" }])
      )
    ).not.toThrow();
  });

  it("names the app and target when the terminal entry is not a single .mjs", () => {
    expect(() =>
      validateAppBuildContract(
        "@apps/term",
        "terminal",
        terminalBuild([{ path: "index.js", role: "primary" }])
      )
    ).toThrow("Terminal app @apps/term primary artifact must be an ESM .mjs entry");
    expect(() =>
      validateAppBuildContract(
        "@apps/term",
        "terminal",
        terminalBuild([
          { path: "a.mjs", role: "primary" },
          { path: "b.mjs", role: "primary" },
        ])
      )
    ).toThrow("Terminal app @apps/term build must include exactly one primary entry artifact");
    expect(() => validateAppBuildContract("@apps/term", "terminal", terminalBuild([]))).toThrow(
      /exactly one primary entry artifact/u
    );
  });

  it("refuses a build whose metadata belongs to another target", () => {
    const build = terminalBuild([{ path: "index.mjs", role: "primary" }]);
    expect(() => validateAppBuildContract("@apps/term", "electron", build)).toThrow(
      "Electron app @apps/term build is missing electron app metadata"
    );
  });

  it("refuses a build with no sealed execution identity", () => {
    const build = terminalBuild([{ path: "index.mjs", role: "primary" }]);
    (build.metadata as { execution?: unknown }).execution = undefined;
    expect(() => validateAppBuildContract("@apps/term", "terminal", build)).toThrow(
      "Terminal app @apps/term build is missing a sealed execution identity"
    );
  });
});
