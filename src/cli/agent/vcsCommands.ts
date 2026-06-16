import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "../commandTable.js";
import { jsonMode, printError, printResult, UsageError } from "../output.js";
import { resolveSessionScope, SESSION_FLAG } from "./sessionContext.js";

/**
 * `natstack vcs ...` — GAD-native version control operations on an attached
 * agent session's context head.
 */

const REPO_FLAG: FlagSpec = {
  name: "repo",
  takesValue: true,
  description:
    "Workspace unit path for status/build-event context; commit snapshots the whole context",
};

interface VcsCommitResult {
  head: string;
  stateHash: string;
  changed: boolean;
  fileCount: number;
  changedPaths?: string[];
  message: string;
}

interface RepoStatus {
  head: string;
  stateHash: string | null;
  dirty: boolean;
  files: Array<{
    path: string;
    status: "added" | "modified" | "deleted";
  }>;
}
function requireRepo(inv: ParsedInvocation): string {
  const repo = typeof inv.flags["repo"] === "string" ? inv.flags["repo"] : inv.positionals[0];
  if (!repo) {
    throw new UsageError("missing repo path — pass --repo REPOPATH (e.g. --repo panels/notes)");
  }
  return repo
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function headForContext(contextId: string): string {
  return `ctx:${contextId}`;
}

function formatNameStatus(files: RepoStatus["files"]): string {
  return files
    .map((file) => {
      const code = file.status === "added" ? "A" : file.status === "modified" ? "M" : "D";
      return `${code}\t${file.path}`;
    })
    .join("\n");
}

function isWithinRepo(filePath: string, repo: string): boolean {
  return filePath === repo || filePath.startsWith(`${repo}/`);
}

function printCommitSummary(result: VcsCommitResult, repo: string): void {
  console.log(`${result.stateHash.slice(0, 12)} ${result.message}`);
  console.log(`scope: whole context head ${result.head}; --repo ${repo} is not a commit filter`);
  const changedPaths = result.changedPaths ?? [];
  if (changedPaths.length === 0) return;

  const outsideRepo = changedPaths.filter((filePath) => !isWithinRepo(filePath, repo));
  if (outsideRepo.length > 0) {
    console.log(`note: ${outsideRepo.length} committed path(s) are outside ${repo}`);
  }
  console.log("changed paths:");
  const maxShown = 50;
  for (const filePath of changedPaths.slice(0, maxShown)) {
    console.log(`  ${filePath}`);
  }
  if (changedPaths.length > maxShown) {
    console.log(`  ... ${changedPaths.length - maxShown} more`);
  }
}

async function status(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const head = headForContext(contextId);
    const result = await client.call<RepoStatus>("vcs.unitStatus", [repo, head]);
    printResult(result, {
      json,
      human: () => {
        console.log(`head: ${result.head}`);
        console.log(`state: ${result.stateHash ?? "(none)"}`);
        if (result.files.length === 0) {
          console.log("clean");
          return;
        }
        for (const file of result.files) {
          console.log(`${file.status}\t${file.path}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function diff(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const head = headForContext(contextId);
    const statusResult = await client.call<RepoStatus>("vcs.unitStatus", [repo, head]);
    const result = formatNameStatus(statusResult.files);
    if (json) printResult(result, { json });
    else process.stdout.write(result ? `${result}\n` : "");
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function commit(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const message = typeof inv.flags["message"] === "string" ? inv.flags["message"] : undefined;
    if (!message || !message.trim()) {
      throw new UsageError("missing commit message — pass -m MSG");
    }
    const repo = requireRepo(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const head = headForContext(contextId);
    const result = await client.call<VcsCommitResult>("vcs.commit", [repo, message, { head }]);
    printResult(result, {
      json,
      human: () => printCommitSummary(result, repo),
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

export const vcsCommands: CliCommand[] = [
  {
    group: "vcs",
    name: "status",
    summary: "Show working-tree status for a context unit",
    usage: "natstack vcs status --repo REPOPATH",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: status,
  },
  {
    group: "vcs",
    name: "diff",
    summary: "Show a name-status diff for a context unit",
    usage: "natstack vcs diff --repo REPOPATH",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: diff,
  },
  {
    group: "vcs",
    name: "commit",
    summary: "Commit all pending changes in the current context",
    usage: "natstack vcs commit -m MSG --repo REPOPATH",
    flags: [
      { name: "message", short: "m", takesValue: true, description: "Commit message" },
      REPO_FLAG,
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: commit,
  },
];
