import { spawn } from "node:child_process";
import process from "node:process";
import { resolveElectronExecutableForVibestudio } from "./branded-electron.mjs";
import { createRunnerShutdown, signalExitCode } from "./run-electron-lifecycle.mjs";
import { readCurrentHostBuildGeneration } from "./host-build-generations.mjs";
import { observeOwnedProcess } from "./owned-process-identity.mjs";
import { processTreeContains, terminateOwnedProcessTree } from "./owned-process-tree.mjs";

const electronBinary = resolveElectronExecutableForVibestudio();
const hostGeneration = readCurrentHostBuildGeneration(process.cwd(), "desktop");

const extraArgs = process.argv.slice(2);

function initialElectronArgs() {
  const args = [];
  const rendererMaxOldSpace = Number.parseInt(
    process.env.VIBESTUDIO_RENDERER_MAX_OLD_SPACE_MB ?? "",
    10
  );
  if (Number.isFinite(rendererMaxOldSpace) && rendererMaxOldSpace > 0) {
    args.push(`--js-flags=--max-old-space-size=${rendererMaxOldSpace}`);
  }

  args.push(hostGeneration, ...extraArgs);
  return args;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

let child = null;
const activeChildren = new Set();
let nextArgs = initialElectronArgs();
let typeCheckStarted = false;
let typeCheckChild = null;
const ownedHubs = new Map();
const shutdown = createRunnerShutdown({
  activeChildren,
  // The main loop owns final exit after it has reaped every registered hub.
  // Signal completion records the shell status but must not bypass that tail.
  exit: (code) => {
    process.exitCode = code;
  },
  requestGracefulStop: (electron, signal) => {
    if (electron.connected) {
      electron.send({ type: "vibestudio:dev-shutdown", signal });
      return;
    }
    electron.kill(signal);
  },
});

function startTypeCheck() {
  if (typeCheckStarted) return;
  typeCheckStarted = true;
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const current = spawn(pnpmCommand, ["type-check"], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  typeCheckChild = current;
  activeChildren.add(current);
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    activeChildren.delete(current);
    if (typeCheckChild === current) typeCheckChild = null;
    shutdown.childExited();
  };
  current.on("error", (error) => {
    console.warn(`[dev] typecheck failed to start: ${error.message}`);
    finish();
  });
  current.on("exit", finish);
}

async function stopTypeCheck() {
  const current = typeCheckChild;
  if (!current || current.exitCode !== null || current.signalCode !== null) return;
  await new Promise((resolve) => {
    const force = setTimeout(() => current.kill("SIGKILL"), 1_000);
    current.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    current.kill("SIGTERM");
  });
}

async function runElectron(args) {
  return new Promise((resolve) => {
    let relaunchArgs = null;
    let settled = false;
    const currentChild = spawn(electronBinary, args, {
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        // Increase Node.js memory limit for main process (3GB)
        NODE_OPTIONS: "--max-old-space-size=3072",
        VIBESTUDIO_DEV_RUNNER_IPC: "1",
        VIBESTUDIO_HOST_ARTIFACT_ROOT: hostGeneration,
      },
    });
    child = currentChild;
    activeChildren.add(currentChild);

    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    currentChild.on("message", (message) => {
      if (message && message.type === "vibestudio:dev-relaunch" && isStringArray(message.args)) {
        relaunchArgs = message.args;
      }
      if (message && message.type === "vibestudio:dev-ready") startTypeCheck();
      if (message && message.type === "vibestudio:dev-owned-hub") {
        const accepted =
          typeof message.registrationId === "string" &&
          message.identity &&
          currentChild.pid &&
          processTreeContains(currentChild.pid, message.identity.pid) &&
          observeOwnedProcess(message.identity) === "owned";
        if (!currentChild.connected || typeof message.registrationId !== "string") return;
        if (!accepted) {
          currentChild.send({
            type: "vibestudio:dev-owned-hub-rejected",
            registrationId: message.registrationId,
          });
          return;
        }
        const identity = message.identity;
        ownedHubs.set(identity.pid, identity);
        currentChild.send({
          type: "vibestudio:dev-owned-hub-accepted",
          registrationId: message.registrationId,
        });
      }
    });

    currentChild.on("exit", (code, signal) => {
      activeChildren.delete(currentChild);
      if (child === currentChild) child = null;
      shutdown.childExited();
      finish({ code, signal, relaunchArgs });
    });
  });
}

// Forward signals to the active Electron process for proper shutdown.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown.request(signal));
}

for (;;) {
  const result = await runElectron(nextArgs);
  if (result.relaunchArgs && !shutdown.requestedSignal()) {
    nextArgs = result.relaunchArgs;
    continue;
  }

  const signal = shutdown.requestedSignal() ?? result.signal;
  await stopTypeCheck();
  for (const identity of ownedHubs.values()) {
    const observation = observeOwnedProcess(identity);
    if (observation === "owned") {
      const retired = await terminateOwnedProcessTree(identity.pid, { identity });
      if (!retired.gone) {
        throw new Error(
          retired.detail ?? `Owned hub process tree ${identity.pid} survived shutdown`
        );
      }
    } else if (observation === "unknown") {
      throw new Error(`Cannot prove ownership of registered hub ${identity.pid} during shutdown`);
    }
  }
  ownedHubs.clear();
  if (result.signal && !shutdown.requestedSignal()) {
    console.error(
      `[dev] Electron terminated by ${result.signal} (shell exit ${signalExitCode(result.signal)})`
    );
  } else if (!signal && result.code) {
    console.error(`[dev] Electron exited with code ${result.code}`);
  }
  process.exit(signal ? signalExitCode(signal) : (result.code ?? 0));
}
