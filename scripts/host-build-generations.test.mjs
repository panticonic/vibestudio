import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  collectHostBuildGenerations,
  publishHostBuildGeneration,
  readCurrentHostBuildGeneration,
  releaseHostBuildGeneration,
} from "./host-build-generations.mjs";
import { NATIVE_WORKSPACE_ENTRIES, SERVER_WORKER_ENTRIES } from "./server-runtime-artifacts.mjs";
import { cleanHostBuildOutput } from "./clean-host-build-output.mjs";

test("publishes immutable complete generations and leaves the prior one readable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-build-generation-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "@panticonic/vibestudio",
        productName: "Vibestudio",
        version: "9.8.7",
        main: "dist/main.cjs",
      })
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist/workerd-programs"), { recursive: true });
    for (const entry of [
      "server.mjs",
      "prepare-workspace-templates.mjs",
      ...Object.values(SERVER_WORKER_ENTRIES.standalone),
      "server-electron.cjs",
      "adblock-engine-worker.cjs",
      "browserPrivacyPreload.cjs",
      "browserTransport.js",
      "fs-disk-worker.cjs",
      ...Object.values(NATIVE_WORKSPACE_ENTRIES),
      "dependency-content-maintenance.cjs",
      "internal-do.bundle.mjs",
      "host-build-fingerprint.json",
    ])
      fs.writeFileSync(path.join(root, "dist", entry), entry);
    for (const entry of ["headless-host", "assets"]) fs.mkdirSync(path.join(root, "dist", entry));
    fs.writeFileSync(path.join(root, "dist/main.cjs"), "main-a");
    fs.writeFileSync(path.join(root, "dist/panelPreload.cjs"), "preload-a");
    fs.writeFileSync(path.join(root, "dist/workerd-programs/router.mjs"), "router-a");
    const first = publishHostBuildGeneration(root, {
      kind: "desktop",
      mode: "development",
      fingerprint: "a".repeat(64),
      inputCount: 1,
    });
    const source = publishHostBuildGeneration(root, {
      kind: "source",
      mode: "development",
      fingerprint: "b".repeat(64),
      inputCount: 1,
    });
    assert.equal(readCurrentHostBuildGeneration(root, "desktop"), first);
    assert.equal(readCurrentHostBuildGeneration(root, "source"), source);
    assert.equal(fs.existsSync(path.join(source, "main.cjs")), false);
    assert.equal(
      fs.readFileSync(path.join(source, "dependency-content-maintenance.cjs"), "utf8"),
      "dependency-content-maintenance.cjs"
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(first, "package.json"), "utf8")), {
      name: "@panticonic/vibestudio",
      productName: "Vibestudio",
      version: "9.8.7",
      main: "main.cjs",
    });

    cleanHostBuildOutput(root);
    fs.mkdirSync(path.join(root, "dist/workerd-programs"), { recursive: true });
    for (const entry of [
      "server-electron.cjs",
      "adblock-engine-worker.cjs",
      "browserPrivacyPreload.cjs",
      "browserTransport.js",
      "fs-disk-worker.cjs",
      ...Object.values(NATIVE_WORKSPACE_ENTRIES),
      "dependency-content-maintenance.cjs",
      "internal-do.bundle.mjs",
      "host-build-fingerprint.json",
    ])
      fs.writeFileSync(path.join(root, "dist", entry), entry);
    for (const entry of ["headless-host", "assets"]) fs.mkdirSync(path.join(root, "dist", entry));
    fs.writeFileSync(path.join(root, "dist/main.cjs"), "main-b");
    fs.writeFileSync(path.join(root, "dist/panelPreload.cjs"), "preload-b");
    fs.writeFileSync(path.join(root, "dist/workerd-programs/router.mjs"), "router-b");
    const second = publishHostBuildGeneration(root, {
      kind: "desktop",
      mode: "development",
      fingerprint: "b".repeat(64),
      inputCount: 1,
    });

    assert.notEqual(first, second);
    assert.equal(fs.readFileSync(path.join(first, "panelPreload.cjs"), "utf8"), "preload-a");
    for (const entry of Object.values(NATIVE_WORKSPACE_ENTRIES)) {
      assert.equal(fs.readFileSync(path.join(first, entry), "utf8"), entry);
      assert.equal(fs.readFileSync(path.join(source, entry), "utf8"), entry);
    }
    assert.equal(
      fs.readFileSync(path.join(first, "workerd-programs/router.mjs"), "utf8"),
      "router-a"
    );
    assert.equal(fs.readFileSync(path.join(second, "panelPreload.cjs"), "utf8"), "preload-b");
    assert.equal(readCurrentHostBuildGeneration(root, "desktop"), second);
    releaseHostBuildGeneration(first);
    assert.equal(fs.existsSync(first), false);
    assert.equal(fs.existsSync(second), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collects generations after a crashed launcher without removing current builds", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-build-generation-gc-"));
  try {
    const generations = path.join(root, "dist/host-generations");
    fs.mkdirSync(generations, { recursive: true });
    const old = path.join(generations, `source-${"a".repeat(64)}`);
    const current = path.join(generations, `source-${"b".repeat(64)}`);
    fs.mkdirSync(old);
    fs.mkdirSync(current);
    fs.writeFileSync(
      path.join(generations, "current-source.json"),
      JSON.stringify({ version: 1, kind: "source", root: current })
    );
    const leaseDir = path.join(generations, ".leases", path.basename(old));
    fs.mkdirSync(leaseDir, { recursive: true });
    const liveLease = path.join(leaseDir, `${process.pid}-live`);
    fs.writeFileSync(liveLease, "");
    collectHostBuildGenerations(root);
    assert.equal(fs.existsSync(old), true);
    fs.rmSync(liveLease);
    fs.writeFileSync(path.join(leaseDir, "99999999-crashed"), "");
    collectHostBuildGenerations(root);
    assert.equal(fs.existsSync(old), false);
    assert.equal(fs.existsSync(current), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("refuses an incomplete generation without replacing current", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-build-generation-failure-"));
  try {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "product", version: "1.0.0" })
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist/workerd-programs"), { recursive: true });
    for (const entry of [
      "server.mjs",
      "prepare-workspace-templates.mjs",
      ...Object.values(SERVER_WORKER_ENTRIES.standalone),
      "browserTransport.js",
      "fs-disk-worker.cjs",
      ...Object.values(NATIVE_WORKSPACE_ENTRIES),
      "dependency-content-maintenance.cjs",
      "internal-do.bundle.mjs",
      "host-build-fingerprint.json",
    ])
      fs.writeFileSync(path.join(root, "dist", entry), entry);
    fs.mkdirSync(path.join(root, "dist/headless-host"));
    const first = publishHostBuildGeneration(root, {
      kind: "source",
      mode: "development",
      fingerprint: "a".repeat(64),
      inputCount: 1,
    });
    fs.rmSync(path.join(root, "dist/browserTransport.js"));
    assert.throws(
      () =>
        publishHostBuildGeneration(root, {
          kind: "source",
          mode: "development",
          fingerprint: "b".repeat(64),
          inputCount: 1,
        }),
      /missing browserTransport\.js/
    );
    assert.equal(readCurrentHostBuildGeneration(root, "source"), first);
    fs.writeFileSync(path.join(root, "dist/browserTransport.js"), "browserTransport.js");
    fs.rmSync(path.join(root, "dist", NATIVE_WORKSPACE_ENTRIES.extensionChild));
    assert.throws(
      () => publishHostBuildGeneration(root, { kind: "source", mode: "development", fingerprint: "b".repeat(64), inputCount: 1 }),
      /missing extension-child\.mjs/
    );
    assert.equal(readCurrentHostBuildGeneration(root, "source"), first);

  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
