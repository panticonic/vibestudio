import { spawnSync } from "node:child_process";

// Build ownership and exact-input reuse live at the compiler entry point.
// Desktop, source, and direct build callers must obey the same boundary.
const result = spawnSync(process.execPath, ["build.mjs"], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
