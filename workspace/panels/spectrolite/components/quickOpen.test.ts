import { describe, expect, it } from "vitest";
import {
  computeQuickOpen,
  fuzzyMatch,
  fuzzyScore,
  matchRanges,
  normalizeCreateName,
} from "./quickOpenModel";

// QuickOpen renders inside a Radix Dialog (portaled overlay), which can't open
// in jsdom (duplicate-React via react-remove-scroll, a pnpm hoist quirk). Its
// decision logic lives in the React-free quickOpenModel and is tested here; the
// rendering is exercised at runtime.

describe("normalizeCreateName", () => {
  it("appends .mdx and trims, and is empty for blank input", () => {
    expect(normalizeCreateName("  Notes ")).toBe("Notes.mdx");
    expect(normalizeCreateName("Notes.mdx")).toBe("Notes.mdx");
    expect(normalizeCreateName("   ")).toBe("");
  });
});

describe("fuzzyScore", () => {
  it("ranks a direct substring above a scattered subsequence", () => {
    expect(fuzzyScore("docs/readme.mdx", "readme")).toBeGreaterThan(
      fuzzyScore("docs/rxexamxe.mdx", "readme")
    );
  });
  it("scores non-matches at zero", () => {
    expect(fuzzyScore("alpha.mdx", "zzz")).toBe(0);
  });
});

describe("fuzzyMatch / matchRanges (shared highlight + score walk)", () => {
  it("returns one contiguous range for a substring hit", () => {
    const m = fuzzyMatch("readme.mdx", "adme")!; // "re[adme].mdx" → indices 2..5
    expect(m.positions).toEqual([2, 3, 4, 5]);
    expect(matchRanges(m.positions)).toEqual([[2, 6]]);
  });
  it("returns scattered single-char ranges for a subsequence hit", () => {
    const m = fuzzyMatch("alpha.mdx", "ax")!;
    // 'a' at 0, then 'x' at the .mdx — non-adjacent, so two ranges.
    expect(matchRanges(m.positions).length).toBe(2);
  });
  it("is null for no match and empty for a blank query", () => {
    expect(fuzzyMatch("alpha.mdx", "zzz")).toBeNull();
    expect(fuzzyMatch("alpha.mdx", "")!.positions).toEqual([]);
  });
});

describe("computeQuickOpen", () => {
  const paths = ["notes/alpha.mdx", "notes/beta.mdx", "journal/gamma.mdx"];

  it("falls back to existing recents (then all notes) when the query is blank", () => {
    const withRecent = computeQuickOpen({
      paths,
      recentPaths: ["notes/beta.mdx", "deleted.mdx"],
      query: "",
    });
    // "deleted.mdx" is no longer in paths, so it's filtered out of recents.
    expect(withRecent.results).toEqual(["notes/beta.mdx"]);
    expect(withRecent.section).toBe("Recent");

    const noRecent = computeQuickOpen({ paths, recentPaths: [], query: "" });
    expect(noRecent.results).toEqual(paths);
    expect(noRecent.section).toBe("All notes");

    // Recents that all point at deleted notes → fall back to all notes AND say so.
    const staleRecent = computeQuickOpen({ paths, recentPaths: ["gone.mdx"], query: "" });
    expect(staleRecent.results).toEqual(paths);
    expect(staleRecent.section).toBe("All notes");
  });

  it("ranks fuzzy matches and labels the section 'Matches'", () => {
    const model = computeQuickOpen({ paths, recentPaths: [], query: "beta" });
    expect(model.results[0]).toBe("notes/beta.mdx");
    expect(model.section).toBe("Matches");
  });

  it("offers create for a novel name and withholds it for an existing one", () => {
    const novel = computeQuickOpen({ paths, recentPaths: [], query: "brand-new" });
    expect(novel.canCreate).toBe(true);
    expect(novel.createName).toBe("brand-new.mdx");

    const existing = computeQuickOpen({ paths, recentPaths: [], query: "notes/alpha" });
    expect(existing.canCreate).toBe(false);
  });
});
