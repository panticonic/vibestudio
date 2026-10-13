import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertHostBuildPayloadComplete,
  collectHostBuildGenerations,
  publishHostBuildGeneration,
  readCurrentHostBuildGeneration,
  releaseHostBuildGeneration,
  readHostPreparationRecipe,
  HOST_PREPARATION_RECIPES,
} from "./host-build-generations.mjs";
import {
  HOST_BRAND_RUNTIME_ARTIFACTS,
  NATIVE_WORKSPACE_ENTRIES,
  SERVER_WORKER_ENTRIES,
  SOURCE_SERVER_PREREQUISITE_ARTIFACTS,
} from "./server-runtime-artifacts.mjs";
import { cleanHostBuildOutput } from "./clean-host-build-output.mjs";

function writeSourcePrerequisites(root, prefix) {
  for (const artifact of SOURCE_SERVER_PREREQUISITE_ARTIFACTS) {
    const file = path.join(root, artifact);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${prefix}:${path.basename(file)}`);
  }
}

function writeHostBrandRuntimeArtifacts(root, prefix) {
  for (const artifact of HOST_BRAND_RUNTIME_ARTIFACTS) {
    const file = path.join(root, artifact);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${prefix}:${path.basename(file)}`);
  }
}

test("validates host payload before its completion receipt is written", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-build-payload-"));
  try {
    writeSourcePrerequisites(root, "fixture");
    const wasm = path.join(root, "dist/sql-wasm.wasm");
    const receipt = path.join(root, "dist/host-build-fingerprint.json");
    fs.rmSync(wasm);
    fs.rmSync(receipt);

    assert.throws(
      () => assertHostBuildPayloadComplete(root, "source"),
      /Cannot publish incomplete source host generation: missing sql-wasm\.wasm/u
    );
    assert.equal(fs.existsSync(receipt), false);

    fs.writeFileSync(wasm, "wasm payload");
    assert.doesNotThrow(() => assertHostBuildPayloadComplete(root, "source"));
    assert.equal(fs.existsSync(receipt), false);

    const favicon = path.join(root, HOST_BRAND_RUNTIME_ARTIFACTS[0]);
    fs.rmSync(favicon);
    assert.throws(
      () => assertHostBuildPayloadComplete(root, "source"),
      /Cannot publish incomplete source host generation: missing assets\/brand\/favicon\.ico/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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
    writeSourcePrerequisites(root, "a");
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
    const recipe = readHostPreparationRecipe(first, "prepare-workspace-templates.mjs");
    assert.equal(readHostPreparationRecipe(source, "prepare-workspace-templates.mjs"), recipe);
    // Consumers read the sealed publication record, not the executable payload.
    fs.renameSync(
      path.join(source, "prepare-workspace-templates.mjs"),
      path.join(source, "recipe-hidden")
    );
    assert.equal(readHostPreparationRecipe(source, "prepare-workspace-templates.mjs"), recipe);
    fs.renameSync(
      path.join(source, "recipe-hidden"),
      path.join(source, "prepare-workspace-templates.mjs")
    );
    assert.equal(fs.existsSync(path.join(source, "main.cjs")), false);
    for (const artifact of HOST_BRAND_RUNTIME_ARTIFACTS) {
      const relative = artifact.slice("dist/".length);
      assert.equal(fs.existsSync(path.join(source, relative)), true);
    }
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
    writeHostBrandRuntimeArtifacts(root, "b");
    writeSourcePrerequisites(root, "a");
    fs.copyFileSync(
      path.join(first, "prepare-workspace-templates.mjs"),
      path.join(root, "dist/prepare-workspace-templates.mjs")
    );
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
    assert.equal(readHostPreparationRecipe(second, "prepare-workspace-templates.mjs"), recipe);
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

test("rejects missing, malformed and unavailable preparation recipe records", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-preparation-recipes-"));
  try {
    assert.throws(
      () => readHostPreparationRecipe(root, "prepare-workspace-templates.mjs"),
      /ENOENT/u
    );
    for (const entries of [
      {},
      { "prepare-workspace-templates.mjs": "bad" },
      { "unowned.js": "a".repeat(64) },
    ]) {
      fs.writeFileSync(
        path.join(root, HOST_PREPARATION_RECIPES),
        JSON.stringify({ format: "vibestudio-host-preparation-recipes/1", entries })
      );
      assert.throws(
        () => readHostPreparationRecipe(root, "prepare-workspace-templates.mjs"),
        /invalid/u
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("relocated source and desktop generations resolve relative to the new checkout", () => {
  const originalRoot = fs.mkdtempSync(path.join(os.tmpdir(), "host-build-generation-original-"));
  const restoredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "host-build-generation-restored-"));
  const borrowed = [];
  const populateOutput = (root, suffix) => {
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "product", productName: "Product", version: "1.0.0" })
    );
    fs.mkdirSync(path.join(root, "node_modules"), { recursive: true });
    fs.mkdirSync(path.join(root, "dist/workerd-programs"), { recursive: true });
    for (const entry of [
      "server.mjs",
      "prepare-workspace-templates.mjs",
      ...Object.values(SERVER_WORKER_ENTRIES.standalone),
      "main.cjs",
      "adblock-engine-worker.cjs",
      "server-electron.cjs",
      "panelPreload.cjs",
      "browserPrivacyPreload.cjs",
      "browserTransport.js",
      "fs-disk-worker.cjs",
      ...Object.values(NATIVE_WORKSPACE_ENTRIES),
      "dependency-content-maintenance.cjs",
      "internal-do.bundle.mjs",
      "host-build-fingerprint.json",
    ]) {
      fs.writeFileSync(path.join(root, "dist", entry), `${suffix}:${entry}`);
    }
    for (const entry of ["headless-host", "assets"])
      fs.mkdirSync(path.join(root, "dist", entry), { recursive: true });
    fs.writeFileSync(path.join(root, "dist/workerd-programs/router.mjs"), `${suffix}:router`);
    writeSourcePrerequisites(root, suffix);
  };

  try {
    populateOutput(originalRoot, "original");
    populateOutput(restoredRoot, "restored");
    const desktopFingerprint = "c".repeat(64);
    const sourceFingerprint = "d".repeat(64);
    const originalDesktop = publishHostBuildGeneration(originalRoot, {
      kind: "desktop",
      mode: "production",
      fingerprint: desktopFingerprint,
      inputCount: 3,
    });
    publishHostBuildGeneration(originalRoot, {
      kind: "source",
      mode: "production",
      fingerprint: sourceFingerprint,
      inputCount: 3,
    });

    const originalGenerations = path.join(originalRoot, "dist/host-generations");
    const restoredGenerations = path.join(restoredRoot, "dist/host-generations");
    fs.mkdirSync(path.dirname(restoredGenerations), { recursive: true });
    fs.cpSync(originalGenerations, restoredGenerations, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
    });

    for (const kind of ["desktop", "source"]) {
      const pointerPath = path.join(restoredGenerations, `current-${kind}.json`);
      const pointerBytes = fs.readFileSync(pointerPath, "utf8");
      const pointer = JSON.parse(pointerBytes);
      assert.equal(pointer.version, 2);
      assert.equal(pointer.root, `${kind}-${pointer.fingerprint}`);
      assert.equal(path.isAbsolute(pointer.root), false);
      fs.writeFileSync(
        pointerPath,
        JSON.stringify({ ...pointer, root: path.join(originalGenerations, pointer.root) })
      );
      assert.throws(() => readCurrentHostBuildGeneration(restoredRoot, kind), /invalid/u);
      fs.writeFileSync(pointerPath, pointerBytes);

      const generationRoot = path.join(restoredGenerations, pointer.root);
      const dependencyLink = path.join(generationRoot, "node_modules");
      if (kind === "desktop") {
        fs.unlinkSync(dependencyLink);
        fs.symlinkSync(path.join(originalRoot, "node_modules"), dependencyLink, "dir");
        assert.throws(
          () => readCurrentHostBuildGeneration(restoredRoot, kind),
          /dependency link is invalid/u
        );
        fs.unlinkSync(dependencyLink);
        fs.symlinkSync(
          path.relative(generationRoot, path.join(restoredRoot, "node_modules")),
          dependencyLink,
          "dir"
        );
      }
      const root = readCurrentHostBuildGeneration(restoredRoot, kind);
      borrowed.push(root);
      assert.equal(root, path.join(restoredGenerations, pointer.root));
      assert.equal(path.isAbsolute(fs.readlinkSync(dependencyLink)), false);
      assert.equal(
        fs.realpathSync(dependencyLink),
        fs.realpathSync(path.join(restoredRoot, "node_modules"))
      );
    }

    const nextDesktop = publishHostBuildGeneration(restoredRoot, {
      kind: "desktop",
      mode: "production",
      fingerprint: "e".repeat(64),
      inputCount: 3,
    });
    assert.equal(
      fs.existsSync(path.join(restoredGenerations, path.basename(originalDesktop))),
      true
    );
    releaseHostBuildGeneration(path.join(restoredGenerations, `desktop-${desktopFingerprint}`));
    borrowed.splice(
      borrowed.indexOf(path.join(restoredGenerations, `desktop-${desktopFingerprint}`)),
      1
    );
    assert.equal(
      fs.existsSync(path.join(restoredGenerations, `desktop-${desktopFingerprint}`)),
      false
    );
    assert.equal(fs.existsSync(nextDesktop), true);
    assert.equal(
      fs.existsSync(path.join(restoredGenerations, `source-${sourceFingerprint}`)),
      true
    );
  } finally {
    for (const root of borrowed) releaseHostBuildGeneration(root);
    fs.rmSync(originalRoot, { recursive: true, force: true });
    fs.rmSync(restoredRoot, { recursive: true, force: true });
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
      JSON.stringify({
        version: 2,
        kind: "source",
        mode: "development",
        fingerprint: "b".repeat(64),
        inputCount: 1,
        root: path.basename(current),
      })
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
    writeSourcePrerequisites(root, "failure");
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
      () =>
        publishHostBuildGeneration(root, {
          kind: "source",
          mode: "development",
          fingerprint: "b".repeat(64),
          inputCount: 1,
        }),
      /missing extension-child\.mjs/
    );
    assert.equal(readCurrentHostBuildGeneration(root, "source"), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
