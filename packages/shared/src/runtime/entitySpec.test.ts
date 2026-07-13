import { describe, expect, it } from "vitest";
import { canonicalizeWorkspaceFilePath } from "./entitySpec.js";

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
