import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { currentGeneration } from "./ci-host-build-inputs.mjs";
import { computeHostBuildFingerprint } from "./host-build-fingerprint.mjs";

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
      fs.mkdirSync(root, { recursive: true });
      fs.symlinkSync("../../../node_modules", path.join(root, "node_modules"), "dir");
      const receiptPath = path.join(root, "host-build-fingerprint.json");
      const pointerPath = path.join(cwd, "dist/host-generations", `current-${kind}.json`);
      fs.writeFileSync(receiptPath, JSON.stringify(build));
      fs.writeFileSync(pointerPath, JSON.stringify(pointer));
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
