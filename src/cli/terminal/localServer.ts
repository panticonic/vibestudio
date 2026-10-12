import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { DevInstanceSupervisor, waitForReady } from "../../dev/devInstanceSupervisor.js";
import { cliConfigRoot } from "../configPaths.js";
import { CliError } from "../output.js";

/**
 * Where a local server keeps its stdio log and ready-file handoff. Both live
 * in the CLI profile's state root, so a development instance resolves them to
 * `<instanceRoot>/logs/server.log` and the product to
 * `~/.config/vibestudio/logs/server.log`.
 */
export function localServerPaths(stateRoot: string = cliConfigRoot()): {
  logFile: string;
  readyFile: string;
} {
  return {
    logFile: path.join(stateRoot, "logs", "server.log"),
    readyFile: path.join(stateRoot, "server-auth", "hub-ready.json"),
  };
}

export interface LocalServerOptions {
  /** Directory containing the compiled `server.mjs`. */
  hostArtifactRoot: string;
  /** Exact application root passed to the server. */
  appRoot: string;
  env: NodeJS.ProcessEnv;
  /**
   * Leave the server running after this CLI exits. A retained server is
   * spawned without the parent IPC lease that otherwise ties its lifetime to
   * this process, so the decision is made when it starts.
   */
  retain: boolean;
  stateRoot?: string;
}

export interface LocalServer {
  /** The hub's structured ready payload (`--ready-file`). */
  ready: unknown;
  pid: number;
  logFile: string;
  retained: boolean;
  /** Settles when the server process exits, with a human-readable cause. */
  exited: Promise<string>;
  /** Stop and join an owned server. A retained server is left running. */
  stop(): Promise<void>;
}

export class LocalServerStartError extends CliError {
  constructor(
    message: string,
    readonly logFile: string
  ) {
    super(`${message}\nServer log: ${logFile}`);
    this.name = "LocalServerStartError";
  }
}

/**
 * Start a Vibestudio server on this machine in the profile's persistent
 * state root. Server stdout/stderr go to the log file, never to the terminal
 * the browser is about to take over. Resolves once the hub publishes its
 * ready file; the server's exit before that is the failure.
 */
export async function startLocalServer(options: LocalServerOptions): Promise<LocalServer> {
  const serverEntry = path.join(options.hostArtifactRoot, "server.mjs");
  const { logFile, readyFile } = localServerPaths(options.stateRoot);
  if (!fs.existsSync(serverEntry)) {
    throw new CliError(
      `This Vibestudio installation has no server build (${serverEntry}). ` +
        "Reinstall Vibestudio; from a source checkout, run `pnpm terminal` instead."
    );
  }
  fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(readyFile), { recursive: true, mode: 0o700 });
  // The previous process's payload may name a dead gateway and a spent invite.
  fs.rmSync(readyFile, { force: true });
  const log = fs.openSync(logFile, "w", 0o600);
  const args = [serverEntry, "--app-root", options.appRoot, "--ready-file", readyFile];
  try {
    return options.retain
      ? await startRetained(args, options, log, logFile, readyFile)
      : await startOwned(args, options, log, logFile, readyFile);
  } finally {
    // The child holds its own descriptor; ours is only the spawn handoff.
    fs.closeSync(log);
  }
}

async function startOwned(
  args: string[],
  options: LocalServerOptions,
  log: number,
  logFile: string,
  readyFile: string
): Promise<LocalServer> {
  let ready: unknown;
  const supervisor = new DevInstanceSupervisor({
    sourceRoot: options.appRoot,
    command: process.execPath,
    args,
    env: options.env,
    stdio: ["ignore", log, log],
    // A terminal hang-up or SIGTERM to the CLI stops and joins the server.
    forwardParentSignals: true,
    readiness: {
      file: readyFile,
      async onReady(value) {
        ready = value;
      },
    },
  });
  try {
    await supervisor.start();
  } catch (error) {
    await supervisor.close().catch(() => undefined);
    throw new LocalServerStartError(
      `The local Vibestudio server stopped before it was ready: ${errorMessage(error)}`,
      logFile
    );
  }
  const pid = supervisor.process?.pid;
  if (pid === undefined) throw new LocalServerStartError("The local server has no pid", logFile);
  const exited = supervisor.wait().then(
    (code) => `the local server exited (code ${code})`,
    (error: unknown) => `the local server failed: ${errorMessage(error)}`
  );
  return {
    ready,
    pid,
    logFile,
    retained: false,
    exited,
    stop: async () => {
      await supervisor.close();
    },
  };
}

async function startRetained(
  args: string[],
  options: LocalServerOptions,
  log: number,
  logFile: string,
  readyFile: string
): Promise<LocalServer> {
  const child = spawn(process.execPath, args, {
    cwd: options.appRoot,
    env: options.env,
    stdio: ["ignore", log, log],
    // Its own process group, so the terminal's Ctrl-C never reaches it.
    detached: process.platform !== "win32",
  });
  const exited = new Promise<string>((resolve) => {
    child.once("exit", (code, signal) =>
      resolve(`the local server exited (${signal ? `signal ${signal}` : `code ${code ?? 1}`})`)
    );
    child.once("error", (error) => resolve(`the local server failed: ${error.message}`));
  });
  let ready: unknown;
  try {
    ready = await waitForReady(readyFile, child, undefined, new AbortController().signal);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    throw new LocalServerStartError(
      `The local Vibestudio server stopped before it was ready: ${errorMessage(error)}`,
      logFile
    );
  }
  if (child.pid === undefined)
    throw new LocalServerStartError("The local server has no pid", logFile);
  // Released: this CLI may exit while the server keeps running.
  child.unref();
  return { ready, pid: child.pid, logFile, retained: true, exited, stop: async () => {} };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
