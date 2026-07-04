/**
 * Three-way merge over content-addressed worktree states — the userland VCS
 * merge semantics (eviction stage P5b).
 *
 * Pure over injected deps and workerd-safe (no Node imports, no Buffer): state
 * file listings and the merge base come from the store that owns lineage (the
 * gad DO's SQL, or a content-store tree listing for states it has not
 * recorded), file bytes from the blobstore, merged text written back to the
 * blobstore. Callers commit the result — no refs move here.
 *
 * Standard case table per path over (base, ours, theirs):
 *   unchanged/unchanged → keep            changed/unchanged → take changed
 *   added one side      → take addition   deleted one side (other unchanged) → delete
 *   both changed same   → take it         both changed differently → diff3 (text) / conflict (binary)
 *   add/add same        → take it         add/add different → diff3 / conflict
 *   delete vs change    → conflict (keep changed side's content, flag)
 */

import { diff3Merge, mergeHunksVsOurs, type MergeHunk } from "./diff3.js";

export type { MergeHunk } from "./diff3.js";

/** One file of a worktree state (normalized camelCase). */
export interface StateFileEntry {
  path: string;
  contentHash: string;
  mode: number;
}

export interface MergeConflict {
  path: string;
  kind: "content" | "binary" | "delete-vs-change" | "mode";
}

export interface MergeComputation {
  status: "clean" | "conflicted" | "up-to-date" | "fast-forward";
  files: Array<{
    path: string;
    contentHash: string;
    size: number;
    mode: number;
    /** Origin-annotated line hunks vs OURS for a text file the 3-way merge
     *  rewrote (spec U3) — the provenance a clean merge commit records so blame
     *  attributes incoming lines. Absent for whole-file take-ours/take-theirs
     *  and binary keeps (the commit records a whole-file op for those). */
    hunks?: MergeHunk[];
  }>;
  conflicts: MergeConflict[];
  baseStateHash: string | null;
}

export interface MergeEngineDeps {
  /** Full file listing of a state (`state:<hex64>`). Must throw for an
   *  unknown state — an empty listing means "empty tree", never "not found". */
  listStateFiles(stateHash: string): Promise<StateFileEntry[]>;
  /** Lowest common ancestor over the transition DAG; null when unrelated. */
  getMergeBase(leftStateHash: string, rightStateHash: string): Promise<string | null>;
  readBlob(digest: string): Promise<Uint8Array | null>;
  writeBlob(bytes: Uint8Array): Promise<{ digest: string; size: number }>;
}

const UTF8_DECODER = new TextDecoder("utf-8");
const UTF8_ENCODER = new TextEncoder();

function byPath(files: StateFileEntry[]): Map<string, StateFileEntry> {
  return new Map(files.map((file) => [file.path, file]));
}

function looksBinary(bytes: Uint8Array): boolean {
  const probe = bytes.subarray(0, 8192);
  return probe.includes(0);
}

/**
 * 3-way merge of the file mode, independent of content. A mode changed on
 * exactly one side is taken; both sides changing it to different values is a
 * conflict (ours kept provisionally). Without this, the content arm would force
 * a single side's mode and silently drop a legitimate chmod (e.g. +x).
 */
function resolveMode(
  b: StateFileEntry | undefined,
  o: StateFileEntry,
  t: StateFileEntry
): { mode: number; conflict: boolean } {
  const base = b?.mode;
  const oursChanged = o.mode !== base;
  const theirsChanged = t.mode !== base;
  if (oursChanged && theirsChanged) {
    return o.mode === t.mode ? { mode: o.mode, conflict: false } : { mode: o.mode, conflict: true };
  }
  if (theirsChanged) return { mode: t.mode, conflict: false };
  // Only ours changed, or neither changed (o.mode === base): ours' mode wins.
  return { mode: o.mode, conflict: false };
}

export class MergeEngine {
  constructor(private readonly deps: MergeEngineDeps) {}

  private async stateFiles(stateHash: string | null): Promise<StateFileEntry[]> {
    if (!stateHash) return [];
    return await this.deps.listStateFiles(stateHash);
  }

  private async readBlob(digest: string): Promise<Uint8Array> {
    const bytes = await this.deps.readBlob(digest);
    if (!bytes) throw new Error(`merge: blob missing from CAS: ${digest}`);
    return bytes;
  }

  /**
   * Compute the merge of `theirs` into `ours`, discovering the merge base from
   * the transition DAG. Pure over store values — no refs are moved and nothing
   * is appended; callers commit the result.
   */
  async compute(
    oursStateHash: string,
    theirsStateHash: string,
    labels: { ours: string; theirs: string }
  ): Promise<MergeComputation> {
    if (oursStateHash === theirsStateHash) {
      return { status: "up-to-date", files: [], conflicts: [], baseStateHash: oursStateHash };
    }
    const baseStateHash = await this.deps.getMergeBase(oursStateHash, theirsStateHash);
    return this.mergeFromBase(baseStateHash, oursStateHash, theirsStateHash, labels);
  }

