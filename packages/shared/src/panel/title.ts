/**
 * Normalize a user-visible panel title at the shared boundary.
 *
 * Titles are labels, not identifiers: remove control characters, collapse
 * whitespace, trim, and keep a bounded display length. `undefined` is the
 * canonical representation of a cleared title.
 */
export const MAX_PANEL_TITLE_LENGTH = 120;

export function normalizePanelTitle(input: string | null | undefined): string | undefined {
  if (input === null || input === undefined) return undefined;

  const cleaned = Array.from(input)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      // Whitespace controls are separators rather than visible content; keep
      // them so the collapse below does not join neighboring words together.
      if (codePoint < 0x20) {
        return (
          codePoint === 0x09 ||
          codePoint === 0x0a ||
          codePoint === 0x0b ||
          codePoint === 0x0c ||
          codePoint === 0x0d
        );
      }
      return codePoint !== 0x7f && (codePoint < 0x80 || codePoint > 0x9f);
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();

  if (!cleaned) return undefined;
  return Array.from(cleaned).slice(0, MAX_PANEL_TITLE_LENGTH).join("");
}
