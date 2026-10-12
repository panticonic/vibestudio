#!/usr/bin/env node
/**
 * End-to-end smoke for `vibestudio terminal`, driven through a real
 * pseudo-terminal exactly as a user runs it on a machine with no paired
 * server:
 *
 *   1. the built CLI starts and owns a local server (isolated HOME/config),
 *      pairs itself by redeeming the root invite, and runs the launch gate
 *      (`--yes` approves the startup review once);
 *   2. the server-built terminal browser is downloaded, imported and run, and
 *      its chrome is rendered into the pty;
 *   3. quitting the browser restores the terminal and stops and joins the
 *      owned server.
 *
 * There is no deadline: a first run builds the terminal browser and its
 * dependencies, which may legitimately take minutes. The CLI's exit is the
 * authoritative failure signal; its output and the server log are retained
 * as evidence when the smoke fails.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pty from "node-pty";
import { readCurrentHostBuildGeneration } from "./host-build-generations.mjs";
import { prepareWorkspaceRelease } from "./prepare-workspace-release.mjs";
import { resolveDevelopmentTemplateSet } from "../src/dev/developmentTemplateSet.ts";
import { developmentTemplateSetEnv } from "./lib/development-template-set.mjs";
import { runOwnedCleanupSteps, runWithOwnedCleanup } from "./lib/owned-cleanup.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Text the browser's chrome renders once it owns the screen. */
const CHROME_MARKER = process.env.TERMINAL_SMOKE_CHROME_MARKER ?? "Vibestudio Terminal";
/** Keys that quit the browser (Ctrl-Q in the current browser). */
const QUIT_KEYS = process.env.TERMINAL_SMOKE_QUIT_KEYS ?? "\x11";

const ANSI =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[()][0-9A-Za-z]|\x1b[=>]/g;

