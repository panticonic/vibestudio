import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSealedTree } from "@vibestudio/shared/removeSealedTree";

/**
 * One temporary root per test run, swept when the run ends.
 *
 * Well over two hundred test files reach for `os.tmpdir()` to build a fixture,
 * and a file that fails partway leaves its fixture behind however carefully
 * the suite is written. Pointing TMPDIR at a run-owned directory makes that
 * irrelevant: every fixture lands inside one tree, and the tree goes at the
 * end whether its tests passed, failed, or threw on the way to cleanup.
 */
export const TEST_TEMP_ROOT_ENV = "VIBESTUDIO_TEST_TEMP_ROOT";

export function createTestTempRoot(): string {
  // Stay under the real temporary directory so fixtures keep the filesystem
  // semantics they were written against — same device, so rename and hardlink
  // behave as they do in production.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-test-run-"));
  process.env[TEST_TEMP_ROOT_ENV] = root;
  process.env["TMPDIR"] = root;
  return root;
}

export function removeTestTempRoot(root: string): void {
  // A test that exercised a sealed projection leaves a directory `fs.rm`
  // cannot enter, which would otherwise strand the whole run's fixtures.
  removeSealedTree(root);
}

export default function setup(): () => void {
  const root = createTestTempRoot();
  return () => {
    removeTestTempRoot(root);
  };
}
