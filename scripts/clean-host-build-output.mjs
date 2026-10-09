import * as fs from "node:fs";
import * as path from "node:path";

const PRESERVED_DIST_ENTRIES = new Set([
  // Official, checksum-pinned runtime distributions have their own atomic
  // publisher. Live instances still launch from these
  // paths; they are not disposable compiler output.
  "node",
  // The sandbox launcher is likewise staged atomically by its own publisher.
  "mxc",
  // An app bake is an explicit, separately produced packaging input.
  "baked-app",
  // Full and source-prerequisite builds share this lock.
  "source-server-prerequisites.lock",
  // ensure-host-build serializes callers while this directory is replaced.
  "host-build.lock",
  // Successful compiler outputs are immutable process generations. Running
  // hosts keep resolving every lazy artifact from the generation they launched.
  "host-generations",
]);

/**
 * Remove every artifact owned by the host build while retaining independently
 * produced packaging inputs and build coordination state.
 */
export function cleanHostBuildOutput(cwd = process.cwd()) {
  const dist = path.resolve(cwd, "dist");
  fs.mkdirSync(dist, { recursive: true });
  for (const entry of fs.readdirSync(dist, { withFileTypes: true })) {
    if (PRESERVED_DIST_ENTRIES.has(entry.name)) continue;
    fs.rmSync(path.join(dist, entry.name), { recursive: true, force: true });
  }
}
