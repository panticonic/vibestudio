import { execFileSync } from "child_process";
import { createRequire } from "module";
import * as fs from "fs";
import * as path from "path";
import { pathToFileURL } from "url";

function createRequireFromRoot(root: string): NodeRequire {
  const packageJson = path.join(root, "package.json");
  const requireBase = fs.existsSync(packageJson) ? packageJson : `${root}${path.sep}`;
  return createRequire(pathToFileURL(requireBase).href);
}

export function resolveBundledNpmCliPath(appRoot = process.env["NATSTACK_APP_ROOT"]): string {
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
    "Bundled npm CLI not found. Ensure the app declares npm as a runtime dependency.",
  );
}

export function runNpmInstall(cwd: string, timeout = 120_000): void {
  const npmCli = resolveBundledNpmCliPath();
  execFileSync(
    process.execPath,
    [
      npmCli,
      "install",
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
      "--ignore-scripts",
      "--legacy-peer-deps",
    ],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      env: {
        ...process.env,
        ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    },
  );
}
