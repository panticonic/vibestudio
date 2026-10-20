/** Own external live-test resources independently of the Playwright worker.
 * IPC is the lifetime lease: even SIGKILL of the worker closes it, and this
 * process's own reaper then retires every child and the directory. */
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, watchLease } from "@vibestudio/shared/ownership";
import { ledgerDirOf, readLedger } from "@vibestudio/shared/ownershipLedger";
import { startEphemeralLinuxSecretService } from "../../scripts/lib/linux-secret-service.mjs";

const [instance, directory] = process.argv.slice(2);
if (!instance || !directory || !process.send)
  throw new Error("Managed server owner requires an IPC lease");
const profileDir = getProfileDataPath();
const ownership = await Ownership.open({ profileDir, lifetime: "leased" });
// The coordinator allocated this directory; it is removed after every group retires.
await ownership.own(directory, "managed-server-directory");

let startupCommand;
const execute = async (file, args, options, startup = true) => {
  const { maxBuffer, ...rest } = options;
  const owned = ownership.spawn(file, args, {
    ...rest,
    kill: "immediate",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { child } = owned;
  let stdout = "";
  let stderr = "";
  let outputError;
  const command = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 && !outputError) resolve({ stdout, stderr });
      else reject(outputError ?? new Error(`Command exited ${code ?? signal}: ${stderr}`));
    });
  });
  void command.catch(() => {});
  if (startup) startupCommand = owned;
  let termination;
  const terminate = () => {
    termination ??= owned.retire();
    void termination.catch(() => {});
  };
  for (const [stream, append] of [
    [
      child.stdout,
      (value) => {
        stdout += value;
      },
    ],
    [
      child.stderr,
      (value) => {
        stderr += value;
      },
    ],
  ]) {
    stream.setEncoding("utf8");
    stream.on("data", (value) => {
      if (outputError) return;
      append(value);
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) {
        outputError = new Error("Managed command output exceeded its limit");
        terminate();
      }
    });
  }
  try {
    return await command;
  } finally {
    if (termination) await termination;
    await owned.join();
    if (startupCommand === owned) startupCommand = undefined;
  }
};
const startupController = new AbortController();
let secretService;
let closing = false;
let shutdown;
const send = (message) => {
  if (process.connected) process.send(message, () => {});
};
const managed = async (operation) => {
  const result = await execute(
    process.execPath,
    ["--import", "tsx", "src/dev/runSystemTest.ts", "--instance", instance, operation],
    {
      maxBuffer: 8 * 1024 * 1024,
    },
    operation !== "stop"
  );
  console.log(result.stdout);
};
const start = async () => {
  await managed("doctor");
  if (closing) return;
  const { stdout } = await execute(
    process.execPath,
    [
      "--import",
      "tsx",
      "src/dev/runCli.ts",
      "--instance",
      instance,
      "remote",
      "pair-device",
      "--ttl-ms",
      "3600000",
      "--json",
    ],
    {
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  if (closing) return;
  const pairingLink = JSON.parse(stdout.trim().split("\n").at(-1)).pairing.deepLink;
  secretService = await startEphemeralLinuxSecretService(ownership, directory, {
    signal: startupController.signal,
  });
  if (closing) return;
  send({
    kind: "ready",
    pairingLink,
    secrets: { env: secretService.env, electronArgs: secretService.electronArgs },
    helperPids: readLedger(ledgerDirOf(profileDir), ownership.id).groups.map((group) => group.pid),
  });
};
let startup;
function stop() {
  closing = true;
  startupController.abort(new Error("Managed server owner is stopping"));
  return (shutdown ??= (async () => {
    let failed = false;
    if (startupCommand) {
      try {
        await startupCommand.retire();
      } catch (error) {
        failed = true;
        console.error(error);
      }
    }
    await startup?.catch(() => {});
    try {
      await managed("stop");
    } catch (error) {
      failed = true;
      console.error(error);
    }
    try {
      await secretService?.dispose();
    } catch (error) {
      failed = true;
      console.error(error);
    }
    try {
      await ownership.release();
    } catch (error) {
      failed = true;
      console.error(error);
    }
    send({ kind: "stopped", failed });
    if (process.connected) process.disconnect();
    process.exitCode = failed ? 1 : 0;
  })());
}
// The caller's lease: its end-of-file means the caller is gone, even by SIGKILL.
watchLease().addEventListener("abort", () => void stop(), { once: true });
// Losing the reaper is losing ownership: wind down and fail.
ownership.signal.addEventListener("abort", () => void stop(), { once: true });
process.on("message", (message) => {
  if (message?.kind === "stop") void stop();
});
process.on("SIGTERM", () => {
  void stop();
});
process.on("SIGINT", () => {
  void stop();
});
startup = start();
void startup.catch((error) => {
  if (closing) return;
  // Pairing output is never included in diagnostics.
  send({ kind: "error", message: error.message });
  console.error(error.message);
  void stop();
});
