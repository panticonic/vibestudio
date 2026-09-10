import { describe, expect, it } from "vitest";
import { WORKSPACE_SOURCES_ENV, readWorkspaceSources } from "./workspaceSources.js";

const source = {
  pin: {
    url: "git+https://example.test/template.git",
    ref: "refs/heads/main",
    commit: "a".repeat(40),
  },
  checkout: "/private/template",
};

describe("host-selected workspace sources", () => {
  it.each(["development", "production", undefined])(
    "accepts host-selected snapshots in %s without a feature flag",
    (mode) => {
      expect(
        readWorkspaceSources({ NODE_ENV: mode, [WORKSPACE_SOURCES_ENV]: JSON.stringify([source]) })
      ).toEqual([source]);
    }
  );

  it("accepts distinct exact snapshots from one distribution repository", () => {
    const next = {
      ...source,
      pin: {
        ...source.pin,
        ref: "refs/heads/distributions/personal",
        commit: "c".repeat(40),
      },
      checkout: "/private/personal",
    };
    expect(
      readWorkspaceSources({
        NODE_ENV: "development",
        [WORKSPACE_SOURCES_ENV]: JSON.stringify([source, next]),
      })
    ).toEqual([source, next]);
  });

  it("rejects two transports for one exact template coordinate", () => {
    expect(() =>
      readWorkspaceSources({
        NODE_ENV: "development",
        [WORKSPACE_SOURCES_ENV]: JSON.stringify([source, source]),
      })
    ).toThrow("selected more than once");
  });
});
