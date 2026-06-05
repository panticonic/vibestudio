import {
  execFile,
  execFileSync,
  spawn,
  spawnSync,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnOptions,
  type SpawnSyncOptions,
  type ChildProcess,
} from "child_process";
import { promisify } from "node:util";
import * as fs from "fs";

const execFileAsyncRaw = promisify(execFile);

let cachedGitBinary: string | null = null;

function candidateGitBinaries(): string[] {
  const candidates = [
    process.env["NATSTACK_GIT_BINARY"],
    "/usr/bin/git",
    "/opt/homebrew/bin/git",
    "/usr/local/bin/git",
    "git",
  ].filter((p): p is string => !!p);

  return [...new Set(candidates)];
}

function canRunGit(candidate: string): boolean {
  if (candidate.includes("/") && !fs.existsSync(candidate)) {
    return false;
  }

  const result = spawnSync(candidate, ["--version"], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  return result.status === 0;
}

export function resolveGitBinary(): string {
  if (cachedGitBinary) return cachedGitBinary;

  for (const candidate of candidateGitBinaries()) {
    if (canRunGit(candidate)) {
      cachedGitBinary = candidate;
      return candidate;
    }
  }

  throw new Error(
    "Git is required but was not found. Install Git or set NATSTACK_GIT_BINARY to an executable git path.",
  );
}

export function assertGitAvailable(): string {
  return resolveGitBinary();
}

export function execGitFileSync(
  args: readonly string[],
  options?: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execGitFileSync(
  args: readonly string[],
  options?: ExecFileSyncOptions,
): Buffer;
export function execGitFileSync(
  args: readonly string[],
  options?: ExecFileSyncOptions | ExecFileSyncOptionsWithStringEncoding,
): Buffer | string {
  return execFileSync(resolveGitBinary(), [...args], options as ExecFileSyncOptions);
}

export function execGitFile(
  args: readonly string[],
  options: Parameters<typeof execFile>[2],
  callback: Parameters<typeof execFile>[3],
): void {
  execFile(resolveGitBinary(), [...args], options, callback as any);
}

/**
 * Async git invocation — never blocks the event loop. Rejects on non-zero exit
 * (same failure semantics as execGitFileSync). Returns captured stdout/stderr as
 * strings. Use this from server hot paths instead of execGitFileSync.
 */
export async function execGitFileAsync(
  args: readonly string[],
  options?: { cwd?: string; encoding?: BufferEncoding; maxBuffer?: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await execFileAsyncRaw(resolveGitBinary(), [...args], {
    ...options,
    encoding: "utf-8",
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}

export function spawnGit(args: readonly string[], options?: SpawnOptions): ChildProcess {
  return spawn(resolveGitBinary(), [...args], options ?? {});
}

export function spawnGitSync(args: readonly string[], options?: SpawnSyncOptions) {
  return spawnSync(resolveGitBinary(), [...args], options);
}
