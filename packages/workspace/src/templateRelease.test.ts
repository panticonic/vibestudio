import { describe, expect, it } from "vitest";
import {
  INITIAL_WORKSPACE_TEMPLATE_ENV,
  DEFAULT_WORKSPACE_TEMPLATES_ENV,
  parseTemplateReleaseArtifact,
  readDefaultWorkspaceTemplates,
  readWorkspaceCreationTemplate,
  sameWorkspaceTemplatePin,
} from "./templateRelease.js";

const pin = {
  url: "git+https://example.test/base.git",
  ref: "refs/heads/main",
  commit: "a".repeat(40),
};

const templates = {
  base: pin,
  personal: { ...pin, commit: "c".repeat(40) },
  system: { ...pin, commit: "d".repeat(40) },
};

describe("workspace template release pointer", () => {
  it("selects three exact independent template pins", () => {
    expect(
      readDefaultWorkspaceTemplates("/unused", {
        [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify(templates),
      })
    ).toEqual(templates);
    expect(
      parseTemplateReleaseArtifact({
        format: "vibestudio-template-release/1",
        workspaceTemplates: templates,
      }).workspaceTemplates
    ).toEqual(templates);
  });

  it("rejects an incomplete template set", () => {
    expect(() =>
      readDefaultWorkspaceTemplates("/unused", {
        [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify({ base: pin }),
      })
    ).toThrow();
  });
  it("accepts the one current exact format", () => {
    expect(
      parseTemplateReleaseArtifact({
        format: "vibestudio-template-release/1",
        workspaceTemplates: templates,
      })
    ).toEqual({ format: "vibestudio-template-release/1", workspaceTemplates: templates });
  });

  it("rejects legacy notes and version fields", () => {
    expect(() =>
      parseTemplateReleaseArtifact({ version: 1, workspaceTemplates: templates, systemNotes: [] })
    ).toThrow();
  });

  it("uses the Base member of the selected template set for generic workspace creation", () => {
    expect(
      readWorkspaceCreationTemplate("/unused", {
        [DEFAULT_WORKSPACE_TEMPLATES_ENV]: JSON.stringify(templates),
      })
    ).toEqual(pin);
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
