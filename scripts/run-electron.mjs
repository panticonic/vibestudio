import { spawn } from "node:child_process";
import process from "node:process";
import { resolveElectronExecutableForVibestudio } from "./branded-electron.mjs";
import { createRunnerShutdown, signalExitCode } from "./run-electron-lifecycle.mjs";

const electronBinary = resolveElectronExecutableForVibestudio();

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

  args.push(".", ...extraArgs);
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
const shutdown = createRunnerShutdown({
  activeChildren,
  exit: (code) => process.exit(code),
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
  process.exit(signal ? signalExitCode(signal) : (result.code ?? 0));
}
