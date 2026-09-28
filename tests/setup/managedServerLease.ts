import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcess,
} from "../../scripts/owned-process-identity.mjs";

export interface ManagedServerReady {
  kind: "ready";
  pairingLink: string;
  secrets: { env: Record<string, string>; electronArgs: string[] };
  helperPids: number[];
}

export function launchManagedServerOwner(
  instance: string,
  directory: string,
  runRoot: string,
  logPath: string,
  environment: Record<string, string> = {}
) {
  const log = fs.openSync(logPath, "a", 0o600);
  const child = fork(
    fileURLToPath(new URL("./managedServerOwner.mjs", import.meta.url)),
    [instance, directory],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", log, log, "ipc"],
      execArgv: [],
      env: { ...process.env, ...environment },
    }
  );
  fs.closeSync(log);
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Managed resource owner exited with ${code}; see ${logPath}`))
    );
  });
  // Mark failures handled even when they precede a caller awaiting cleanup.
  void exited.catch(() => {});
  const identity = captureOwnedProcessIdentity(child.pid!);
  const ownerDirectory = path.join(runRoot, "resource-owners");
  fs.mkdirSync(ownerDirectory, { recursive: true });
  fs.writeFileSync(path.join(ownerDirectory, `${child.pid}.json`), JSON.stringify(identity), {
    mode: 0o600,
  });
  const ready = new Promise<ManagedServerReady>((resolve, reject) => {
    child.on("message", (message: ManagedServerReady | { kind: "error"; message: string }) => {
      if (message.kind === "ready") resolve(message);
      if (message.kind === "error") reject(new Error(message.message));
    });
    child.once("exit", () =>
      reject(new Error(`Managed resource owner exited before readiness; see ${logPath}`))
    );
    child.once("error", reject);
  });
  return {
    pid: child.pid!,
    ready,
    async stop() {
      if (child.connected) child.send({ kind: "stop" });
      await exited;
    },
  };
}

/** Coordinator backstop: finish resource cleanup before deleting run files. */
export async function stopRunResourceOwners(runRoot: string): Promise<void> {
  const directory = path.join(runRoot, "resource-owners");
  if (!fs.existsSync(directory)) return;
  for (const file of fs.readdirSync(directory)) {
    const identity = JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
    if (observeOwnedProcess(identity) === "absent") continue;
    if (observeOwnedProcess(identity) !== "owned")
      throw new Error(`Cannot verify resource owner ${identity.pid}`);
    process.kill(identity.pid, "SIGTERM");
    const deadline = Date.now() + 300_000;
    while (observeOwnedProcess(identity) === "owned" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (observeOwnedProcess(identity) !== "absent") {
      throw new Error(`Managed resource owner ${identity.pid} has not finished cleanup`);
    }
  }
}
