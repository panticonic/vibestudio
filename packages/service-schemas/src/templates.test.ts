import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  templateInspectionSchema,
  templateLocatorSchema,
  templateRegistrySchema,
  templatesMethods,
} from "./templates.js";

describe("templates contract", () => {
  it("decodes the current official registry through the public service contract", () => {
    const registry = templatesMethods.registry.returns.parse(
      JSON.parse(readFileSync(new URL("../../../templates/registry.json", import.meta.url), "utf8"))
    );
    expect(registry.templates.find((entry) => entry.id === "system-testing")?.consumers).toEqual([
      "personal",
      "system",
      "examples",
    ]);
    expect(registry.templates.find((entry) => entry.id === "examples")?.role).toBe("catalog");
  });
  it("contains discovery, inspection, and publication operations", () => {
    expect(Object.keys(templatesMethods)).toEqual([
      "updateAssistant",
      "updateSignal",
      "updateStatus",
      "checkUpdates",
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
      "publicationRepositories",
      "authoringSetup",
      "publicationVersion",
      "authoringUpstream",
      "authoringParts",
      "reviewPublication",
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
  it("composes development support into a declared catalog template", () => {
    const registry = templateRegistrySchema.parse({
      version: 1,
      templates: [
        {
          id: "examples",
          role: "catalog",
          name: "Examples",
          description: "Actual examples",
          url: "git+https://example.test/examples.git",
        },
        {
          id: "system-testing",
          role: "development",
          name: "Testing",
          description: "Acceptance",
          url: "git+https://example.test/testing.git",
          consumers: ["examples"],
        },
      ],
    });
    expect(registry.templates[1]?.consumers).toEqual(["examples"]);
    for (const consumer of ["missing", "system-testing"]) {
      expect(
        templateRegistrySchema.safeParse({
          ...registry,
          templates: registry.templates.map((entry) =>
            entry.role === "development" ? { ...entry, consumers: [consumer] } : entry
          ),
        }).success
      ).toBe(false);
    }
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

it("requires current host coordinates in update status", () => {
  expect(
    templatesMethods.updateStatus.returns.safeParse({ workspaceEpoch: 0, checks: [] }).success
  ).toBe(false);
  expect(
    templatesMethods.updateStatus.returns.parse({
      workspaceEpoch: 0,
      workspaceAppVersion: "0.1.84",
      currentAppVersion: "0.1.84",
      checks: [],
    })
  ).toHaveProperty("currentAppVersion", "0.1.84");
});
