import { describe, expect, it } from "vitest";
import {
  buildCompareEntry,
  describeDiffTarget,
  focusedFileKind,
  parseDiffTarget,
  rowMatchesDiffTarget,
  shortHash,
  type DiffTarget,
} from "./diffTarget";

describe("parseDiffTarget", () => {
  it("parses a full target from the launch state-arg", () => {
    const target = parseDiffTarget({
      repoPath: "packages/demo",
      path: "src/util.ts",
      oldHash: "h-old",
      newHash: "h-new",
      oldState: "state:aaa",
      newState: "state:bbb",
    });
    expect(target).toEqual({
      repoPath: "packages/demo",
      path: "src/util.ts",
      oldHash: "h-old",
      newHash: "h-new",
      oldState: "state:aaa",
      newState: "state:bbb",
    });
  });

  it("keeps a null newState (delete) distinct from a missing one", () => {
    const removed = parseDiffTarget({ repoPath: "r", path: "p", newState: null });
    expect(removed?.newState).toBeNull();
    const minimal = parseDiffTarget({ repoPath: "r", path: "p" });
    expect(minimal).toEqual({ repoPath: "r", path: "p" });
    expect("newState" in (minimal as DiffTarget)).toBe(false);
  });

  it("rejects malformed / missing required fields without throwing", () => {
    expect(parseDiffTarget(null)).toBeNull();
    expect(parseDiffTarget(undefined)).toBeNull();
    expect(parseDiffTarget("nope")).toBeNull();
    expect(parseDiffTarget({ path: "p" })).toBeNull();
    expect(parseDiffTarget({ repoPath: "r" })).toBeNull();
    expect(parseDiffTarget({ repoPath: 1, path: "p" })).toBeNull();
  });

  it("parses the degrade flags and the changed-file set", () => {
    const target = parseDiffTarget({
      repoPath: "r",
      path: "b.ts",
      binary: true,
      tooLarge: true,
      files: [
        { path: "a.ts", kind: "added", newHash: "na" },
        { path: "b.ts", kind: "changed", oldHash: "ob", newHash: "nb", binary: true },
        // malformed entries are dropped, not fatal:
        { path: "c.ts" },
        { kind: "removed" },
        "nope",
      ],
    });
    expect(target?.binary).toBe(true);
    expect(target?.tooLarge).toBe(true);
    expect(target?.files).toEqual([
      { path: "a.ts", kind: "added", newHash: "na" },
      { path: "b.ts", kind: "changed", oldHash: "ob", newHash: "nb", binary: true },
    ]);
  });

  it("omits files when none of the entries validate", () => {
    const target = parseDiffTarget({ repoPath: "r", path: "p", files: [{ path: "x" }] });
    expect(target && "files" in target).toBe(false);
  });
});

describe("focusedFileKind", () => {
  it("derives changed / added / removed from the two hashes", () => {
    expect(focusedFileKind({ repoPath: "r", path: "p", oldHash: "o", newHash: "n" })).toBe(
      "changed"
    );
    expect(focusedFileKind({ repoPath: "r", path: "p", newHash: "n" })).toBe("added");
    expect(focusedFileKind({ repoPath: "r", path: "p", oldHash: "o" })).toBe("removed");
    expect(focusedFileKind({ repoPath: "r", path: "p", newState: null })).toBe("removed");
  });
});

describe("buildCompareEntry", () => {
  it("uses the whole changed-file set when present", () => {
    const target: DiffTarget = {
      repoPath: "packages/demo",
      path: "b.ts",
      oldState: "state:a",
      newState: "state:b",
      files: [
        { path: "a.ts", kind: "added", newHash: "na" },
        { path: "b.ts", kind: "changed", oldHash: "ob", newHash: "nb" },
      ],
    };
    expect(buildCompareEntry(target)).toEqual({
      repoPath: "packages/demo",
      oldState: "state:a",
      newState: "state:b",
      diffStat: { filesChanged: 2 },
      changedFiles: [
        { path: "a.ts", kind: "added", newHash: "na" },
        { path: "b.ts", kind: "changed", oldHash: "ob", newHash: "nb" },
      ],
    });
  });

  it("falls back to a single focused-file entry, carrying degrade flags", () => {
    const target: DiffTarget = {
      repoPath: "r",
      path: "logo.png",
      oldHash: "o",
      newHash: "n",
      oldState: "state:a",
      newState: "state:b",
      binary: true,
    };
    expect(buildCompareEntry(target)).toEqual({
      repoPath: "r",
      oldState: "state:a",
      newState: "state:b",
      diffStat: { filesChanged: 1 },
      changedFiles: [
        { path: "logo.png", kind: "changed", oldHash: "o", newHash: "n", binary: true },
      ],
    });
  });

  it("represents a removed target as a single removed file, newState null", () => {
    const entry = buildCompareEntry({ repoPath: "r", path: "p", oldHash: "o", newState: null });
    expect(entry.newState).toBeNull();
    expect(entry.changedFiles).toEqual([{ path: "p", kind: "removed", oldHash: "o" }]);
  });
});

describe("rowMatchesDiffTarget", () => {
  const target: DiffTarget = {
    repoPath: "packages/demo",
    path: "src/util.ts",
    newHash: "h-new",
  };

  it("matches on exact path", () => {
    expect(rowMatchesDiffTarget({ path: "src/util.ts", contentHash: "other" }, target)).toBe(true);
  });

  it("matches on the new-state content hash", () => {
    expect(rowMatchesDiffTarget({ path: "elsewhere.ts", contentHash: "h-new" }, target)).toBe(true);
  });

  it("does not match an unrelated row", () => {
    expect(rowMatchesDiffTarget({ path: "elsewhere.ts", contentHash: "other" }, target)).toBe(
      false
    );
  });
});

describe("shortHash / describeDiffTarget", () => {
  it("truncates and strips the algorithm prefix", () => {
    expect(shortHash("sha256:0123456789abcdef")).toBe("0123456789ab…");
    expect(shortHash("short")).toBe("short");
    expect(shortHash(null)).toBe("—");
  });

  it("describes an added/changed target with its short new state", () => {
    expect(
      describeDiffTarget({ repoPath: "r", path: "p", newState: "state:abcdef0123456789" })
    ).toBe("r · p @ abcdef012345…");
  });

  it("describes a removed target", () => {
    expect(describeDiffTarget({ repoPath: "r", path: "p", newState: null })).toBe(
      "r · p @ removed"
    );
  });
});
