import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseOptions, resolvePackagedExecutable } from "./packaged-isolation-smoke.mjs";
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
