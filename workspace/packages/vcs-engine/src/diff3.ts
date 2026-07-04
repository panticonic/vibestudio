/**
 * Vendored three-way line merge (diff3) — pure, no deps, workerd-safe.
 *
 * Userland home of the VCS text-merge semantics (eviction stage P5b). Also
 * hosts the provenance-hunk derivation (`computeReplaceHunks`) the edit engine
 * uses — since P5c the host has no copy of any of this.
 *
 * Standard shape: compute LCS-based alignments base↔ours and base↔theirs,
 * walk the base, take non-conflicting changes from either side, and emit
 * git-style conflict hunks where both sides changed the same region
 * differently.
 */

/* eslint-disable @typescript-eslint/no-non-null-assertion --
   Vendored, bounds-checked diff3: every array/typed-array index below is provably in
   range (the LCS table is (n+1)×(m+1); cursors are bounded by their loop conditions).
   The `!`s reflect noUncheckedIndexedAccess, not unsafe access. */

export interface Diff3Result {
  ok: boolean;
  /** Merged text (with conflict markers when !ok). */
  text: string;
  conflicts: number;
}

export interface Chunk {
  /** [start, end) in base */
  baseStart: number;
  baseEnd: number;
  /** replacement lines from the changed side */
  lines: string[];
}

/** Myers-lite LCS diff: returns chunks describing side's changes vs base. */
export function diffChunks(base: string[], side: string[]): Chunk[] {
  const n = base.length;
  const m = side.length;
  // LCS table (n+1 x m+1). Workspace files are small enough for O(n·m) here;
  // the merge engine only diff3s files that BOTH sides touched.
  const lcs: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        base[i] === side[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const chunks: Chunk[] = [];
  let i = 0;
  let j = 0;
  let pending: Chunk | null = null;
  const flush = (): void => {
    if (pending) {
      chunks.push(pending);
      pending = null;
    }
  };
  while (i < n || j < m) {
    if (i < n && j < m && base[i] === side[j]) {
      flush();
      i++;
      j++;
    } else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) {
      pending ??= { baseStart: i, baseEnd: i, lines: [] };
      pending.lines.push(side[j]!);
      j++;
    } else {
      pending ??= { baseStart: i, baseEnd: i, lines: [] };
      pending.baseEnd = i + 1;
      i++;
    }
  }
  flush();
  return chunks;
}

