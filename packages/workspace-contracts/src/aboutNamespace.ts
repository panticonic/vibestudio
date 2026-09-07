/**
 * The `about/` workspace namespace and its protection classification.
 *
 * Units that live under the workspace `about/` directory are classified as
 * **privileged panels** for panel-control protection. This classification does
 * not grant host capabilities; it raises the protection/approval severity for
 * operations targeting the panel. There is no manifest opt-in flag for this —
 * an about page is a normal panel whose classification is derived *purely from
 * its location* under `about/`. Because that rule is a security boundary, it must
 * be expressed in exactly one place instead of scattered `startsWith("about/")`
 * checks that can (and did) drift apart.
 *
 * Semantics of {@link isAboutSource} (deliberately strict, since it gates the
 * protection classification):
 *   - Matches only canonical workspace-relative sources of the form
 *     `about/<page>` where `<page>` is non-empty (e.g. `about/new`).
 *   - Case-sensitive: the directory is literally lowercase `about`, so
 *     `About/new` / `ABOUT/new` do NOT match.
 *   - The bare directory `about` (no trailing slash + page) is NOT a privileged
 *     unit — the rule is "units *under* about/", not the directory itself.
 *   - The empty page `about/` (trailing slash, nothing after it) is NOT a unit
 *     and does NOT match.
 *   - Non-canonical inputs (`./about/new`, `/about/new`, backslashes) are
 *     intentionally NOT recognized. Callers are expected to pass canonical
 *     sources; this is a fail-safe, not an input sanitizer for untrusted paths.
 */

/** Prefix for the protected `about/` workspace namespace. Includes the slash. */
export const ABOUT_SOURCE_PREFIX = "about/";

/**
 * True iff `source` is a unit under the protected `about/` namespace, i.e. of
 * the form `about/<page>` with a non-empty page. This classification affects
 * panel-control protection; it does not grant host capabilities. See the module
 * doc comment for the exact (strict, case-sensitive) semantics.
 */
export function isAboutSource(source: string): boolean {
  return source.startsWith(ABOUT_SOURCE_PREFIX) && source.length > ABOUT_SOURCE_PREFIX.length;
}

/**
 * Build the canonical source for an about page from its page id.
 * `aboutPanelSource("new") === "about/new"`. The result satisfies
 * `isAboutSource(...)` for any non-empty `page`. `page` must be a bare unit
 * path (e.g. `"new"`), not an already-prefixed source.
 */
export function aboutPanelSource(page: string): string {
  return `${ABOUT_SOURCE_PREFIX}${page}`;
}

/**
 * Well-known about-page ids the host menu navigates to via the `navigate-about`
 * event. These are workspace-provided units the host assumes exist under
 * `about/`; they are page ids (the `navigate-about` payload), not sources.
 */
export const ABOUT_PAGES = {
  NEW: "new",
  KEYBOARD_SHORTCUTS: "keyboard-shortcuts",
  HELP: "help",
  ABOUT: "about",
  CREDENTIALS: "credentials",
  PERMISSIONS: "permissions",
  DOWNLOADS: "downloads",
  BOOKMARKS: "bookmarks",
  HISTORY: "history",
} as const;

export type AboutPageId = (typeof ABOUT_PAGES)[keyof typeof ABOUT_PAGES];
