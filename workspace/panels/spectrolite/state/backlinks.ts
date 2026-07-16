/**
 * Pure backlink scanning — no panel runtime.
 *
 * Finds every note whose `[[wikilink]]` targets the active file. The content
 * reader is injected so this stays runtime-free + unit-testable (the panel
 * supplies a `vcs.readFile`-backed reader; tests supply a filesystem one).
 * Scans are bounded + concurrent so large vaults don't serialize thousands of
 * reads onto the UI update path.
 */

import { promises as fs } from "fs";
import { extractWikilinks } from "../mdx/wikilink";

export interface Backlink {
  fromPath: string;
  /** Snippet of the line containing the wikilink, for context. */
  snippet: string;
}

/** Reads a candidate's content, or null if unavailable. */
export type BacklinkReader = (relPath: string) => Promise<string | null>;

const DEFAULT_BACKLINK_CONCURRENCY = 24;

export interface FindBacklinksOptions {
  concurrency?: number;
  /** Inject the content reader (defaults to a filesystem read under `root`). */
  readFile?: BacklinkReader;
}

function basenameNoExt(path: string): string {
  const name = path.split("/").pop() ?? path;
  return name.replace(/\.mdx$/, "");
}

export async function findBacklinks(
  root: string,
  activePath: string,
  candidatePaths: string[],
  options: FindBacklinksOptions = {}
): Promise<Backlink[]> {
  const targetName = basenameNoExt(activePath);
  const fullTarget = activePath.replace(/\.mdx$/, "");
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? DEFAULT_BACKLINK_CONCURRENCY));
  const candidates = candidatePaths.filter((path) => path !== activePath);
  const read: BacklinkReader =
    options.readFile ??
    (async (relPath) => {
      try {
        return await fs.readFile(`${root}/${relPath}`, "utf-8");
      } catch {
        return null;
      }
    });

  async function scan(path: string): Promise<Backlink | null> {
    const content = await read(path);
    if (content === null) return null;
    if (
      !content.includes("[[") ||
      (!content.includes(targetName) && !content.includes(fullTarget))
    ) {
      return null;
    }
    const targets = extractWikilinks(content);
    const hit = targets.some((t) => {
      const trimmed = t.endsWith(".mdx") ? t.slice(0, -4) : t;
      return trimmed === targetName || trimmed === fullTarget || trimmed.endsWith(`/${targetName}`);
    });
    if (!hit) return null;
    const lineMatch = content
      .split("\n")
      .find(
        (line) => line.includes("[[") && (line.includes(targetName) || line.includes(fullTarget))
      );
    return { fromPath: path, snippet: lineMatch?.trim().slice(0, 120) ?? "" };
  }

  const out: Backlink[] = [];
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const results = await Promise.all(batch.map(scan));
    for (const backlink of results) {
      if (backlink) out.push(backlink);
    }
  }
  return out;
}
