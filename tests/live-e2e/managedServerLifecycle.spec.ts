import { test, expect } from "@playwright/test";
import { fork, execFileSync } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { resolveDevInstance } from "../../src/dev/instanceRegistry";
import { stopRunResourceOwners } from "../setup/managedServerLease";

for (const phase of ["provisioning", "ready"] as const) {
  test(`killing a live-test worker during ${phase} reaps its managed server and helpers`, async () => {
    test.setTimeout(360_000);
    const root = process.env["VIBESTUDIO_E2E_TEMP_ROOT"]!;
    const directory = fs.mkdtempSync(path.join(root, "l-"));
    const instance = `website-lifecycle-${randomUUID().slice(0, 8)}`;
    const log = test.info().outputPath("owner.log");
    const worker = fork(
      fileURLToPath(new URL("../setup/fixtures/managedServerWorker.ts", import.meta.url)),
      [instance, directory, root, log],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }
    );
    let stderr = "";
    worker.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    const exited = once(worker, "exit");
    const ready = new Promise<{ ownerPid: number; helperPids: number[] }>((resolve, reject) => {
      worker.on("message", (message: { kind: string; ownerPid: number; helperPids?: number[] }) => {
        if (message.kind === (phase === "ready" ? "ready" : "started"))
          resolve({ ownerPid: message.ownerPid, helperPids: message.helperPids ?? [] });
      });
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error(`Fixture exited before ready: ${stderr}`)));
    });
    try {
      const resources = await ready;
      await expect
        .poll(
          () => {
            try {
              return resolveDevInstance(process.cwd(), instance).root;
            } catch {
              return null;
            }
          },
          { timeout: 60_000 }
        )
        .toBeTruthy();
      const server = resolveDevInstance(process.cwd(), instance);
      const serverRoot = server.root;
      const table = execFileSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number));
      const descendants = new Set([server.supervisorPid]);
      let previousSize = 0;
      while (previousSize !== descendants.size) {
        previousSize = descendants.size;
        for (const [pid, parent] of table) if (descendants.has(parent!)) descendants.add(pid!);
      }
      worker.kill("SIGKILL");
      await exited;
      await expect
        .poll(
          () => {
            try {
              resolveDevInstance(process.cwd(), instance);
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 60_000 }
        )
        .toBe(true);
      for (const pid of [resources.ownerPid, ...resources.helperPids, ...descendants]) {
        await expect
          .poll(
            () => {
              try {
                process.kill(pid, 0);
                return false;
              } catch (error) {
                return (error as NodeJS.ErrnoException).code === "ESRCH";
              }
            },
            { timeout: 60_000 }
          )
          .toBe(true);
      }
      expect(fs.existsSync(serverRoot)).toBe(false);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
      await exited;
      await stopRunResourceOwners(root);
      if (fs.existsSync(log))
        await test.info().attach("owner.log", { path: log, contentType: "text/plain" });
    }
  });
}
