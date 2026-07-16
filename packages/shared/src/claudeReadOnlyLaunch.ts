import { accessSync, constants, mkdirSync } from "node:fs";
import * as path from "node:path";

export interface ClaudeReadOnlyLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  scratchDirectory: string;
}

export interface ClaudeReadOnlyLaunchInput {
  argv: string[];
  profileDir: string;
  contextDirectory: string;
  /** Test seams. Production intentionally supports only Linux/bubblewrap. */
  platform?: NodeJS.Platform;
  pathValue?: string;
}

function executableOnPath(name: string, pathValue: string | undefined): string | null {
  for (const directory of (pathValue ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next exact PATH entry.
    }
  }
  return null;
}

/**
 * Build the only supported linked-Claude process launch.
 *
 * The host tree is mounted read-only, including the materialized context. A
 * disposable profile directory and /tmp are the only writable mounts. This is
 * an OS boundary, not a prompt convention: native Edit/Write/Bash calls receive
 * EROFS for managed projection paths. Server-side semantic reads still work,
 * and scratch is explicit through VIBESTUDIO_LINKED_SCRATCH.
 *
 * We deliberately fail on platforms without the one audited backend instead of
 * silently launching an uncontained session or approximating containment with
 * chmod (which the same process could undo).
 */
export function confineClaudeReadOnly(input: ClaudeReadOnlyLaunchInput): ClaudeReadOnlyLaunch {
  const argv = input.argv.filter((value): value is string => typeof value === "string");
  if (argv.length === 0) throw new Error("Claude launch has no executable");
  const platform = input.platform ?? process.platform;
  if (platform !== "linux") {
    throw new Error(
      `Linked Claude requires an OS-enforced read-only launch; no backend is supported on ${platform}`
    );
  }
  const bwrap = executableOnPath("bwrap", input.pathValue ?? process.env["PATH"]);
  if (!bwrap) {
    throw new Error(
      "Linked Claude requires bubblewrap (bwrap) so managed context projections are read-only"
    );
  }

  const profileDir = path.resolve(input.profileDir);
  const contextDirectory = path.resolve(input.contextDirectory);
  const scratchDirectory = path.join(profileDir, "scratch");
  mkdirSync(scratchDirectory, { recursive: true, mode: 0o700 });

  return {
    command: bwrap,
    args: [
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev-bind",
      "/dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--bind",
      profileDir,
      profileDir,
      "--ro-bind",
      contextDirectory,
      contextDirectory,
      "--chdir",
      contextDirectory,
      "--setenv",
      "TMPDIR",
      "/tmp",
      "--setenv",
      "VIBESTUDIO_LINKED_SCRATCH",
      scratchDirectory,
      "--",
      ...argv,
    ],
    env: {
      TMPDIR: "/tmp",
      VIBESTUDIO_LINKED_SCRATCH: scratchDirectory,
    },
    scratchDirectory,
  };
}

export function linkedScratchDirectory(profileDir: string): string {
  return path.join(path.resolve(profileDir), "scratch");
}
