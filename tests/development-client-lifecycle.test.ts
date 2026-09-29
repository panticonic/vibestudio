import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startEphemeralLinuxSecretService } from "../scripts/lib/linux-secret-service.mjs";
import { createDevelopmentClientLifetime } from "../scripts/development-client-lifecycle.js";
import { createOwnedProcessLifetime } from "../scripts/development-client-lifecycle.js";

describe.skipIf(process.platform === "win32")("development client lifetime", () => {
  it("joins one acquired generation before starting its replacement", async () => {
    const lifetime = createOwnedProcessLifetime();
    const start = () => spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    try {
      const first = lifetime.acquire(start);
      await once(first.stdout!, "data");
      await lifetime.retireChild(first);
      expect(() => process.kill(-first.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      const next = lifetime.acquire(start);
      await once(next.stdout!, "data");
      expect(() => process.kill(-next.pid!, 0)).not.toThrow();
      const foreign = spawn(process.execPath, ["-e", ""], { detached: true, stdio: "ignore" });
      await once(foreign, "exit");
      expect(() => lifetime.retireChild(foreign)).toThrow("not acquired");
    } finally {
      await lifetime.retire();
    }
  });
  it("cleans up a refused spawn through the ordinary lifetime", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibestudio-client-lifetime-test-"));
    const lifetime = createDevelopmentClientLifetime(root);
    const refused = lifetime.acquire(() => spawn(join(root, "missing-executable"), [], { detached: true, stdio: "ignore" }));
    const [error] = await once(refused, "error");
    expect(error).toMatchObject({ code: "ENOENT" });
    await lifetime.close();
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it.skipIf(process.platform !== "linux")("joins real keyring helpers and cancels creation after asynchronous setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "vs-keyring-"));
    const lifetime = createDevelopmentClientLifetime(root);
    const groups: number[] = [];
    try {
      const secrets = await startEphemeralLinuxSecretService(root, (start: () => import("node:child_process").ChildProcess) => {
        const child = lifetime.acquire(start);
        if (child.pid) groups.push(child.pid);
        return child;
      });
      expect(secrets.env.DBUS_SESSION_BUS_ADDRESS).toContain(root);
      expect(groups).toHaveLength(2);
    } finally {
      await lifetime.close();
    }
    for (const pid of groups) {
      expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    }
    await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });

    const cancelledRoot = await mkdtemp(join(tmpdir(), "vs-keyring-cancel-"));
    const cancelled = createDevelopmentClientLifetime(cancelledRoot);
    const startup = startEphemeralLinuxSecretService(cancelledRoot, cancelled.acquire);
    cancelled.requestStop();
    try {
      await expect(startup).rejects.toThrow("Client lifetime is stopping");
    } finally {
      await cancelled.close();
    }
    await expect(access(cancelledRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("retires a retained descendant before deleting state, and prevents creation during startup cancellation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibestudio-client-lifetime-test-"));
    const lifetime = createDevelopmentClientLifetime(root);
    const groups: number[] = [];
    const leader = lifetime.acquire(() => spawn(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'inherit'] });
      child.stdout.once('data', () => process.exit(0));
    `], { detached: true, stdio: "ignore" }));
    try {
      groups.push(leader.pid!);
      await once(leader, "exit");
      await access(root);
      lifetime.requestStop();
      let created = false;
      const start = () => { created = true; return leader; };
      expect(() => lifetime.acquire(start)).toThrow("Client lifetime is stopping");
      expect(created).toBe(false);
      await Promise.all([lifetime.close(), lifetime.close()]);
      expect(() => lifetime.acquire(start)).toThrow("Client lifetime is stopping");
      expect(created).toBe(false);
      await expect(access(root)).rejects.toMatchObject({ code: "ENOENT" });
      for (const pid of groups) {
        expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      }
    } finally {
      for (const pid of groups) {
        try { process.kill(-pid, "SIGKILL"); } catch { /* Already proved absent. */ }
      }
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
