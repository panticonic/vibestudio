/**
 * Pure decision layer behind the quick-open palette — no React, no runtime — so
 * the fuzzy ranking, recents fallback, and create-fallthrough rule are
 * unit-testable without mounting the (portaled) dialog. Mirrors how the terminal
 * keeps `commandLauncherModel`/`commandSources` separate from its launcher UI.
 */

export function labelFor(path: string): string {
  return (
    path
      .split("/")
      .pop()
      ?.replace(/\.mdx$/i, "") ?? path
  );
}

export interface FuzzyMatch {
  /** Higher is a better match. */
  score: number;
  /** Indices in `path` that matched, ascending (empty for an empty query). */
  positions: number[];
}

/**
 * Single source of truth for the fuzzy match: a contiguous substring scores
 * highest, otherwise a left-to-right subsequence walk. Returns the matched
 * positions too, so ranking (fuzzyScore) and highlighting (matchRanges) stay
 * consistent instead of re-deriving the walk in two places.
 */
export function fuzzyMatch(path: string, query: string): FuzzyMatch | null {
  const haystack = path.toLowerCase();
  const needle = query.trim().toLowerCase();
  if (!needle) return { score: 1, positions: [] };
  const direct = haystack.indexOf(needle);
  if (direct >= 0) {
    const positions: number[] = [];
    for (let i = 0; i < needle.length; i += 1) positions.push(direct + i);
    return { score: 100 - direct, positions };
  }
  let score = 0;
  let pos = 0;
  const positions: number[] = [];
  for (const ch of needle) {
    const found = haystack.indexOf(ch, pos);
    if (found < 0) return null;
    score += Math.max(1, 16 - (found - pos));
    positions.push(found);
    pos = found + 1;
  }
  return { score, positions };
}

export function fuzzyScore(path: string, query: string): number {
  return fuzzyMatch(path, query)?.score ?? 0;
}

/** Collapse ascending matched positions into contiguous [start, end) ranges. */
export function matchRanges(positions: number[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const index of positions) {
    const last = ranges[ranges.length - 1];
    if (last && index === last[1]) last[1] = index + 1;
    else ranges.push([index, index + 1]);
  }
  return ranges;
}

export function normalizeCreateName(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "";
  return trimmed.endsWith(".mdx") ? trimmed : `${trimmed}.mdx`;
}

export interface QuickOpenModel {
  /** Ranked vault paths to show as open targets. */
  results: string[];
  /** Normalized name for a would-be new note (`""` when not creatable). */
  createName: string;
  /** Whether the create affordance should appear. */
  canCreate: boolean;
  /** Section header for the result list. */
  section: string;
}

export function computeQuickOpen(args: {
  paths: string[];
  recentPaths: string[];
  query: string;
}): QuickOpenModel {
  const { paths, recentPaths, query } = args;
  const trimmed = query.trim();

  let results: string[];
  // Only call the result set "Recent" when recents that still exist were
  // actually used — recentPaths can be non-empty yet all point at deleted notes,
  // in which case we fall back to all notes and must label it as such.
  let usedRecent = false;
  if (!trimmed) {
    const existingRecent = recentPaths.filter((path) => paths.includes(path));
    usedRecent = existingRecent.length > 0;
    const source = usedRecent ? existingRecent : paths;
    results = source.slice(0, 12);
  } else {
    results = paths
      .map((path) => ({ path, score: fuzzyScore(path, query) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      .slice(0, 12)
      .map(({ path }) => path);
  }

  const createName = normalizeCreateName(query);
  const canCreate =
    !!createName && !paths.some((path) => path.toLowerCase() === createName.toLowerCase());
  const section = trimmed ? "Matches" : usedRecent ? "Recent" : "All notes";

  return { results, createName, canCreate, section };
}
