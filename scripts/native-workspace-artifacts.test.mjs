import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinModules } from "node:module";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { pathToFileURL } from "node:url";
import * as esbuild from "esbuild";
import { assertSingleInfrastructureModuleTree } from "./lib/bundle-module-identity.mjs";
import { nativeWorkspaceArtifactConfigs } from "./native-workspace-artifacts.mjs";
import { NATIVE_WORKSPACE_ENTRIES } from "./server-runtime-artifacts.mjs";

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

test("native children are self-contained generation artifacts and the supervisor needs no adjacent package output", async () => {
  const cache = path.join(os.homedir(), ".cache");
  fs.mkdirSync(cache, { recursive: true });
  const root = fs.mkdtempSync(path.join(cache, "vibestudio-native-artifact-test-"));
  let child;
  try {
    for (const config of nativeWorkspaceArtifactConfigs()) {
      const output = path.join(root, path.basename(config.outfile));
      const result = await esbuild.build({ ...config, outfile: output, metafile: true });
      assertSingleInfrastructureModuleTree(result.metafile, process.cwd());
      for (const artifact of Object.values(result.metafile.outputs)) {
        for (const imported of artifact.imports) {
          assert.ok(
            !imported.external || builtins.has(imported.path) || imported.path === "electron",
            `Ambient package dependency: ${imported.path}`
          );
        }
      }
    }
    assert.deepEqual(fs.readdirSync(root).sort(), Object.values(NATIVE_WORKSPACE_ENTRIES).sort());
    child = spawn(
      process.execPath,
      [path.join(root, NATIVE_WORKSPACE_ENTRIES.workspaceSupervisor)],
      { cwd: root, env: {}, stdio: ["pipe", "pipe", "pipe"] }
    );
    let output = "";
    let errors = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      errors += data;
    });
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code));
    });
    child.stdin.end('{"type":"shutdown"}\n');
    assert.equal(await completed, 0, errors);
    assert.deepEqual(output.trim().split("\n").map(JSON.parse), [{ type: "ready" }]);
  } finally {
    if (child && child.exitCode === null) {
      const joined = new Promise((resolve) => child.once("close", resolve));
      child.kill("SIGTERM");
      await joined;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("native disk preserves binary views across the installed supervisor and command IPC", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-native-disk-bytes-")));
  const supervisor = path.join(root, NATIVE_WORKSPACE_ENTRIES.workspaceSupervisor);
  const worker = path.join(root, "fs-disk-worker.cjs");
  const owner = path.join(root, "test-owner.mjs");
  let child;
  let closed;
  let disk;
  try {
    await Promise.all([
      esbuild.build({ ...nativeWorkspaceArtifactConfigs()[0], outfile: supervisor }),
      esbuild.build({
        entryPoints: ["src/server/services/fsDiskWorker.ts"], bundle: true, platform: "node",
        target: "node20", format: "cjs", tsconfig: "tsconfig.json", external: ["electron"], outfile: worker,
      }),
      esbuild.build({
        stdin: {
          contents: `
            export { createFsDiskPort } from "./src/server/services/fsDiskPort.ts";
            export { readControl, writeControl } from "./packages/process-adapter/src/isolation/control.ts";
          `,
          resolveDir: process.cwd(),
        },
        bundle: true, platform: "node", format: "esm", tsconfig: "tsconfig.json", external: ["electron"], outfile: owner,
      }),
    ]);
    const { createFsDiskPort, readControl, writeControl } = await import(pathToFileURL(owner).href);
    child = spawn(process.execPath, [supervisor], { cwd: root, env: {}, stdio: ["pipe", "pipe", "pipe"] });
    closed = once(child, "close");
    let stderr = "";
    child.stderr.on("data", data => { stderr = (stderr + data).slice(-4096); });
    const adapter = Object.assign(new EventEmitter(), {
      postMessage: value => writeControl(child.stdin, { type: "message", id: "disk", value }),
    });
    const ready = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`Native disk supervisor exited ${code}: ${stderr}`)));
      readControl(child.stdout, frame => {
        switch (frame.type) {
          case "ready":
            writeControl(child.stdin, {
              type: "fork", id: "disk", entry: worker, cwd: root, execArgv: [],
              env: { VIBESTUDIO_RIPGREP_PATH: process.execPath },
            });
            return;
          case "spawn":
            resolve();
            return;
          case "message":
            adapter.emit("message", frame.value);
            return;
          case "disconnect":
            adapter.emit("disconnect");
            return;
          case "exit":
            adapter.emit("exit", frame.code);
            return;
          case "failure":
            reject(new Error(String(frame.message)));
            adapter.emit("error", new Error(String(frame.message)));
        }
      }, error => {
        reject(error);
        if (adapter.listenerCount("error")) adapter.emit("error", error);
      });
    });
    disk = createFsDiskPort(adapter);
    await ready;
    const scope = { root, panelId: "test-panel", exposeHostPaths: false, ownerCallerIds: ["test-panel"] };
    const view = Uint8Array.of(99, 0, 255, 128, 98).subarray(1, 4);
    await disk.call(scope, "writeFile", ["binary.dat", view]);
    assert.deepEqual(fs.readFileSync(path.join(root, "binary.dat")), Buffer.from([0, 255, 128]));
    const bufferWindow = Buffer.from([9, 0, 129, 8]).subarray(1, 3);
    await disk.call(scope, "appendFile", ["binary.dat", bufferWindow]);
    const retained = await disk.call(scope, "readFile", ["binary.dat"]);
    assert.deepEqual(retained, Uint8Array.of(0, 255, 128, 0, 129));
    const snapshot = await disk.call(scope, "snapshot", ["binary.dat"]);
    assert.deepEqual(snapshot.buffer, retained);
    await disk.call(scope, "writeFile", ["binary.dat", new Uint8Array()]);
    assert.deepEqual(await disk.call(scope, "readFile", ["binary.dat"]), new Uint8Array());
    await disk.closeCaller("test-panel");
    writeControl(child.stdin, { type: "shutdown" });
    assert.equal((await closed)[0], 0, stderr);
  } finally {
    disk?.retire();
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      await closed;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
