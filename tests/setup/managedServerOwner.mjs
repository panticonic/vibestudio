/** Own external live-test resources independently of the Playwright worker.
 * IPC is the lifetime lease: even SIGKILL of the worker closes it. */
import { spawn } from "node:child_process";
import { tsImport } from "tsx/esm/api";
const { createDevelopmentClientLifetime } = await tsImport("../../scripts/development-client-lifecycle.ts", import.meta.url);
import { captureOwnedProcessIdentity } from "../../scripts/owned-process-identity.mjs";
import { terminateOwnedProcessTree } from "../../scripts/owned-process-tree.mjs";
import { startEphemeralLinuxSecretService } from "../../scripts/lib/linux-secret-service.mjs";

let startupCommand;
const execute = async (file, args, options, startup = true) => {
  const { timeout, maxBuffer, ...rest } = options;
  const child = spawn(file, args, {
    ...rest,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
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
  const owned = { pid: child.pid, identity: captureOwnedProcessIdentity(child.pid) };
  if (startup) startupCommand = owned;
  let termination;
  const terminate = () => {
    termination ??= terminateOwnedProcessTree(owned.pid, { identity: owned.identity });
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
  const timer = setTimeout(terminate, timeout);
  try {
    return await command;
  } finally {
    clearTimeout(timer);
    if (termination) {
      const result = await termination;
      if (!result.gone) throw new Error("Timed-out command tree did not terminate");
    }
    if (startupCommand?.pid === owned.pid) startupCommand = undefined;
  }
};
const [instance, directory] = process.argv.slice(2);
if (!instance || !directory || !process.send)
  throw new Error("Managed server owner requires an IPC lease");
const lifetime = createDevelopmentClientLifetime(directory);
const children = [];
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
      timeout: 240_000,
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
      timeout: 180_000,
      maxBuffer: 8 * 1024 * 1024,
    }
  );
  if (closing) return;
  const pairingLink = JSON.parse(stdout.trim().split("\n").at(-1)).pairing.deepLink;
  secretService = await startEphemeralLinuxSecretService(
    directory,
    (startChild) => {
      const child = lifetime.acquire(startChild);
      children.push(child);
      return child;
    },
    lifetime.retireChild,
    { signal: startupController.signal }
  );
  if (closing) return;
  send({
    kind: "ready",
    pairingLink,
    secrets: { env: secretService.env, electronArgs: secretService.electronArgs },
    helperPids: children.map((child) => child.pid),
  });
};
let startup;
function stop() {
  closing = true;
  startupController.abort(new Error("Managed server owner is stopping"));
  lifetime.requestStop();
  return (shutdown ??= (async () => {
    let failed = false;
    if (startupCommand) {
      try {
        const result = await terminateOwnedProcessTree(startupCommand.pid, {
          identity: startupCommand.identity,
        });
        if (!result.gone) throw new Error("Startup command tree did not terminate");
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
      await lifetime.close();
    } catch (error) {
      failed = true;
      console.error(error);
    }
    send({ kind: "stopped", failed });
    if (process.connected) process.disconnect();
    process.exitCode = failed ? 1 : 0;
  })());
}
process.on("disconnect", () => {
  void stop();
});
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
