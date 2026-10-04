import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { terminateOwnedProcessTree } from "../../scripts/owned-process-tree.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import {
  captureOwnedProcessIdentity,
  observeOwnedProcessGroup,
  type OwnedProcessIdentity,
} from "@vibestudio/shared/ownedProcessIdentity";
import { OwnedProcessGroup } from "@vibestudio/shared/ownedProcessGroup";

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
  it.skipIf(process.platform === "win32")(
    "coalesces repeated CLI signals into one ordered child retirement",
    async () => {
      const root = temporaryRoot();
      const ready = path.join(root, "ready");
      const countFile = path.join(root, "signal-count");
      const service = path.join(root, "service.mjs");
      const ownerEntry = path.join(root, "owner.mjs");
      fs.writeFileSync(
        service,
        `
        import fs from 'node:fs';
        let signals = 0;
        const stop = () => {
          fs.writeFileSync(process.argv[3], String(++signals));
          setTimeout(() => process.exit(0), 300);
        };
        process.on('SIGINT', stop); process.on('SIGTERM', stop);
        fs.writeFileSync(process.argv[2], 'ready');
        setInterval(() => {}, 1000);
      `
      );
      fs.writeFileSync(
        ownerEntry,
        `
        import { DevInstanceSupervisor } from ${JSON.stringify(new URL("./devInstanceSupervisor.ts", import.meta.url).href)};
        const owner = new DevInstanceSupervisor({ sourceRoot: process.argv[2], command: process.execPath,
          args: [process.argv[3], process.argv[4], process.argv[5]], env: process.env, stdio: 'ignore', forwardParentSignals: true });
        try { await owner.start(); await owner.wait(); } finally { await owner.close(); }
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
          countFile,
        ],
        { detached: true, stdio: "ignore" }
      );
      const identity = captureOwnedProcessIdentity(owner.pid!);
      const exit = new Promise<number | null>((resolve) => owner.once("exit", resolve));
      try {
        await expect.poll(() => fs.existsSync(ready)).toBe(true);
        owner.kill("SIGINT");
        await expect.poll(() => fs.existsSync(countFile)).toBe(true);
        owner.kill("SIGINT");
        owner.kill("SIGTERM");
        expect(await exit).toBe(0);
        expect(fs.readFileSync(countFile, "utf8")).toBe("1");
      } finally {
        await terminateOwnedProcessTree(owner.pid!, { identity, termTimeoutMs: 100 });
      }
    }
  );
  it.skipIf(process.platform === "win32")(
    "keeps the CLI signal owner alive through post-retirement state cleanup",
    async () => {
      const root = temporaryRoot();
      const ready = path.join(root, "ready.json");
      const cleanupStarted = path.join(root, "cleanup-started");
      const cleanupDone = path.join(root, "cleanup-done");
      const service = path.join(root, "service.mjs");
      const ownerEntry = path.join(root, "owner.mjs");
      fs.writeFileSync(
        service,
        `
        import fs from 'node:fs';
        process.on('SIGTERM', () => process.exit(0));
        fs.writeFileSync(process.argv[2], '{}');
        setInterval(() => {}, 1000);
      `
      );
      fs.writeFileSync(
        ownerEntry,
        `
        import fs from 'node:fs';
        import { DevInstanceSupervisor } from ${JSON.stringify(new URL("./devInstanceSupervisor.ts", import.meta.url).href)};
        const owner = new DevInstanceSupervisor({ sourceRoot: process.argv[2], command: process.execPath,
          args: [process.argv[3], process.argv[4]], env: process.env, stdio: 'ignore', forwardParentSignals: true });
        try {
          await owner.start();
          await owner.wait();
        } finally {
          fs.writeFileSync(process.argv[5], 'retiring-state');
          await new Promise(resolve => setTimeout(resolve, 300));
          fs.writeFileSync(process.argv[6], 'removed-state');
          await owner.close();
        }
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
          cleanupStarted,
          cleanupDone,
        ],
        { detached: true, stdio: "ignore" }
      );
      const identity = captureOwnedProcessIdentity(owner.pid!);
      const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
        owner.once("exit", (code, signal) => resolve({ code, signal }))
      );
      try {
        await expect.poll(() => fs.existsSync(ready)).toBe(true);
        owner.kill("SIGTERM");
        await expect.poll(() => fs.existsSync(cleanupStarted)).toBe(true);
        // pnpm/tsx can deliver another signal after the child has already exited.
        owner.kill("SIGTERM");
        expect(await exit).toEqual({ code: 0, signal: null });
        expect(fs.readFileSync(cleanupDone, "utf8")).toBe("removed-state");
      } finally {
        await terminateOwnedProcessTree(owner.pid!, { identity, termTimeoutMs: 100 });
      }
    }
  );
  it.skipIf(process.platform === "win32")(
    "joins a registered detached group after abrupt child death",
    async () => {
      const root = temporaryRoot();
      const entry = path.join(root, "registered-owner.mjs");
      const readyFile = path.join(root, "ready.json");
      fs.writeFileSync(
        entry,
        `
      import { spawn } from "node:child_process";
      import fs from "node:fs";
      import { registerOwnedProcessGroup } from ${JSON.stringify(new URL("../../packages/shared/src/ownedProcessRegistration.mjs", import.meta.url).href)};
      import { captureOwnedProcessIdentity } from ${JSON.stringify(new URL("../../packages/shared/src/ownedProcessIdentity.mjs", import.meta.url).href)};
      const child = spawn(process.execPath, ["-e", 'process.on("SIGTERM",()=>{}); console.log("ready"); setInterval(()=>{},1000)'], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
      await new Promise(resolve => child.stdout.once("data", resolve));
      const identity = captureOwnedProcessIdentity(child.pid);
      await registerOwnedProcessGroup(identity);
      fs.writeFileSync(process.argv[2], JSON.stringify(identity));
      setInterval(()=>{},1000);
    `
      );
      let receipt: OwnedProcessIdentity | undefined;
      const supervisor = new DevInstanceSupervisor({
        sourceRoot: root,
        command: process.execPath,
        args: [entry, readyFile],
        env: process.env,
        stdio: "ignore",
        readiness: {
          file: readyFile,
          async onReady(value) {
            receipt = value as OwnedProcessIdentity;
          },
        },
      });
      try {
        await supervisor.start();
        expect(observeOwnedProcessGroup(receipt!)).toBe("owned");
        supervisor.process!.kill("SIGKILL");
        await expect(supervisor.wait()).resolves.toBe(137);
        expect(observeOwnedProcessGroup(receipt!)).toBe("absent");
      } finally {
        await supervisor.stop("SIGKILL");
        if (receipt) await OwnedProcessGroup.adopt(receipt).retire("SIGKILL");
      }
    },
    10_000
  );

  it.skipIf(process.platform === "win32")(
    "rejects a transferred receipt for a process outside its child tree",
    async () => {
      const root = temporaryRoot();
      const foreign = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        detached: true,
        stdio: "ignore",
      });
      const foreignOwner = OwnedProcessGroup.create(foreign);
      const receipt = captureOwnedProcessIdentity(foreign.pid!);
      const entry = path.join(root, "unrelated-receipt.mjs");
      fs.writeFileSync(
        entry,
        `
      import { registerOwnedProcessGroup } from ${JSON.stringify(new URL("../../packages/shared/src/ownedProcessRegistration.mjs", import.meta.url).href)};
      await registerOwnedProcessGroup(${JSON.stringify(receipt)}).then(() => process.exit(3), () => process.exit(0));
    `
      );
      const supervisor = new DevInstanceSupervisor({
        sourceRoot: root,
        command: process.execPath,
        args: [entry],
        env: process.env,
        stdio: "ignore",
      });
      try {
        await supervisor.start();
        await expect(supervisor.wait()).resolves.toBe(0);
        expect(observeOwnedProcessGroup(receipt)).toBe("owned");
      } finally {
        await supervisor.stop("SIGKILL");
        await foreignOwner.retire("SIGKILL");
      }
    }
  );

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

  it("preserves the original failed-spawn error without manufacturing a cleanup refusal", async () => {
    const supervisor = new DevInstanceSupervisor({
      sourceRoot: temporaryRoot(),
      command: path.join(temporaryRoot(), "missing-owned-executable"),
      args: [],
      env: process.env,
      stdio: "ignore",
    });
    const original = await supervisor.start().catch((error: unknown) => error);
    expect(original).toMatchObject({ code: "ENOENT" });
    expect(original).not.toBeInstanceOf(AggregateError);
    await expect(supervisor.wait()).rejects.toBe(original);
    await expect(supervisor.close()).rejects.toBe(original);
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
    "keeps repeated graceful stops owned until an explicit force retires the exact process group",
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
            "process.on('SIGTERM',()=>fs.writeFileSync(process.argv[1]+'.stopping','owned'));",
            "fs.writeFileSync(process.argv[1],JSON.stringify({pid:child.pid}));",
            "setInterval(()=>{},1000);",
          ].join(""),
          readyFile,
        ],
        env: process.env,
        stdio: "ignore",
        readiness: {
          file: readyFile,
          async onReady(value) {
            grandchildPid = (value as { pid: number }).pid;
          },
        },
      });

      let graceful: Promise<number> | undefined;
      let repeated: Promise<number> | undefined;
      try {
        await supervisor.start();
        expect(grandchildPid).toBeGreaterThan(0);
        let settled = false;
        graceful = supervisor.stop().then((code) => {
          settled = true;
          return code;
        });
        await expect.poll(() => fs.existsSync(readyFile + ".stopping")).toBe(true);
        repeated = supervisor.stop("SIGTERM");
        vi.useFakeTimers();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        expect(supervisor.process!.exitCode).toBeNull();
        expect(supervisor.process!.signalCode).toBeNull();
        vi.useRealTimers();
        await expect(supervisor.stop("SIGKILL")).resolves.toBe(137);
        await expect(graceful).resolves.toBe(137);
        await expect(repeated).resolves.toBe(137);
        await expectProcessToDisappear(grandchildPid);
      } finally {
        vi.useRealTimers();
        await supervisor.stop("SIGKILL");
        await Promise.allSettled([graceful, repeated]);
      }
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
