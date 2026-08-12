import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupRunTempRoot, recordRunStarted } from "../setup/e2eCleanupLedger.js";
import { E2E_ARTIFACT_ROOT_ENV, E2E_RUN_ID_ENV, E2E_TEMP_ROOT_ENV } from "../setup/e2eRun.js";
import { startOwnedXvfb } from "../setup/ownedXvfb.js";

export default async function globalSetup(): Promise<() => Promise<void>> {
  const runId = process.env[E2E_RUN_ID_ENV];
  const artifactRoot = process.env[E2E_ARTIFACT_ROOT_ENV];
  if (!runId || !artifactRoot) {
    throw new Error("Playwright E2E run context was not initialized by its config");
  }

  fs.mkdirSync(artifactRoot, { recursive: true });
  const runTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `vibestudio-e2e-${runId}-`));
  process.env[E2E_TEMP_ROOT_ENV] = runTempRoot;
  recordRunStarted(runTempRoot);
  let xvfb;
  try {
    xvfb = await startOwnedXvfb(runTempRoot);
  } catch (error) {
    cleanupRunTempRoot(runTempRoot);
    throw error;
  }
  console.log(`[E2E] run ${runId}`);
  console.log(`[E2E] artifacts ${artifactRoot}`);
  console.log(`[E2E] temporary root ${runTempRoot}`);
  if (xvfb) console.log(`[E2E] owned X11 display ${xvfb.display} (pid ${xvfb.pid})`);

  return async () => {
    await xvfb?.stop();
    cleanupRunTempRoot(runTempRoot);
  };
}
