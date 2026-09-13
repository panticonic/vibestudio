import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Remove a tree that may contain deliberately sealed directories.
 *
 * A native development session projects its verified toolchain into a
 * `0o500` directory so the tool cannot swap its own binary, and restores
 * write permission when the session retires. A session that was killed
 * rather than retired leaves that seal behind, and `fs.rm` then abandons
 * the whole tree at the first `unlink` it is refused — which silently
 * stranded tens of gigabytes of instance state per killed run.
 *
 * Each refusal names the exact path it could not remove, so granting the
 * owner write permission on that one directory and retrying makes
 * progress without walking the tree speculatively.
 */
export function removeSealedTree(
  target: string,
  deps: {
    rmSync?: typeof fs.rmSync;
    chmodSync?: typeof fs.chmodSync;
    lstatSync?: typeof fs.lstatSync;
  } = {}
): void {
  const rmSync = deps.rmSync ?? fs.rmSync;
  const chmodSync = deps.chmodSync ?? fs.chmodSync;
  const lstatSync = deps.lstatSync ?? fs.lstatSync;
  const unsealed = new Set<string>();
  for (;;) {
    try {
      rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      return;
    } catch (error) {
      const refused = sealedDirectory(error, lstatSync);
      // Refuse to loop on a directory that stayed unremovable after being
      // unsealed: the next attempt would fail identically.
      if (!refused || unsealed.has(refused)) throw error;
      unsealed.add(refused);
      chmodSync(refused, 0o700);
    }
  }
}

/** The directory whose missing write permission refused this removal, if any. */
function sealedDirectory(error: unknown, lstatSync: typeof fs.lstatSync): string | undefined {
  const candidate = error as NodeJS.ErrnoException;
  if (candidate?.code !== "EACCES" && candidate?.code !== "EPERM") return undefined;
  if (typeof candidate.path !== "string" || candidate.path.length === 0) return undefined;
  // Removing an entry needs write permission on its parent; removing the
  // sealed directory itself needs it on the directory.
  const entry = candidate.path;
  try {
    if (lstatSync(entry).isDirectory()) return entry;
  } catch {
    // The entry is gone or unreadable; its parent is still the thing that
    // refused us.
  }
  const parent = path.dirname(entry);
  return parent === entry ? undefined : parent;
}
