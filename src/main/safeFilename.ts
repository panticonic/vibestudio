const RESERVED_FILENAME_CHARACTERS = new Set('<>:"/\\|?*');

export function sanitizeFilenamePart(value: string, replacement: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || RESERVED_FILENAME_CHARACTERS.has(character)
        ? replacement
        : character;
    })
    .join("");
}
