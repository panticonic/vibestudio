import type { FlagSpec, ParsedInvocation } from "../commandTable.js";
import { UsageError } from "../output.js";

export const REPO_FLAG: FlagSpec = {
  name: "repo",
  takesValue: true,
  multiple: true,
  description: "Repo path to scope the operation to (e.g. panels/notes); repeatable for push",
};

export function normalizeRepoPath(repo: string): string {
  return repo
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

/** First `--repo` (or first positional) for single-repo commands. */
export function requireRepo(inv: ParsedInvocation): string {
  const repo = typeof inv.flags["repo"] === "string" ? inv.flags["repo"] : inv.positionals[0];
  if (!repo) {
    throw new UsageError("missing repo path — pass --repo REPOPATH (e.g. --repo panels/notes)");
  }
  return normalizeRepoPath(repo);
}