function log(line) {
  process.stdout.write(`[terminal-smoke] ${line}\n`);
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

/** Observe a pty: accumulated output, waits on text, and its exit. */
function observe(term) {
  let raw = "";
  const waiters = new Set();
  const exitFailure = (exitCode, signal) =>
    new Error(
      `vibestudio terminal exited (code ${exitCode}, signal ${signal || "none"}) before the expected output`
    );
  const exited = new Promise((resolve) => {
    term.onExit(({ exitCode, signal }) => {
      resolve({ exitCode, signal });
      for (const waiter of waiters) waiter.reject(exitFailure(exitCode, signal));
      waiters.clear();
    });
  });
  term.onData((chunk) => {
    raw += chunk;
    const text = raw.replace(ANSI, "");
    for (const waiter of [...waiters]) {
      if (text.includes(waiter.needle)) {
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  });
  return {
    get raw() {
      return raw;
    },
    get text() {
      return raw.replace(ANSI, "");
    },
    exited,
    waitFor(needle) {
      if (raw.replace(ANSI, "").includes(needle)) return Promise.resolve();
      return new Promise((resolve, reject) => waiters.add({ needle, resolve, reject }));
    },
  };
}

async function main() {
  const scratchParent = path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
    "vibestudio",
    "terminal-smoke"
  );
  fs.mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  const tempRoot = fs.mkdtempSync(path.join(scratchParent, "run-"));
  const home = path.join(tempRoot, "home");
  const configHome = path.join(tempRoot, "xdg-config");
  const stateRoot = path.join(configHome, "vibestudio");
  const serverLog = path.join(stateRoot, "logs", "server.log");
  const readyFile = path.join(stateRoot, "server-auth", "hub-ready.json");
  let preparation;
  let term = null;
  let screen = null;
  let serverPid;
  let failed = false;

  return runWithOwnedCleanup(
    async () => {
      try {
        fs.mkdirSync(home, { recursive: true });
        fs.mkdirSync(configHome, { recursive: true });
        const hostArtifactRoot = readCurrentHostBuildGeneration(repoRoot, "desktop");
        const templates = await resolveDevelopmentTemplateSet({
          repoRoot,
          checkpointRoot: path.join(tempRoot, "template-checkpoints"),
        });
        if (!templates) {
          throw new Error(
            "The terminal smoke needs the canonical template checkouts. Run `pnpm dev:templates setup`."
          );
        }
        const env = {
          ...process.env,
          ...developmentTemplateSetEnv(templates),
          NODE_ENV: process.env.NODE_ENV ?? "development",
          VIBESTUDIO_APP_ROOT: repoRoot,
          VIBESTUDIO_HOST_ARTIFACT_ROOT: hostArtifactRoot,
          HOME: home,
          XDG_CONFIG_HOME: configHome,
          APPDATA: path.join(tempRoot, "appdata"),
          npm_config_cache: process.env.npm_config_cache ?? path.join(tempRoot, "npm-cache"),
          TERM: "xterm-256color",
        };
        // The smoke is its own isolated profile, never a developer instance.
        delete env.VIBESTUDIO_INSTANCE_ROOT;
        delete env.VIBESTUDIO_INSTANCE;
        log("preparing workspace templates");
        preparation = prepareWorkspaceRelease({
          executable: process.execPath,
          entry: path.join(hostArtifactRoot, "prepare-workspace-templates.mjs"),
          appRoot: repoRoot,
          output: path.join(tempRoot, "release"),
          scratch: path.join(tempRoot, "preparation"),
          env,
        });
        await preparation.completed;

        log("running `vibestudio terminal --yes` in a pseudo-terminal");
        term = pty.spawn(
          process.execPath,
          [path.join(hostArtifactRoot, "cli", "client.mjs"), "terminal", "--yes"],
          { name: "xterm-256color", cols: 120, rows: 40, cwd: home, env }
        );
        screen = observe(term);
        await screen.waitFor("starting a local Vibestudio server");
        log("the command started its own local server");
        await screen.waitFor("Pairing this terminal");
        await screen.waitFor(CHROME_MARKER);
        log("the terminal browser rendered its chrome");

        serverPid = JSON.parse(fs.readFileSync(readyFile, "utf8")).pid;
        if (!Number.isInteger(serverPid) || !processAlive(serverPid)) {
          throw new Error(`the owned server (pid ${serverPid}) is not running under the browser`);
        }

        term.write(QUIT_KEYS);
        const { exitCode, signal } = await screen.exited;
        term = null;
        if (exitCode !== 0 || signal) {
          throw new Error(
            `vibestudio terminal exited with code ${exitCode}, signal ${signal || "none"}`
          );
        }
        if (!screen.raw.includes("\x1b[?1049l") || !screen.raw.includes("\x1b[?25h")) {
          throw new Error("quitting did not restore the main screen and cursor");
        }
        if (!screen.text.includes("Local server stopped.")) {
          throw new Error("the command did not report stopping its local server");
        }
        if (processAlive(serverPid)) {
          throw new Error(`the owned server (pid ${serverPid}) survived the browser`);
        }
        log(`the owned server (pid ${serverPid}) was stopped and joined`);
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    async () => {
      await runOwnedCleanupSteps(
        [
          async () => {
            if (!term) return;
            // Hanging up the pty ends the CLI, which stops and joins its server.
            term.kill("SIGHUP");
            await screen?.exited;
          },
          async () => {
            if (failed) retainEvidence(tempRoot, scratchParent, serverLog, screen);
          },
          async () => {
            if (serverPid && processAlive(serverPid)) {
              throw Object.assign(
                new Error(`the owned server (pid ${serverPid}) outlived its CLI`),
                { code: "EOWNERSHIP" }
              );
            }
          },
          async () => preparation?.stop(),
          async () => {
            // A surviving server still owns its state; never remove it underneath.
            if (serverPid && processAlive(serverPid)) return;
            await fs.promises.rm(tempRoot, { recursive: true, force: true });
          },
        ],
        "Terminal smoke cleanup failed"
      );
    },
    "Terminal smoke failed"
  );
}

function retainEvidence(tempRoot, scratchParent, serverLog, screen) {
  const evidence = path.join(scratchParent, `failure-${path.basename(tempRoot)}`);
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  if (fs.existsSync(serverLog)) fs.copyFileSync(serverLog, path.join(evidence, "server.log"));
  if (screen) fs.writeFileSync(path.join(evidence, "terminal-output.txt"), screen.text);
  log(`failure evidence retained in ${evidence}`);
}

main().catch((error) => {
  console.error(`[terminal-smoke] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
