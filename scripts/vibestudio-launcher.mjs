#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  NPM_UPDATE_ENV,
  NPM_UPDATE_FILES,
  NPM_UPDATE_REQUESTED_EXIT_CODE,
  isPrivateUpdateFile,
  readPrivateJson,
  validateUpdateResult,
  writePrivateJsonAtomic,
} from "./npm-update-contract.mjs";
import {
  checkForActiveUpdateLock,
  createUpdateLaunch,
  getLauncherCentralDataPath,
  handleElectronUpdateExit,
  resolveNpmGlobalInstall,
} from "./npm-update-launcher.mjs";
import { resolveDesktopLaunchArgs } from "./desktop-launch-args.mjs";

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const centralDataPath = getLauncherCentralDataPath();

if (!process.env["VIBESTUDIO_APP_ROOT"]) {
  process.env["VIBESTUDIO_APP_ROOT"] = packageRoot;
}

const argv = process.argv.slice(2);
const desktopLaunch = resolveDesktopLaunchArgs(argv);

const lock = await checkForActiveUpdateLock(centralDataPath);
if (lock.active) {
  console.error("Vibestudio is updating. Try again in a moment.");
  process.exit(75);
}

function hasElectron() {
  try {
    require.resolve("electron");
    return true;
  } catch {
    return false;
  }
}

function forwardSignals(child) {
  const handlers = [];
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const handler = () => {
      if (!child.killed) child.kill(signal);
    };
    handlers.push([signal, handler]);
    process.on(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}

function endWith(cleanupSignals, code, signal) {
  cleanupSignals();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
}

function launchCli(args) {
  const cli = path.join(packageRoot, "dist", "cli", "client.mjs");
  const child = spawn(process.execPath, [cli, ...args], {
    stdio: "inherit",
    shell: false,
  });
  const cleanupSignals = forwardSignals(child);
  child.on("exit", (code, signal) => endWith(cleanupSignals, code, signal));
}

async function launchGui(args) {
  const provenance = await resolveNpmGlobalInstall(packageRoot, { centralDataPath });
  const updateLaunch = provenance ? createUpdateLaunch(provenance) : null;
  let electronBinary;
  try {
    const { resolveElectronExecutableForVibestudio } = await import(
      pathToFileURL(path.join(packageRoot, "scripts", "branded-electron.mjs")).href
    );
    electronBinary = resolveElectronExecutableForVibestudio({
      installed: true,
      requireCodesign: Boolean(process.env[NPM_UPDATE_ENV.resultPath]),
    });
  } catch (error) {
    recordRelaunchFailure(error);
    throw error;
  }
  const child = spawn(electronBinary, [packageRoot, ...args], {
    stdio: "inherit",
    shell: false,
    env: {
      ...process.env,
      NODE_OPTIONS: "--max-old-space-size=3072",
      ...(updateLaunch
        ? { [NPM_UPDATE_ENV.launch]: JSON.stringify(updateLaunch) }
        : { [NPM_UPDATE_ENV.launch]: undefined }),
    },
  });
  const cleanupSignals = forwardSignals(child);
  child.on("exit", (code, signal) => {
    cleanupSignals();
    const hasUpdateRequest =
      updateLaunch?.canInstall &&
      fs.existsSync(path.join(updateLaunch.requestDirectory, "request.json"));
    if (updateLaunch?.canInstall && (code === NPM_UPDATE_REQUESTED_EXIT_CODE || hasUpdateRequest)) {
      void handleElectronUpdateExit({
        code,
        signal,
        launch: updateLaunch,
        centralDataPath,
      })
        .then((result) => {
          if (result.handled) process.exit(result.relaunched === false ? 1 : 0);
          endWith(() => {}, code, signal);
        })
        .catch((error) => {
          console.error(`[npm-update] ${error instanceof Error ? error.message : String(error)}`);
          process.exit(1);
        });
      return;
    }
    if (updateLaunch?.canInstall) {
      fs.rmSync(updateLaunch.requestDirectory, { recursive: true, force: true });
    }
    endWith(() => {}, code, signal);
  });
}

function recordRelaunchFailure(error) {
  const resultPath = process.env[NPM_UPDATE_ENV.resultPath];
  if (!isPrivateUpdateFile(resultPath, NPM_UPDATE_FILES.result)) return;
  try {
    const value = readPrivateJson(resultPath, validateUpdateResult);
    if (
      !value ||
      !isPrivateUpdateFile(value.logPath, NPM_UPDATE_FILES.log) ||
      path.dirname(value.logPath) !== path.dirname(resultPath)
    ) {
      return;
    }
    const summary = `The updated app could not prepare Electron: ${
      error instanceof Error ? error.message : String(error)
    }`;
    writePrivateJsonAtomic(resultPath, {
      ...value,
      outcome: "failed",
      summary,
      completedAt: new Date().toISOString(),
    });
    fs.appendFileSync(value.logPath, `${new Date().toISOString()} relaunch-failed ${summary}\n`, {
      mode: 0o600,
    });
  } catch {
    // The retained update log and stderr are the terminal recovery surface.
  }
}

if (desktopLaunch.wantsGui && hasElectron()) {
  await launchGui(desktopLaunch.args);
} else if (desktopLaunch.wantsGui) {
  console.error(
    "The desktop GUI is not included in @panticonic/vibestudio-server; install @panticonic/vibestudio to use the app."
  );
  launchCli(["--help"]);
} else {
  launchCli(argv);
}
