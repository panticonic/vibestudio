/**
 * Compare JavaScript strings lexicographically by their UTF-16 code units.
 *
 * This is the text order used by canonical JSON object keys and by JavaScript's
 * default string sort. It is runtime- and locale-independent: it performs no
 * collation, Unicode normalization, case folding, or code-point conversion.
 * Protocol-visible sequences must use this comparator instead of
 * `localeCompare`, whose result depends on the runtime's ICU data and locale.
 */
export function compareUtf16CodeUnits(left: string, right: string): -1 | 0 | 1 {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Encode a string as an ASCII key whose ordinary byte/text ordering is exactly
 * JavaScript UTF-16 code-unit ordering. Persistent indexes use this when their
 * database's native Unicode collation has different astral/BMP semantics.
 */
export function utf16CodeUnitSortKey(value: string): string {
  let key = "";
  for (let index = 0; index < value.length; index += 1) {
    key += value.charCodeAt(index).toString(16).padStart(4, "0");
  }
  return key;
}
