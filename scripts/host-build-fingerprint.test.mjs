import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  computeHostBuildFingerprint,
  DESKTOP_HOST_BUILD_FINGERPRINT_PATH,
  HOST_BUILD_FINGERPRINT_PATH,
  invalidateHostBuildFingerprints,
  readHostBuildFingerprint,
  sameHostBuildFingerprint,
  writeHostBuildFingerprint,
} from "./host-build-fingerprint.mjs";

test("host artifact and release resolver changes invalidate the host build fingerprint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-build-fingerprint-input-"));
  try {
    const assetProducer = path.join(root, "scripts/lib/sql-js-runtime-asset.mjs");
    const executableResolver = path.join(root, "scripts/lib/mac-app-executable.mjs");
    for (const helper of [assetProducer, executableResolver])
      fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.writeFileSync(assetProducer, "export const revision = 1;\n");
    fs.writeFileSync(executableResolver, "export const revision = 1;\n");
    const first = computeHostBuildFingerprint({ cwd: root, mode: "development" });

    fs.writeFileSync(executableResolver, "export const revision = 2;\n");
    const second = computeHostBuildFingerprint({ cwd: root, mode: "development" });

    assert.equal(first.inputCount, 2);
    assert.equal(second.inputCount, 2);
    assert.notEqual(first.fingerprint, second.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("partial replacement invalidates both build modes without retiring immutable generations", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-build-fingerprint-"));
  try {
    const production = {
      version: 1,
      mode: "production",
      fingerprint: "a".repeat(64),
      inputCount: 1,
    };
    writeHostBuildFingerprint(production, root);
    writeHostBuildFingerprint(production, root, DESKTOP_HOST_BUILD_FINGERPRINT_PATH);
    const retained = path.join(root, "dist", "host-generations", "retained", "server.mjs");
    fs.mkdirSync(path.dirname(retained), { recursive: true });
    fs.writeFileSync(retained, "immutable running host");

    invalidateHostBuildFingerprints(root);
    assert.equal(readHostBuildFingerprint(root), null);
    assert.equal(readHostBuildFingerprint(root, DESKTOP_HOST_BUILD_FINGERPRINT_PATH), null);
    assert.equal(fs.readFileSync(retained, "utf8"), "immutable running host");

    const development = { ...production, mode: "development" };
    writeHostBuildFingerprint(development, root, HOST_BUILD_FINGERPRINT_PATH);
    assert.equal(sameHostBuildFingerprint(readHostBuildFingerprint(root), development), true);
    assert.equal(
      sameHostBuildFingerprint(
        readHostBuildFingerprint(root, DESKTOP_HOST_BUILD_FINGERPRINT_PATH),
        production
      ),
      false
    );
    invalidateHostBuildFingerprints(root);
    invalidateHostBuildFingerprints(root);
    assert.equal(readHostBuildFingerprint(root), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
