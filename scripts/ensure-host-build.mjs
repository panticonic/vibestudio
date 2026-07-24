import { spawnSync } from "node:child_process";
import {
  computeHostBuildFingerprint,
  readHostBuildFingerprint,
  sameHostBuildFingerprint,
} from "./host-build-fingerprint.mjs";

const expected = computeHostBuildFingerprint();
const current = readHostBuildFingerprint();

if (sameHostBuildFingerprint(current, expected)) {
  console.log(`[host-build] Reusing current ${expected.mode} artifacts.`);
  process.exit(0);
}

console.log(`[host-build] Inputs changed; building ${expected.mode} artifacts.`);
const result = spawnSync(process.execPath, ["build.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (result.error) {
  throw result.error;
}
process.exit(result.status ?? 1);
