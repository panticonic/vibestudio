import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanHostBuildOutput } from "./clean-host-build-output.mjs";
import {
  NODE_RUNTIME_VERSION,
  NODE_RUNTIME_TARGETS,
  nodeRuntimeTarget,
  nodeRuntimeExecutable,
  nodeRuntimeDirectory,
  verifyNodeRuntimeArchive,
  assertNodeRuntimeArtifacts,
  stageNodeRuntime,
} from "./node-runtime-artifacts.mjs";

test("pins CI and all supported installed runtime targets to the same official release", async () => {
  assert.equal(
    (await readFile(new URL("../.nvmrc", import.meta.url), "utf8")).trim(),
    NODE_RUNTIME_VERSION
  );
  assert.match(NODE_RUNTIME_VERSION, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(NODE_RUNTIME_TARGETS.map((x) => `${x.platform}-${x.arch}`).sort(), [
    "darwin-arm64",
    "linux-arm64",
    "linux-x64",
    "win32-x64",
  ]);
  for (const target of NODE_RUNTIME_TARGETS) {
    assert.match(target.sha256, /^[a-f0-9]{64}$/);
    assert.ok(target.archive.includes(`v${NODE_RUNTIME_VERSION}-`));
    assert.equal(
      nodeRuntimeExecutable(target),
      target.platform === "win32" ? "node.exe" : "bin/node"
    );
  }
  assert.throws(() => nodeRuntimeTarget("win32", "arm64"), /Unsupported/);
});
test(
  "concurrent publishers reuse the verified winning distribution",
  { skip: process.platform === "win32" },
  async () => {
    const appRoot = await mkdtemp(path.join(os.tmpdir(), "node-artifact-publish-"));
    try {
      const archiveName = "fixture-node.tar.gz";
      const source = path.join(appRoot, "fixture-node");
      const cache = path.join(appRoot, ".cache", "node-distributions");
      await mkdir(path.join(source, "bin"), { recursive: true });
      await mkdir(cache, { recursive: true });
      await writeFile(path.join(source, "bin", "node"), "#!/bin/sh\nprintf 'runtime-alive'\n");
      const archive = path.join(cache, archiveName);
      await promisify(execFile)("tar", ["-czf", archive, "-C", appRoot, "fixture-node"]);
      const target = {
        ...nodeRuntimeTarget("linux", "x64"),
        archive: archiveName,
        sha256: createHash("sha256")
          .update(await readFile(archive))
          .digest("hex"),
      };
      const results = await Promise.all([
        stageNodeRuntime(appRoot, target),
        stageNodeRuntime(appRoot, target),
      ]);
      assert.deepEqual(results[0], results[1]);
      assert.deepEqual(await assertNodeRuntimeArtifacts(appRoot, target), results[0]);
      // A live instance retains this executable path while another instance
      // rebuilds the host. Cleaning compiler output must not retire a runtime.
      await writeFile(path.join(appRoot, "dist", "old-host-entry.js"), "obsolete");
      cleanHostBuildOutput(appRoot);
      await assert.rejects(readFile(path.join(appRoot, "dist", "old-host-entry.js")), {
        code: "ENOENT",
      });
      const launch = await promisify(execFile)(results[0].executable, []);
      assert.equal(launch.stdout, "runtime-alive");
      assert.deepEqual(await stageNodeRuntime(appRoot, target), results[0]);
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  }
);
test("rejects substituted downloads before extraction", () => {
  const content = Buffer.from("verified fixture archive");
  const target = { archive: "fixture", sha256: createHash("sha256").update(content).digest("hex") };
  verifyNodeRuntimeArchive(content, target);
  assert.throws(
    () => verifyNodeRuntimeArchive(Buffer.from("substitute"), target),
    /checksum mismatch/
  );
});
test("rejects changed or additional distribution files before packaging", async () => {
  const appRoot = await mkdtemp(path.join(os.tmpdir(), "node-artifact-contract-"));
  const target = nodeRuntimeTarget("linux", "x64");
  const root = nodeRuntimeDirectory(appRoot, target);
  const executable = path.join(root, "bin", "node");
  const bytes = Buffer.from("synthetic installed binary");
  try {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, bytes);
    await writeFile(
      path.join(root, "vibestudio-runtime.json"),
      JSON.stringify({
        version: 1,
        nodeVersion: NODE_RUNTIME_VERSION,
        archive: target.archive,
        archiveSha256: target.sha256,
        files: { "bin/node": { sha256: createHash("sha256").update(bytes).digest("hex") } },
      })
    );
    assert.equal((await assertNodeRuntimeArtifacts(appRoot, target)).executable, executable);
    await writeFile(executable, "changed");
    await assert.rejects(assertNodeRuntimeArtifacts(appRoot, target), /changed: bin\/node/);
    await writeFile(executable, bytes);
    await writeFile(path.join(root, "extra.js"), "extra");
    await assert.rejects(assertNodeRuntimeArtifacts(appRoot, target), /unexpected: extra\.js/);
    await rm(executable);
    await assert.rejects(assertNodeRuntimeArtifacts(appRoot, target), /missing: bin\/node/);
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
});
