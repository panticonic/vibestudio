/**
 * Stage and verify natlang bundles from a natlang repository, for the host scripts that vendor or run them
 * (`natlang-vendor.mjs`, `natlang-eval.mjs`).
 *
 * Natlang's `ts-host/scripts/stage-vibestudio.mjs` refuses a working tree whose build sources differ from HEAD, and the
 * natlang checkout is shared with live editors, so staging happens in a temporary `git worktree` of one commit
 * (`origin/main` unless told otherwise). The worktree and its scratch are retired in a `finally` path, success or not.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runWithOwnedCleanup } from "./owned-cleanup.mjs";

/** The natlang repository: `NATLANG_REPO`, else `~/natlang`. */
export function natlangRepository(env = process.env) {
  const repository = path.resolve(env["NATLANG_REPO"] ?? path.join(os.homedir(), "natlang"));
  if (!fs.existsSync(path.join(repository, "ts-host/scripts/stage-vibestudio.mjs"))) {
    throw new Error(
      `${repository} is not a natlang checkout with ts-host/scripts/stage-vibestudio.mjs; set NATLANG_REPO`
    );
  }
  return repository;
}

function git(repository, ...args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed in ${repository}: ${result.stderr.trim()}`);
  }
  return result.stdout.trim();
}

/** Run a node script, inheriting output, and settle with its exit status. */
function runNode(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`node ${args.join(" ")} exited ${code ?? `by ${signal}`}`))
    );
  });
}

/**
 * Run `body(tsHost)` with `ts-host` of `commit` checked out in a temporary worktree whose installed packages are the
 * repository's own (the layout `stage-vibestudio.mjs --check` builds).
 */
export async function withNatlangWorktree(repository, commit, body, scratchRoot = os.tmpdir()) {
  const resolved = git(repository, "rev-parse", `${commit}^{commit}`);
  const directory = fs.mkdtempSync(path.join(scratchRoot, "natlang-worktree-"));
  const worktree = path.join(directory, "tree");
  return runWithOwnedCleanup(
    async () => {
      git(repository, "worktree", "add", "--detach", worktree, resolved);
      const tsHost = path.join(worktree, "ts-host");
      fs.symlinkSync(
        path.join(repository, "ts-host/node_modules"),
        path.join(tsHost, "node_modules")
      );
      if (fs.existsSync(path.join(repository, "node_modules"))) {
        fs.symlinkSync(path.join(repository, "node_modules"), path.join(worktree, "node_modules"));
      }
      return body(tsHost, resolved);
    },
    async () => {
      // The worktree is registered with the repository, so it is removed through it.
      if (fs.existsSync(worktree)) git(repository, "worktree", "remove", "--force", worktree);
      fs.rmSync(directory, { recursive: true, force: true });
    },
    "natlang worktree cleanup failed"
  );
}

/** Stage `only` (core, llama, eval, or dashboard; all when absent) of the worktree `tsHost` into `out`, with its pin. */
export function stageInWorktree(tsHost, { only, out }) {
  return runNode(tsHost, [
    path.join(tsHost, "scripts/stage-vibestudio.mjs"),
    "--out",
    out,
    ...(only ? ["--only", only] : []),
  ]);
}

/** Stage `only` of `commit` into `out` in a temporary worktree. Returns the commit staged. */
export function stageNatlang({ repository, commit = "origin/main", only, out, scratchRoot }) {
  return withNatlangWorktree(
    repository,
    commit,
    async (tsHost, resolved) => {
      await stageInWorktree(tsHost, { only, out });
      return resolved;
    },
    scratchRoot
  );
}

/**
 * Verify a vendored `dir` against its pin and a fresh build of the pinned commit, using the pinned commit's own
 * build scripts. The pinned commit must exist in `repository`.
 */
export function checkVendoredNatlang({ repository, dir }) {
  return runNode(path.join(repository, "ts-host"), [
    path.join(repository, "ts-host/scripts/stage-vibestudio.mjs"),
    "--check",
    dir,
  ]);
}
