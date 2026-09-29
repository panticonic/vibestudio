import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import { TEST_TEMP_ROOT_ENV } from "./vitestTempRoot.js";

// Workers inherit the run-owned temporary root from the global setup that
// created it, so every fixture this file's tests build lands inside the one
// tree the run sweeps at the end.
const testTempRoot = process.env[TEST_TEMP_ROOT_ENV];
if (testTempRoot) process.env["TMPDIR"] = testTempRoot;

process.env["VIBESTUDIO_APP_ROOT"] ??= path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
// Host tests consume the same immutable artifact generation as a native launch.
process.env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] ??= readCurrentHostBuildGeneration(
  process.env["VIBESTUDIO_APP_ROOT"],
  "desktop"
);

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
}
