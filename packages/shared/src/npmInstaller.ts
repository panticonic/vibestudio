import { execFileSync } from "child_process";
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { getCentralDataPath } from "@vibestudio/env-paths";

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

export function runNpmInstall(
  cwd: string,
  options: number | { timeout?: number; ignoreScripts?: boolean; cacheDir?: string } = 120_000
): void {
  const timeout = typeof options === "number" ? options : (options.timeout ?? 120_000);
  const ignoreScripts = typeof options === "number" ? true : (options.ignoreScripts ?? true);
  const cacheDir =
    typeof options === "number" || !options.cacheDir
      ? path.join(getCentralDataPath(), "npm-cache")
      : options.cacheDir;
  const npmCli = resolveBundledNpmCliPath();

  const installWithCache = (installCacheDir: string) => {
    fs.mkdirSync(installCacheDir, { recursive: true });
    const args = [
      npmCli,
      "install",
      "--no-audit",
      "--no-fund",
      "--legacy-peer-deps",
      "--cache",
      installCacheDir,
    ];
    if (ignoreScripts) args.push("--ignore-scripts");
    execFileSync(process.execPath, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      timeout,
      env: {
        ...process.env,
        ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
      },
    });
  };

  try {
    installWithCache(cacheDir);
  } catch (error) {
    if (!isRecoverableNpmCacheError(error)) throw error;

    // cacache can retain an index entry whose content file was removed by an
    // interrupted cleanup or another npm client. A clean one-shot cache lets
    // npm refetch the package without deleting a shared cache that another
    // Vibestudio process may currently be using.
    const recoveryCacheDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vibestudio-npm-cache-recovery-")
    );
    try {
      console.warn(
        "[npmInstaller] npm cache corruption detected; retrying once with a clean cache"
      );
      installWithCache(recoveryCacheDir);
    } finally {
      try {
        fs.rmSync(recoveryCacheDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn(
          `[npmInstaller] Failed to remove recovery cache ${recoveryCacheDir}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
  }
}

function isRecoverableNpmCacheError(error: unknown): boolean {
  const output = npmErrorOutput(error);
  if (/\bEINTEGRITY\b/i.test(output)) return true;
  return (
    /\bENOENT\b/i.test(output) &&
    /(?:Invalid response body|_cacache[\\/](?:content-v2|index-v5))/i.test(output)
  );
}

function npmErrorOutput(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  const processError = error as Error & { stdout?: unknown; stderr?: unknown };
  for (const value of [processError.stdout, processError.stderr]) {
    if (typeof value === "string") parts.push(value);
    else if (Buffer.isBuffer(value)) parts.push(value.toString("utf8"));
  }
  return parts.join("\n");
}
