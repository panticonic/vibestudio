import { describe, expect, it } from "vitest";
import {
  templateInspectionSchema,
  templateLocatorSchema,
  templateRegistrySchema,
  templatesMethods,
} from "./templates.js";

describe("templates contract", () => {
  it("contains discovery, inspection, and publication operations", () => {
    expect(Object.keys(templatesMethods)).toEqual([
      "installed",
      "inspectContribution",
      "suggestContribution",
      "prepareUpdate",
      "reviewUpdate",
      "readUpdateFile",
      "resolveUpdate",
      "publishUpdate",
      "registry",
      "resolveSource",
      "inspect",
      "inspectAuthoring",
      "authoringParts",
      "publishAuthoring",
    ]);
  });
  it("keeps registry entries loosely coupled to moving repository URLs", () => {
    const registry = templateRegistrySchema.parse({
      version: 1,
      templates: [
        ...(["base", "personal", "system"] as const).map((role) => ({
          id: role,
          role,
          name: role,
          description: `${role} workspace`,
          url: `git+https://example.test/${role}.git`,
        })),
      ],
    });
    expect(registry.templates[0]).not.toHaveProperty("commit");
    expect(registry.templates[0]).not.toHaveProperty("snapshot");
  });
  it("accepts a focused third-party registry without official foundation entries", () => {
    expect(
      templateRegistrySchema.parse({
        version: 1,
        templates: [
          {
            id: "acme-notes",
            role: "catalog",
            name: "Acme Notes",
            description: "A focused workspace catalog can stand on its own.",
            url: "git+https://example.com/acme/notes.git",
          },
        ],
      }).templates
    ).toHaveLength(1);
  });
  it("rejects removed catalog selectors", () => {
    expect(templateLocatorSchema.safeParse({ catalogId: "base" }).success).toBe(false);
  });
  it("accepts an already reviewed exact pin for reinspection", () => {
    expect(
      templateLocatorSchema.parse({
        pin: {
          url: "https://example.com/base.git",
          ref: "refs/heads/main",
          commit: "a".repeat(40),
        },
      })
    ).toHaveProperty("pin.commit", "a".repeat(40));
  });
  it("describes one exact self-contained snapshot", () => {
    expect(
      templateInspectionSchema.parse({
        pin: {
          url: "https://example.com/base.git",
          ref: "refs/tags/v1",
          commit: "a".repeat(40),
        },
        presentation: { name: "Base", description: "Common source" },
        repositories: ["workers/agent"],
        dependencies: [],
      }).repositories
    ).toEqual(["workers/agent"]);
  });
});
