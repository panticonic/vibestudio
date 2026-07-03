/**
 * Edit-op application over content-addressed working file maps — the userland
 * VCS EDIT semantics (eviction stage P5c; formerly the host's
 * `WorkspaceVcs.buildEditOpRows` + `applyReplaceHunks`).
 *
 * Pure over injected blob IO and workerd-safe (no Node imports, no Buffer):
 * base blob bytes are read from the store that owns them (the host content
 * store over the gad DO's blobstore RPC bridge), new bytes written back, and
 * the result is the new working file map plus the edit-op rows (kind / path /
 * old+new content hash / provenance hunks / mode) the store persists.
 *
 * The op union is the canonical edit input: file create/overwrite/delete/mode
 * are first-class, `replace` hunks are exact ranges into the base content the
 * author saw (no fuzzy matching here), and whole-file `write` over an existing
 * TEXT file is diffed into hunks so fs-library writes carry the same
 * hunk-level provenance as the agent replace/edit tool.
 */

import { computeReplaceHunks } from "./diff3.js";
import { assertSafeVcsPath, assertWritableVcsEditPath } from "./paths.js";

/** One file of a working file map (path → content address + mode). */
export interface WorkingFileEntry {
  path: string;
  contentHash: string;
  mode: number;
  size?: number;
}

/**
 * Wire-safe file content for write/create ops. `blob` references bytes already
 * in the content store by digest (the revert path re-instates pre-transition
 * content without moving bytes); note the content store's read policy already
 * admits every edit-capable caller, so a blob reference discloses nothing a
 * direct blob read would not.
 */
export type EditContent =
  | { kind: "text"; text: string }
  | { kind: "bytes"; base64: string }
  | { kind: "blob"; contentHash: string };

export interface ReplaceHunk {
  start: number;
  end: number;
  oldText?: string;
  newText: string;
}

/** The canonical edit-op union (see module doc). */
export type EditOp =
  | { kind: "replace"; path: string; hunks: ReplaceHunk[] }
  | { kind: "write"; path: string; content: EditContent; mode?: number }
  | { kind: "create"; path: string; content: EditContent; mode?: number }
  | { kind: "delete"; path: string }
  | { kind: "chmod"; path: string; mode: number };

/** One edit-op row to persist (uncommitted; the store assigns edit_seq). */
export interface EditOpRowDraft {
  kind: "replace" | "write" | "create" | "delete" | "chmod";
  path: string;
  oldContentHash: string | null;
  newContentHash: string | null;
  hunks?: unknown;
  mode?: number | null;
}

export interface EditEngineDeps {
  /** Full blob bytes by content digest; null when absent (missing = loud error). */
  readBlob(digest: string): Promise<Uint8Array | null>;
  /** Store bytes; returns the content digest + byte size (idempotent). */
  writeBlob(bytes: Uint8Array): Promise<{ digest: string; size: number }>;
}

const UTF8_FATAL = new TextDecoder("utf-8", { fatal: true });
const UTF8_ENCODER = new TextEncoder();

/** Decode bytes as UTF-8 text iff they are valid text (no NUL); else null. */
export function decodeUtf8Text(bytes: Uint8Array): string | null {
  try {
    const text = UTF8_FATAL.decode(bytes);
    return text.includes("\u0000") ? null : text;
  } catch {
    return null;
  }
}

export function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s/gu, "");
  let binary: string;
  try {
    binary = atob(normalized);
  } catch {
    throw new Error("bytes content is not valid base64");
  }
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Apply exact-range replacement hunks to base content (right-to-left so
 * earlier offsets stay valid). Verifies `oldText` when supplied.
 */
export function applyReplaceHunks(content: string, hunks: ReplaceHunk[]): string {
  const sorted = [...hunks].sort((a, b) => b.start - a.start);
  let prevStart = content.length + 1;
  let out = content;
  for (const h of sorted) {
    if (h.start < 0 || h.end > content.length || h.start > h.end) {
      throw new Error(`replace hunk out of range [${h.start},${h.end}] (len ${content.length})`);
    }
    if (h.end > prevStart) throw new Error(`overlapping replace hunks at ${h.start}`);
    prevStart = h.start;
    if (h.oldText !== undefined && content.slice(h.start, h.end) !== h.oldText) {
      throw new Error(`replace hunk oldText mismatch at [${h.start},${h.end}]`);
    }
    out = out.slice(0, h.start) + h.newText + out.slice(h.end);
  }
  return out;
}

/** In-file conflict-marker probe (commit refuses unresolved merge markers). */
export const CONFLICT_MARKER_RE = /^(<{7}|={7}|>{7})/m;

