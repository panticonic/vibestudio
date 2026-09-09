import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseOptions,
  readableTail,
  resolvePackagedExecutable,
} from "./packaged-isolation-smoke.mjs";
import includeRuntimeModuleFile from "./electron-runtime-module-files.mjs";

test("preserves installed compiler declaration inputs without force-including package sources", () => {
  assert.equal(
    includeRuntimeModuleFile("node_modules/@typescript/typescript-linux-x64/lib/lib.d.ts"),
    true
  );
  assert.equal(includeRuntimeModuleFile("node_modules/example/src/compiler.cc"), undefined);
});
const roots = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
test("requires explicit installed package and rejects malformed options", () => {
  assert.throws(() => parseOptions([]), /Usage/);
  assert.throws(() => parseOptions(["--app", "app", "--timeout-ms", "0"]), /Unknown/);
  assert.throws(() => parseOptions(["--app"]), /Missing/);
  assert.deepEqual(parseOptions(["--app", "app"]), { app: "app", timeoutMs: 600000 });
});
test("resolves actual macOS bundle executable without assuming product name", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "packaged-resolver-"));
  roots.push(root);
  const app = path.join(root, "Product.app");
  const bin = path.join(app, "Contents", "MacOS");
  await fs.mkdir(bin, { recursive: true });
  await fs.writeFile(path.join(bin, "Real Product"), "fixture");
  assert.equal(await resolvePackagedExecutable(app, "darwin"), path.join(bin, "Real Product"));
  await fs.writeFile(path.join(bin, "ambiguous"), "fixture");
  await assert.rejects(resolvePackagedExecutable(app, "darwin"), /one main/);
});
test("accepts explicit installed executable outside checkout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "packaged-exe-"));
  roots.push(root);
  const binary = path.join(root, "Product.exe");
  await fs.writeFile(binary, "fixture");
  assert.equal(await resolvePackagedExecutable(binary, "win32"), binary);
});
test("all packaged harness entry points parse with the host runtime", () => {
  for (const file of ["packaged-isolation-smoke.mjs", "lib/packaged-server-bootstrap.cjs"])
    execFileSync(process.execPath, ["--check", fileURLToPath(new URL(file, import.meta.url))]);
});

test("reports the thrown error rather than the minified source that precedes it", () => {
  // Node prints an uncaught error as its source line, a caret, then the message.
  // From a bundled dependency that source line is minified, and reporting it
  // verbatim buries the only part of the crash a reader can act on.
  const crash = [
    "/opt/app/dist/server.mjs:1",
    `?cDt.test(e.data)||(zt(i,{validation:"base64url"${"x".repeat(3000)}`,
    "           ^",
    "",
    "ZodError: Invalid base64url string at reach.endpointSecret",
    "    at parseReach (/opt/app/dist/server.mjs:1:2)",
  ].join("\n");

  const reported = readableTail(crash);
  assert.match(reported, /^ZodError: Invalid base64url string/u);
  assert.ok(!reported.includes("cDt.test"), "minified source must not lead the report");
  assert.ok(reported.length < 500, `expected a readable extract, got ${reported.length} chars`);
});

test("masks secret material without discarding the line that explains the failure", () => {
  // Dropping every line that mentions a secret also drops the diagnostic.
  const reported = readableTail("[pair] code AbCdEfGhIjKlMnOpQrStUv is the secret invite");
  assert.ok(!reported.includes("AbCdEfGhIjKlMnOpQrStUv"), "secret material must not survive");
  assert.match(reported, /is the secret invite/u);
});

test("truncates a minified line instead of dropping the surrounding context", () => {
  const reported = readableTail(`[server] starting\n${"y".repeat(2000)}\n[server] stopped`);
  assert.match(reported, /\[server\] starting/u);
  assert.match(reported, /\[server\] stopped/u);
  assert.match(reported, /… \[2000 chars\]/u);
});

test("keeps the error a minified line would otherwise evict", async () => {
  // Reproduces the packaged crash: Node prints a minified source line larger
  // than any sensible character window, then the message and stack. A rolling
  // character buffer keeps the wrong end of that.
  const { spawnCaptured } = await import("./packaged-isolation-smoke.mjs");
  const { EventEmitter } = await import("node:events");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();

  const captured = spawnCaptured(child);
  child.stdout.emit("data", `/opt/app/dist/server.mjs:1\n${"m".repeat(200_000)}\n`);
  child.stdout.emit("data", "           ^\n\nZodError: Invalid base64url string\n");
  child.stdout.emit("data", "    at parseReach (/opt/app/dist/server.mjs:1:2)\nNode.js v24.18.0\n");

  const reported = captured.tail();
  assert.match(reported, /^ZodError: Invalid base64url string/u, reported.slice(0, 200));
  assert.ok(!reported.includes("mmmm"), "the minified line must not dominate the report");
});
