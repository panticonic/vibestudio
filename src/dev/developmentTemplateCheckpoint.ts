import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { GitClient } from "@vibestudio/git";

function git(directory: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync("git", ["-C", directory, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(env ? { env } : {}),
  }).trim();
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

export interface DevelopmentTemplateCheckpoint {
  checkout: string;
  sourceCheckout: string;
  changedPaths: readonly string[];
  temporary: boolean;
}

/** Seal the visible worktree into an instance-owned immutable Git commit. */
export async function prepareDevelopmentTemplateCheckpoint(input: {
  checkout: string;
  target: string;
  gitClient: GitClient;
}): Promise<DevelopmentTemplateCheckpoint> {
  const sourceCheckout = fs.realpathSync(path.resolve(input.checkout));
  const status = await input.gitClient.status(sourceCheckout);
  if (!status.commit) throw new Error(`Local template checkout ${sourceCheckout} has no commit`);
  if (!status.dirty) {
    return { checkout: sourceCheckout, sourceCheckout, changedPaths: [], temporary: false };
  }

  const changedPaths = status.files
    .map((file) => file.path)
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
  git(target, ["checkout", "-B", "vibestudio-dev-checkpoint", status.commit]);
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
  return { checkout: target, sourceCheckout, changedPaths, temporary: true };
}
