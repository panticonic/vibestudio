import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership } from "@vibestudio/shared/ownership";
import { awaitRetirement, ledgerDirOf, listLedgers } from "@vibestudio/shared/ownershipLedger";

export interface ManagedServerReady {
  kind: "ready";
  pairingLink: string;
  secrets: { env: Record<string, string>; electronArgs: string[] };
  /** Process-group leaders of the owner's live helpers (from its ledger). */
  helperPids: number[];
}

/**
 * Start the resource owner for one live test. The owner is a lessee of the
 * caller's ownership: when the caller dies, however abruptly, the lease ends,
 * the owner stops the server it provisioned in order, and the caller's reaper
 * retires whatever the owner leaves behind. The ledger records `runRoot` so
 * the run coordinator can join every owner before deleting the run's files.
 */
export async function launchManagedServerOwner(
  instance: string,
  directory: string,
  runRoot: string,
  logPath: string,
  environment: Record<string, string> = {}
) {
  const ownership = await Ownership.open({
    profileDir: getProfileDataPath(),
    lifetime: "leased",
    meta: { role: "managed-server-owner", runRoot },
  });
  const log = fs.openSync(logPath, "a", 0o600);
  let owned;
  try {
    owned = ownership.spawn(
      process.execPath,
      [fileURLToPath(new URL("./managedServerOwner.mjs", import.meta.url)), instance, directory],
      {
        stdio: ["ignore", log, log, "ipc"],
        env: { ...process.env, ...environment },
        kill: "graceful",
        lease: true,
        label: "managed-server-owner",
      }
    );
  } catch (error) {
    await ownership.release().catch(() => undefined);
    throw error;
  } finally {
    fs.closeSync(log);
  }
  const { child } = owned;
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
      const failures: unknown[] = [];
      try {
        await exited;
      } catch (error) {
        failures.push(error);
      }
      try {
        await ownership.release();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Managed resource owner stop failed");
    },
  };
}

/**
 * Coordinator backstop: join the retirement of every ownership recorded for this
 * run (the owners and desktops of a killed worker are retired by its reaper)
 * before deleting run files.
 */
export async function stopRunResourceOwners(runRoot: string): Promise<void> {
  const dir = ledgerDirOf(getProfileDataPath());
  const failures: unknown[] = [];
  for (const { ledger } of listLedgers(dir)) {
    if (ledger.meta["runRoot"] !== runRoot) continue;
    try {
      await awaitRetirement(dir, ledger.id, { token: ledger.token });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Managed resource owners did not retire");
}
