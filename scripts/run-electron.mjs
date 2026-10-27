import process from "node:process";
import { resolveElectronExecutableForVibestudio } from "./branded-electron.mjs";
import { createRunnerShutdown, signalExitCode } from "./run-electron-lifecycle.mjs";
import { readCurrentHostBuildGeneration } from "./host-build-generations.mjs";
import { ownedEntry } from "./lib/owned-entry.mjs";

const electronBinary = resolveElectronExecutableForVibestudio();
const hostGeneration =
  process.env.VIBESTUDIO_HOST_ARTIFACT_ROOT ??
  readCurrentHostBuildGeneration(process.cwd(), "desktop");

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

function isStopSignal(reason) {
  return reason?.code === "ESTOP" ? reason.signal : "SIGTERM";
}

await ownedEntry(
  async ({ signal: ownerSignal, ownership }) => {
    const activeChildren = new Set();
    const ownedByChild = new Map();
    let nextArgs = initialElectronArgs();
    let typeCheckStarted = false;
    const shutdown = createRunnerShutdown({
      activeChildren,
      // The main loop owns final exit after it has joined the running Electron.
      // Signal completion records the shell status but must not bypass that tail.
      exit: (code) => {
        process.exitCode = code;
      },
      // Start retirement as soon as shutdown is requested: Electron gets SIGTERM
      // and its own ordered quit, then whatever its group still holds is killed.
      // The compiler is disposable. A failure surfaces from `ownership.release()`.
      requestGracefulStop: (nativeChild) => {
        const owned = ownedByChild.get(nativeChild);
        if (owned) void ownership.scope.track(owned.retire());
        else nativeChild.kill("SIGTERM");
      },
    });

    const track = (nativeChild, owned) => {
      ownedByChild.set(nativeChild, owned);
      activeChildren.add(nativeChild);
    };
    const untrack = (nativeChild) => {
      activeChildren.delete(nativeChild);
      ownedByChild.delete(nativeChild);
      shutdown.childExited();
    };

    function startTypeCheck() {
      if (process.env.NODE_ENV !== "development" || typeCheckStarted || shutdown.requestedSignal())
        return;
      typeCheckStarted = true;
      const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      const owned = ownership.spawn(pnpmCommand, ["type-check"], {
        kill: "immediate",
        label: "type-check",
        cwd: process.cwd(),
        env: process.env,
        stdio: "inherit",
      });
      const { child } = owned;
      track(child, owned);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        untrack(child);
      };
      child.on("error", (error) => {
        console.warn(`[dev] typecheck failed to start: ${error.message}`);
        finish();
      });
      child.on("exit", finish);
      owned.registered.catch((error) => {
        console.error("[dev] compiler ownership registration failed", error);
        shutdown.request("SIGTERM");
      });
    }

    function runElectron(args) {
      return new Promise((resolve, reject) => {
        let relaunchArgs = null;
        let settled = false;
        const owned = ownership.spawn(electronBinary, args, {
          kill: "graceful",
          label: "electron",
          stdio: ["inherit", "inherit", "inherit", "ipc"],
          env: {
            ...process.env,
            // Increase Node.js memory limit for main process (3GB)
            NODE_OPTIONS: "--max-old-space-size=3072",
            VIBESTUDIO_DEV_RUNNER_IPC: "1",
            VIBESTUDIO_HOST_ARTIFACT_ROOT: hostGeneration,
          },
        });
        const currentChild = owned.child;
        track(currentChild, owned);

        currentChild.on("message", (message) => {
          if (
            message &&
            message.type === "vibestudio:dev-relaunch" &&
            typeof message.requestId === "string" &&
            isStringArray(message.args)
          ) {
            const stopping = shutdown.requestedSignal() !== null;
            if (!stopping) relaunchArgs = message.args;
            if (currentChild.connected)
              currentChild.send(
                {
                  type: stopping
                    ? "vibestudio:dev-relaunch-rejected"
                    : "vibestudio:dev-relaunch-accepted",
                  requestId: message.requestId,
                  ...(stopping ? { reason: "Developer instance is stopping" } : {}),
                },
                (error) => {
                  if (error) console.error("[dev] relaunch acknowledgement failed", error);
                }
              );
          }
          if (message && message.type === "vibestudio:dev-ready") startTypeCheck();
        });

        currentChild.on("error", (error) => {
          untrack(currentChild);
          if (!settled) {
            settled = true;
            reject(error);
          }
        });
        owned.registered.catch(reject);

        currentChild.on("exit", (code, signal) => {
          untrack(currentChild);
          if (settled) return;
          settled = true;
          resolve({ code, signal, relaunchArgs, owned });
        });
      });
    }

    const ownerLost = () => shutdown.request(isStopSignal(ownerSignal.reason));
    ownerSignal.addEventListener("abort", ownerLost, { once: true });
    if (ownerSignal.aborted) ownerLost();
    try {
      for (;;) {
        if (ownerSignal.aborted || shutdown.requestedSignal()) break;
        const result = await runElectron(nextArgs);
        // Electron has exited: retire whatever its group still holds.
        await result.owned.join();
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
    }
  },
  { appRoot: process.cwd() }
);
