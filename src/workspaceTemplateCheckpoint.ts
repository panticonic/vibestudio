import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

function git(directory: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  // A checkpoint lands the whole workspace inside a private temporary tree, so
  // its deepest paths are the developer's plus wherever the checkpoint sits.
  // Windows refuses those past 260 characters unless Git is told otherwise, and
  // the failure is per-file — a checkout that mostly worked, missing exactly
  // the files with the longest names.
  return execFileSync("git", ["-c", "core.longpaths=true", "-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  });
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
  const commit = git(sourceCheckout, ["rev-parse", "--verify", "HEAD"]).trim();
  const changedPaths = [
    ...new Set([
      ...git(sourceCheckout, ["diff", "--no-renames", "--name-only", "-z", "HEAD", "--"]).split(
        "\0"
      ),
      ...git(sourceCheckout, ["ls-files", "--others", "--exclude-standard", "-z"]).split("\0"),
    ]),
  ]
    .filter(Boolean)
    .filter((relativePath) => !isDependencyArtifactPath(relativePath))
    .sort();
  const target = path.resolve(input.target);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  execFileSync(
    "git",
    ["clone", "--local", "--no-hardlinks", "--no-checkout", sourceCheckout, target],
    {
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
  git(target, ["checkout", "-B", "vibestudio-dev-checkpoint", commit]);
  for (const relativePath of changedPaths) copyWorktreePath(sourceCheckout, target, relativePath);
  git(target, ["add", "-A"]);
  try {
    git(target, ["diff", "--cached", "--quiet"]);
  } catch (error) {
    if ((error as { status?: number }).status !== 1) throw error;
    git(target, ["commit", "--no-gpg-sign", "-m", "Vibestudio development checkpoint"], {
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
