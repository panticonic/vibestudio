import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
