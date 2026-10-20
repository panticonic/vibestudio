import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ownership } from "@vibestudio/shared/ownership";
import { ledgerDirOf, readLedger } from "@vibestudio/shared/ownershipLedger";
import { startEphemeralLinuxSecretService } from "../scripts/lib/linux-secret-service.mjs";

function available(): boolean {
  try {
    for (const tool of ["dbus-daemon", "gnome-keyring-daemon", "gdbus"])
      execFileSync("which", [tool], { stdio: "ignore" });
    return process.platform === "linux";
  } catch {
    return false;
  }
}

function running(pid: number): boolean {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = raw.slice(raw.lastIndexOf(")") + 2, raw.lastIndexOf(")") + 3);
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}

let profile: string;
beforeEach(() => {
  // The bus socket path must stay under dbus-daemon's 98-byte limit.
  profile = fs.mkdtempSync("/tmp/ss-");
});
afterEach(() => {
  fs.rmSync(profile, { recursive: true, force: true });
});

describe.skipIf(!available())("isolated Linux secret service", () => {
  it("owns its helpers and IPC directory through the caller's ownership", async () => {
    const ownership = await Ownership.open({ profileDir: profile, lifetime: "leased" });
    const root = await ownership.scratch("state-");
    let pids: number[] = [];
    let ipcRuntimeDir = "";
    try {
      const secrets = await startEphemeralLinuxSecretService(ownership, root);
      const runtimeDir = secrets.env.XDG_RUNTIME_DIR;
      if (!runtimeDir) throw new Error("The secret service published no runtime directory");
      ipcRuntimeDir = runtimeDir;
      // Short names inside the profile's scratch keep the AF_UNIX path in bounds.
      expect(secrets.env.DBUS_SESSION_BUS_ADDRESS.length).toBeLessThan(150);
      expect(ipcRuntimeDir.startsWith(path.join(profile, "ownership", "scratch"))).toBe(true);
      const ledger = readLedger(ledgerDirOf(profile), ownership.id)!;
      pids = ledger.groups.map((group) => group.pid);
      // The name waiter has usually finished by readiness and may already be
      // dropped from the ledger; the bus and keyring must be registered and serve on.
      expect(pids.length).toBeGreaterThanOrEqual(2);
      expect(pids.filter(running)).toHaveLength(2);
      await secrets.dispose();
      expect(pids.some(running)).toBe(false);
    } finally {
      await ownership.release();
    }
    expect(fs.existsSync(root)).toBe(false);
    expect(fs.existsSync(path.dirname(ipcRuntimeDir))).toBe(false);
  });

  it("starts nothing when cancelled before startup, and keeps the cancellation as the error", async () => {
    const ownership = await Ownership.open({ profileDir: profile, lifetime: "leased" });
    try {
      const root = await ownership.scratch("state-");
      const cancelled = new Error("cancelled before startup");
      await expect(
        startEphemeralLinuxSecretService(ownership, root, { signal: AbortSignal.abort(cancelled) })
      ).rejects.toBe(cancelled);
      expect(readLedger(ledgerDirOf(profile), ownership.id)!.groups).toEqual([]);
    } finally {
      await ownership.release();
    }
  });
});
