import type {
  GitOverwritePreview,
  GitPublishRepoResult,
  GitPullUpstreamResult,
  GitPushUpstreamResult,
  GitUpstreamState,
  GitUpstreamStatusRow,
} from "@vibestudio/service-schemas/gitInterop";
import { formatRelativeTime } from "@vibestudio/git/formatting";
import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
  parseInvocation,
  renderCommandHelp,
} from "../commandTable.js";
import { loadCliCredentials } from "../credentialStore.js";
import { AuthError, EXIT_ERROR, jsonMode, printError, printResult, UsageError } from "../output.js";
import { RpcClient as CliRpcClient } from "@vibestudio/direct-client";
import { normalizeServerBaseUrl } from "../serverUrl.js";
import { normalizeRepoPath, REPO_FLAG, requireRepo } from "./vcsCommandShared.js";

const GIT_REMOTE_FLAG: FlagSpec = {
  name: "remote",
  takesValue: true,
  description: "Declared remote name (default: origin)",
};

const GIT_BRANCH_FLAG: FlagSpec = {
  name: "branch",
  takesValue: true,
  description: "Remote branch name (default: the declared remote branch, else main)",
};

const GIT_AUTO_PUSH_FLAG: FlagSpec = {
  name: "auto-push",
  takesValue: false,
  description: "Push automatically after future gad main advances",
};

const GIT_OFF_FLAG: FlagSpec = {
  name: "off",
  takesValue: false,
  description: "Turn auto-push off",
};

const GIT_FORCE_PUSH_FLAG: FlagSpec = {
  name: "force",
  takesValue: false,
  description: "Overwrite upstream history after one-time approval",
};

const GIT_DRY_RUN_FLAG: FlagSpec = {
  name: "dry-run",
  takesValue: false,
  description: "Fetch and preview incoming commits without importing",
};

const GIT_NAME_FLAG: FlagSpec = {
  name: "name",
  takesValue: true,
  description: "Repository name for publish (default: repo path leaf)",
};

const GIT_PROVIDER_FLAG: FlagSpec = {
  name: "provider",
  takesValue: true,
  description: "Remote provider id (default: github)",
};

const GIT_PRIVATE_FLAG: FlagSpec = {
  name: "private",
  takesValue: false,
  description: "Create the published repository as private",
};

const GIT_PUBLIC_FLAG: FlagSpec = {
  name: "public",
  takesValue: false,
  description: "Create the published repository as public",
};

const GIT_DESCRIPTION_FLAG: FlagSpec = {
  name: "description",
  short: "d",
  takesValue: true,
  description: "Repository description for publish",
};

const GIT_PATH_FLAG: FlagSpec = {
  name: "path",
  takesValue: true,
  description: "Workspace repo path for import",
};

const GIT_URL_FLAG: FlagSpec = {
  name: "url",
  takesValue: true,
  description: "External Git HTTPS URL",
};

const GIT_CREDENTIAL_FLAG: FlagSpec = {
  name: "credential",
  takesValue: true,
  description: "Stored credential id to use for this remote",
};

const GIT_FORGET_REMOTE_FLAG: FlagSpec = {
  name: "forget-remote",
  takesValue: false,
  description: "Also remove the declared remote config entry",
};

interface VcsGitCommand {
  name: string;
  summary: string;
  usage: string;
  flags: FlagSpec[];
  run: (inv: ParsedInvocation) => Promise<number>;
}

function resolveGitRpcClient(): CliRpcClient {
  const token = process.env["VIBESTUDIO_AGENT_TOKEN"];
  if (token) {
    const rawUrl = process.env["VIBESTUDIO_SERVER_URL"];
    if (!rawUrl) {
      throw new AuthError("VIBESTUDIO_AGENT_TOKEN is set but VIBESTUDIO_SERVER_URL is missing");
    }
    return new CliRpcClient({ url: normalizeServerBaseUrl(rawUrl), token });
  }
  const creds = loadCliCredentials();
  if (!creds) {
    throw new AuthError('not paired — run `vibestudio remote pair "<pair-link>"` first');
  }
  if (!creds.workspaceName) {
    throw new AuthError(
      "no remote workspace selected — run `vibestudio remote select <workspace>`"
    );
  }
  return new CliRpcClient(creds);
}