function sameLines(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

export interface Diff3Options {
  oursLabel?: string;
  theirsLabel?: string;
}

export function diff3Merge(
  baseText: string,
  oursText: string,
  theirsText: string,
  opts: Diff3Options = {}
): Diff3Result {
  // Fast paths
  if (oursText === theirsText) return { ok: true, text: oursText, conflicts: 0 };
  if (oursText === baseText) return { ok: true, text: theirsText, conflicts: 0 };
  if (theirsText === baseText) return { ok: true, text: oursText, conflicts: 0 };

  const base = splitLines(baseText);
  const ours = splitLines(oursText);
  const theirs = splitLines(theirsText);
  const oursChunks = diffChunks(base, ours);
  const theirsChunks = diffChunks(base, theirs);

  const out: string[] = [];
  let conflicts = 0;
  let cursor = 0; // position in base
  let oi = 0;
  let ti = 0;

  while (oi < oursChunks.length || ti < theirsChunks.length) {
    const oc = oursChunks[oi];
    const tc = theirsChunks[ti];
    const next = Math.min(oc?.baseStart ?? Infinity, tc?.baseStart ?? Infinity);
    // copy untouched base up to the next chunk
    for (; cursor < next; cursor++) out.push(base[cursor]!);

    const oActive = oc !== undefined && oc.baseStart <= cursor;
    const tActive = tc !== undefined && tc.baseStart <= cursor;
    const spansOverlap =
      oc !== undefined &&
      tc !== undefined &&
      (oActive || tActive) &&
      (oc.baseStart === tc.baseStart || (oc.baseStart < tc.baseEnd && tc.baseStart < oc.baseEnd));

    if (spansOverlap) {
      if (!oc || !tc) throw new Error("internal diff3 overlap without both chunks");
      // Overlapping region: extend to the union of both sides' base spans,
      // absorbing any further chunks that fall inside the union.
      let regionEnd = Math.max(oc.baseEnd, tc.baseEnd, cursor);
      const oursLines: string[] = [...oc.lines];
      const theirsLines: string[] = [...tc.lines];
      // Per-side coverage: base extent already represented in that side's
      // lines, so gap-filling never duplicates or resurrects base lines.
      let oursCovEnd = oc.baseEnd;
      let theirsCovEnd = tc.baseEnd;
      oi++;
      ti++;
      let grew = true;
      while (grew) {
        grew = false;
        while (oi < oursChunks.length && oursChunks[oi]!.baseStart < regionEnd) {
          const chunk = oursChunks[oi]!;
          // unchanged base lines between the previous chunk and this one
          for (let k = oursCovEnd; k < chunk.baseStart; k++) oursLines.push(base[k]!);
          oursLines.push(...chunk.lines);
          oursCovEnd = Math.max(oursCovEnd, chunk.baseEnd);
          regionEnd = Math.max(regionEnd, chunk.baseEnd);
          oi++;
          grew = true;
        }
        while (ti < theirsChunks.length && theirsChunks[ti]!.baseStart < regionEnd) {
          const chunk = theirsChunks[ti]!;
          for (let k = theirsCovEnd; k < chunk.baseStart; k++) theirsLines.push(base[k]!);
          theirsLines.push(...chunk.lines);
          theirsCovEnd = Math.max(theirsCovEnd, chunk.baseEnd);
          regionEnd = Math.max(regionEnd, chunk.baseEnd);
          ti++;
          grew = true;
        }
      }
      // Lines of base between each side's covered span and regionEnd that the
      // side did NOT change are part of that side's view of the region.
      const oursView = regionView(base, oc.baseStart, oursCovEnd, regionEnd, oursLines, cursor);
      const theirsView = regionView(
        base,
        tc.baseStart,
        theirsCovEnd,
        regionEnd,
        theirsLines,
        cursor
      );

      if (sameLines(oursView, theirsView)) {
        out.push(...oursView);
      } else {
        conflicts++;
        out.push(`<<<<<<< ${opts.oursLabel ?? "ours"}`);
        out.push(...oursView);
        out.push("=======");
        out.push(...theirsView);
        out.push(`>>>>>>> ${opts.theirsLabel ?? "theirs"}`);
      }
      cursor = regionEnd;
    } else if (oActive && !tActive) {
      out.push(...oc.lines);
      cursor = Math.max(cursor, oc.baseEnd);
      oi++;
    } else if (tActive && !oActive) {
      out.push(...tc.lines);
      cursor = Math.max(cursor, tc.baseEnd);
      ti++;
    }
  }
  for (; cursor < base.length; cursor++) out.push(base[cursor]!);

  return { ok: conflicts === 0, text: joinLines(out, baseText, oursText, theirsText), conflicts };
}

/** A side's content for the conflict region [start, regionEnd). */
function regionView(
  base: string[],
  chunkStart: number,
  chunkEnd: number,
  regionEnd: number,
  changedLines: string[],
  regionStart: number
): string[] {
  const view: string[] = [];
  // base lines before the side's own chunk inside the region
  for (let k = regionStart; k < chunkStart; k++) view.push(base[k]!);
  view.push(...changedLines);
  // base lines after the side's chunk through the region end
  for (let k = chunkEnd; k < regionEnd; k++) view.push(base[k]!);
  return view;
}

/**
 * An origin-annotated hunk describing how OURS becomes the merged result, at
 * line granularity — the provenance shape a clean merge commit records so blame
 * attributes incoming lines to the merge (spec U3), rather than recording an
 * op-less commit. Char offsets index OURS (same convention as
 * {@link computeReplaceHunks}); `newText` is the merged replacement. `origin` is
 * "theirs" when the region was unchanged on OURS and taken from THEIRS, and
 * "resolved" when both sides changed the region and the 3-way merge combined
 * them. Pure provenance — never replayed.
 */
export interface MergeHunk {
  start: number;
  end: number;
  newText: string;
  origin: "theirs" | "resolved";
  /** Char offsets into THEIRS the incoming block aligns to — set on `theirs`
   *  hunks so blame can route a hit here into the other parent's own chain
   *  (§5.2 step 3). `theirsText.slice(theirsStart, theirsEnd) === newText` for a
   *  clean take-theirs block; a `theirs` deletion carries a zero-width anchor. */
  theirsStart?: number;
  theirsEnd?: number;
}

/**
 * Derive origin-annotated merge hunks vs OURS from the same LCS chunk alignment
 * {@link diff3Merge} uses internally — surfaced (not duplicated) so merge
 * commits can record per-file ops. Operates on the already-computed merged text
 * for a CLEAN merge (no conflict markers); each divergence of the merged text
 * from OURS is one hunk, labelled "resolved" when OURS also changed that region
 * relative to BASE (both sides contributed) else "theirs". A "theirs" hunk also
 * carries its source char span in THEIRS ({@link MergeHunk.theirsStart}) so
 * blame can route into the other parent's chain (§5.2).
 */
export function mergeHunksVsOurs(
  baseText: string,
  oursText: string,
  theirsText: string,
  mergedText: string
): MergeHunk[] {
  if (oursText === mergedText) return [];
  const oursLines = oursText.split("\n");
  const mergedLines = mergedText.split("\n");
  const baseLines = baseText.split("\n");
  const theirsLines = theirsText.split("\n");
  // Regions of OURS that differ from BASE (ours' own edits), keyed by ours-line
  // index — used to distinguish "resolved" (ours touched it too) from "theirs".
  const oursChangedLines = new Set<number>();
  {
    // Walk an LCS alignment of base→ours in OURS coordinates.
    let bi = 0;
    let oi = 0;
    const chunks = diffChunks(baseLines, oursLines);
    // diffChunks yields base-coordinate spans with the replacement (ours) lines;
    // reconstruct which ours-line indices are inside a replacement.
    for (const c of chunks) {
      // ours lines emitted between the previous chunk end and this chunk are
      // copied base lines (unchanged); advance oi/bi accordingly.
      const copyBase = c.baseStart - bi;
      oi += copyBase;
      bi = c.baseStart;
      for (let k = 0; k < c.lines.length; k++) oursChangedLines.add(oi + k);
      oi += c.lines.length;
      bi = c.baseEnd;
    }
  }
  const oursOffset = lineStartOffsets(oursLines, oursText.length);
  const theirsOffset = lineStartOffsets(theirsLines, theirsText.length);
  // Built lazily on the first "theirs" hunk: each merged-line index → the
  // THEIRS-line it copies, so an incoming block resolves to its source range.
  let mergedToTheirs: Array<number | null> | null = null;
  const hunks: MergeHunk[] = [];
  // ours → merged chunk alignment (ours-coordinate spans in c.baseStart/baseEnd),
  // tracking the merged-line cursor in lockstep for the theirs alignment.
  let oursCursor = 0;
  let mergedCursor = 0;
  for (const c of diffChunks(oursLines, mergedLines)) {
    mergedCursor += c.baseStart - oursCursor;
    const mergedStart = mergedCursor;
    const start = Math.min(oursOffset[c.baseStart] ?? oursText.length, oursText.length);
    const end =
      c.baseEnd > c.baseStart
        ? Math.min(oursOffset[c.baseEnd] ?? oursText.length, oursText.length)
        : start;
    const replacement = c.lines.length > 0 ? c.lines.join("\n") : "";
    let oursTouched = false;
    for (let k = c.baseStart; k < c.baseEnd; k++) {
      if (oursChangedLines.has(k)) {
        oursTouched = true;
        break;
      }
    }
    const hunk: MergeHunk = {
      start,
      end,
      newText: c.lines.length > 0 && end < oursText.length ? `${replacement}\n` : replacement,
      origin: oursTouched ? "resolved" : "theirs",
    };
    if (hunk.origin === "theirs") {
      mergedToTheirs ??= mergedToTheirsLineMap(theirsLines, mergedLines);
      const theirsStartLine =
        mergedStart < mergedToTheirs.length ? mergedToTheirs[mergedStart] : null;
      // newText is always a prefix of the aligned THEIRS block (it may drop the
      // block's trailing "\n" at ours' last line), so `start + newText.length`
      // slices back to exactly newText and keeps `start + offsetWithin` routing
      // exact — see MergeHunk.theirsStart.
      const theirsStart =
        theirsStartLine != null
          ? Math.min(theirsOffset[theirsStartLine] ?? theirsText.length, theirsText.length)
          : theirsText.length; // deletion at/past MERGED's end → zero-width anchor
      hunk.theirsStart = theirsStart;
      hunk.theirsEnd = theirsStart + hunk.newText.length;
    }
    hunks.push(hunk);
    mergedCursor = mergedStart + c.lines.length;
    oursCursor = c.baseEnd;
  }
  return hunks;
}

/** Char offset of each line's start (sentinel one past the last line). */
function lineStartOffsets(lines: string[], textLength: number): number[] {
  const offsets: number[] = [];
  let off = 0;
  for (const line of lines) {
    offsets.push(off);
    off += line.length + 1; // + "\n"
  }
  offsets.push(textLength);
  return offsets;
}

/**
 * For each merged-line index, the THEIRS-line index it copies verbatim, or
 * `null` where the merged line has no direct counterpart in THEIRS (it came
 * from OURS or a resolution). Derived from the same LCS alignment the merge
 * uses, so a clean "theirs" block maps to a contiguous THEIRS line range.
 */
function mergedToTheirsLineMap(theirsLines: string[], mergedLines: string[]): Array<number | null> {
  const map: Array<number | null> = new Array<number | null>(mergedLines.length).fill(null);
  let ti = 0; // theirs line
  let mi = 0; // merged line
  for (const c of diffChunks(theirsLines, mergedLines)) {
    const common = c.baseStart - ti;
    for (let k = 0; k < common; k++) map[mi + k] = ti + k;
    mi += common + c.lines.length;
    ti = c.baseEnd;
  }
  for (let k = mi; k < mergedLines.length; k++) map[k] = ti + (k - mi);
  return map;
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function joinLines(
  lines: string[],
  baseText: string,
  oursText: string,
  theirsText: string
): string {
  const text = lines.join("\n");
  // Preserve a trailing newline when any input ended with one.
  const trailing = baseText.endsWith("\n") || oursText.endsWith("\n") || theirsText.endsWith("\n");
  return text.length > 0 && trailing ? `${text}\n` : text;
}

/**
 * Derive character-offset replace-hunks describing how `oldText` becomes
 * `newText`, at line granularity. Used to give whole-file writes (the shape
 * fs.writeFile/appendFile/truncate/copyFile/rename-into produce) the same
 * hunk-level provenance as the agent `replace`/`edit` tool. Hunks here are pure
 * PROVENANCE — never replayed (replay uses the post-content hash) — so the
 * offsets are reasonable line-region spans, not a byte-exact patch. Returns a
 * single whole-file hunk if the texts share no line structure.
 */
export function computeReplaceHunks(
  oldText: string,
  newText: string
): Array<{ start: number; end: number; oldText: string; newText: string }> {
  if (oldText === newText) return [];
  const oldLines = oldText.split("\n");
  const chunks = diffChunks(oldLines, newText.split("\n"));
  if (chunks.length === 0) return [];
  // Char offset of each line start in oldText (sentinel one past the last line).
  const lineOffset: number[] = [];
  let off = 0;
  for (const l of oldLines) {
    lineOffset.push(off);
    off += l.length + 1; // + "\n"
  }
  lineOffset.push(oldText.length);
  const hunks: Array<{ start: number; end: number; oldText: string; newText: string }> = [];
  for (const c of chunks) {
    const start = Math.min(lineOffset[c.baseStart] ?? oldText.length, oldText.length);
    const end =
      c.baseEnd > c.baseStart
        ? Math.min(lineOffset[c.baseEnd] ?? oldText.length, oldText.length)
        : start;
    const replacement = c.lines.length > 0 ? c.lines.join("\n") : "";
    hunks.push({
      start,
      end,
      oldText: oldText.slice(start, end),
      // Keep a trailing newline on a multi-line insertion that lands at a line boundary.
      newText: c.lines.length > 0 && end < oldText.length ? `${replacement}\n` : replacement,
    });
  }
  return hunks;
}
