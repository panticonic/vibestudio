import { describe, expect, it } from "vitest";
import {
  parseBaseTemplateReleaseArtifact,
  readWorkspaceCreationTemplate,
} from "./baseTemplateRelease.js";

const pin = {
  url: "git+https://example.test/base.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}`,
};

describe("Base release pointer", () => {
  it("accepts the one current exact format", () => {
    expect(
      parseBaseTemplateReleaseArtifact({
        format: "vibestudio-base-release/1",
        baseTemplate: pin,
      })
    ).toEqual({ format: "vibestudio-base-release/1", baseTemplate: pin });
  });

  it("rejects legacy notes and version fields", () => {
    expect(() =>
      parseBaseTemplateReleaseArtifact({ version: 1, baseTemplate: pin, systemNotes: [] })
    ).toThrow();
  });

  it("uses the sealed development Base for workspace creation", () => {
    expect(
      readWorkspaceCreationTemplate("/unused", {
        NODE_ENV: "development",
        VIBESTUDIO_DEV_ROOT_TEMPLATE: JSON.stringify(pin),
      })
    ).toEqual(pin);
  });

  it("rejects a development Base override outside development mode", () => {
    expect(() =>
      readWorkspaceCreationTemplate("/unused", {
        NODE_ENV: "production",
        VIBESTUDIO_DEV_ROOT_TEMPLATE: JSON.stringify(pin),
      })
    ).toThrow(/only select workspace creation in development mode/);
  });
});
