import { copyFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** Declare long-path support beside the stock, resource-less workerd executable.
 * This is installation metadata, applied before execution, never a runtime
 * mutation. Windows must separately have LongPathsEnabled enabled by its owner.
 */
export function prepareWindowsWorkerdMetadata({
  cwd = process.cwd(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  if (platform !== "win32") return;
  if (arch !== "x64") throw new Error(`Unsupported Windows workerd architecture: ${arch}`);
  const require = createRequire(path.join(cwd, "package.json"));
  const executable = require.resolve("@cloudflare/workerd-windows-64/bin/workerd.exe");
  copyFileSync(new URL("./workerd.exe.manifest", import.meta.url), `${executable}.manifest`);
}
