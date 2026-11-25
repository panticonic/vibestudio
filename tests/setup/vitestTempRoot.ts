import { ownTestRun } from "./ownedTestRun.js";

export const TEST_TEMP_ROOT_ENV = "VIBESTUDIO_TEST_TEMP_ROOT";

/** Redirect all ordinary fixtures into one crash-owned run, including workers. */
export default async function setup(): Promise<() => Promise<void>> {
  const previousRoot = process.env[TEST_TEMP_ROOT_ENV],
    previousTmp = process.env["TMPDIR"];
  const run = await ownTestRun("vibestudio-test-run-");
  process.env[TEST_TEMP_ROOT_ENV] = run.root;
  process.env["TMPDIR"] = run.root;
  return async () => {
    try {
      await run.close();
    } finally {
      if (previousRoot === undefined) delete process.env[TEST_TEMP_ROOT_ENV];
      else process.env[TEST_TEMP_ROOT_ENV] = previousRoot;
      if (previousTmp === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = previousTmp;
    }
  };
}
