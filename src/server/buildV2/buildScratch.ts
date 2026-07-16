import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const BUILD_SCRATCH_ROOT = path.join(os.tmpdir(), "vibestudio-builds");

/**
 * Create a scratch directory owned by one build invocation.
 *
 * Build keys identify cache entries, not running processes. Multiple workspace
 * servers can legitimately build the same key at once, so a deterministic
 * directory name would let either process overwrite or delete the other's
 * inputs. mkdtempSync atomically adds a unique suffix across processes.
 */
export function createBuildScratchDir(label: string): string {
  fs.mkdirSync(BUILD_SCRATCH_ROOT, { recursive: true });
  return fs.mkdtempSync(path.join(BUILD_SCRATCH_ROOT, `${label}-`));
}
