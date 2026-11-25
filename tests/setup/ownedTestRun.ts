import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, OWNERSHIP_PARENT_ENV } from "@vibestudio/shared/ownership";

/** Preserve bytes only by explicit request; processes still retire normally. */
export const KEEP_TEST_TEMP_ENV = "VIBESTUDIO_KEEP_SCRATCH";

/** One test-run adapter over the shared crash-safe resource owner. */
export async function ownTestRun(prefix: string) {
  const previousParent = process.env[OWNERSHIP_PARENT_ENV];
  const ownership = await Ownership.open({
    profileDir: getProfileDataPath(),
    lifetime: "leased",
    meta: { role: "test-run", prefix },
  });
  let root: string;
  try {
    root =
      process.env[KEEP_TEST_TEMP_ENV] === "1"
        ? fs.mkdtempSync(path.join(os.tmpdir(), prefix))
        : await ownership.scratch(prefix, { directory: os.tmpdir() });
  } catch (error) {
    try {
      await ownership.release();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Test root creation and retirement failed");
    }
    throw error;
  }
  if (process.env[KEEP_TEST_TEMP_ENV] === "1")
    console.info(`[test] Keeping requested scratch: ${root}`);
  const descriptor = JSON.stringify(ownership.reference);
  process.env[OWNERSHIP_PARENT_ENV] = descriptor;
  let closing: Promise<void> | undefined;
  return {
    root,
    ownership,
    close() {
      closing ??= (async () => {
        // Cleanup callbacks must still see this closing root, so they cannot
        // escape its sealed child admission by inheriting the caller's parent.
        try {
          await ownership.release();
        } finally {
          if (process.env[OWNERSHIP_PARENT_ENV] === descriptor) {
            if (previousParent === undefined) delete process.env[OWNERSHIP_PARENT_ENV];
            else process.env[OWNERSHIP_PARENT_ENV] = previousParent;
          }
        }
      })();
      return closing;
    },
  };
}
