import { createHash } from "node:crypto";

// workerd uses uniqueKey verbatim as a directory name as well as the namespace
// identity. Keep these portable across filesystems; do not encode separators
// or arbitrary source/class names directly into a path component.
export const UNIVERSAL_DO_UNIQUE_KEY = "vibestudio-universal-do";

export function internalDoUniqueKey(source: string, className: string): string {
  return createHash("sha256")
    .update(JSON.stringify([source, className]))
    .digest("hex");
}
