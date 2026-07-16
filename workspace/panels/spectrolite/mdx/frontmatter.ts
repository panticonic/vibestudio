/** Parse the small, authored MDX frontmatter surface Spectrolite uses. */

import * as YAML from "yaml";

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;

export interface ParsedFrontmatter {
  title: string | null;
  dependencies: Record<string, string>;
  raw: string | null;
}

function emptyParsed(): ParsedFrontmatter {
  return { title: null, dependencies: {}, raw: null };
}

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(markdown);
  if (!match) return emptyParsed();
  const raw = match[1] ?? "";
  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch {
    return { ...emptyParsed(), raw };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ...emptyParsed(), raw };
  }
  const value = parsed as Record<string, unknown>;
  const dependencies: Record<string, string> = {};
  const declared = value["dependencies"];
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    for (const [name, reference] of Object.entries(declared as Record<string, unknown>)) {
      if (typeof reference === "string") dependencies[name] = reference;
    }
  }
  return {
    title: typeof value["title"] === "string" ? value["title"] : null,
    dependencies,
    raw,
  };
}

export function diffDependencies(
  before: Record<string, string>,
  after: Record<string, string>
): { added: Record<string, string>; changed: Record<string, string>; removed: string[] } {
  const added: Record<string, string> = {};
  const changed: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, reference] of Object.entries(after)) {
    if (!(name in before)) added[name] = reference;
    else if (before[name] !== reference) changed[name] = reference;
  }
  for (const name of Object.keys(before)) {
    if (!(name in after)) removed.push(name);
  }
  return { added, changed, removed };
}
