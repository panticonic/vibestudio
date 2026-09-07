import { describe, expect, it } from "vitest";
import { templateInspectionSchema, templateLocatorSchema, templatesMethods } from "./templates.js";

describe("templates contract", () => {
  it("contains only upstream discovery, inspection, and publication operations", () => {
    expect(Object.keys(templatesMethods)).toEqual([
      "catalog", "inspect", "inspectAuthoring", "authoringParts", "publishAuthoring", "suggestRegistryEntry",
    ]);
  });
  it("binds catalog selections to an exact registry snapshot", () => {
    expect(templateLocatorSchema.safeParse({ catalogId: "base" }).success).toBe(false);
    expect(templateLocatorSchema.safeParse({
      catalogId: "base", registryCommit: "a".repeat(40), registrySnapshot: `v1-sha256:${"b".repeat(64)}`,
    }).success).toBe(true);
  });
  it("accepts an already reviewed exact pin for reinspection", () => {
    expect(templateLocatorSchema.parse({
      pin: { url: "https://example.com/base.git", ref: "refs/heads/main", commit: "a".repeat(40), snapshot: `v1-sha256:${"b".repeat(64)}` },
    })).toHaveProperty("pin.commit", "a".repeat(40));
  });
  it("describes one exact self-contained snapshot", () => {
    expect(templateInspectionSchema.parse({
      pin: { url: "https://example.com/base.git", ref: "refs/tags/v1", commit: "a".repeat(40), snapshot: `v1-sha256:${"b".repeat(64)}` },
      presentation: { name: "Base", description: "Common source" }, repositories: ["workers/agent"], files: ["README.md"],
    }).repositories).toEqual(["workers/agent"]);
  });
});
