import * as fs from "fs";
import * as path from "path";
import { getCentralDataPath } from "@vibestudio/env-paths";

// esbuild canonicalizes entry paths before resolving their relative imports.
// macOS reports /var/... from os.tmpdir(), while its canonical path is
// /private/var/.... Build wrappers must start from that same canonical path or
// imports to workspace source under /Users resolve below /private instead.

/**
 * Create a scratch directory owned by one build invocation.
 *
 * Build keys identify cache entries, not running processes. Multiple workspace
 * servers can legitimately build the same key at once, so a deterministic
 * directory name would let either process overwrite or delete the other's
 * inputs. mkdtempSync atomically adds a unique suffix across processes.
 */
export function createBuildScratchDir(label: string): string {
  // Scratch follows the instance owner, including a release producer's private
  // preparation root. A killed compiler must not strand unowned projections
  // in a global temporary directory after its ephemeral instance is retired.
  const root = path.join(getCentralDataPath(), "build-scratch");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(fs.realpathSync(root), `${label}-`));
}