async function invokeGitInterop<T>(method: string, args: unknown[]): Promise<T> {
  const client = resolveGitRpcClient();
  try {
    return await client.call<T>(`gitInterop.${method}`, args);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function collectOptionalRepos(inv: ParsedInvocation): string[] {
  const repos: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const repo = normalizeRepoPath(raw);
    if (repo && !seen.has(repo)) {
      seen.add(repo);
      repos.push(repo);
    }
  };
  for (const value of inv.flagsMulti("repo")) add(value);
  for (const positional of inv.positionals) add(positional);
  return repos;
}

function requireGitRepo(inv: ParsedInvocation): string {
  return requireRepo(inv);
}

function requireFlagString(inv: ParsedInvocation, name: string): string {
  const value = inv.flags[name];
  if (typeof value !== "string" || !value) {
    throw new UsageError(`missing --${name}`);
  }
  return value;
}

function optionalFlagString(inv: ParsedInvocation, name: string): string | undefined {
  const value = inv.flags[name];
  return typeof value === "string" && value ? value : undefined;
}

function isActionableGitState(state: GitUpstreamState): boolean {
  return state === "diverged" || state === "auth-failed" || state === "error";
}

function shortSha(value: string | null | undefined): string {
  return value ? value.slice(0, 7) : "-";
}

function renderGitStatusHuman(rows: GitUpstreamStatusRow[]): void {
  if (rows.length === 0) {
    console.log("no git upstreams configured");
    console.log(
      "run `vibestudio vcs git publish --repo <repo>` or `vibestudio vcs git enable --repo <repo>`"
    );
    return;
  }
  for (const row of rows) {
    const remote =
      row.remote && row.branch ? `${row.remote} ${row.branch}` : "(no upstream remote)";
    const state =
      row.state === "ahead"
        ? `ahead ${row.aheadBy}`
        : row.state === "behind"
          ? `behind ${row.behindBy}`
          : row.state === "diverged"
            ? "DIVERGED"
            : row.state;
    const pushInfo =
      row.state === "in-sync"
        ? `pushed ${formatRelativeTime(row.lastPushedAt)} (${shortSha(row.lastPushedSha)})`
        : row.state === "ahead"
          ? `${row.autoPush ? "auto-push pending" : `auto-push off - \`vibestudio vcs git push --repo ${row.repoPath}\``}`
          : row.state === "behind"
            ? `upstream +${row.behindBy} - \`vibestudio vcs git pull --repo ${row.repoPath}\``
            : row.state === "diverged"
              ? `upstream +${row.behindBy} / local +${row.aheadBy} - \`vibestudio vcs git pull --repo ${row.repoPath}\` or \`vibestudio vcs git push --repo ${row.repoPath} --force\``
              : row.state === "local-only"
                ? "`vibestudio vcs git remote set` or `vibestudio vcs git publish`"
                : (row.lastError ?? "");
    console.log(`${row.repoPath.padEnd(24)} ${state.padEnd(12)} ${remote.padEnd(18)} ${pushInfo}`);
  }
}

