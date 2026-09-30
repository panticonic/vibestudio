import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
  type OwnedProcessIdentity,
} from "@vibestudio/shared/ownedProcessIdentity";
import { describe, expect, it, vi } from "vitest";
import { processTreeAlive, terminateOwnedProcessTree } from "../scripts/owned-process-tree.mjs";

describe.skipIf(process.platform === "win32")("owned POSIX process tree", () => {
  it.each(["parent-death", "ipc-disconnect"])(
    "revokes a detached hub and workspace on %s before readiness",
    async (failure) => {
      const lifetimeModule = new URL("../scripts/owned-process-tree.mjs", import.meta.url).href;
      const identityModule = new URL("../scripts/owned-process-identity.mjs", import.meta.url).href;
      const workspace =
        'process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);';
      const hub = `
        import { spawn } from "node:child_process";
        import { bindProcessLifetimeToParent } from ${JSON.stringify(lifetimeModule)};
        import { captureOwnedProcessIdentity } from ${JSON.stringify(identityModule)};
        bindProcessLifetimeToParent();
        const workspace = spawn(process.execPath, ["-e", ${JSON.stringify(workspace)}], {
          detached: true, stdio: ["ignore", "pipe", "ignore"],
        });
        workspace.stdout.once("data", () => process.send({
          hub: captureOwnedProcessIdentity(process.pid),
          workspace: captureOwnedProcessIdentity(workspace.pid),
        }));
        setInterval(() => {}, 1000);
      `;
      const desktop = `
        const { spawn } = require("node:child_process");
        const hub = spawn(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(hub)}], {
          detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
        });
        hub.once("message", (receipt) => process.send(receipt));
        process.on("message", () => hub.disconnect());
        setInterval(() => {}, 1000);
      `;
      const parent = spawn(process.execPath, ["-e", desktop], {
        detached: true,
        stdio: ["ignore", "ignore", "inherit", "ipc"],
      });
      const parentIdentity = captureOwnedProcessIdentity(parent.pid!);
      let receipts: { hub: OwnedProcessIdentity; workspace: OwnedProcessIdentity } | undefined;
      try {
        [receipts] = (await once(parent, "message", {
          signal: AbortSignal.timeout(5_000),
        })) as [typeof receipts];
        expect(observeOwnedProcessGroup(receipts!.hub)).toBe("owned");
        expect(observeOwnedProcessGroup(receipts!.workspace)).toBe("owned");
        if (failure === "parent-death") parent.kill("SIGKILL");
        else parent.send({ disconnect: true });
        await vi.waitFor(() => expect(observeOwnedProcessGroup(receipts!.hub)).toBe("absent"), {
          timeout: 5_000,
        });
        await vi.waitFor(
          () => expect(observeOwnedProcessGroup(receipts!.workspace)).toBe("absent"),
          { timeout: 5_000 }
        );
      } finally {
        await terminateOwnedProcessTree(parent.pid!, {
          identity: parentIdentity,
          termTimeoutMs: 100,
        });
        for (const identity of receipts ? [receipts.hub, receipts.workspace] : []) {
          await terminateOwnedProcessTree(identity.pid, { identity, termTimeoutMs: 100 });
        }
      }
    },
    10_000
  );
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

  it("retires a child sharing the caller's process group without signalling the caller", async () => {
    // Every other case here spawns `detached`, which is why this went unnoticed:
    // a child spawned *without* it stays in the caller's own process group, so
    // its pgid is ours. Signalling that group SIGKILLs the test runner itself —
    // the failure mode reads as an external kill, not as a bug in here.
    const owned = spawn(
      process.execPath,
      ["-e", `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`],
      { stdio: ["ignore", "pipe", "ignore"] }
    );
    await once(owned.stdout!, "data");
    expect(processTreeAlive(owned.pid!)).toBe(true);

    try {
      const result = await terminateOwnedProcessTree(owned.pid!, {
        termTimeoutMs: 100,
        killTimeoutMs: 5_000,
      });

      expect(result).toMatchObject({ gone: true });
      expect(processTreeAlive(owned.pid!)).toBe(false);
      // Reaching this line at all is the point: the caller was not signalled.
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(owned.pid!, "SIGKILL");
      } catch {}
    }
  }, 10_000);

  it("retires a retained group after its captured leader has been reaped", async () => {
    const descendant = `process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000);`;
    const parent = `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["ignore", "pipe", "ignore"] });
      child.stdout.once("data", () => { console.log("ready"); process.exit(0); });
    `;
    const owned = spawn(process.execPath, ["-e", parent], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const identity = captureOwnedProcessIdentity(owned.pid!);
    const exited = once(owned, "exit");
    await once(owned.stdout!, "data");
    await exited;
    try {
      expect(observeOwnedProcessGroup(identity)).toBe("retained");
      await expect(
        terminateOwnedProcessTree(owned.pid!, { identity, termTimeoutMs: 100 })
      ).resolves.toMatchObject({ gone: true, escalated: true });
      expect(observeOwnedProcessGroup(identity)).toBe("absent");
    } finally {
      await terminateOwnedProcessTree(owned.pid!, { identity, termTimeoutMs: 0 });
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
