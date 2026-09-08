import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  publishHostBuildGeneration,
  readCurrentHostBuildGeneration,
} from "./host-build-generations.mjs";
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
      "server-electron.cjs",
      "browserPrivacyPreload.cjs",
      "browserTransport.js",
      "fs-disk-worker.cjs",
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
      "browserPrivacyPreload.cjs",
      "browserTransport.js",
      "fs-disk-worker.cjs",
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
    assert.equal(
      fs.readFileSync(path.join(first, "workerd-programs/router.mjs"), "utf8"),
      "router-a"
    );
    assert.equal(fs.readFileSync(path.join(second, "panelPreload.cjs"), "utf8"), "preload-b");
    assert.equal(readCurrentHostBuildGeneration(root, "desktop"), second);
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
      "browserTransport.js",
      "fs-disk-worker.cjs",
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
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
