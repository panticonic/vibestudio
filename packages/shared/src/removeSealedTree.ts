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
 * Node's recursive removal can report the tree root even when a nested
 * directory caused the refusal. On permission failure, unseal the surviving
 * directories in the owned tree and retry removal.
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
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch (error) {
    const refusal = error as NodeJS.ErrnoException;
    if (refusal?.code !== "EACCES" && refusal?.code !== "EPERM") throw error;
    unsealDirectories(target, lstatSync, chmodSync);
    rmSync(target, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}

function unsealDirectories(
  entry: string,
  lstatSync: typeof fs.lstatSync,
  chmodSync: typeof fs.chmodSync
): void {
  let stat: fs.Stats;
  try {
    stat = lstatSync(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!stat.isDirectory()) return;
  if ((stat.mode & 0o700) !== 0o700) chmodSync(entry, stat.mode | 0o700);
  for (const child of fs.readdirSync(entry, { withFileTypes: true })) {
    if (child.isDirectory()) unsealDirectories(path.join(entry, child.name), lstatSync, chmodSync);
  }
}
