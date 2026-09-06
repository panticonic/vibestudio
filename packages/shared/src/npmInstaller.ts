import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "node:crypto";
import {
  assertNativePrerequisites,
  compileNativeLaunch,
} from "@vibestudio/process-adapter/native-launch";
import { prepareNativeRuntime } from "./nativeRuntimeResources.js";
import { nativeWorkspaceCleanup } from "./nativeWorkspaceCleanup.js";
import { getNativeExecutionInstallation } from "./runtimePaths.js";

const DEFAULT_NPM_INSTALL_TIMEOUT_MS = 10 * 60_000;
let npmInstallTail: Promise<void> = Promise.resolve();

async function withNpmInstallSlot<T>(run: () => Promise<T>): Promise<T> {
  const predecessor = npmInstallTail;
  let release!: () => void;
  npmInstallTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await predecessor;
  try {
    return await run();
  } finally {
    release();
  }
}

export type NpmResolutionFailure = "package-not-found" | "version-not-found";

/**
 * A registry resolution refusal caused by the requested dependency itself.
 *
 * This is deliberately distinct from process, network, cache, and filesystem
 * failures: callers can turn it into a correctable domain error without
 * parsing npm's presentation text at every boundary.
 */
export class NpmResolutionError extends Error {
  readonly reason: NpmResolutionFailure;

  constructor(reason: NpmResolutionFailure, cause: unknown) {
    super(
      reason === "version-not-found"
        ? "npm could not find a matching package version"
        : "npm could not find a requested package",
      { cause }
    );
    this.name = "NpmResolutionError";
    this.reason = reason;
  }
}

async function runNpmInstallInSlot(
  cwd: string,
  options: {
    appRoot: string;
    timeout?: number;
    ignoreScripts?: boolean;
  }
): Promise<void> {
  const timeout = options.timeout ?? DEFAULT_NPM_INSTALL_TIMEOUT_MS;
  const ignoreScripts = options.ignoreScripts ?? true;

  const platform = process.platform;
  if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
    throw new Error(`Unsupported npm runtime platform: ${platform}`);
  const installRoot = fs.realpathSync(cwd);
  const utilityRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), ".delete-npm-")));
  const stateRoot = path.join(utilityRoot, "workspace");
  const runtimeRoot = path.join(utilityRoot, ".runtime-npm");

  const home = path.join(stateRoot, "home");
  const temporary = path.join(home, "tmp");
  const cacheDir = path.join(stateRoot, "cache");
  let resetInstall = false;
  // Retry traversal must have the same authority as package lifecycle scripts.
  const discardPartialInstall = (): void => {
    resetInstall = true;
  };
  try {
    fs.mkdirSync(stateRoot);
    fs.mkdirSync(runtimeRoot);
    fs.mkdirSync(temporary, { recursive: true });
    const runtime = prepareNativeRuntime({ appRoot: options.appRoot, runtimeRoot, platform });
    const installation = getNativeExecutionInstallation(options.appRoot);
    const guestEnvironment = {
      ...runtime.environment,
      HOME: home,
      USERPROFILE: home,
      APPDATA: home,
      LOCALAPPDATA: home,
      XDG_CONFIG_HOME: home,
      XDG_CACHE_HOME: home,
      XDG_DATA_HOME: home,
      TEMP: temporary,
      TMP: temporary,
      TMPDIR: temporary,
      PATH: [
        path.dirname(runtime.executable),
        ...(platform === "win32"
          ? (process.env["PATH"] ?? process.env["Path"] ?? "").split(path.delimiter)
          : ["/usr/bin", "/bin"]),
      ].join(path.delimiter),
      ...(platform === "win32"
        ? { ComSpec: path.join(runtime.environment["SystemRoot"]!, "System32", "cmd.exe") }
        : {}),
    };
    const npmCli = runtime.npmCli;
    // Private-registry credentials require an explicit future API; ambient host
    // npm profiles are not an installation authority. No user
    // npmrc, ambient NODE_OPTIONS, credentials or profile cache enter this domain.
    const invokeNpm = `
    const fs = require('node:fs');
    const path = require('node:path');
    const [reset, cli, ...args] = process.argv.slice(1);
    if (reset === '1') {
      fs.rmSync(path.join(process.cwd(), 'node_modules'), {recursive:true, force:true});
      fs.rmSync(path.join(process.cwd(), 'package-lock.json'), {force:true});
    }
    process.argv = [process.execPath, cli, ...args];
    fs.mkdirSync(args[args.indexOf('--cache') + 1], {recursive:true});
    require(cli);
  `;

    const installWithCache = async (installCacheDir: string): Promise<void> => {
      const args = [
        npmCli,
        "install",
        "--no-audit",
        "--no-fund",
        // A closure is a declared set. Since npm 7 an unmet peer of a declared
        // package is installed on npm's own initiative at whatever version the
        // registry serves today, which puts a package in the tree that no
        // manifest names and no cache key describes -- and lets that invented
        // version outrank a pinned one (an auto-installed react-dom whose peer
        // range excludes the react the closure asked for). Callers declare every
        // package they intend to resolve; anything missing must surface as an
        // unresolved import naming its owner, not as a registry-latest guess.
        "--legacy-peer-deps",
        "--cache",
        installCacheDir,
      ];
      if (ignoreScripts) args.push("--ignore-scripts");
      const launch = compileNativeLaunch({
        installation,
        containerId: `vibestudio-npm-${randomUUID()}`,
        argv: [runtime.executable, "-e", invokeNpm, resetInstall ? "1" : "0", ...args],
        cwd: installRoot,
        guestEnvironment,
        readPaths: runtime.readPaths,
        writePaths: [installRoot, stateRoot],
        network: "allow",
      });
      await assertNativePrerequisites({ installation, environment: launch.environment });
      resetInstall = false;
      await new Promise<void>((resolve, reject) => {
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        const child = execFile(
          launch.command,
          launch.args,
          {
            cwd: launch.cwd,
            env: launch.environment,
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
          const recoveryCacheDir = path.join(
            stateRoot,
            `vibestudio-npm-cache-recovery-${randomUUID()}`
          );
          discardPartialInstall();
          console.warn(
            "[npmInstaller] npm cache corruption detected; retrying once with a clean cache"
          );
          try {
            await installWithCache(recoveryCacheDir);
          } catch (recoveryError) {
            throw classifyNpmInstallError(recoveryError);
          }
          return;
        }

        if (attempt === 3 || !isTransientNpmInstallError(error)) {
          throw classifyNpmInstallError(error);
        }
        console.warn(
          `[npmInstaller] transient npm install failure; retrying (${attempt}/3): ${npmErrorOutput(error).split("\n")[0]}`
        );
        discardPartialInstall();
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  } finally {
    nativeWorkspaceCleanup(options.appRoot)(utilityRoot);
  }
}

/**
 * Bound dependency installation concurrency. Each invocation owns a private
 * cache because package lifecycle code may write every admitted resource.
 */
export function runNpmInstall(
  cwd: string,
  options: Parameters<typeof runNpmInstallInSlot>[1]
): Promise<void> {
  return withNpmInstallSlot(() => runNpmInstallInSlot(cwd, options));
}

function classifyNpmInstallError(error: unknown): unknown {
  const output = npmErrorOutput(error);
  if (/\bEETARGET\b|No matching version found for\b/i.test(output)) {
    return new NpmResolutionError("version-not-found", error);
  }
  if (
    /\bE404\b/i.test(output) &&
    /(?:Not Found\s*-\s*GET|is not in this registry|package not found)/i.test(output)
  ) {
    return new NpmResolutionError("package-not-found", error);
  }
  return error;
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
