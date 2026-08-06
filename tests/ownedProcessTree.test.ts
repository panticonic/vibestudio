import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { processTreeAlive, terminateOwnedProcessTree } from "../scripts/owned-process-tree.mjs";

describe.skipIf(process.platform === "win32")("owned POSIX process tree", () => {
  it("escalates and removes a three-level tree whose descendants ignore SIGTERM", async () => {
    const grandchild = `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const child = `
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => {});
      spawn(process.execPath, ["-e", ${JSON.stringify(grandchild)}], { stdio: "ignore" });
      setInterval(() => {}, 1000);
    `;
    const parent = `
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => {});
      spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" });
      console.log("ready");
      setInterval(() => {}, 1000);
    `;
    const owned = spawn(process.execPath, ["-e", parent], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    await once(owned.stdout!, "data");
    expect(processTreeAlive(owned.pid!)).toBe(true);

    const result = await terminateOwnedProcessTree(owned.pid!, {
      termTimeoutMs: 100,
      killTimeoutMs: 5_000,
    });

    expect(result).toMatchObject({ gone: true, escalated: true });
    expect(processTreeAlive(owned.pid!)).toBe(false);
  }, 10_000);

  it("removes descendants that deliberately use their own process group", async () => {
    const child = `
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const parent = `
      const { spawn } = require("node:child_process");
      process.on("SIGTERM", () => {});
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(child)}], {
        detached: true,
        stdio: "ignore",
      });
      console.log(child.pid);
      setInterval(() => {}, 1000);
    `;
    const owned = spawn(process.execPath, ["-e", parent], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const [childPidOutput] = await once(owned.stdout!, "data");
    const childPid = Number(String(childPidOutput).trim());
    expect(Number.isInteger(childPid)).toBe(true);

    try {
      const result = await terminateOwnedProcessTree(owned.pid!, {
        termTimeoutMs: 100,
        killTimeoutMs: 5_000,
      });

      expect(result).toMatchObject({ gone: true, escalated: true });
      expect(processTreeAlive(owned.pid!)).toBe(false);
      expect(() => process.kill(childPid, 0)).toThrow();
    } finally {
      try {
        process.kill(-owned.pid!, "SIGKILL");
      } catch {}
      try {
        process.kill(-childPid, "SIGKILL");
      } catch {}
    }
  }, 10_000);

  it("classifies an already-exited owner as gone", async () => {
    const owned = spawn(process.execPath, ["-e", ""], {
      detached: true,
      stdio: "ignore",
    });
    await once(owned, "exit");
    await expect(terminateOwnedProcessTree(owned.pid!)).resolves.toEqual({
      gone: true,
      escalated: false,
    });
  });
});
