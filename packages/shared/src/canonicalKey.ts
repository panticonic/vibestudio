const SEPARATOR = "\x00";
const NULLISH_SENTINEL = "<null>";

export type CanonicalKeyPart = string | number | null | undefined;

export function canonicalKey(parts: ReadonlyArray<CanonicalKeyPart>): string {
  return parts.map(encodePart).join(SEPARATOR);
}

export function parseCanonicalKey(key: string): Array<string | null> {
  return key.split(SEPARATOR).map((part) => (part === NULLISH_SENTINEL ? null : part));
}

function encodePart(part: CanonicalKeyPart): string {
  const normalized = part == null ? NULLISH_SENTINEL : String(part);
  if (normalized.includes(SEPARATOR)) {
    throw new Error("canonicalKey parts must not contain NUL bytes");
  }
  if (normalized === NULLISH_SENTINEL && part != null) {
    throw new Error(`canonicalKey part is reserved: ${NULLISH_SENTINEL}`);
  }
  return normalized;
}
