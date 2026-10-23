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
 * Installed Linux acceptance uses the same scenario, twice in one private
 * profile (fresh, then returning), with an already complete release:
 *
 *   node --import tsx scripts/terminal-app-smoke.mjs \
 *     --app-directory release/linux-unpacked \
 *     --expected-release build-resources/workspace-template-release.json
 *
 * The expected receipt must name the templates actually being accepted. An
 * unpublished worktree is not a release pin; never inject its source selection
 * into this path. These measurements are profile-cold/warm, not compiler-cold:
 * release production and seal validation finish before either launch starts.
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
import { ownedEntry } from "./lib/owned-entry.mjs";
import { parseTemplateReleaseArtifact } from "../packages/workspace/src/templateRelease.ts";
import { preparedWorkspaceReleaseManifestSchema } from "../src/server/preparedWorkspaceRelease.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** Text the browser's chrome renders once it owns the screen. */
const CHROME_MARKER = process.env.TERMINAL_SMOKE_CHROME_MARKER ?? "Vibestudio ·";
/** Keys that quit the browser: the default prefix (Ctrl-Space, sent as NUL), then `q`. */
const QUIT_KEYS = process.env.TERMINAL_SMOKE_QUIT_KEYS ?? "\x00q";

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
export function observe(term) {
  let raw = "";
  let exit;
  const waiters = new Set();
  const exitFailure = (exitCode, signal) =>
    new Error(
      `vibestudio terminal exited (code ${exitCode}, signal ${signal || "none"}) before the expected output`
    );
  const waitFor = (matches) => {
    if (exit) return Promise.reject(exitFailure(exit.exitCode, exit.signal));
    if (matches(raw)) return Promise.resolve();
    return new Promise((resolve, reject) => waiters.add({ matches, resolve, reject }));
  };
  const exited = new Promise((resolve) => {
    term.onExit(({ exitCode, signal }) => {
      exit = { exitCode, signal };
      resolve({ exitCode, signal });
      for (const waiter of waiters) waiter.reject(exitFailure(exitCode, signal));
      waiters.clear();
    });
  });
  term.onData((chunk) => {
    raw = (raw + chunk).slice(-262144);
    for (const waiter of [...waiters]) {
      if (waiter.matches(raw)) {
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
      return waitFor((output) => output.replace(ANSI, "").includes(needle));
    },
    waitForScreen(needle) {
      return waitFor((output) => {
        const entered = output.lastIndexOf("\x1b[?1049h");
        return (
          entered >= 0 &&
          output.lastIndexOf("\x1b[?1049l") < entered &&
          output.slice(entered).replace(ANSI, "").includes(needle)
        );
      });
    },
  };
}

/** Reject stale or source-only packages before they can create a profile. The
 * producer below still performs the canonical full seal/artifact validation. */
export function installedSmokeTarget(appDirectory, expectedReleasePath) {
  const resources = path.join(path.resolve(appDirectory), "resources");
  const expected = parseTemplateReleaseArtifact(
    JSON.parse(fs.readFileSync(expectedReleasePath, "utf8"))
  ).workspaceTemplates;
  const installed = parseTemplateReleaseArtifact(
    JSON.parse(fs.readFileSync(path.join(resources, "workspace-template-release.json"), "utf8"))
  ).workspaceTemplates;
  const manifestPath = path.join(resources, "userland-builds/release.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(
      `Installed application has no complete prepared workspace release: ${manifestPath}`
    );
  }
  const manifest = preparedWorkspaceReleaseManifestSchema.parse(
    JSON.parse(fs.readFileSync(manifestPath, "utf8"))
  );
  for (const role of ["base", "personal", "system"]) {
    for (const field of ["url", "ref", "commit"]) {
      if (
        installed[role][field] !== expected[role][field] ||
        manifest.templates[role]?.[field] !== expected[role][field]
      ) {
        throw new Error(`Installed ${role} template ${field} does not match the expected release`);
      }
    }
  }
  const executable = path.join(path.resolve(appDirectory), "vibestudio");
  const launcher = path.join(resources, "vibestudio-cli");
  const appRoot = path.join(resources, "app.asar");
  const hostArtifactRoot = path.join(resources, "app.asar.unpacked/dist");
  for (const file of [
    executable,
    launcher,
    appRoot,
    path.join(hostArtifactRoot, "prepare-workspace-templates.cjs"),
    path.join(hostArtifactRoot, "cli/client.mjs"),
  ]) {
    if (!fs.statSync(file).isFile()) throw new Error(`Installed artifact is not a file: ${file}`);
  }
  return { resources, appRoot, hostArtifactRoot, executable, launcher };
}

/** Scratch belongs to both the CLI/server and the producer. Attempt every
 * join, but never retire their data unless all ownership boundaries settle. */
export async function cleanupTerminalSmoke({
  discoverServer,
  stopTerminal,
  retainFailureEvidence,
  verifyServerStopped,
  stopPreparation,
  removeScratch,
  scratch,
}) {
  let ownershipSettled = true;
  const ownershipStep = (step) => async () => {
    try {
      await step();
    } catch (error) {
      ownershipSettled = false;
      throw error;
    }
  };
  await runOwnedCleanupSteps(
    [
      ownershipStep(discoverServer),
      ownershipStep(stopTerminal),
      retainFailureEvidence,
      ownershipStep(verifyServerStopped),
      ownershipStep(stopPreparation),
      async () => {
        if (!ownershipSettled) await retainFailureEvidence(true);
      },
      async () => {
        if (!ownershipSettled) {
          throw Object.assign(
            new Error(`Terminal smoke ownership is unresolved; scratch retained: ${scratch}`),
            { code: "EOWNERSHIP" }
          );
        }
        await removeScratch();
      },
    ],
    "Terminal smoke cleanup failed"
  );
}

/** `ownership` and `signal` come from `ownedEntry`: the workspace producer is a
 * member of the ownership, and a stop request ends the producer and hangs up
 * the terminal under test so the run unwinds through its cleanup. */
export async function main(args, { ownership, signal, scratchRoot }) {
  let installed;
  if (args.length) {
    if (args.length !== 4 || args[0] !== "--app-directory" || args[2] !== "--expected-release") {
      throw new Error(
        "Usage: terminal-app-smoke.mjs [--app-directory LINUX_APP --expected-release TEMPLATE_RELEASE_JSON]"
      );
    }
    installed = installedSmokeTarget(args[1], args[3]);
  }
  const scratchParent = path.join(
    process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"),
    "vibestudio",
    "terminal-smoke"
  );
  fs.mkdirSync(scratchParent, { recursive: true, mode: 0o700 });
  // Reaper-owned and disk-backed: removed with the ownership even if this
  // process is killed; the cleanup below also removes it as soon as it is safe.
  const tempRoot = scratchRoot;
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
        const hostArtifactRoot =
          installed?.hostArtifactRoot ?? readCurrentHostBuildGeneration(repoRoot, "desktop");
        const templates = installed
          ? null
          : await resolveDevelopmentTemplateSet({
              repoRoot,
              checkpointRoot: path.join(tempRoot, "template-checkpoints"),
            });
        if (!installed && !templates) {
          throw new Error(
            "The terminal smoke needs the canonical template checkouts. Run `pnpm dev:templates setup`."
          );
        }
        const env = {
          ...process.env,
          ...(templates ? developmentTemplateSetEnv(templates) : {}),
          NODE_ENV: installed ? "production" : (process.env.NODE_ENV ?? "development"),
          VIBESTUDIO_APP_ROOT: installed?.appRoot ?? repoRoot,
          VIBESTUDIO_HOST_ARTIFACT_ROOT: hostArtifactRoot,
          HOME: home,
          XDG_CONFIG_HOME: configHome,
          APPDATA: path.join(tempRoot, "appdata"),
          npm_config_cache: installed
            ? path.join(tempRoot, "npm-cache")
            : (process.env.npm_config_cache ?? path.join(tempRoot, "npm-cache")),
          TERM: "xterm-256color",
        };
        // The smoke is its own isolated profile, never a developer instance.
        delete env.VIBESTUDIO_INSTANCE_ROOT;
        delete env.VIBESTUDIO_INSTANCE;
        if (installed) {
          delete env.VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES;
          delete env.VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE;
          delete env.VIBESTUDIO_WORKSPACE_SOURCES;
          delete env.VIBESTUDIO_TEMPLATE_CHECKOUTS;
          delete env.VIBESTUDIO_SHARED_DERIVED_CACHE_DIR;
          delete env.VIBESTUDIO_SHARED_BUILD_CACHE_DIR;
          delete env.NPM_CONFIG_CACHE;
          env.ELECTRON_RUN_AS_NODE = "1";
          env.VIBESTUDIO_WORKSPACE_RELEASE_ROOT = installed.resources;
        }
        log("preparing workspace templates");
        const stop = () => {
          void preparation?.stop().catch(() => {});
          term?.kill("SIGHUP");
        };
        signal.addEventListener("abort", stop, { once: true });
        preparation = prepareWorkspaceRelease({
          ownership,
          executable: installed?.executable ?? process.execPath,
          entry: path.join(
            hostArtifactRoot,
            installed ? "prepare-workspace-templates.cjs" : "prepare-workspace-templates.mjs"
          ),
          appRoot: installed?.appRoot ?? repoRoot,
          output: path.join(tempRoot, "release"),
          scratch: path.join(tempRoot, "preparation"),
          env,
        });
        await preparation.completed;
        signal.throwIfAborted();

        for (const sample of installed ? ["cold-profile", "warm-profile"] : ["source-profile"]) {
          const startedAt = performance.now();
          log(`launching ${sample}`);
          log("running `vibestudio terminal --yes` in a pseudo-terminal");
          term = pty.spawn(
            installed?.launcher ?? process.execPath,
            installed
              ? ["terminal", "--yes"]
              : [path.join(hostArtifactRoot, "cli", "client.mjs"), "terminal", "--yes"],
            { name: "xterm-256color", cols: 120, rows: 40, cwd: home, env }
          );
          screen = observe(term);
          await screen.waitFor(
            sample === "warm-profile"
              ? "Starting the local Vibestudio server"
              : "starting a local Vibestudio server"
          );
          log("the command started its own local server");
          await screen.waitFor(
            sample === "warm-profile" ? "Reconnecting to the local server" : "Pairing this terminal"
          );
          await screen.waitForScreen(CHROME_MARKER);
          log("the terminal browser rendered its chrome");
          log(
            `${sample}: browser chrome ready after ${Math.round(performance.now() - startedAt)} ms`
          );

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
          serverPid = undefined;
        }
      } catch (error) {
        failed = true;
        throw error;
      }
    },
    async () => {
      await cleanupTerminalSmoke({
        scratch: tempRoot,
        discoverServer: async () => {
          if (!serverPid && fs.existsSync(readyFile)) {
            const pid = JSON.parse(fs.readFileSync(readyFile, "utf8")).pid;
            if (Number.isInteger(pid)) serverPid = pid;
          }
        },
        stopTerminal: async () => {
          if (!term) return;
          // Hanging up the pty ends the CLI, which stops and joins its server.
          term.kill("SIGHUP");
          await screen?.exited;
        },
        retainFailureEvidence: async (cleanupFailed = false) => {
          if (failed || cleanupFailed) retainEvidence(tempRoot, scratchParent, serverLog, screen);
        },
        verifyServerStopped: async () => {
          if (serverPid && processAlive(serverPid)) {
            throw Object.assign(new Error(`the owned server (pid ${serverPid}) outlived its CLI`), {
              code: "EOWNERSHIP",
            });
          }
        },
        stopPreparation: async () => preparation?.stop(),
        removeScratch: async () => {
          await fs.promises.rm(tempRoot, { recursive: true, force: true });
        },
      });
    },
    "Terminal smoke failed"
  );
}

function retainEvidence(tempRoot, scratchParent, serverLog, screen) {
  const evidence = path.join(scratchParent, `failure-${path.basename(tempRoot)}`);
  fs.mkdirSync(evidence, { recursive: true, mode: 0o700 });
  if (fs.existsSync(serverLog)) {
    const fd = fs.openSync(serverLog, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const bytes = Buffer.alloc(Math.min(size, 262144));
      fs.readSync(fd, bytes, 0, bytes.length, Math.max(0, size - bytes.length));
      fs.writeFileSync(path.join(evidence, "server.log"), bytes, { mode: 0o600 });
    } finally {
      fs.closeSync(fd);
    }
  }
  if (screen)
    fs.writeFileSync(path.join(evidence, "terminal-output.txt"), screen.text, { mode: 0o600 });
  log(`failure evidence retained in ${evidence}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  ownedEntry(
    ({ ownership, signal, scratchRoot }) =>
      main(process.argv.slice(2), { ownership, signal, scratchRoot }),
    { scratchPrefix: "terminal-smoke-" }
  ).catch((error) => {
    console.error(`[terminal-smoke] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
