import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import { Ownership } from "@vibestudio/shared/ownership";
import { processIsRunning } from "../../tests/fixtures/processLiveness.js";

const roots: string[] = [];
const ownerships: Ownership[] = [];
const CHILD_FIXTURE_STARTUP_POLL_MS = 5_000;
const OWNERSHIP_URL = new URL("../../packages/shared/src/ownership.mjs", import.meta.url).href;
const SUPERVISOR_URL = new URL("./devInstanceSupervisor.ts", import.meta.url).href;

/** Full-suite load delayed fixture readiness beyond Vitest's default 1s poll (up to 1.4s); this
 * bounded test-only budget covers tsx/node scheduling without changing production readiness. */
async function expectChildFixtureReady(file: string): Promise<void> {
  await expect
    .poll(() => fs.existsSync(file), { timeout: CHILD_FIXTURE_STARTUP_POLL_MS })
    .toBe(true);
}

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dev-supervisor-"));
  roots.push(root);
  return root;
}

/** The ownership every supervisor under test registers its child with. */
async function openOwnership(): Promise<Ownership> {
  const ownership = await Ownership.open({
    profileDir: temporaryRoot(),
    lifetime: "leased",
  });
  ownerships.push(ownership);
  return ownership;
}

afterEach(async () => {
  await Promise.allSettled(ownerships.splice(0).map((ownership) => ownership.release()));
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("DevInstanceSupervisor", () => {
  it.skipIf(process.platform === "win32")(
    "coalesces repeated stop requests into one ordered child retirement",
    async () => {
      const root = temporaryRoot();
      const ready = path.join(root, "ready");
      const countFile = path.join(root, "signal-count");
      const service = path.join(root, "service.mjs");
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
      const supervisor = new DevInstanceSupervisor({
        ownership: await openOwnership(),
        sourceRoot: root,
        command: process.execPath,
        args: [service, ready, countFile],
        env: process.env,
        stdio: "ignore",
      });
      await supervisor.start();
      await expectChildFixtureReady(ready);
      const first = supervisor.stop();
      await expect.poll(() => fs.existsSync(countFile)).toBe(true);
      const repeated = [supervisor.stop("SIGINT"), supervisor.stop("SIGTERM"), supervisor.stop()];
      await expect(first).resolves.toBe(0);
      await expect(Promise.all(repeated)).resolves.toEqual([0, 0, 0]);
      expect(fs.readFileSync(countFile, "utf8")).toBe("1");
    }
  );

  it.skipIf(process.platform === "win32")(
    "retires a leader killed abruptly together with what it left in its group",
    async () => {
      const root = temporaryRoot();
      const readyFile = path.join(root, "ready.json");
      let grandchildPid = 0;
      const supervisor = new DevInstanceSupervisor({
        ownership: await openOwnership(),
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
            "fs.writeFileSync(process.argv[1]+'.tmp',JSON.stringify({pid:child.pid}));fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);",
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
      await supervisor.start();
      expect(grandchildPid).toBeGreaterThan(0);
      supervisor.process!.kill("SIGKILL");
      await expect(supervisor.wait()).resolves.toBe(137);
      await expectProcessToDisappear(grandchildPid);
    }
  );

  it.skipIf(process.platform !== "linux")(
    "retires a service and its worker when the owning process is killed",
    async () => {
      const root = temporaryRoot();
      const ready = path.join(root, "parent-loss.json");
      const service = path.join(root, "service.mjs");
      const ownerEntry = path.join(root, "owner.mjs");
      fs.writeFileSync(
        service,
        `
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      const worker = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {stdio:'ignore'});
      fs.writeFileSync(process.argv[2] + '.tmp', JSON.stringify({service:process.pid, worker:worker.pid})); fs.renameSync(process.argv[2] + '.tmp', process.argv[2]);
      setInterval(() => {}, 1000);
    `
      );
      fs.writeFileSync(
        ownerEntry,
        `
      import { Ownership } from ${JSON.stringify(OWNERSHIP_URL)};
      import { DevInstanceSupervisor } from ${JSON.stringify(SUPERVISOR_URL)};
      const ownership = await Ownership.open({ profileDir: process.argv[2], lifetime: 'leased' });
      const supervisor = new DevInstanceSupervisor({ownership, sourceRoot:process.argv[2], command:process.execPath,
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
        await expectChildFixtureReady(ready);
        identity = JSON.parse(fs.readFileSync(ready, "utf8"));
        expect(alive(identity!.service)).toBe(true);
        expect(alive(identity!.worker)).toBe(true);
        owner.kill("SIGKILL");
        await ownerExit;
        // The owner's reaper, not the dead owner, retires the service group.
        await expect.poll(() => [identity!.service, identity!.worker].filter(alive)).toEqual([]);
      } finally {
        owner.kill("SIGKILL");
        await ownerExit;
        for (const pid of identity ? [identity.service, identity.worker] : []) {
          if (alive(pid)) process.kill(pid, "SIGKILL");
        }
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
      fs.writeFileSync(process.argv[2]! + '.tmp', JSON.stringify({pid:process.pid}));
      fs.renameSync(process.argv[2]! + '.tmp', process.argv[2]!);
      process.on('SIGTERM', () => setTimeout(() => {
        fs.writeFileSync(stopped, 'drained');
        process.exit(0);
      }, 150));
      setInterval(() => {}, 1000);
    `
    );
    const loader = createRequire(import.meta.url).resolve("tsx");
    const supervisor = new DevInstanceSupervisor({
      ownership: await openOwnership(),
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

  it("requires exact absolute execution coordinates", async () => {
    const ownership = await openOwnership();
    expect(
      () =>
        new DevInstanceSupervisor({
          ownership,
          sourceRoot: ".",
          command: process.execPath,
          args: [],
          env: process.env,
        })
    ).toThrow("sourceRoot must be absolute");
    expect(
      () =>
        new DevInstanceSupervisor({
          ownership,
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
      ownership: await openOwnership(),
      sourceRoot: root,
      command: process.execPath,
      args: [
        "-e",
        "const fs=require('node:fs');fs.writeFileSync(process.argv[1]+'.tmp', JSON.stringify({generation:'g1'}));fs.renameSync(process.argv[1]+'.tmp', process.argv[1])",
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
      ownership: await openOwnership(),
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
      ownership: await openOwnership(),
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
        ownership: await openOwnership(),
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
            "fs.writeFileSync(process.argv[1]+'.tmp',JSON.stringify({pid:child.pid}));fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);",
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
        ownership: await openOwnership(),
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
            "fs.writeFileSync(process.argv[1]+'.tmp',JSON.stringify({pid:child.pid}));fs.renameSync(process.argv[1]+'.tmp',process.argv[1]);",
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (!processIsRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Process ${pid} remained alive after its owned group was stopped`);
}
