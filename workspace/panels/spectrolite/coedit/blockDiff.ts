/**
 * Inline block-diff + suggestion resolution for the SuggestionCard (section C).
 *
 * Render a small inline diff of the user's live block vs the scribe's proposed
 * block. The user picks accept / keep-mine / merge;
 * resolving applies the chosen text to that block (and records the choice).
 * Pure + testable; the React card consumes these.
 */

import { diffWordsWithSpace } from "diff";

export interface DiffSegment {
  type: "equal" | "insert" | "delete";
  value: string;
}

/** Word-level diff of the user's text (old) vs the scribe's proposal (new). */
export function computeBlockDiff(oldText: string, newText: string): DiffSegment[] {
  return diffWordsWithSpace(oldText, newText).map((part) => ({
    type: part.added ? "insert" : part.removed ? "delete" : "equal",
    value: part.value,
  }));
}

export type SuggestionChoice = "accept" | "keep" | "merge";

/**
 * The text to apply for a chosen resolution:
 *  - accept → take the scribe's proposal
 *  - keep   → keep the user's live text (discard the suggestion)
 *  - merge  → both, scribe's appended below the user's, for the user to reconcile
 */
export function resolveSuggestion(
  choice: SuggestionChoice,
  userText: string,
  scribeText: string
): string {
  switch (choice) {
    case "accept":
      return scribeText;
    case "keep":
      return userText;
    case "merge":
      return `${userText.replace(/\s+$/, "")}\n\n${scribeText.replace(/^\s+/, "")}`;
  }
}
