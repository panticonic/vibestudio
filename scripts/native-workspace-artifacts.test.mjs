import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { builtinModules } from "node:module";
import { spawn } from "node:child_process";
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
