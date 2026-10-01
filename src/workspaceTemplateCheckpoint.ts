import * as fs from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Checkpoint construction owns every writer. Git's automatic maintenance may
// detach a pack rewrite after commit, racing the exact snapshot reader.
export const CHECKPOINT_GIT_CONFIG = [
  "-c",
  "core.longpaths=true",
  "-c",
  "maintenance.auto=false",
  "-c",
  "gc.auto=0",
] as const;

async function git(
  directory: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv
): Promise<string> {
  // A checkpoint lands the whole workspace inside a private temporary tree, so
  // its deepest paths are the developer's plus wherever the checkpoint sits.
  // Windows refuses those past 260 characters unless Git is told otherwise, and
  // the failure is per-file — a checkout that mostly worked, missing exactly
  // the files with the longest names.
  const { stdout } = await execFileAsync(
    "git",
    [...CHECKPOINT_GIT_CONFIG, "-C", directory, ...args],
    {
      encoding: "utf8",
      ...(env ? { env } : {}),
    }
  );
  return stdout;
}

function copyWorktreePath(sourceRoot: string, targetRoot: string, relativePath: string): void {
  const source = path.resolve(sourceRoot, relativePath);
  const target = path.resolve(targetRoot, relativePath);
  if (
    path.relative(sourceRoot, source).startsWith("..") ||
    path.relative(targetRoot, target).startsWith("..")
  ) {
    throw new Error(`Development template status contains an invalid path: ${relativePath}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (stat.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(source), target);
    return;
  }
  if (!stat.isFile()) {
    throw new Error(`Development template path is not a regular file: ${relativePath}`);
  }
  fs.copyFileSync(source, target);
  fs.chmodSync(target, stat.mode & 0o777);
}

function isDependencyArtifactPath(relativePath: string): boolean {
  return relativePath.split(/[\\/]/u).includes("node_modules");
}

export interface WorkspaceSourceCheckpoint {
  checkout: string;
  sourceCheckout: string;
  changedPaths: readonly string[];
}

/** Seal the visible worktree into an instance-owned immutable Git commit. */
export async function checkpointWorkspaceSource(input: {
  checkout: string;
  target: string;
}): Promise<WorkspaceSourceCheckpoint> {
  const sourceCheckout = fs.realpathSync(path.resolve(input.checkout));
  // Native Git owns developer checkouts, including linked/detached worktrees.
  // Always seal a private clone, so downstream exact readers never observe a
  // live checkout or need to interpret its .git indirection.
  const commit = (await git(sourceCheckout, ["rev-parse", "--verify", "HEAD"])).trim();
  const changedPaths = [
    ...new Set([
      ...(
        await git(sourceCheckout, ["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"])
      ).split("\0"),
      ...(await git(sourceCheckout, ["ls-files", "--others", "--exclude-standard", "-z"])).split(
        "\0"
      ),
    ]),
  ]
    .filter(Boolean)
    .filter((relativePath) => !isDependencyArtifactPath(relativePath))
    .sort();
  const target = path.resolve(input.target);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Transfer the captured commit through Git's snapshot protocol. A checkpoint
  // owns its complete current tree, not the source repository's history, tags,
  // or other branches. Fetching the exact commit also keeps a concurrent HEAD
  // move from changing the snapshot requested above.
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  await git(target, ["init", "--quiet"]);
  await git(target, ["remote", "add", "origin", sourceCheckout]);
  await git(target, ["fetch", "--no-tags", "--depth=1", "origin", commit]);
  await git(target, ["checkout", "-B", "vibestudio-dev-checkpoint", commit]);
  for (const relativePath of changedPaths) copyWorktreePath(sourceCheckout, target, relativePath);
  await git(target, ["add", "-A"]);
  try {
    await git(target, ["diff", "--cached", "--quiet"]);
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
    await git(target, ["commit", "--no-gpg-sign", "-m", "Vibestudio development checkpoint"], {
      ...process.env,
      GIT_AUTHOR_NAME: "Vibestudio Development",
      GIT_AUTHOR_EMAIL: "development@vibestudio.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Vibestudio Development",
      GIT_COMMITTER_EMAIL: "development@vibestudio.invalid",
      GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    });
  }
  return { checkout: target, sourceCheckout, changedPaths };
}
