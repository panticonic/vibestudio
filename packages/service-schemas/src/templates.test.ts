import { describe, expect, it } from "vitest";
import { templateInspectionSchema, templateLocatorSchema, templatesMethods } from "./templates.js";

describe("templates contract", () => {
  it("contains only exact inspection and publication operations", () => {
    expect(Object.keys(templatesMethods)).toEqual([
      "resolveSource",
      "inspect",
      "inspectAuthoring",
      "authoringParts",
      "publishAuthoring",
    ]);
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
        files: ["README.md"],
      }).repositories
    ).toEqual(["workers/agent"]);
  });
});
