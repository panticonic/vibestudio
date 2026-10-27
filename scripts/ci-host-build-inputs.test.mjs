import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { currentGeneration } from "./ci-host-build-inputs.mjs";
import { computeHostBuildFingerprint } from "./host-build-fingerprint.mjs";
import { publishHostBuildGeneration } from "./host-build-generations.mjs";
import {
  NATIVE_WORKSPACE_ENTRIES,
  SOURCE_SERVER_PREREQUISITE_ARTIFACTS,
} from "./server-runtime-artifacts.mjs";

test("generation transport validates build receipt identity independently of pointer format", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ci-host-inputs-"));
  try {
    fs.writeFileSync(path.join(cwd, "package.json"), '{"version":"1.0.0"}');
    fs.mkdirSync(path.join(cwd, "node_modules"));
    for (const [kind, mode] of [
      ["desktop", "production"],
      ["source", "development"],
    ]) {
      const build = computeHostBuildFingerprint({ cwd, mode });
      const pointer = { ...build, version: 2, kind, root: `${kind}-${build.fingerprint}` };
      const root = path.join(cwd, "dist/host-generations", pointer.root);
      const receiptPath = path.join(root, "host-build-fingerprint.json");
      const pointerPath = path.join(cwd, "dist/host-generations", `current-${kind}.json`);
      for (const artifact of new Set([
        ...SOURCE_SERVER_PREREQUISITE_ARTIFACTS,
        ...[
          "main.cjs",
          "connectionProcess.cjs",
          "adblock-engine-worker.cjs",
          "server-electron.cjs",
          "panelPreload.cjs",
          "browserDataPreload.cjs",
          "browserTransport.js",
          "fs-disk-worker.cjs",
          ...Object.values(NATIVE_WORKSPACE_ENTRIES),
        ].map((entry) => `dist/${entry}`),
      ])) {
        const file = path.join(cwd, artifact);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (["dist/headless-host", "dist/workerd-programs"].includes(artifact))
          fs.mkdirSync(file, { recursive: true });
        else fs.writeFileSync(file, "fixture payload");
      }
      fs.writeFileSync(path.join(cwd, "dist/host-build-fingerprint.json"), JSON.stringify(build));
      assert.equal(publishHostBuildGeneration(cwd, { ...build, kind }), root);
      assert.deepEqual(currentGeneration(kind, mode, cwd), {
        mode,
        fingerprint: build.fingerprint,
        inputCount: build.inputCount,
      });
      assert.throws(
        () => currentGeneration(kind, mode === "production" ? "development" : "production", cwd),
        /does not match/
      );
      for (const corrupted of [
        { ...build, version: 2 },
        { ...build, fingerprint: "f".repeat(64) },
        { ...build, inputCount: build.inputCount + 1 },
      ]) {
        fs.writeFileSync(receiptPath, JSON.stringify(corrupted));
        assert.throws(() => currentGeneration(kind, mode, cwd), /does not match/);
      }
      fs.writeFileSync(receiptPath, JSON.stringify(build));
      fs.writeFileSync(
        pointerPath,
        JSON.stringify({ ...pointer, inputCount: pointer.inputCount + 1 })
      );
      assert.throws(() => currentGeneration(kind, mode, cwd), /does not match/);
      fs.writeFileSync(pointerPath, JSON.stringify(pointer));
      fs.writeFileSync(path.join(cwd, "package.json"), '{"version":"1.0.1"}');
      assert.throws(() => currentGeneration(kind, mode, cwd), /does not match/);
      fs.writeFileSync(path.join(cwd, "package.json"), '{"version":"1.0.0"}');
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