async function gitStatus(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repos = collectOptionalRepos(inv);
    // One-shot CLI invocation: fetch so ahead/behind reflects the remote now.
    const rows = await invokeGitInterop<GitUpstreamStatusRow[]>("upstreamStatus", [
      repos,
      { fetch: true },
    ]);
    printResult(rows, { json, human: () => renderGitStatusHuman(rows) });
    return rows.some((row) => isActionableGitState(row.state)) ? EXIT_ERROR : 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function gitEnable(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireGitRepo(inv);
    const upstream = {
      remote: optionalFlagString(inv, "remote") ?? "origin",
      ...(optionalFlagString(inv, "branch") ? { branch: optionalFlagString(inv, "branch") } : {}),
      autoPush: inv.flags["auto-push"] === true,
      ...(optionalFlagString(inv, "credential")
        ? { credentialId: optionalFlagString(inv, "credential") }
        : {}),
    };
    const result = await invokeGitInterop("setUpstream", [repo, upstream]);
    printResult(result, {
      json,
      human: () => {
        console.log(
          `tracking ${repo} on ${upstream.remote}${upstream.branch ? `/${upstream.branch}` : ""}`
        );
        console.log(
          upstream.autoPush
            ? "auto-push: on"
            : `auto-push: off - enable with \`vibestudio vcs git auto --repo ${repo}\``
        );
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function gitDisable(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireGitRepo(inv);
    const result = await invokeGitInterop("removeUpstream", [repo]);
    if (inv.flags["forget-remote"] === true) {
      await invokeGitInterop("removeSharedRemote", [
        repo,
        optionalFlagString(inv, "remote") ?? "origin",
      ]);
    }
    printResult(result, {
      json,
      human: () => {
        console.log(`detached git upstream for ${repo}`);
        if (inv.flags["forget-remote"] === true) console.log("declared remote removed");
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function gitAuto(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireGitRepo(inv);
    const enabled = inv.flags["off"] !== true;
    const result = await invokeGitInterop("setAutoPush", [repo, enabled]);
    printResult(result, {
      json,
      human: () => console.log(`auto-push ${enabled ? "enabled" : "disabled"} for ${repo}`),
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

function printOverwritePreview(preview: GitOverwritePreview | undefined): void {
  if (!preview || preview.count === 0) return;
  console.log(`overwrote ${preview.count} upstream commit(s):`);
  for (const commit of preview.commits) {
    console.log(`  ${shortSha(commit.sha)} ${commit.summary}`);
  }
}

async function gitPush(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireGitRepo(inv);
    const result = await invokeGitInterop<GitPushUpstreamResult>("pushUpstream", [
      repo,
      { force: inv.flags["force"] === true },
    ]);
    printResult(result, {
      json,
      human: () => {
        printOverwritePreview(result.overwrites);
        if (result.pushed) {
          console.log(`pushed ${repo} (${shortSha(result.headCommit)})`);
          if (result.exported > 0)
            console.log(`exported ${result.exported} gad commit(s) as git history`);
        } else {
          console.log(`${repo} already in sync`);
        }
      },
    });
    return isActionableGitState(result.status) ? EXIT_ERROR : 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function gitPull(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireGitRepo(inv);
    const dryRun = inv.flags["dry-run"] === true;
    const result = await invokeGitInterop<GitPullUpstreamResult>("pullUpstream", [
      repo,
      { dryRun },
    ]);
    printResult(result, {
      json,
      human: () => {
        if (result.incoming.length === 0) {
          console.log(`${repo} has no incoming upstream commits`);
        } else {
          console.log(`${repo} incoming ${result.incoming.length} commit(s):`);
          for (const commit of result.incoming) {
            console.log(`  ${shortSha(commit.sha)} ${commit.summary}`);
          }
        }
        if (dryRun) console.log("dry-run: no import performed");
        else if (result.imported) console.log(`imported upstream changes into gad main`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function gitPublish(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireGitRepo(inv);
    if (inv.flags["private"] === true && inv.flags["public"] === true) {
      throw new UsageError("choose only one of --private or --public");
    }
    const result = await invokeGitInterop<GitPublishRepoResult>("publishRepo", [
      {
        repoPath: repo,
        ...(optionalFlagString(inv, "provider")
          ? { provider: optionalFlagString(inv, "provider") }
          : {}),
        ...(optionalFlagString(inv, "name") ? { name: optionalFlagString(inv, "name") } : {}),
        private: inv.flags["public"] === true ? false : true,
        ...(optionalFlagString(inv, "description")
          ? { description: optionalFlagString(inv, "description") }
          : {}),
      },
    ]);
    printResult(result, {
      json,
      human: () => {
        console.log(`published ${repo} -> ${result.webUrl}`);
        console.log(`  exported ${result.exported} gad commit(s) as git history`);
        if (result.pushed) console.log(`  pushed main (${shortSha(result.headCommit)})`);
        console.log(`  auto-push: off - enable with \`vibestudio vcs git auto --repo ${repo}\``);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function gitImport(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const url = inv.positionals[0] ?? optionalFlagString(inv, "url");
    if (!url) throw new UsageError("missing Git URL");
    const repoPath = requireFlagString(inv, "path");
    const branch = optionalFlagString(inv, "branch");
    const result = await invokeGitInterop("importProject", [
      {
        path: repoPath,
        remote: { name: "origin", url, ...(branch ? { branch } : {}) },
        ...(optionalFlagString(inv, "credential")
          ? { credentialId: optionalFlagString(inv, "credential") }
          : {}),
      },
    ]);
    printResult(result, {
      json,
      human: () => {
        console.log(`imported ${repoPath} from ${url}${branch ? ` (branch ${branch})` : ""}`);
        console.log(`  tracking: on`);
        console.log(
          `  upstream push: manual - \`vibestudio vcs git push --repo ${repoPath}\`, or \`vibestudio vcs git auto --repo ${repoPath}\``
        );
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function gitRemoteSet(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireGitRepo(inv);
    const remote = {
      name: optionalFlagString(inv, "name") ?? "origin",
      url: requireFlagString(inv, "url"),
      ...(optionalFlagString(inv, "branch") ? { branch: optionalFlagString(inv, "branch") } : {}),
    };
    const result = await invokeGitInterop("setSharedRemote", [repo, remote]);
    printResult(result, {
      json,
      human: () => console.log(`set ${repo} remote ${remote.name} -> ${remote.url}`),
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function gitRemoteRemove(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireGitRepo(inv);
    const remoteName = optionalFlagString(inv, "name") ?? inv.positionals[0] ?? "origin";
    const result = await invokeGitInterop("removeSharedRemote", [repo, remoteName]);
    printResult(result, {
      json,
      human: () => console.log(`removed ${repo} remote ${remoteName}`),
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

const vcsGitCommands: VcsGitCommand[] = [
  {
    name: "status",
    summary: "Show upstream state for tracked repos",
    usage: "vibestudio vcs git status [--repo REPOPATH ...]",
    flags: [REPO_FLAG, JSON_FLAG],
    run: gitStatus,
  },
  {
    name: "enable",
    summary: "Track a repo on a declared Git remote",
    usage:
      "vibestudio vcs git enable --repo REPOPATH [--remote origin] [--branch main] [--auto-push]",
    flags: [
      REPO_FLAG,
      GIT_REMOTE_FLAG,
      GIT_BRANCH_FLAG,
      GIT_AUTO_PUSH_FLAG,
      GIT_CREDENTIAL_FLAG,
      JSON_FLAG,
    ],
    run: gitEnable,
  },
  {
    name: "disable",
    summary: "Detach a repo from upstream tracking",
    usage: "vibestudio vcs git disable --repo REPOPATH [--forget-remote]",
    flags: [REPO_FLAG, GIT_REMOTE_FLAG, GIT_FORGET_REMOTE_FLAG, JSON_FLAG],
    run: gitDisable,
  },
  {
    name: "auto",
    summary: "Toggle auto-push for a tracked repo",
    usage: "vibestudio vcs git auto --repo REPOPATH [--off]",
    flags: [REPO_FLAG, GIT_OFF_FLAG, JSON_FLAG],
    run: gitAuto,
  },
  {
    name: "push",
    summary: "Export gad main and push it to the tracked upstream",
    usage: "vibestudio vcs git push --repo REPOPATH [--force]",
    flags: [REPO_FLAG, GIT_FORCE_PUSH_FLAG, JSON_FLAG],
    run: gitPush,
  },
  {
    name: "pull",
    summary: "Fetch, merge or fast-forward, and import upstream changes into gad main",
    usage: "vibestudio vcs git pull --repo REPOPATH [--dry-run]",
    flags: [REPO_FLAG, GIT_DRY_RUN_FLAG, JSON_FLAG],
    run: gitPull,
  },
  {
    name: "publish",
    summary: "Create a provider repo, configure tracking, export, and push",
    usage: "vibestudio vcs git publish --repo REPOPATH [--name NAME] [--private|--public]",
    flags: [
      REPO_FLAG,
      GIT_NAME_FLAG,
      GIT_PROVIDER_FLAG,
      GIT_PRIVATE_FLAG,
      GIT_PUBLIC_FLAG,
      GIT_DESCRIPTION_FLAG,
      JSON_FLAG,
    ],
    run: gitPublish,
  },
  {
    name: "import",
    summary: "Import an external Git repo through gitInterop",
    usage: "vibestudio vcs git import URL --path REPOPATH [--branch main] [--credential ID]",
    flags: [GIT_URL_FLAG, GIT_PATH_FLAG, GIT_BRANCH_FLAG, GIT_CREDENTIAL_FLAG, JSON_FLAG],
    run: gitImport,
  },
  {
    name: "remote:set",
    summary: "Declare or update a Git remote for a repo",
    usage:
      "vibestudio vcs git remote set --repo REPOPATH --url URL [--name origin] [--branch main]",
    flags: [
      REPO_FLAG,
      { name: "name", takesValue: true, description: "Remote name (default: origin)" },
      GIT_URL_FLAG,
      GIT_BRANCH_FLAG,
      JSON_FLAG,
    ],
    run: gitRemoteSet,
  },
  {
    name: "remote:rm",
    summary: "Remove a declared Git remote from a repo",
    usage: "vibestudio vcs git remote rm --repo REPOPATH [--name origin]",
    flags: [
      REPO_FLAG,
      { name: "name", takesValue: true, description: "Remote name (default: origin)" },
      JSON_FLAG,
    ],
    run: gitRemoteRemove,
  },
];

function findVcsGitCommand(name: string): VcsGitCommand | undefined {
  return vcsGitCommands.find((cmd) => cmd.name === name);
}

function renderVcsGitHelp(): string {
  const lines = [
    "vibestudio vcs git",
    "",
    "Usage:",
    ...vcsGitCommands.map((cmd) => `  ${cmd.usage.padEnd(78)} ${cmd.summary}`),
  ];
  return lines.join("\n");
}

function renderNestedGitCommandHelp(command: VcsGitCommand): string {
  return renderCommandHelp({
    group: "vcs",
    name: "git",
    summary: command.summary,
    usage: command.usage,
    flags: command.flags,
    run: async () => 0,
  });
}

async function runVcsGit(_inv: ParsedInvocation, rawArgs: string[]): Promise<number> {
  const [first, ...rest] = rawArgs;
  if (!first || first === "help" || first === "--help" || first === "-h") {
    console.log(renderVcsGitHelp());
    return 0;
  }
  let commandName = first;
  let commandArgs = rest;
  if (first === "remote") {
    const [remoteVerb, ...remoteRest] = rest;
    if (!remoteVerb || remoteVerb === "help" || remoteVerb === "--help" || remoteVerb === "-h") {
      console.log(renderVcsGitHelp());
      return 0;
    }
    commandName = `remote:${remoteVerb}`;
    commandArgs = remoteRest;
  }
  const command = findVcsGitCommand(commandName);
  if (!command) {
    console.error(
      `Unknown vcs git command: ${first === "remote" ? `remote ${rest[0] ?? ""}`.trim() : first}`
    );
    console.log(renderVcsGitHelp());
    return 2;
  }
  if (commandArgs.includes("--help") || commandArgs.includes("-h")) {
    console.log(renderNestedGitCommandHelp(command));
    return 0;
  }
  let inv: ParsedInvocation;
  try {
    inv = parseInvocation(
      {
        group: "vcs",
        name: "git",
        summary: command.summary,
        usage: command.usage,
        flags: command.flags,
        run: async () => 0,
      },
      commandArgs
    );
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(error.message);
      console.error(`Usage: ${command.usage}`);
      return error.exitCode;
    }
    throw error;
  }
  return await command.run(inv);
}

export const vcsGitCommand: CliCommand = {
  group: "vcs",
  name: "git",
  summary: "Track, publish, import, push, and pull external Git upstreams",
  usage: "vibestudio vcs git <status|enable|disable|auto|push|pull|publish|import|remote>",
  passthrough: true,
  passthroughHelp: true,
  run: runVcsGit,
};
