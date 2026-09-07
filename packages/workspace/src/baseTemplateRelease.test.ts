import { describe, expect, it } from "vitest";
import {
  INITIAL_WORKSPACE_TEMPLATE_ENV,
  DEFAULT_WORKSPACE_TEMPLATES_ENV,
  parseBaseTemplateReleaseArtifact,
  readBaseTemplateRelease,
  readDefaultWorkspaceTemplates,
  readWorkspaceCreationTemplate,
  sameWorkspaceTemplatePin,
} from "./baseTemplateRelease.js";

const pin = {
  url: "git+https://example.test/base.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
  snapshot: `v1-sha256:${"b".repeat(64)}` as const,
};

describe("Base release pointer", () => {
  it("selects three exact independent distribution pins without requiring a running Base", () => {
    const templates = { base: pin, personal: { ...pin, commit: "c".repeat(40) }, system: { ...pin, commit: "d".repeat(40) } };
    expect(readDefaultWorkspaceTemplates("/unused", { [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify(templates) })).toEqual(templates);
    expect(parseBaseTemplateReleaseArtifact({ format: "vibestudio-base-release/1", baseTemplate: pin, workspaceTemplates: templates }).workspaceTemplates).toEqual(templates);
  });

  it("rejects an incomplete distribution set instead of silently using the combined Base", () => {
    expect(() => readDefaultWorkspaceTemplates("/unused", { [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify({ base: pin }) })).toThrow();
  });
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

  it("does not let a local acquisition source select production workspace creation", () => {
    expect(
      readWorkspaceCreationTemplate(process.cwd(), {
        NODE_ENV: "production",
        VIBESTUDIO_DEV_ROOT_TEMPLATE: JSON.stringify(pin),
      })
    ).toEqual(readBaseTemplateRelease(process.cwd()).baseTemplate);
  });

  it("allows a source desktop to select its initial template without development mode", () => {
    expect(
      readWorkspaceCreationTemplate(
        "/unused",
        {
          NODE_ENV: "production",
          [INITIAL_WORKSPACE_TEMPLATE_ENV]: JSON.stringify(pin),
        },
        { allowInitialOverride: true }
      )
    ).toEqual(pin);
  });

  it("compares every exact coordinate, including the credential requirement", () => {
    expect(sameWorkspaceTemplatePin(pin, { ...pin })).toBe(true);
    expect(sameWorkspaceTemplatePin(pin, { ...pin, commit: "c".repeat(40) })).toBe(false);
    expect(sameWorkspaceTemplatePin(pin, { ...pin, credential: "github" })).toBe(false);
  });
});
