import { spawn } from "node:child_process";
import { runParentOwnedMain } from "./lib/parent-owned-main.mjs";
import { tsImport } from "tsx/esm/api";
const { OwnedProcessGroup } = await tsImport(
  "@vibestudio/shared/ownedProcessGroup",
  import.meta.url
);
import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolveElectronExecutableForVibestudio } from "./branded-electron.mjs";
import { createRunnerShutdown, signalExitCode } from "./run-electron-lifecycle.mjs";
import { readCurrentHostBuildGeneration } from "./host-build-generations.mjs";
import {
  createOwnedProcessGroupReceiver,
  registerOwnedProcessGroup,
} from "@vibestudio/shared/ownedProcessRegistration";

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

const activeChildren = new Set();
let nextArgs = initialElectronArgs();
let typeCheckStarted = false;
let typeCheckOwner = null;
const electronOwners = new Set();
const registeredReceivers = new Set();
const childOwners = new Map();
const requestedRetirements = new Map();
const shutdown = createRunnerShutdown({
  activeChildren,
  // The main loop owns final exit after it has reaped every registered hub.
  // Signal completion records the shell status but must not bypass that tail.
  exit: (code) => {
    process.exitCode = code;
  },
  requestGracefulStop: (nativeChild, signal) => {
    const owner = childOwners.get(nativeChild);
    if (!owner) {
      nativeChild.kill(signal);
      return;
    }
    // Start retirement as soon as shutdown is requested. Waiting for the
    // Electron exit before entering finally cannot contain a stalled exit.
    requestedRetirements.set(
      owner,
      owner.retire(signal).then(
        () => ({ status: "fulfilled" }),
        (reason) => ({ status: "rejected", reason })
      )
    );
  },
});

async function startTypeCheck() {
  if (typeCheckStarted || shutdown.requestedSignal()) return;
  typeCheckStarted = true;
  const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const current = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./parent-owned-command.mjs", import.meta.url)),
      pnpmCommand,
      "type-check",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      detached: process.platform !== "win32",
    }
  );
  if (current.pid) {
    typeCheckOwner = OwnedProcessGroup.create(current);
    childOwners.set(current, typeCheckOwner);
  }
  activeChildren.add(current);
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    activeChildren.delete(current);
    shutdown.childExited();
  };
  current.on("error", (error) => {
    console.warn(`[dev] typecheck failed to start: ${error.message}`);
    finish();
  });
  current.on("exit", finish);
  if (typeCheckOwner?.identity) await registerOwnedProcessGroup(typeCheckOwner.identity);
}

async function stopTypeCheck() {
  await typeCheckOwner?.retire();
}

async function runElectron(args) {
  return new Promise((resolve, reject) => {
    let relaunchArgs = null;
    let settled = false;
    let groupOwner = null;
    let registered = null;
    const currentChild = spawn(electronBinary, args, {
      detached: process.platform !== "win32",
      stdio: ["inherit", "inherit", "inherit", "ipc"],
      env: {
        ...process.env,
        // Increase Node.js memory limit for main process (3GB)
        NODE_OPTIONS: "--max-old-space-size=3072",
        VIBESTUDIO_DEV_RUNNER_IPC: "1",
        VIBESTUDIO_HOST_ARTIFACT_ROOT: hostGeneration,
      },
    });
    if (currentChild.pid) {
      const owner = OwnedProcessGroup.create(currentChild, {
        termTimeoutMs: 5 * 60_000,
        requestGracefulStop: (signal) => {
          if (currentChild.connected)
            currentChild.send({ type: "vibestudio:dev-shutdown", signal });
          else currentChild.kill(signal);
        },
      });
      groupOwner = owner;
      electronOwners.add(owner);
      childOwners.set(currentChild, owner);
      if (owner.identity) {
        registered = createOwnedProcessGroupReceiver(
          currentChild,
          owner.identity,
          (identity) => OwnedProcessGroup.adopt(identity),
          { forwardToParent: true }
        );
        registeredReceivers.add(registered);
      }
    }
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
      if (message && message.type === "vibestudio:dev-ready")
        void startTypeCheck().catch((error) => {
          console.error("[dev] compiler ownership registration failed", error);
          shutdown.request("SIGTERM");
        });
    });

    currentChild.on("error", (error) => {
      activeChildren.delete(currentChild);
      shutdown.childExited();
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    if (groupOwner?.identity) void registerOwnedProcessGroup(groupOwner.identity).catch(reject);

    currentChild.on("exit", (code, signal) => {
      activeChildren.delete(currentChild);
      shutdown.childExited();
      finish({ code, signal, relaunchArgs, child: currentChild, owner: groupOwner, registered });
    });
  });
}

// Forward signals to the active Electron process for proper shutdown.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => shutdown.request(signal));
}

await runParentOwnedMain(async (ownerSignal) => {
  const ownerLost = () => shutdown.request("SIGTERM");
  ownerSignal.addEventListener("abort", ownerLost, { once: true });
  if (ownerSignal.aborted) ownerLost();
  try {
    for (;;) {
      if (ownerSignal.aborted || shutdown.requestedSignal()) break;
      const result = await runElectron(nextArgs);
      await result.owner?.retire();
      await result.registered?.close();
      registeredReceivers.delete(result.registered);
      electronOwners.delete(result.owner);
      childOwners.delete(result.child);
      requestedRetirements.delete(result.owner);
      if (result.relaunchArgs && !shutdown.requestedSignal()) {
        nextArgs = result.relaunchArgs;
        continue;
      }

      const signal = shutdown.requestedSignal() ?? result.signal;
      if (result.signal && !shutdown.requestedSignal()) {
        console.error(
          `[dev] Electron terminated by ${result.signal} (shell exit ${signalExitCode(result.signal)})`
        );
      } else if (!signal && result.code) {
        console.error(`[dev] Electron exited with code ${result.code}`);
      }
      process.exitCode = signal ? signalExitCode(signal) : (result.code ?? 0);
      break;
    }
  } finally {
    ownerSignal.removeEventListener("abort", ownerLost);
    const failures = [];
    const requested = await Promise.all(requestedRetirements.values());
    failures.push(
      ...requested.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    );
    // Joining Electron closes its IPC producer before the hub receipt set is sealed.
    const desktop = await Promise.allSettled([...electronOwners].map((owner) => owner.retire()));
    failures.push(
      ...desktop.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    );
    try {
      await stopTypeCheck();
    } catch (error) {
      failures.push(error);
    }
    const registered = await Promise.allSettled(
      [...registeredReceivers].map((receiver) => receiver.close())
    );
    failures.push(
      ...registered.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    );
    if (failures.length)
      throw new AggregateError(failures, "Development runner resource retirement failed");
    registeredReceivers.clear();
  }
});
