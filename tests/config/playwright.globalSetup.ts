import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupRunTempRoot, recordRunStarted } from "../setup/e2eCleanupLedger.js";
import { prepareE2eRootTemplate, publishE2eRootTemplate } from "../setup/e2eRootTemplate.js";
import { E2E_ARTIFACT_ROOT_ENV, E2E_RUN_ID_ENV, E2E_TEMP_ROOT_ENV } from "../setup/e2eRun.js";
import { ownTestRun } from "../setup/ownedTestRun.js";
import { startOwnedXvfb } from "../setup/ownedXvfb.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export default async function globalSetup(): Promise<() => Promise<void>> {
  const runId = process.env[E2E_RUN_ID_ENV];
  const artifactRoot = process.env[E2E_ARTIFACT_ROOT_ENV];
  if (!runId || !artifactRoot) {
    throw new Error("Playwright E2E run context was not initialized by its config");
  }

  fs.mkdirSync(artifactRoot, { recursive: true });
  const run = await ownTestRun("vibestudio-e2e-");
  const runTempRoot = run.root;
  process.env[E2E_TEMP_ROOT_ENV] = runTempRoot;

  let xvfb: Awaited<ReturnType<typeof startOwnedXvfb>> | undefined;
  let rootTemplate: Awaited<ReturnType<typeof prepareE2eRootTemplate>>;
  const retireResources = async () => {
    const errors: unknown[] = [];
    try {
      await xvfb?.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await run.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "E2E resources did not retire cleanly");
  };
  try {
    recordRunStarted(runTempRoot);
    xvfb = await startOwnedXvfb(runTempRoot, run.ownership);
    // Resolving and materializing the exact Base root is Git-bound and async,
    // so it happens once here; the synchronous per-case workspace creator picks
    // the result up from the environment.
    rootTemplate = await prepareE2eRootTemplate({
      projectRoot,
      runTempRoot,
    });
    publishE2eRootTemplate(rootTemplate);
  } catch (error) {
    try {
      await cleanupRunTempRoot(runTempRoot, retireResources);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "E2E setup and retirement failed");
    }
    throw error;
  }
  console.log(`[E2E] run ${runId}`);
  console.log(`[E2E] artifacts ${artifactRoot}`);
  console.log(`[E2E] temporary root ${runTempRoot}`);
  console.log(`[E2E] root template ${rootTemplate.pin.commit} from ${rootTemplate.checkout}`);
  if (xvfb) console.log(`[E2E] owned X11 display ${xvfb.display} (pid ${xvfb.pid})`);

  return async () => {
    await cleanupRunTempRoot(runTempRoot, retireResources);
  };
}
