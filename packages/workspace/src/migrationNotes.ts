import YAML from "yaml";

export const MIGRATIONS_SOURCE_DIR = "migrations" as const;

export interface MigrationNote {
  path: string;
  facet: string;
  degradedOk: boolean;
  verify: string;
  body: string;
  markdown: string;
}

export interface MigrationNoteSummary {
  path: string;
  title: string;
  degradedOk: boolean;
}

const NOTE_PATH = /^migrations\/([^/]+)\/(.+\.md)$/u;

function noteError(path: string, message: string): Error {
  return new Error(`Invalid migration note ${path}: ${message}`);
}

/**
 * Parse the deliberately tiny migration-note contract. Notes are living
 * target-state documents: there is no note identity, version, or applied
 * marker to parse here.
 */
export function parseMigrationNote(path: string, markdown: string): MigrationNote {
  const match = NOTE_PATH.exec(path);
  if (!match || path.includes("..") || path.includes("\\")) {
    throw noteError(path, "expected migrations/<template-name>/<note>.md");
  }
  const normalized = markdown.replace(/\r\n?/gu, "\n");
  const lines = normalized.split("\n");
  if (lines[0] !== "---") throw noteError(path, "missing YAML frontmatter");
  const close = lines.indexOf("---", 1);
  if (close < 0) throw noteError(path, "unterminated YAML frontmatter");

  let header: unknown;
  try {
    header = YAML.parse(lines.slice(1, close).join("\n")) as unknown;
  } catch (error) {
    throw noteError(path, error instanceof Error ? error.message : String(error));
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    throw noteError(path, "frontmatter must be a mapping");
  }
  const fields = header as Record<string, unknown>;
  const unknown = Object.keys(fields).filter((key) => key !== "degraded-ok" && key !== "verify");
  if (unknown.length > 0) {
    throw noteError(
      path,
      `unknown frontmatter field${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}`
    );
  }
  if (typeof fields["degraded-ok"] !== "boolean") {
    throw noteError(path, "degraded-ok must be true or false");
  }
  if (typeof fields["verify"] !== "string" || fields["verify"].trim().length === 0) {
    throw noteError(path, "verify must be a non-empty command or probe");
  }
  const body = lines
    .slice(close + 1)
    .join("\n")
    .trim();
  if (!body) throw noteError(path, "target-contract body is empty");

  return {
    path,
    facet: match[1]!,
    degradedOk: fields["degraded-ok"],
    verify: fields["verify"].trim(),
    body,
    markdown,
  };
}

/** Human presentation derived only from a validated living note. */
export function summarizeMigrationNote(note: MigrationNote): MigrationNoteSummary {
  const heading = /^#\s+(.+)$/mu.exec(note.body)?.[1]?.trim();
  const fallback = note.path.split("/").at(-1)?.replace(/\.md$/u, "") ?? note.path;
  return {
    path: note.path,
    title: heading || fallback,
    degradedOk: note.degradedOk,
  };
}

export function migrationFacetFromRepoPath(repoPath: string): string | null {
  const match = /^migrations\/([^/]+)$/u.exec(repoPath);
  return match?.[1] ?? null;
}

export function migrationFacetsForRepoPaths(repoPaths: readonly string[]): string[] {
  return [
    ...new Set(repoPaths.flatMap((repoPath) => migrationFacetFromRepoPath(repoPath) ?? [])),
  ].sort();
}
