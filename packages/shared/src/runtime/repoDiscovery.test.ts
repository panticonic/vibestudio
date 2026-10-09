import { describe, expect, it } from "vitest";
import { discoverRepos } from "./repoDiscovery.js";

describe("discoverRepos", () => {
  it("discovers flat and container repositories from owned files", () => {
    expect(
      discoverRepos([
        "packages/core/src/index.ts",
        "packages/core/package.json",
        "projects/notes/readme.md",
        "meta/vibestudio.yml",
      ])
    ).toEqual([
      { repoPath: "meta", kind: "meta" },
      { repoPath: "packages/core", kind: "build-unit" },
      { repoPath: "projects/notes", kind: "content" },
    ]);
  });

  it("rejects a container-root file instead of minting an empty repository", () => {
    expect(() => discoverRepos(["workers/workerd.d.ts"])).toThrow(
      "move it into workers/<repo>/ so every source file has one repository owner"
    );
  });
});
