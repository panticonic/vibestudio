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

function installedFixture(root, nestedVersion = "4.11.3") {
  const write = (relative, value) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(value));
  };
  write("package.json", { name: "host-fixture", dependencies: { consumer: "1.0.0", aws: "^4" } });
  fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "same lock\n");
  write("node_modules/consumer/package.json", {
    name: "consumer",
    version: "1.0.0",
    dependencies: { aws: "^4" },
  });
  write("node_modules/aws/package.json", { name: "aws", version: "4.11.3" });
  write("node_modules/consumer/node_modules/aws/package.json", {
    name: "aws",
    version: nestedVersion,
  });
}

test("same source and lock with different nested installed dependency invalidates source generation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-installed-input-"));
  try {
    installedFixture(root);
    const before = computeHostBuildFingerprint({ cwd: root });
    const manifest = path.join(root, "node_modules/consumer/node_modules/aws/package.json");
    fs.writeFileSync(manifest, JSON.stringify({ name: "aws", version: "4.12.1" }));
    assert.notEqual(computeHostBuildFingerprint({ cwd: root }).fingerprint, before.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("equivalent relocated installed graph reuses source identity, including owner-resolved links", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "host-relocated-input-"));
  try {
    const left = path.join(parent, "left"),
      right = path.join(parent, "right");
    installedFixture(left);
    installedFixture(right);
    // Use absolute links with different physical addresses but equal package/alias topology.
    for (const root of [left, right]) {
      fs.renameSync(path.join(root, "node_modules/consumer"), path.join(root, "consumer-store"));
      fs.symlinkSync(path.join(root, "consumer-store"), path.join(root, "node_modules/consumer"));
    }
    assert.equal(
      computeHostBuildFingerprint({ cwd: left }).fingerprint,
      computeHostBuildFingerprint({ cwd: right }).fingerprint
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("generated local package output does not invalidate before/after build input identity", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-local-generated-"));
  try {
    installedFixture(root);
    const local = path.join(root, "packages/local");
    fs.mkdirSync(path.join(local, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(local, "package.json"),
      JSON.stringify({ name: "local", version: "1", private: true })
    );
    fs.writeFileSync(path.join(local, "source.ts"), "export const answer = 1;\n");
    fs.symlinkSync(local, path.join(root, "node_modules/local"));
    const before = computeHostBuildFingerprint({ cwd: root });
    fs.writeFileSync(path.join(local, "dist/index.js"), "new generated output\n");
    assert.equal(computeHostBuildFingerprint({ cwd: root }).fingerprint, before.fingerprint);
    fs.writeFileSync(path.join(local, "source.ts"), "export const answer = 2;\n");
    assert.notEqual(computeHostBuildFingerprint({ cwd: root }).fingerprint, before.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("same-version dependency rebinding changes actual singleton topology", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-installed-topology-"));
  try {
    installedFixture(root);
    const before = computeHostBuildFingerprint({ cwd: root });
    fs.rmSync(path.join(root, "node_modules/consumer/node_modules/aws"), { recursive: true });
    assert.notEqual(computeHostBuildFingerprint({ cwd: root }).fingerprint, before.fingerprint);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
