import {
  DerivedCacheCoordinator,
  derivedCacheDatabasePath,
  type DerivedCacheLease,
} from "./derivedCache.js";
import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import {
  assertNativePrerequisites,
  compileNativeLaunch,
} from "@vibestudio/process-adapter/native-launch";
import { prepareNativeRuntime } from "@vibestudio/shared/nativeRuntimeResources";
import { nativeWorkspaceCleanup } from "@vibestudio/shared/nativeWorkspaceCleanup";
import { getNativeExecutionInstallation } from "@vibestudio/shared/runtimePaths";

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
    const manifest = ignoreScripts
      ? fs.readFileSync(path.join(installRoot, "package.json"), "utf8")
      : null;
    const registryCache = path.join(getSharedDerivedDataPath(), "npm-registry-downloads");
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

    let installDeadline = 0;
    const invoke = async (
      command: "install" | "ci",
      installCacheDir: string,
      lockOnly = false
    ): Promise<void> => {
      const phase = lockOnly ? "resolve" : command === "ci" ? "download" : "install";
      const logsDir = path.join(stateRoot, "logs", randomUUID());
      const args = [
        npmCli,
        command,
        "--no-audit",
        "--no-fund",
        "--timing",
        "--logs-dir",
        logsDir,
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
      if (lockOnly) args.push("--package-lock-only");
      const launch = compileNativeLaunch({
        installation,
        containerId: `vibestudio-npm-${randomUUID()}`,
        argv: [runtime.executable, "-e", invokeNpm, resetInstall ? "1" : "0", ...args],
        cwd: installRoot,
        guestEnvironment,
        readPaths: runtime.readPaths,
        writePaths: [
          installRoot,
          stateRoot,
          ...(command === "ci" && installCacheDir === registryCache ? [registryCache] : []),
        ],
        network: "allow",
      });
      await assertNativePrerequisites({ installation, environment: launch.environment });
      resetInstall = false;
      await new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        console.log(`[npm-install-profile] ${JSON.stringify({ phase, state: "started" })}`);
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;
        const child = execFile(
          launch.command,
          launch.args,
          {
            cwd: launch.cwd,
            env: launch.environment,
          },
          (error, stdout, stderr) => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
            const profile = {
              phase,
              elapsedMs: Date.now() - startedAt,
              state: error || timedOut ? "failed" : "completed",
              ...(error || timedOut
                ? {
                    code: error?.code,
                    signal: error?.signal,
                    timedOut,
                    stderr: stderr.slice(-4_000),
                    npmLogTail: readNpmLogTail(logsDir),
                  }
                : {}),
            };
            console.log(`[npm-install-profile] ${JSON.stringify(profile)}`);
            if (error) Object.assign(error, { stdout, stderr, npmPhase: phase });
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
          timeoutHandle = setTimeout(
            () => {
              timedOut = true;
              // npm installs its own SIGTERM handler and can remain alive while
              // stalled sockets drain. A timed-out unattended build must actually
              // release the cache key so the retry can make progress.
              child.kill("SIGKILL");
            },
            Math.max(0, installDeadline - Date.now())
          );
          timeoutHandle.unref();
        }
      });
    };

    const installWithCache = async (
      privateCache: string,
      downloadCache = registryCache
    ): Promise<void> => {
      // Preserve the existing attempt budget across resolution and download.
      installDeadline = Date.now() + timeout;
      if (!ignoreScripts) return invoke("install", privateCache);

      // Resolve in the private domain first: even --ignore-scripts does not
      // prevent npm's Git fetcher from running dependency preparation code.
      // Only a complete registry graph may enter the shared download domain.
      await invoke("install", privateCache, true);
      if (fs.readFileSync(path.join(installRoot, "package.json"), "utf8") !== manifest)
        throw new Error("npm resolution changed the installation manifest");
      const lockPath = path.join(installRoot, "package-lock.json");
      if (!fs.lstatSync(lockPath).isFile())
        throw new Error("npm dependency lockfile is not a regular file");
      assertRegistryDependencyGraph(
        JSON.parse(fs.readFileSync(lockPath, "utf8")),
        createRequire(npmCli)("npm-package-arg").resolve
      );
      fs.mkdirSync(downloadCache, { recursive: true, mode: 0o700 });
      // npm ci consumes the reviewed graph. With registry sources and scripts
      // disabled, only npm's downloader writes this cache, never package code.
      if (downloadCache !== registryCache) {
        await invoke("ci", downloadCache);
        return;
      }
      const owner = new DerivedCacheCoordinator(derivedCacheDatabasePath(registryCache));
      const leases: DerivedCacheLease[] = [];
      const release = () => {
        for (const lease of leases.splice(0)) lease.release();
      };
      try {
        leases.push(owner.acquire(registryCache, "_cacache"));
        leases.push(owner.acquire(registryCache, "_logs"));
        try {
          await invoke("ci", downloadCache);
        } finally {
          release();
        }
        await owner.prune(registryCache);
      } finally {
        try {
          release();
        } finally {
          owner.close();
        }
      }
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
            await installWithCache(recoveryCacheDir, recoveryCacheDir);
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

function readNpmLogTail(logsDir: string): string {
  try {
    const log = fs.readdirSync(logsDir).find((name) => name.endsWith("-debug-0.log"));
    if (!log) return "";
    const file = fs.openSync(path.join(logsDir, log), "r");
    try {
      const size = fs.fstatSync(file).size;
      const bytes = Buffer.alloc(Math.min(size, 4_000));
      fs.readSync(file, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      return bytes.toString("utf8");
    } finally {
      fs.closeSync(file);
    }
  } catch {
    // Diagnostic collection must preserve the original process result.
    return "";
  }
}

function assertRegistryDependencyGraph(
  lock: { lockfileVersion?: number; packages?: Record<string, Record<string, unknown>> },
  parse: (
    name: string,
    spec: string
  ) => { registry?: boolean; type?: string; subSpec?: { registry?: boolean } }
): void {
  if (lock.lockfileVersion !== 3 || !lock.packages?.[""])
    throw new Error("npm resolution did not produce a complete dependency lockfile");
  for (const [location, pkg] of Object.entries(lock.packages)) {
    if (
      location &&
      (!location.startsWith("node_modules/") ||
        location.includes("\\") ||
        location.split("/").some((part) => !part || part === "." || part === ".."))
    )
      throw new Error(`Refusing npm dependency outside its installation: ${location}`);
    if (pkg["link"]) throw new Error(`Refusing linked npm dependency: ${location}`);
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      for (const [name, spec] of Object.entries((pkg[field] ?? {}) as Record<string, string>)) {
        const source = parse(name, spec);
        if (!source.registry && !(source.type === "alias" && source.subSpec?.registry))
          throw new Error(
            `Refusing non-registry npm dependency ${name} in ${location || "root"}: ${spec}`
          );
      }
    }
    if (!location || (pkg["inBundle"] && pkg["resolved"] === undefined)) continue;
    if (typeof pkg["resolved"] !== "string" || typeof pkg["integrity"] !== "string")
      throw new Error(`npm dependency ${location} has no registry resolution and integrity`);
    const source = new URL(pkg["resolved"]);
    if (
      source.protocol !== "https:" ||
      source.hostname !== "registry.npmjs.org" ||
      source.username ||
      source.password
    )
      throw new Error(`Refusing non-registry npm dependency: ${location} (${pkg["resolved"]})`);
  }
}

/**
 * Bound dependency installation concurrency. Resolution and lifecycle code
 * own private caches; reviewed registry downloads reuse a profile cache.
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
