import { execFile } from "child_process";
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { pathToFileURL } from "url";

const execFileAsync = promisify(execFile);

function createRequireFromRoot(root: string): NodeRequire {
  const packageJson = path.join(root, "package.json");
  const requireBase = fs.existsSync(packageJson) ? packageJson : `${root}${path.sep}`;
  return createRequire(pathToFileURL(requireBase).href);
}

export function resolveBundledNpmCliPath(appRoot = process.env["VIBESTUDIO_APP_ROOT"]): string {
  const roots = [appRoot, process.cwd()].filter((p): p is string => !!p);
  for (const root of roots) {
    try {
      const requireFromRoot = createRequireFromRoot(root);
      const npmPackageJson = requireFromRoot.resolve("npm/package.json");
      const npmCli = path.join(path.dirname(npmPackageJson), "bin", "npm-cli.js");
      if (fs.existsSync(npmCli)) return npmCli;
    } catch {
      // Try next root.
    }
  }

  throw new Error(
    "Bundled npm CLI not found. Ensure the app declares npm as a runtime dependency."
  );
}

export async function runNpmInstall(
  cwd: string,
  options: { timeout?: number; ignoreScripts?: boolean } = {}
): Promise<void> {
  const timeout = options.timeout ?? 120_000;
  const ignoreScripts = options.ignoreScripts ?? true;
  const npmCli = resolveBundledNpmCliPath();
  const args = [npmCli, "install", "--no-audit", "--no-fund"];
  if (ignoreScripts) args.push("--ignore-scripts");
  await execFileAsync(process.execPath, args, {
    cwd,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    env: {
      ...process.env,
      ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    },
  });
}