export function hasConflictMarkers(text: string): boolean {
  return CONFLICT_MARKER_RE.test(text);
}

export class EditEngine {
  constructor(private readonly deps: EditEngineDeps) {}

  /** Resolve an EditContent to (bytes-in-store, digest, size). */
  private async putContent(
    content: EditContent,
    label: string
  ): Promise<{ digest: string; size: number }> {
    if (content.kind === "text") {
      return this.deps.writeBlob(UTF8_ENCODER.encode(content.text));
    }
    if (content.kind === "bytes") {
      return this.deps.writeBlob(base64ToBytes(content.base64));
    }
    if (content.kind === "blob") {
      const bytes = await this.deps.readBlob(content.contentHash);
      if (!bytes) {
        throw new Error(`${label}: referenced blob missing from store: ${content.contentHash}`);
      }
      return { digest: content.contentHash, size: bytes.length };
    }
    throw new Error("unknown file content kind");
  }

  /** Text of a stored blob when it is valid UTF-8 text, else null. */
  private async blobText(digest: string): Promise<string | null> {
    const bytes = await this.deps.readBlob(digest);
    return bytes ? decodeUtf8Text(bytes) : null;
  }

  /**
   * Apply `edits` over a working file map → the new map + the edit-op rows to
   * persist. Blobs are written to the store here; the input map is not
   * mutated.
   */
  async applyEditOps(
    base: ReadonlyMap<string, WorkingFileEntry>,
    edits: EditOp[]
  ): Promise<{ files: Map<string, WorkingFileEntry>; rows: EditOpRowDraft[] }> {
    const files = new Map(base);
    const rows: EditOpRowDraft[] = [];
    for (const op of edits) {
      // Store-boundary path guards (any client-side guard is bypassable).
      assertSafeVcsPath(op.path);
      if (op.kind === "create" || op.kind === "write") assertWritableVcsEditPath(op.path);
      const before = files.get(op.path);
      const oldHash = before?.contentHash ?? null;
      if (op.kind === "delete") {
        if (!files.delete(op.path)) throw new Error(`delete: no such path ${op.path}`);
        rows.push({ kind: "delete", path: op.path, oldContentHash: oldHash, newContentHash: null });
        continue;
      }
      if (op.kind === "chmod") {
        if (!before) throw new Error(`chmod: no such path ${op.path}`);
        files.set(op.path, { ...before, mode: op.mode });
        rows.push({
          kind: "chmod",
          path: op.path,
          oldContentHash: oldHash,
          newContentHash: oldHash,
          mode: op.mode,
        });
        continue;
      }
      if (op.kind === "create" || op.kind === "write") {
        if (op.kind === "create" && before) {
          throw new Error(`create: path already exists ${op.path}`);
        }
        const { digest, size } = await this.putContent(op.content, op.kind);
        const mode = op.mode ?? before?.mode ?? 33188;
        files.set(op.path, { path: op.path, contentHash: digest, mode, size });
        // Whole-file write over an existing TEXT file → hunk-level provenance
        // (pure provenance: replay uses the post-content hash, never the hunks).
        let hunks: unknown | undefined;
        if (op.kind === "write" && before && digest !== before.contentHash) {
          const oldText = await this.blobText(before.contentHash);
          const newText = oldText !== null ? await this.blobText(digest) : null;
          if (oldText !== null && newText !== null) {
            const h = computeReplaceHunks(oldText, newText);
            if (h.length > 0) hunks = h;
          }
        }
        rows.push({
          kind: op.kind,
          path: op.path,
          oldContentHash: oldHash,
          newContentHash: digest,
          ...(hunks !== undefined ? { hunks } : {}),
          mode,
        });
        continue;
      }
      // replace — exact hunks into the current content.
      if (!before) throw new Error(`replace: no such path ${op.path}`);
      const baseBytes = await this.deps.readBlob(before.contentHash);
      if (!baseBytes) throw new Error(`replace: base blob missing for ${op.path}`);
      const baseText = decodeUtf8Text(baseBytes);
      if (baseText === null) {
        throw new Error(`replace: cannot apply text hunks to binary file ${op.path}`);
      }
      const nextText = applyReplaceHunks(baseText, op.hunks);
      const { digest, size } = await this.deps.writeBlob(UTF8_ENCODER.encode(nextText));
      files.set(op.path, { ...before, contentHash: digest, size });
      rows.push({
        kind: "replace",
        path: op.path,
        oldContentHash: oldHash,
        newContentHash: digest,
        hunks: op.hunks,
      });
    }
    return { files, rows };
  }
}
