import { describe, expect, it } from "vitest";
import {
  describeDiffTarget,
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
});

describe("rowMatchesDiffTarget", () => {
  const target: DiffTarget = {
    repoPath: "packages/demo",
    path: "src/util.ts",
    newHash: "h-new",
  };

  it("matches on exact path", () => {
    expect(rowMatchesDiffTarget({ path: "src/util.ts", content_hash: "other" }, target)).toBe(true);
  });

  it("matches on the new-state content hash", () => {
    expect(rowMatchesDiffTarget({ path: "elsewhere.ts", content_hash: "h-new" }, target)).toBe(
      true
    );
  });

  it("does not match an unrelated row", () => {
    expect(rowMatchesDiffTarget({ path: "elsewhere.ts", content_hash: "other" }, target)).toBe(
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
    expect(describeDiffTarget({ repoPath: "r", path: "p", newState: null })).toBe("r · p @ removed");
  });
});