  /**
   * Compute the merge of `theirs` into `ours` against an explicitly supplied
   * `base` — for callers that authored `ours` as an in-memory draft off a
   * known base and never recorded a DAG edge to it. Avoids the merge-base
   * lookup entirely.
   */
  async compute3(
    input: { base: string | null; ours: string; theirs: string },
    labels: { ours: string; theirs: string }
  ): Promise<MergeComputation> {
    if (input.ours === input.theirs) {
      return { status: "up-to-date", files: [], conflicts: [], baseStateHash: input.ours };
    }
    return this.mergeFromBase(input.base, input.ours, input.theirs, labels);
  }

  /** Shared 3-way merge body once the base state hash is known. */
  private async mergeFromBase(
    baseStateHash: string | null,
    oursStateHash: string,
    theirsStateHash: string,
    labels: { ours: string; theirs: string }
  ): Promise<MergeComputation> {
    if (baseStateHash === theirsStateHash) {
      return { status: "up-to-date", files: [], conflicts: [], baseStateHash };
    }

    const [baseFiles, oursFiles, theirsFiles] = await Promise.all([
      this.stateFiles(baseStateHash),
      this.stateFiles(oursStateHash),
      this.stateFiles(theirsStateHash),
    ]);
    if (baseStateHash === oursStateHash) {
      return {
        status: "fast-forward",
        files: theirsFiles.map((file) => ({
          path: file.path,
          contentHash: file.contentHash,
          size: 0,
          mode: file.mode,
        })),
        conflicts: [],
        baseStateHash,
      };
    }

    const base = byPath(baseFiles);
    const ours = byPath(oursFiles);
    const theirs = byPath(theirsFiles);
    const allPaths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort();

    const merged: Array<{ path: string; contentHash: string; size: number; mode: number }> = [];
    const conflicts: MergeConflict[] = [];
    const keep = (file: StateFileEntry): void => {
      merged.push({ path: file.path, contentHash: file.contentHash, size: 0, mode: file.mode });
    };

    for (const path of allPaths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const oursChanged =
        (o?.contentHash ?? null) !== (b?.contentHash ?? null) ||
        (o?.mode ?? null) !== (b?.mode ?? null);
      const theirsChanged =
        (t?.contentHash ?? null) !== (b?.contentHash ?? null) ||
        (t?.mode ?? null) !== (b?.mode ?? null);

      if (!oursChanged && !theirsChanged) {
        if (o) keep(o);
        continue;
      }
      if (oursChanged && !theirsChanged) {
        if (o) keep(o); // includes ours-deleted (o absent → drop)
        continue;
      }
      if (theirsChanged && !oursChanged) {
        if (t) keep(t);
        continue;
      }
      // Both changed.
      if (o && t && o.contentHash === t.contentHash) {
        const m = resolveMode(b, o, t);
        keep({ ...o, mode: m.mode });
        if (m.conflict) conflicts.push({ path, kind: "mode" });
        continue;
      }
      if (!o && !t) continue; // both deleted
      if (!o || !t) {
        // delete vs change — keep the surviving change, flag the conflict
        conflicts.push({ path, kind: "delete-vs-change" });
        const survivor = o ?? t;
        if (survivor != null) keep(survivor);
        continue;
      }
      // Content-level: diff3 when all three are text.
      const [baseBytes, oursBytes, theirsBytes] = await Promise.all([
        b ? this.readBlob(b.contentHash) : Promise.resolve(new Uint8Array(0)),
        this.readBlob(o.contentHash),
        this.readBlob(t.contentHash),
      ]);
      if (looksBinary(baseBytes) || looksBinary(oursBytes) || looksBinary(theirsBytes)) {
        conflicts.push({ path, kind: "binary" });
        keep(o); // ours wins provisionally; theirs recoverable from its state
        continue;
      }
      const baseTextDecoded = UTF8_DECODER.decode(baseBytes);
      const oursTextDecoded = UTF8_DECODER.decode(oursBytes);
      const theirsTextDecoded = UTF8_DECODER.decode(theirsBytes);
      const result = diff3Merge(baseTextDecoded, oursTextDecoded, theirsTextDecoded, {
        oursLabel: labels.ours,
        theirsLabel: labels.theirs,
      });
      const bytes = UTF8_ENCODER.encode(result.text);
      const { digest, size } = await this.deps.writeBlob(bytes);
      const m = resolveMode(b, o, t);
      // U3: record origin-annotated hunks (vs OURS) only for a CLEANLY merged
      // text file — a conflicted result carries markers, not real provenance.
      const hunks = result.ok
        ? mergeHunksVsOurs(baseTextDecoded, oursTextDecoded, theirsTextDecoded, result.text)
        : undefined;
      merged.push({
        path,
        contentHash: digest,
        size,
        mode: m.mode,
        ...(hunks && hunks.length > 0 ? { hunks } : {}),
      });
      if (!result.ok) conflicts.push({ path, kind: "content" });
      if (m.conflict) conflicts.push({ path, kind: "mode" });
    }

    return {
      status: conflicts.length === 0 ? "clean" : "conflicted",
      files: merged,
      conflicts,
      baseStateHash,
    };
  }
}
