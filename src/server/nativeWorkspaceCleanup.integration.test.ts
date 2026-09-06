import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeWorkspaceCleanup } from "@vibestudio/shared/nativeWorkspaceCleanup";

const appRoot = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const directories: string[] = [];
const attackers: ChildProcess[] = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const attacker of attackers.splice(0)) {
    if (attacker.exitCode !== null || attacker.signalCode !== null) continue;
    const closed = once(attacker, "close");
    attacker.kill("SIGKILL");
    try {
      await closed;
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length) {
    directories.length = 0;
    throw new AggregateError(failures, "Cleanup adversary did not stop; fixture paths retained");
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(workspace = true) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "vibestudio-cleanup-")));
  directories.push(root);
  const trash = path.join(root, ".delete-fixture");
  mkdirSync(trash);
  const receipt = path.join(trash, "deletion.json");
  const marker = JSON.stringify({ version: 1, name: "fixture", workspaceId: "cleanup-test" });
  writeFileSync(receipt, marker, { mode: 0o600 });
  const tree = path.join(trash, "workspace");
  if (workspace) mkdirSync(tree);
  const outside = path.join(root, "outside");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "canary"), "host-owned contents");
  return { root, trash, receipt, marker, tree, outside };
}

function link(target: string, alias: string) {
  symlinkSync(target, alias, process.platform === "win32" ? "junction" : "dir");
}

async function stopAttacker(attacker: ChildProcess): Promise<void> {
  if (attacker.exitCode !== null || attacker.signalCode !== null) return;
  const closed = once(attacker, "close");
  attacker.kill("SIGKILL");
  await closed;
}

describe("MXC workspace trash cleanup", () => {
  it("removes the staged tree and links without modifying outside targets", () => {
    const f = fixture();
    mkdirSync(path.join(f.tree, "nested"));
    writeFileSync(path.join(f.tree, "nested/data"), "workspace contents");
    link(f.outside, path.join(f.tree, "outside-link"));
    nativeWorkspaceCleanup(appRoot)(f.trash);
    expect(existsSync(f.trash)).toBe(false);
    expect(readFileSync(path.join(f.outside, "canary"), "utf8")).toBe("host-owned contents");
  });

  it("finishes a receipt whose workspace subtree was already removed", () => {
    const f = fixture(false);
    nativeWorkspaceCleanup(appRoot)(f.trash);
    expect(existsSync(f.trash)).toBe(false);
    expect(readFileSync(path.join(f.outside, "canary"), "utf8")).toBe("host-owned contents");
  });

  it("preserves the receipt after rejected cleanup and supports a repaired retry", () => {
    const f = fixture(false);
    link(f.outside, f.tree);
    expect(() => nativeWorkspaceCleanup(appRoot)(f.trash)).toThrow();
    expect(readFileSync(f.receipt, "utf8")).toBe(f.marker);
    expect(readFileSync(path.join(f.outside, "canary"), "utf8")).toBe("host-owned contents");
    unlinkSync(f.tree);
    mkdirSync(f.tree);
    writeFileSync(path.join(f.tree, "retry-data"), "remaining workspace data");
    nativeWorkspaceCleanup(appRoot)(f.trash);
    expect(existsSync(f.trash)).toBe(false);
  });

  it("contains recursive deletion while a separate process replaces directories with outside links", async () => {
    const f = fixture();
    const node = path.join(f.tree, "node");
    const parked = path.join(f.tree, "parked");
    mkdirSync(node);
    for (let index = 0; index < 500; index++)
      writeFileSync(path.join(node, String(index)), "workspace");
    const attacker = spawn(
      process.execPath,
      [
        "-e",
        `
      const fs = require('node:fs');
      const [node, parked, outside] = process.argv.slice(1);
      let swaps = 0;
      const swap = () => {
        try {
          fs.renameSync(node, parked);
          try {
            fs.symlinkSync(outside, node, process.platform === 'win32' ? 'junction' : 'dir');
            swaps++;
          } finally {
            try { fs.unlinkSync(node); } catch {}
            try { fs.renameSync(parked, node); } catch {}
          }
        } catch {}
      };
      while (swaps < 10) swap();
      process.stdout.write('ready\\n');
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && fs.existsSync(require('node:path').dirname(node))) swap();
    `,
        node,
        parked,
        f.outside,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    attackers.push(attacker);
    await new Promise<void>((resolve, reject) => {
      let output = "";
      let stderr = "";
      const deadline = setTimeout(
        () => reject(new Error(`Cleanup adversary did not start: ${stderr}`)),
        5000
      );
      attacker.stderr?.on("data", (chunk) => {
        stderr = (stderr + String(chunk)).slice(-4096);
      });
      attacker.stdout?.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("ready\n")) {
          clearTimeout(deadline);
          resolve();
        }
      });
      attacker.once("error", (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      attacker.once("exit", () => {
        clearTimeout(deadline);
        reject(new Error(`Cleanup adversary exited: ${stderr}`));
      });
    });
    try {
      try {
        nativeWorkspaceCleanup(appRoot)(f.trash);
      } catch {
        // Concurrent mutation may prevent completion. It must retain catalog
        // authority for retry whenever the guest subtree still exists.
        if (existsSync(f.tree)) expect(readFileSync(f.receipt, "utf8")).toBe(f.marker);
      }
      expect(readFileSync(path.join(f.outside, "canary"), "utf8")).toBe("host-owned contents");
    } finally {
      await stopAttacker(attacker);
    }
    if (existsSync(f.trash)) nativeWorkspaceCleanup(appRoot)(f.trash);
    expect(existsSync(f.trash)).toBe(false);
    expect(readFileSync(path.join(f.outside, "canary"), "utf8")).toBe("host-owned contents");
  }, 30000);
});
