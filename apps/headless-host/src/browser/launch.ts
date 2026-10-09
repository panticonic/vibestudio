/**
 * Launch headless Chromium with a loopback-only CDP endpoint (port 0) and
 * parse the DevTools WebSocket URL from stderr.
 */
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createDevLogger } from "@vibestudio/dev-log";

const log = createDevLogger("HeadlessHost:launch");

const WS_URL_PATTERN = /DevTools listening on (ws:\/\/[^\s]+)/;

export interface LaunchedChromium {
  wsEndpoint: string;
  process: ChildProcess;
  profileDir: string;
  stop(): Promise<void>;
}

function chromiumRuntimeTempRoot(executablePath: string): string {
  const snapName = snapNameFromExecutablePath(executablePath);
  if (snapName) return path.join(os.homedir(), "snap", snapName, "common");
  if (process.platform === "win32") return os.tmpdir();
  return "/var/tmp";
}

async function removeOwnedDirectories(profileDir: string, runtimeDir: string): Promise<void> {
  const results = await Promise.allSettled([
    fs.promises.rm(profileDir, { recursive: true, force: true }),
    fs.promises.rm(runtimeDir, { recursive: true, force: true }),
  ]);
  const failures = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((failure) => failure.reason),
      "Failed to remove owned Chromium profile or runtime directory",
      { cause: failures[0]?.reason }
    );
  }
}

function snapNameFromExecutablePath(executablePath: string): string | null {
  const normalized = path.resolve(executablePath);
  if (path.dirname(normalized) !== "/snap/bin") return null;
  return path.basename(normalized) || null;
}

function isHiddenHomePath(candidate: string, homeDir: string): boolean {
  const relative = path.relative(homeDir, path.resolve(candidate));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  return relative.split(path.sep).some((segment) => segment.startsWith("."));
}

export function resolveChromiumProfileRoot(opts: {
  executablePath: string;
  profileRoot: string;
  homeDir?: string;
}): string {
  const homeDir = opts.homeDir ?? os.homedir();
  const snapName = snapNameFromExecutablePath(opts.executablePath);
  if (!snapName || !isHiddenHomePath(opts.profileRoot, homeDir)) return opts.profileRoot;
  const defaultRoot = path.join(homeDir, ".local", "state", "vibestudio", "headless-host");
  const relativeInstance = path.relative(defaultRoot, path.resolve(opts.profileRoot));
  const safeRelativeInstance =
    relativeInstance && !relativeInstance.startsWith("..") && !path.isAbsolute(relativeInstance)
      ? relativeInstance
      : "";
  return path.join(
    homeDir,
    "snap",
    snapName,
    "common",
    "vibestudio",
    "headless-host",
    safeRelativeInstance
  );
}

export async function launchChromium(opts: {
  executablePath: string;
  profileRoot: string;
  extraArgs?: string[];
}): Promise<LaunchedChromium> {
  const profileRoot = resolveChromiumProfileRoot({
    executablePath: opts.executablePath,
    profileRoot: opts.profileRoot,
  });
  if (profileRoot !== opts.profileRoot) {
    log.info(`Using snap-accessible Chromium profile dir: ${profileRoot}`);
  }
  fs.mkdirSync(profileRoot, { recursive: true });
  const profileDir = fs.mkdtempSync(path.join(profileRoot, "chromium-"));
  let runtimeDir: string;
  try {
    const runtimeTempRoot = chromiumRuntimeTempRoot(opts.executablePath);
    fs.mkdirSync(runtimeTempRoot, { recursive: true });
    runtimeDir = fs.mkdtempSync(path.join(runtimeTempRoot, "vsc-"));
  } catch (error) {
    try {
      await fs.promises.rm(profileDir, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Chromium runtime directory setup failed and profile cleanup failed",
        { cause: error }
      );
    }
    throw error;
  }
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--mute-audio",
    "--window-size=1280,800",
    // Automated macOS hosts do not own an interactive login keychain. Avoid a
    // native keychain prompt blocking Chromium before it publishes the CDP
    // endpoint; this affects only Chromium's disposable test profile.
    ...(process.platform === "darwin" ? ["--use-mock-keychain"] : []),
    ...(opts.extraArgs ?? []),
  ];
  let child: ChildProcess;
  try {
    child = spawn(opts.executablePath, args, {
      stdio: ["ignore", "ignore", "pipe"],
      // Chromium's crash reporter and other ancillary state otherwise use the
      // user's global config/cache even with a separate --user-data-dir.
      env: {
        ...process.env,
        // Chromium places its single-instance and crash-handler Unix sockets
        // under TMPDIR. The caller's instance TMPDIR can exceed AF_UNIX's path
        // limit, so keep only transient IPC under this private short directory.
        TMPDIR: runtimeDir,
        TMP: runtimeDir,
        TEMP: runtimeDir,
        XDG_CONFIG_HOME: path.join(profileDir, "config"),
        XDG_CACHE_HOME: path.join(profileDir, "cache"),
        CHROME_CONFIG_HOME: path.join(profileDir, "config"),
      },
    });
  } catch (error) {
    try {
      await removeOwnedDirectories(profileDir, runtimeDir);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Chromium spawn failed and owned directory cleanup failed",
        { cause: error }
      );
    }
    throw error;
  }
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  let retirement: Promise<void> | undefined;
  const stop = (): Promise<void> =>
    (retirement ??= (async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await removeOwnedDirectories(profileDir, runtimeDir);
    })());
  let wsEndpoint: string;
  try {
    wsEndpoint = await new Promise<string>((resolve, reject) => {
      let stderr = "";
      // A cold Chromium start can be slow; it either reports its endpoint or
      // exits/errors, and those are the only outcomes this waits for.
      const cleanup = () => {
        child.stderr?.off("data", onData);
        child.stderr?.resume();
        child.off("exit", onExit);
        child.off("error", onError);
      };
      const onData = (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-4096);
        const match = WS_URL_PATTERN.exec(stderr);
        if (match) {
          cleanup();
          resolve(match[1]!);
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `Chromium exited (code ${code}, signal ${signal ?? "none"}) before reporting an endpoint:\n${stderr.slice(-2000)}`
          )
        );
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };
      child.stderr?.on("data", onData);
      child.once("exit", onExit);
      child.once("error", onError);
    });
  } catch (error) {
    try {
      await stop();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Chromium launch failed and owned directory cleanup failed",
        { cause: error }
      );
    }
    throw error;
  }

  log.info(`Chromium up: ${wsEndpoint}`);
  return {
    wsEndpoint,
    process: child,
    profileDir,
    stop,
  };
}
