import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import {
  awaitHubReady,
  exportReleaseBuild,
  joinChildProcess,
} from "./prebuild-release-userland.mjs";
const roots = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "release-userland-test-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

test("ready admission propagates the original process failure without a deadline", async () => {
  const root = await fixture();
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const error = new Error("native runtime failed to spawn");
  const ready = awaitHubReady(child, path.join(root, "ready.json"));
  const assertion = assert.rejects(ready, (failure) => failure === error);
  child.emit("error", error);
  await assertion;
  assert.equal(child.listenerCount("exit"), 0);
});

test("a terminal server exit settles readiness even when no ready file was published", async () => {
  const root = await fixture();
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const ready = awaitHubReady(child, path.join(root, "ready.json"));
  const assertion = assert.rejects(ready, /exited \(1\)/);
  child.emit("exit", 1, null);
  await assertion;
});

test("joins an IPC-owned process and its streams after explicit owner revocation", async () => {
  const child = spawn(
    process.execPath,
    ["-e", 'process.on("disconnect", () => process.exit(0)); process.send("ready");'],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    }
  );
  const joined = joinChildProcess(child);
  child.stdout.resume();
  child.stderr.resume();
  await new Promise((resolve) => child.once("message", resolve));
  child.disconnect();
  assert.deepEqual(await joined, { code: 0, signal: null, error: undefined });
  assert.equal(child.stdout.closed, true);
  assert.equal(child.stderr.closed, true);
  assert.equal(child.connected, false);
});

test("joins a failed spawn without requiring an exit event for a nonexistent process", async () => {
  const root = await fixture();
  const child = spawn(path.join(root, "missing-executable"), [], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const joined = joinChildProcess(child);
  child.stdout.resume();
  child.stderr.resume();
  const result = await joined;
  assert.equal(result.error.code, "ENOENT");
});

test("exports only immutable records and verifies every payload before publication", async () => {
  const root = await fixture();
  const source = path.join(root, "source"),
    destination = path.join(root, "release");
  await fs.mkdir(source);
  const key = "a".repeat(64),
    bytes = Buffer.from("export default {};");
  await fs.writeFile(path.join(source, "bundle.js"), bytes);
  await fs.writeFile(path.join(source, "metadata.json"), JSON.stringify({ buildKey: key }));
  await fs.writeFile(
    path.join(source, "artifacts.json"),
    JSON.stringify([
      {
        path: "bundle.js",
        byteLength: bytes.length,
        integrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
      },
    ])
  );
  await fs.writeFile(path.join(source, "grants.db"), "private mutable authority");
  await fs.writeFile(path.join(source, "metadata.json.tmp.writer"), "incomplete");
  await exportReleaseBuild(source, destination, key);
  assert.deepEqual((await fs.readdir(destination)).sort(), [
    "artifacts.json",
    "bundle.js",
    "metadata.json",
  ]);
  await fs.writeFile(path.join(source, "bundle.js"), "corrupt");
  await assert.rejects(
    exportReleaseBuild(source, path.join(root, "corrupt"), key),
    /integrity mismatch/
  );
  await assert.rejects(
    exportReleaseBuild(source, path.join(root, "other"), "b".repeat(64)),
    /key mismatch/
  );
});

test("rejects artifact paths that would escape the release record", async () => {
  const root = await fixture(),
    key = "c".repeat(64);
  await fs.writeFile(path.join(root, "metadata.json"), JSON.stringify({ buildKey: key }));
  await fs.writeFile(path.join(root, "artifacts.json"), JSON.stringify([{ path: "../outside" }]));
  await assert.rejects(
    exportReleaseBuild(root, path.join(root, "release"), key),
    /Invalid release artifact path/
  );
});
