import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { OwnedProcessGroup } from "@vibestudio/shared/ownedProcessGroup";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
  type OwnedProcessIdentity,
} from "@vibestudio/shared/ownedProcessIdentity";

it.skipIf(process.platform === "win32")(
  "preserves the actual command's terminal exit code",
  async () => {
    const child = spawn(
      process.execPath,
      [resolve("scripts/parent-owned-command.mjs"), process.execPath, "-e", "process.exit(7)"],
      { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }
    );
    const owner = OwnedProcessGroup.create(child);
    try {
      const [code, signal] = await once(child, "exit");
      expect({ code, signal }).toEqual({ code: 7, signal: null });
    } finally {
      await owner.retire("SIGKILL");
    }
  }
);

it.skipIf(process.platform === "win32")(
  "revokes a non-Node command tree when its launcher is killed",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "vs-command-lease-"));
    const ready = join(root, "ready.json");
    const entry = join(root, "launcher.cjs");
    const worker = `process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000);`;
    const command = `
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const worker = spawn(process.execPath, ["-e", ${JSON.stringify(worker)}], { detached:true, stdio:["ignore","pipe","ignore"] });
    worker.stdout.once("data",()=>fs.writeFileSync(${JSON.stringify(ready)}, JSON.stringify({ command:process.pid, worker:worker.pid })));
    setInterval(()=>{},1000);
  `;
    await writeFile(
      entry,
      `
    const { spawn } = require("node:child_process");
    const lease = spawn(process.execPath, [${JSON.stringify(resolve("scripts/parent-owned-command.mjs"))}, process.execPath, "-e", ${JSON.stringify(command)}], { detached:true, stdio:["ignore","ignore","ignore","ipc"] });
    process.send({ lease:lease.pid });
    setInterval(()=>{},1000);
  `
    );
    const launcher = spawn(process.execPath, [entry], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const launcherOwner = OwnedProcessGroup.create(launcher);
    const receipts: OwnedProcessIdentity[] = [];
    try {
      const [message] = await once(launcher, "message");
      receipts.push(captureOwnedProcessIdentity((message as { lease: number }).lease));
      let payload: { command: number; worker: number } | undefined;
      await expect
        .poll(async () => {
          try {
            payload = JSON.parse(await readFile(ready, "utf8"));
            return true;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw error;
          }
        })
        .toBe(true);
      receipts.push(captureOwnedProcessIdentity(payload!.worker));
      const exited = once(launcher, "exit");
      launcher.kill("SIGKILL");
      await exited;
      await expect
        .poll(() => receipts.map(observeOwnedProcessGroup), { timeout: 5_000 })
        .toEqual(["absent", "absent"]);
      await expect
        .poll(async () => {
          try {
            return (await readFile(`/proc/${payload!.command}/stat`, "utf8"))
              .split(") ")[1]!
              .split(" ")[0];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
            throw error;
          }
        })
        .toSatisfy((state: string) => ["absent", "Z", "X"].includes(state));
    } finally {
      await launcherOwner.retire("SIGKILL");
      await Promise.all(
        receipts.map((receipt) => OwnedProcessGroup.adopt(receipt).retire("SIGKILL"))
      );
      await rm(root, { recursive: true, force: true });
    }
  },
  10_000
);
