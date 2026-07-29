/**
 * Pure local-state helpers for the Collection panel.
 *
 * Kept free of `@vibestudio/runtime` imports so they unit-test in a plain
 * Node/vitest environment without a panel runtime.
 */
import type { CollectionOrchestrationState } from "@workspace/collection-orchestration";

export interface CollectionStateArgs extends CollectionOrchestrationState {
  /** Display name; also pushed to the panel title when the user edits it. */
  title?: string;
  /** Free-form notes about the collection as a whole. */
  note?: string;
  /** Per-child notes, keyed by panel id. */
  notes?: Record<string, string>;
  /** Where the collection came from, e.g. "Firefox · Window 2". Set by the creator. */
  origin?: string;
}

/** Merge a per-child note into the persisted map, dropping emptied notes. */
export function withMemberNote(
  notes: Record<string, string> | undefined,
  panelId: string,
  note: string
): Record<string, string> {
  const next = { ...(notes ?? {}) };
  const trimmed = note.trim();
  if (trimmed) next[panelId] = trimmed;
  else delete next[panelId];
  return next;
}

/** Drop notes for panels that are no longer members, so state does not grow forever. */
export function pruneNotes(
  notes: Record<string, string> | undefined,
  memberIds: readonly string[]
): Record<string, string> {
  const live = new Set(memberIds);
  return Object.fromEntries(Object.entries(notes ?? {}).filter(([id]) => live.has(id)));
}
