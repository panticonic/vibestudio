import type { GitClient } from "@natstack/git";

export interface PublishWorkspaceRepoOptions {
  force?: boolean;
  branch?: string;
}

export interface PublishWorkspaceRepoResult {
  repoPath: string;
  branch: string;
  commit: string | null;
  changed: boolean;
  pushed: boolean;
  message: string;
  buildEventsQuery: {
    service: "build.listRecentBuildEvents";
    args: [string];
    description: string;
  };
}

const INTERNAL_REMOTE = "__natstack";

export async function publishWorkspaceRepo(
  gitClient: Pick<
    GitClient,
    | "addAll"
    | "addRemote"
    | "commit"
    | "getCurrentBranch"
    | "getCurrentCommit"
    | "listRemotes"
    | "push"
    | "status"
  >,
  repoPath: string,
  message: string,
  options: PublishWorkspaceRepoOptions = {}
): Promise<PublishWorkspaceRepoResult> {
  await ensureInternalRemote(gitClient, repoPath);
  await gitClient.addAll(repoPath);

  const status = await gitClient.status(repoPath);
  const branch =
    options.branch ?? status.branch ?? (await gitClient.getCurrentBranch(repoPath)) ?? "main";
  const changed = status.files.some(
    (file) => file.status !== "unmodified" && file.status !== "ignored"
  );

  let commit = status.commit ?? (await gitClient.getCurrentCommit(repoPath));
  if (changed) {
    commit = await gitClient.commit({ dir: repoPath, message });
  }

  try {
    await gitClient.push({
      dir: repoPath,
      remote: INTERNAL_REMOTE,
      ref: branch,
      force: options.force ?? false,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const commitDetail = commit ? ` Local commit ${commit} exists.` : "";
    throw new Error(
      `Workspace publish failed for ${repoPath} on ${branch}.${commitDetail} ` +
        `The workspace source ref was not updated; retry publishWorkspaceRepo or inspect git.status("${repoPath}"). ` +
        `Underlying error: ${detail}`
    );
  }

  return {
    repoPath,
    branch,
    commit,
    changed,
    pushed: true,
    buildEventsQuery: {
      service: "build.listRecentBuildEvents",
      args: [buildEventRepoPath(repoPath)],
      description:
        "Push-triggered builds run asynchronously; query this for recent build failures.",
    },
    message: changed
      ? `Committed ${commit?.slice(0, 7) ?? "unknown"} and pushed to ${INTERNAL_REMOTE}/${branch}`
      : `No working-tree changes; pushed current HEAD to ${INTERNAL_REMOTE}/${branch}`,
  };
}

function buildEventRepoPath(repoPath: string): string {
  return repoPath.replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+$/, "");
}

async function ensureInternalRemote(
  gitClient: Pick<GitClient, "addRemote" | "listRemotes">,
  repoPath: string
): Promise<void> {
  const remotes = await gitClient.listRemotes(repoPath);
  if (remotes.some((remote) => remote.remote === INTERNAL_REMOTE)) return;
  await gitClient.addRemote(repoPath, INTERNAL_REMOTE, repoPath);
}
