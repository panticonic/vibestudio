import { describe, expect, it } from "vitest";
import { canonicalizeWorkspaceFilePath, normalizeWorkspaceRepoPath } from "./entitySpec.js";

describe("canonicalizeWorkspaceFilePath", () => {
  it("expands file-looking container roots into a canonical repo file", () => {
    expect(canonicalizeWorkspaceFilePath("projects/note.txt")).toBe("projects/note/note.txt");
    expect(canonicalizeWorkspaceFilePath("/panels/demo.tsx")).toBe("panels/demo/demo.tsx");
    expect(canonicalizeWorkspaceFilePath("workers/job-worker.ts")).toBe(
      "workers/job-worker/job-worker.ts"
    );
  });

  it("preserves existing repo files, ordinary repo roots, flat repos, and hidden ids", () => {
    expect(canonicalizeWorkspaceFilePath("projects/note/README.md")).toBe(
      "projects/note/README.md"
    );
    expect(canonicalizeWorkspaceFilePath("projects/note")).toBe("projects/note");
    expect(canonicalizeWorkspaceFilePath("meta")).toBe("meta");
    expect(canonicalizeWorkspaceFilePath("projects/.tmp-marker.txt")).toBe(
      "projects/.tmp-marker.txt"
    );
  });
});

describe("normalizeWorkspaceRepoPath", () => {
  it("names the shape it received instead of calling it empty", () => {
    // The mistake this reports: feeding a surface that returns `{ repoPath }`
    // rows straight into one that takes bare paths. "empty" sent three
    // successive attempts looking for a missing value.
    expect(() =>
      normalizeWorkspaceRepoPath({ repoPath: "packages/x" } as unknown as string)
    ).toThrow(/expected a string, received \{"repoPath":"packages\/x"\}/u);
    expect(() => normalizeWorkspaceRepoPath(undefined as unknown as string)).toThrow(
      /expected a string, received undefined/u
    );
    expect(() => normalizeWorkspaceRepoPath(null as unknown as string)).toThrow(
      /expected a string, received null/u
    );
    expect(() => normalizeWorkspaceRepoPath([] as unknown as string)).toThrow(
      /expected a string, received an array of 0/u
    );
  });

  it("still reports an empty string as empty", () => {
    expect(() => normalizeWorkspaceRepoPath("")).toThrow(/Invalid workspace repo path: empty/u);
  });

  it("bounds a large received value", () => {
    const wide = { repoPath: "packages/".padEnd(400, "x") };
    expect(() => normalizeWorkspaceRepoPath(wide as unknown as string)).toThrow(/…/u);
  });

  it("normalizes an ordinary repo path unchanged", () => {
    expect(normalizeWorkspaceRepoPath("packages/template-management")).toBe(
      "packages/template-management"
    );
    expect(normalizeWorkspaceRepoPath("meta")).toBe("meta");
  });
});
