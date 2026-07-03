import { describe, expect, it } from "vitest";
import { VCS_CONTAINER_SECTIONS, VCS_FLAT_SECTIONS, discoverRepoPaths } from "./repos.js";

describe("repo taxonomy (userland twin of the host section taxonomy)", () => {
  it("discovers container repos, flat repos, and ignores non-repo sections", () => {
    expect(
      discoverRepoPaths([
        "packages/core/src/index.ts",
        "packages/core/package.json",
        "panels/chat/index.tsx",
        "meta/vibez1.yml",
        "agents/scribe/AGENT.md", // non-repo section
        "unknown/thing.txt", // unknown section
        "projects/vault/notes.md",
      ])
    ).toEqual(["meta", "packages/core", "panels/chat", "projects/vault"]);
  });

  it("needs a name segment for container sections and dedupes", () => {
    expect(discoverRepoPaths(["packages", "packages/a/x", "packages/a/y"])).toEqual([
      "packages/a",
    ]);
  });

  it("classifies meta as flat and the container set as containers", () => {
    expect(VCS_FLAT_SECTIONS.has("meta")).toBe(true);
    expect(VCS_CONTAINER_SECTIONS.has("meta")).toBe(false);
    for (const section of ["panels", "apps", "packages", "workers", "extensions", "projects"]) {
      expect(VCS_CONTAINER_SECTIONS.has(section)).toBe(true);
    }
  });
});
