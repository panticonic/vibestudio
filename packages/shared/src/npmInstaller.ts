import { execFile } from "child_process";
import { createRequire } from "module";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { getCentralDataPath } from "@vibestudio/env-paths";

const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 10 * 60_000;

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
  options: number | { timeout?: number; ignoreScripts?: boolean; cacheDir?: string } =
    DEFAULT_NPM_INSTALL_TIMEOUT_MS
): Promise<void> {
  const timeout =
    typeof options === "number" ? options : (options.timeout ?? DEFAULT_NPM_INSTALL_TIMEOUT_MS);
  const ignoreScripts = typeof options === "number" ? true : (options.ignoreScripts ?? true);
  const cacheDir =
    typeof options === "number" || !options.cacheDir
      ? path.join(getCentralDataPath(), "npm-cache")
      : options.cacheDir;
  const npmCli = resolveBundledNpmCliPath();

  const installWithCache = async (installCacheDir: string): Promise<void> => {
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
    await new Promise<void>((resolve, reject) => {
      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const child = execFile(
        process.execPath,
        args,
        {
          cwd,
          env: {
            ...process.env,
            ...(process.versions["electron"] ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
          },
        },
        (error) => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (timedOut) {
            const timeoutError = error ?? new Error(`npm install timed out after ${timeout}ms`);
            Object.assign(timeoutError, { timedOut: true });
            reject(timeoutError);
          } else if (error) {
            reject(error);
          } else {
            resolve();
          }
        }
      );

      if (timeout > 0) {
        timeoutHandle = setTimeout(() => {
          timedOut = true;
          // npm installs its own SIGTERM handler and can remain alive while
          // stalled sockets drain. A timed-out unattended build must actually
          // release the cache key so the retry can make progress.
          child.kill("SIGKILL");
        }, timeout);
        timeoutHandle.unref();
      }
    });
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await installWithCache(cacheDir);
      return;
    } catch (error) {
      if (isRecoverableNpmCacheError(error)) {
        // cacache can retain an index entry whose content file was removed by
        // an interrupted cleanup or another npm client. A clean one-shot cache
        // lets npm refetch without deleting a cache another process may use.
        const recoveryCacheDir = fs.mkdtempSync(
          path.join(os.tmpdir(), "vibestudio-npm-cache-recovery-")
        );
        try {
          console.warn(
            "[npmInstaller] npm cache corruption detected; retrying once with a clean cache"
          );
          await installWithCache(recoveryCacheDir);
          return;
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

      if (attempt === 3 || !isTransientNpmInstallError(error)) throw error;
      console.warn(
        `[npmInstaller] transient npm install failure; retrying (${attempt}/3): ${npmErrorOutput(error).split("\n")[0]}`
      );
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

function isTransientNpmInstallError(error: unknown): boolean {
  const processError = error as { killed?: unknown; signal?: unknown; timedOut?: unknown } | null;
  if (
    processError?.timedOut === true ||
    processError?.killed === true ||
    processError?.signal === "SIGKILL"
  ) {
    return true;
  }
  return /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH)\b|\b(?:429|502|503|504)\b|npm error network/i.test(
    npmErrorOutput(error)
  );
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
