import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { completeAfterPack, reportAfterPackFailure } from "./electron-after-pack.mjs";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach } from "node:test";
import { afterPackCompletionPath } from "./lib/after-pack-completion.mjs";
import { fileURLToPath } from "node:url";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

test("after-pack diagnostics render nested operation and cleanup failures", async () => {
  const operationFailure = new Error("native dependency verification failed", {
    cause: new Error("SQLite errcode=5, errstr=database is locked"),
  });
  const cleanupFailure = new Error("owned package process exited with status 7");
  const failure = new AggregateError(
    [new AggregateError([operationFailure], "Installed release operation failed"), cleanupFailure],
    "Installed release operation failed",
    { cause: operationFailure }
  );
  let diagnostic;

  await reportAfterPackFailure(failure, (message) => {
    diagnostic = message;
  });

  assert.match(diagnostic, /native dependency verification failed/);
  assert.match(diagnostic, /SQLite errcode=5, errstr=database is locked/);
  assert.match(diagnostic, /owned package process exited with status 7/);
});

test("prepackaged Electron hooks import without loading the RPC build output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "after-pack-import-test-"));
  roots.push(root);
  const loader = path.join(root, "block-rpc-loader.mjs");
  fs.writeFileSync(
    loader,
    `export async function resolve(specifier, context, nextResolve) {
      if (specifier === "@vibestudio/rpc") throw new Error("unexpected RPC import");
      return nextResolve(specifier, context);
    }\n`
  );
  const result = spawnSync(
    process.execPath,
    [
      "--no-warnings",
      "--experimental-loader",
      loader,
      "--input-type=module",
      "-e",
      'await Promise.all([import("./scripts/stage-electron-native-isolation.mjs"), import("./scripts/electron-runtime-module-files.mjs"), import("./scripts/electron-after-pack.mjs")])',
    ],
    { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("publishes the afterPack receipt only after every boundary, preparation, and signing stage", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "after-pack-test-"));
  roots.push(outDir);
  const context = {
    outDir,
    appOutDir: path.join(outDir, "linux-unpacked"),
    electronPlatformName: "linux",
    arch: 1,
  };
  const stages = [];
  const receiptPath = afterPackCompletionPath(outDir, "linux", 1);

  assert.equal(fs.existsSync(receiptPath), false);
  await completeAfterPack(context, {
    checkBoundary: async () => stages.push("boundary"),
    prepareUserland: async () => stages.push("prepare"),
    sign: async () => stages.push("sign"),
  });

  assert.deepEqual(stages, ["boundary", "prepare", "boundary", "sign"]);
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  assert.deepEqual(receipt, {
    format: "vibestudio-electron-after-pack/1",
    platform: "linux",
    arch: 1,
    appOutDir: "linux-unpacked",
  });
});

test("does not publish an afterPack receipt when any required stage fails", async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "after-pack-test-"));
  roots.push(outDir);
  const context = {
    outDir,
    appOutDir: path.join(outDir, "linux-unpacked"),
    electronPlatformName: "linux",
    arch: 1,
  };
  const failure = new Error("prepared userland verification failed");
  const receiptPath = afterPackCompletionPath(outDir, "linux", 1);

  await assert.rejects(
    completeAfterPack(context, {
      checkBoundary: async () => {},
      prepareUserland: async () => {
        throw failure;
      },
      sign: async () => assert.fail("signing must not run after preparation fails"),
    }),
    (error) => error === failure
  );
  assert.equal(fs.existsSync(receiptPath), false);
});
