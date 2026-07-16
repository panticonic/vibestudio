/** Canonical path vocabulary for every content-addressed tree producer and
 * consumer. These are filesystem-realistic UTF-8 bounds, not transport-only
 * paging limits: a tree that cannot be projected safely is not a valid tree. */
export const MAX_TREE_ENTRY_NAME_UTF8_BYTES = 255;
/** Root entries are depth zero; 128 nested directories plus a leaf yields at
 * most 129 path segments. */
export const MAX_TREE_PATH_SEGMENTS = 129;
/** Linux/POSIX projection boundary (PATH_MAX minus the terminating NUL). */
export const MAX_TREE_PATH_UTF8_BYTES = 4_095;

const textEncoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

/** Exactly one safe, projectable tree-entry segment. */
export function isValidTreeEntryName(name: string): boolean {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    utf8ByteLength(name) <= MAX_TREE_ENTRY_NAME_UTF8_BYTES &&
    name !== "." &&
    name !== ".." &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("\0")
  );
}

export function assertValidTreeEntryName(name: string): void {
  if (!isValidTreeEntryName(name)) {
    throw new Error(`Invalid tree entry name: ${JSON.stringify(name)}`);
  }
}

/** Split and validate a relative POSIX tree path. Empty names the root. */
export function splitTreePath(path: string): string[] {
  if (path === "") return [];
  if (utf8ByteLength(path) > MAX_TREE_PATH_UTF8_BYTES) {
    throw new Error(`Tree path exceeds ${MAX_TREE_PATH_UTF8_BYTES} UTF-8 bytes`);
  }
  const segments = path.split("/");
  if (segments.length > MAX_TREE_PATH_SEGMENTS) {
    throw new Error(`Tree path exceeds ${MAX_TREE_PATH_SEGMENTS} segments`);
  }
  for (const segment of segments) assertValidTreeEntryName(segment);
  return segments;
}
