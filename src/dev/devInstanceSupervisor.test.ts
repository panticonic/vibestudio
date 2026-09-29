import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { terminateOwnedProcessTree } from "../../scripts/owned-process-tree.mjs";
import { afterEach, describe, expect, it } from "vitest";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dev-supervisor-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("DevInstanceSupervisor", () => {
  it.skipIf(process.platform !== "linux")(
    "revokes a detached service and its worker when the supervisor is killed",
    async () => {
      const root = temporaryRoot();
      const ready = path.join(root, "parent-loss.json");
      const service = path.join(root, "service.mjs");
      const ownerEntry = path.join(root, "owner.mjs");
      fs.writeFileSync(
        service,
        `
      import { bindProcessLifetimeToParent } from ${JSON.stringify(new URL("../../scripts/owned-process-tree.mjs", import.meta.url).href)};
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      bindProcessLifetimeToParent();
      const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      fs.writeFileSync(process.argv[2], JSON.stringify({service:process.pid, worker:worker.pid}));
      setInterval(() => {}, 1000);
    `
      );
      fs.writeFileSync(
        ownerEntry,
        `
      import { DevInstanceSupervisor } from ${JSON.stringify(new URL("./devInstanceSupervisor.ts", import.meta.url).href)};
      const supervisor = new DevInstanceSupervisor({sourceRoot:process.argv[2], command:process.execPath,
        args:[process.argv[3],process.argv[4]],env:process.env,stdio:'ignore'});
      await supervisor.start(); await supervisor.wait();
    `
      );
      const owner = spawn(
        process.execPath,
        [
          "--import",
          createRequire(import.meta.url).resolve("tsx"),
          ownerEntry,
          root,
          service,
          ready,
        ],
        { stdio: "ignore" }
      );
      const ownerExit = new Promise<void>((resolve) => owner.once("exit", () => resolve()));
      let identity: { service: number; worker: number } | undefined;
      const alive = (pid: number) => {
        try {
          return fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]!.split(" ")[0] !== "Z";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
      };
      try {
        await expect.poll(() => fs.existsSync(ready)).toBe(true);
        identity = JSON.parse(fs.readFileSync(ready, "utf8"));
        expect(alive(identity!.service)).toBe(true);
        expect(alive(identity!.worker)).toBe(true);
        owner.kill("SIGKILL");
        await ownerExit;
        await expect.poll(() => [identity!.service, identity!.worker].filter(alive)).toEqual([]);
      } finally {
        owner.kill("SIGKILL");
        await ownerExit;
        if (identity && alive(identity.service)) await terminateOwnedProcessTree(identity.service);
      }
    }
  );

  it("supervises the actual TypeScript server until its graceful shutdown completes", async () => {
    const root = temporaryRoot();
    const readyFile = path.join(root, "ready.json");
    const stoppedFile = path.join(root, "stopped");
    const entry = path.join(root, "server.ts");
    fs.writeFileSync(
      entry,
      `
      import fs from 'node:fs';
      const stopped: string = process.argv[3]!;
      fs.writeFileSync(process.argv[2]!, JSON.stringify({pid:process.pid}));
      process.on('SIGTERM', () => setTimeout(() => {
        fs.writeFileSync(stopped, 'drained');
        process.exit(0);
      }, 150));
      setInterval(() => {}, 1000);
    `
    );
    const loader = createRequire(import.meta.url).resolve("tsx");
    const supervisor = new DevInstanceSupervisor({
      sourceRoot: root,
      command: process.execPath,
      args: ["--import", loader, entry, readyFile, stoppedFile],
      env: process.env,
      stdio: "ignore",
      readiness: {
        file: readyFile,
        async onReady(value) {
          expect((value as { pid: number }).pid).toBe(supervisor.process!.pid);
        },
      },
    });
    try {
      await supervisor.start();
      supervisor.process!.kill("SIGTERM");
      expect(fs.existsSync(stoppedFile)).toBe(false);
      await supervisor.wait();
      expect(fs.readFileSync(stoppedFile, "utf8")).toBe("drained");
    } finally {
      await supervisor.stop();
    }
  });

  it("requires exact absolute execution coordinates", () => {
    expect(
      () =>
        new DevInstanceSupervisor({
          sourceRoot: ".",
          command: process.execPath,
          args: [],
          env: process.env,
        })
    ).toThrow("sourceRoot must be absolute");
    expect(
      () =>
        new DevInstanceSupervisor({
          sourceRoot: temporaryRoot(),
          command: "node",
          args: [],
          env: process.env,
        })
    ).toThrow("command must be absolute");
  });

  it("waits for and verifies readiness before exposing the child", async () => {
    const root = temporaryRoot();
    const readyFile = path.join(root, "ready.json");
    const observed: unknown[] = [];
    const supervisor = new DevInstanceSupervisor({
      sourceRoot: root,
      command: process.execPath,
      args: [
        "-e",
        "require('node:fs').writeFileSync(process.argv[1], JSON.stringify({generation:'g1'}))",
        readyFile,
      ],
      env: process.env,
      stdio: "ignore",
      readiness: {
        file: readyFile,
        onReady(value) {
          observed.push(value);
          return Promise.resolve();
        },
      },
    });

    await supervisor.start();
    await expect(supervisor.wait()).resolves.toBe(0);
    expect(observed).toEqual([{ generation: "g1" }]);
  });

  it("reports early child exit as a readiness failure", async () => {
    const root = temporaryRoot();
    const supervisor = new DevInstanceSupervisor({
      sourceRoot: root,
      command: process.execPath,
      args: ["-e", "process.exit(7)"],
      env: process.env,
      stdio: "ignore",
      readiness: {
        file: path.join(root, "never-ready.json"),
        onReady() {
          return Promise.resolve();
        },
      },
    });

    await expect(supervisor.start()).rejects.toThrow(
      "exited with code 7 before publishing readiness"
    );
  });

  it.runIf(process.platform !== "win32")(
    "drains descendants when the process-group leader exits first",
    async () => {
      const root = temporaryRoot();
      const readyFile = path.join(root, "ready.json");
      let grandchildPid = 0;
      const supervisor = new DevInstanceSupervisor({
        sourceRoot: root,
        command: process.execPath,
        args: [
          "-e",
          [
            "const {spawn}=require('node:child_process');",
            "const fs=require('node:fs');",
            "const child=spawn(process.execPath,['-e',",
            "  'process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'",
            "],{stdio:'ignore'});",
            "fs.writeFileSync(process.argv[1],JSON.stringify({pid:child.pid}));",
            "setTimeout(()=>process.exit(0),20);",
          ].join(""),
          readyFile,
        ],
        env: process.env,
        stdio: "ignore",
        stopTimeoutMs: 50,
        readiness: {
          file: readyFile,
          async onReady(value) {
            grandchildPid = (value as { pid: number }).pid;
          },
        },
      });

      await supervisor.start();
      await supervisor.wait();
      await expectProcessToDisappear(grandchildPid);
    }
  );

  it.runIf(process.platform !== "win32")(
    "terminates the complete exact process group and escalates after the grace period",
    async () => {
      const root = temporaryRoot();
      const readyFile = path.join(root, "ready.json");
      let grandchildPid = 0;
      const supervisor = new DevInstanceSupervisor({
        sourceRoot: root,
        command: process.execPath,
        args: [
          "-e",
          [
            "const {spawn}=require('node:child_process');",
            "const fs=require('node:fs');",
            "const child=spawn(process.execPath,['-e',",
            "  'process.on(\"SIGTERM\",()=>{});setInterval(()=>{},1000)'",
            "],{stdio:'ignore'});",
            "process.on('SIGTERM',()=>{});",
            "fs.writeFileSync(process.argv[1],JSON.stringify({pid:child.pid}));",
            "setInterval(()=>{},1000);",
          ].join(""),
          readyFile,
        ],
        env: process.env,
        stdio: "ignore",
        stopTimeoutMs: 50,
        readiness: {
          file: readyFile,
          async onReady(value) {
            grandchildPid = (value as { pid: number }).pid;
          },
        },
      });

      await supervisor.start();
      expect(grandchildPid).toBeGreaterThan(0);
      await supervisor.stop();

      await expectProcessToDisappear(grandchildPid);
    }
  );
});

async function expectProcessToDisappear(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} remained alive after its owned group was stopped`);
}
