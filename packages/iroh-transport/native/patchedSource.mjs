import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The reviewed pin: upstream commit, lock digests before and after the patch,
 * and the patch digest. Every build path reads it from here so a repair can
 * never be produced from unreviewed input. */
export const pinnedSource = JSON.parse(readFileSync(join(here, "source.json"), "utf8"));

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export function runIn(command, commandArgs, cwd, extraEnv = {}, capture = false) {
  const result = spawnSync(command, commandArgs, {
    cwd,
    env: { ...process.env, ...extraEnv },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit ${result.status}`);
  return result.stdout?.trim();
}

/**
 * Fetch the pinned upstream commit into `outputDirectory/source` and apply the
 * reviewed patch, checking every digest on the way. Refuses a pre-existing
 * output directory so a build can never inherit unverified bytes.
 */
export function preparePatchedSource(outputDirectory) {
  const output = resolve(outputDirectory);
  if (existsSync(output)) throw new Error(`Output directory already exists: ${output}`);
  const patch = join(here, pinnedSource.patch);
  if (sha256(readFileSync(patch)) !== pinnedSource.patchSha256) {
    throw new Error("Source patch digest mismatch");
  }
  mkdirSync(output, { recursive: true });
  const source = join(output, "source");
  runIn("git", ["init", source], output);
  runIn("git", ["remote", "add", "origin", pinnedSource.repository], source);
  runIn("git", ["fetch", "--depth", "1", "origin", pinnedSource.commit], source);
  runIn("git", ["checkout", "--detach", "FETCH_HEAD"], source);
  if (runIn("git", ["rev-parse", "HEAD"], source, {}, true) !== pinnedSource.commit) {
    throw new Error("Source commit mismatch");
  }
  const lock = join(source, "Cargo.lock");
  if (sha256(readFileSync(lock)) !== pinnedSource.baseCargoLockSha256) {
    throw new Error("Upstream lock digest mismatch");
  }
  runIn("git", ["apply", "--check", patch], source);
  runIn("git", ["apply", patch], source);
  if (sha256(readFileSync(lock)) !== pinnedSource.patchedCargoLockSha256) {
    throw new Error("Patched lock digest mismatch");
  }
  return { output, source, target: join(output, "target") };
}
