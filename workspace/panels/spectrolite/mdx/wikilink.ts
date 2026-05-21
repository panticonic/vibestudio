/**
 * Wikilink syntax bridge: `[[Page]]` / `[[Page|Alias]]` ↔ `<WikiLink>` JSX.
 *
 * MDXEditor's markdown parser pipeline isn't extensible from userland (the
 * MarkdownParseOptions type is intentionally excluded from public types), so
 * we pre-process at the read/write boundary:
 *
 *   - On file open (read from disk):
 *     `[[Page Name]]` becomes `<WikiLink target="Page Name" />`
 *     `[[Page Name|click here]]` becomes `<WikiLink target="Page Name">click here</WikiLink>`
 *   - On flush (write to disk): the inverse transformation.
 *
 * `<WikiLink>` is registered as a JSX descriptor (text-level, inline-like)
 * so MDXEditor renders it via the editor we wire in `LiveJsxEditor.tsx`.
 * Preview-mode compilation receives the JSX directly since `mdxComponents`
 * exposes `WikiLink` as a runtime component.
 *
 * Path resolution uses Obsidian-style "shortestPossible" matching against
 * the workspace's `.mdx` files: the link target is the file basename
 * (without `.mdx`), and the resolver walks the workspace to find the
 * shortest matching path.
 */

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const WIKILINK_JSX_RE_SELF = /<WikiLink\s+target=("([^"]+)"|'([^']+)')\s*\/>/g;
const WIKILINK_JSX_RE_WITH_TEXT = /<WikiLink\s+target=("([^"]+)"|'([^']+)')\s*>([\s\S]*?)<\/WikiLink>/g;

/** Transform on read: `[[X]]` → `<WikiLink target="X" />`. */
export function wikilinksToJsx(markdown: string): string {
  return markdown.replace(WIKILINK_RE, (_match, target: string, alias: string | undefined) => {
    const t = target.trim();
    if (!alias) return `<WikiLink target="${escapeAttr(t)}" />`;
    return `<WikiLink target="${escapeAttr(t)}">${alias.trim()}</WikiLink>`;
  });
}

/** Transform on write: `<WikiLink ...>` → `[[X]]` / `[[X|Y]]`. */
export function wikilinksFromJsx(markdown: string): string {
  let out = markdown.replace(WIKILINK_JSX_RE_WITH_TEXT, (_match, _full, dq, sq, text: string) => {
    const target = (dq ?? sq ?? "").trim();
    const inner = text.trim();
    if (!inner || inner === target) return `[[${target}]]`;
    return `[[${target}|${inner}]]`;
  });
  out = out.replace(WIKILINK_JSX_RE_SELF, (_match, _full, dq, sq) => {
    const target = (dq ?? sq ?? "").trim();
    return `[[${target}]]`;
  });
  return out;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

/**
 * Obsidian-style shortestPossible resolver. Given a wikilink target and a
 * list of relative paths (from the workspace root), returns the shortest
 * matching path or `null` if no match.
 */
export function resolveWikilinkTarget(target: string, allPaths: string[]): string | null {
  const needle = target.endsWith(".mdx") ? target : `${target}.mdx`;
  const matches = allPaths.filter((p) => p === needle || p.endsWith(`/${needle}`));
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.length - b.length);
  return matches[0]!;
}

/** Find every wikilink target in a markdown document (post-JSX or raw). */
export function extractWikilinks(markdown: string): string[] {
  const out = new Set<string>();
  for (const m of markdown.matchAll(WIKILINK_RE)) {
    out.add(m[1]!.trim());
  }
  for (const m of markdown.matchAll(WIKILINK_JSX_RE_SELF)) {
    out.add((m[2] ?? m[3] ?? "").trim());
  }
  for (const m of markdown.matchAll(WIKILINK_JSX_RE_WITH_TEXT)) {
    out.add((m[2] ?? m[3] ?? "").trim());
  }
  return [...out];
}
