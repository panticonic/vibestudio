import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(fileURLToPath(import.meta.url));

rmSync(new URL("./dist", import.meta.url), { recursive: true, force: true });
execFileSync("tsc", ["--project", "tsconfig.build.json"], {
  cwd: packageRoot,
  stdio: "inherit",
});
