import { describe, it, expect } from "vitest";

import { assertSafeVcsPath, normalizeRepoPathForLog } from "./paths.js";

describe("normalizeRepoPathForLog", () => {
  it("accepts canonical repo paths", () => {
    for (const ok of ["panels/chat", "packages/foo", "projects/vault", "meta"]) {
      expect(normalizeRepoPathForLog(ok), ok).toBe(ok);
    }
  });

  it("rejects non-canonical aliases that would collide on disk", () => {
    // These are the aliases refService.validateRepoPath also rejects: they must
    // never split into a second identity backing the same projection dir/cache.
    for (const bad of [
      "panels/./chat",
      "panels//chat",
      "./panels/chat",
      "panels/chat/",
      "/panels/chat",
      "panels\\chat",
      "..",
      "a/../b",
      "packages",
      "panels",
      "agents/scribe",
      "src",
      "projects/vault/sub",
      "",
    ]) {
      expect(() => normalizeRepoPathForLog(bad), bad).toThrow(/Invalid workspace repo path/);
    }
  });
});

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
