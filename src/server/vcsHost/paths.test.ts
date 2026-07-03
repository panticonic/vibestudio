import { describe, it, expect } from "vitest";

import { assertSafeVcsPath } from "./paths.js";

describe("assertSafeVcsPath", () => {
  it("rejects escapes, absolute paths, and NUL", () => {
    expect(() => assertSafeVcsPath("../up.txt")).toThrow(/escapes worktree/);
    expect(() => assertSafeVcsPath("/abs.txt")).toThrow(/escapes worktree/);
    expect(() => assertSafeVcsPath("a/../b")).toThrow(/escapes worktree/);
    expect(() => assertSafeVcsPath("a\0b")).toThrow(/escapes worktree/);
    expect(() => assertSafeVcsPath("")).toThrow(/empty/);
  });

  it("rejects segments the tree encoder rejects (`.`, empty, backslash)", () => {
    // Mirrors splitTreePath/assertValidTreeEntryName in
    // packages/shared/src/contentTree/treeObjects.ts — these must fail at the
    // guard, not later at tree-encode time as phantom working-map keys.
    for (const bad of ["a/./b", "a//b", "./a", "foo/", ".", "a\\b"]) {
      expect(() => assertSafeVcsPath(bad), bad).toThrow(/valid tree path|escapes/);
    }
  });

  it("accepts ordinary repo-relative paths", () => {
    for (const ok of ["a/b", "a.b/c", "ok/nested.txt", "single", "packages/foo/index.ts"]) {
      expect(() => assertSafeVcsPath(ok), ok).not.toThrow();
    }
  });
});
