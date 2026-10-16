import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import {
  assertHostBuildPayloadComplete,
  admitPublishedHostBuildGeneration,
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

function publishFixtureGeneration(root, build) {
  const { kind: _kind, ...identity } = build;
  fs.writeFileSync(
    path.join(root, "dist/host-build-fingerprint.json"),
    JSON.stringify({ version: 1, ...identity })
  );
  return publishHostBuildGeneration(root, build);
}

function writeSourcePrerequisites(root, prefix) {
  for (const artifact of SOURCE_SERVER_PREREQUISITE_ARTIFACTS) {
    if (artifact === `dist/${HOST_PREPARATION_RECIPES}`) continue;
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

function admittedSourceFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-admission-"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}');
  fs.mkdirSync(path.join(root, "node_modules"));
  writeSourcePrerequisites(root, "admission");
  for (const name of ["headless-host", "workerd-programs"]) {
    fs.rmSync(path.join(root, "dist", name));
    fs.mkdirSync(path.join(root, "dist", name));
  }
  const build = { kind: "source", mode: "development", fingerprint: "a".repeat(64), inputCount: 1 };
  const published = publishFixtureGeneration(root, build);
  return { root, build, published };
}

test("admits the sealed generation without reading payloads or rewriting publication records", (t) => {
  const { root, build, published } = admittedSourceFixture();
  const reads = [];
  const writes = [];
  const read = fs.readFileSync;
  const write = fs.writeFileSync;
  t.mock.method(fs, "readFileSync", (file, ...args) => {
    reads.push(String(file));
    return read(file, ...args);
  });
  t.mock.method(fs, "writeFileSync", (file, ...args) => {
    writes.push(String(file));
    return write(file, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(admitPublishedHostBuildGeneration(root, build), published);
    assert.equal(publishHostBuildGeneration(root, build), published);
    assert.ok(
      reads.every((file) =>
        ["current-source.json", "host-build-fingerprint.json", HOST_PREPARATION_RECIPES].includes(
          path.basename(file)
        )
      )
    );
    assert.ok(writes.every((file) => path.basename(file) === "owner"));
    assert.equal(
      reads.some((file) => file.endsWith("prepare-workspace-templates.mjs")),
      false
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("admits absence only when no existing publication is corrupt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "absent-host-generation-"));
  const build = { kind: "source", mode: "development", fingerprint: "a".repeat(64), inputCount: 1 };
  try {
    assert.equal(admitPublishedHostBuildGeneration(root, build), null);
    const generations = path.join(root, "dist/host-generations");
    fs.mkdirSync(generations, { recursive: true });
    assert.equal(admitPublishedHostBuildGeneration(root, build), null);
    fs.writeFileSync(
      path.join(generations, "current-source.json"),
      JSON.stringify({ version: 2, ...build, root: `source-${build.fingerprint}` })
    );
    assert.throws(() => admitPublishedHostBuildGeneration(root, build), { code: "ENOENT" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const corruption of ["receipt", "pointer", "recipe", "payload"])
  test(`fails ${corruption} corruption rather than rebuilding a sealed generation`, () => {
    const { root, build, published } = admittedSourceFixture();
    try {
      if (corruption === "receipt") {
        const { kind: _kind, ...identity } = build;
        fs.writeFileSync(
          path.join(published, "host-build-fingerprint.json"),
          JSON.stringify({ version: 1, ...identity, inputCount: 2 })
        );
      }
      if (corruption === "pointer")
        fs.writeFileSync(path.join(root, "dist/host-generations/current-source.json"), "{}");
      if (corruption === "recipe")
        fs.writeFileSync(path.join(published, HOST_PREPARATION_RECIPES), "{}");
      if (corruption === "payload") fs.rmSync(path.join(published, "browserTransport.js"));
      assert.throws(
        () => admitPublishedHostBuildGeneration(root, build),
        /receipt|invalid|incomplete/u
      );
      assert.throws(() => publishHostBuildGeneration(root, build), /receipt|invalid|incomplete/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

test("selects an existing proven generation when its pointer is legitimately absent", () => {
  const { root, build, published } = admittedSourceFixture();
  try {
    const pointer = path.join(root, "dist/host-generations/current-source.json");
    fs.rmSync(pointer);
    assert.equal(admitPublishedHostBuildGeneration(root, build), published);
    assert.equal(readCurrentHostBuildGeneration(root, "source"), published);
    releaseHostBuildGeneration(published);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("only the requested generation is an admission dependency", () => {
  const { root, build, published } = admittedSourceFixture();
  const pointer = path.join(root, "dist/host-generations/current-source.json");
  try {
    const older = { ...build, fingerprint: "b".repeat(64) };
    fs.writeFileSync(
      pointer,
      JSON.stringify({ version: 2, ...older, root: `source-${older.fingerprint}` })
    );
    assert.equal(admitPublishedHostBuildGeneration(root, build), published);
    fs.writeFileSync(pointer, JSON.stringify({ version: 1, root: "/legacy/checkout" }));
    assert.equal(admitPublishedHostBuildGeneration(root, build), published);
    const missing = { ...build, fingerprint: "c".repeat(64) };
    assert.equal(admitPublishedHostBuildGeneration(root, missing), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validates executable payload before publication-owned records are written", () => {
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
    assert.equal(fs.existsSync(path.join(root, "dist", HOST_PREPARATION_RECIPES)), false);

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

test("cold source publication creates and requires its own sealed preparation recipe", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-cold-source-publication-"));
  try {
    fs.writeFileSync(path.join(root, "package.json"), '{"name":"fixture"}');
    fs.mkdirSync(path.join(root, "node_modules"));
    writeSourcePrerequisites(root, "fresh-source");
    const recipePath = path.join(root, "dist", HOST_PREPARATION_RECIPES);
    assert.equal(fs.existsSync(recipePath), false);
    assert.doesNotThrow(() => assertHostBuildPayloadComplete(root, "source"));
    const build = {
      kind: "source",
      mode: "development",
      fingerprint: "d".repeat(64),
      inputCount: 1,
    };
    const published = publishFixtureGeneration(root, build);
    const expectedRecipe = createHash("sha256")
      .update(fs.readFileSync(path.join(root, "dist/prepare-workspace-templates.mjs")))
      .digest("hex");
    assert.equal(
      readHostPreparationRecipe(published, "prepare-workspace-templates.mjs"),
      expectedRecipe
    );
    assert.equal(
      readHostPreparationRecipe(path.join(root, "dist"), "prepare-workspace-templates.mjs"),
      expectedRecipe
    );
    assert.equal(admitPublishedHostBuildGeneration(root, build), published);
    fs.rmSync(path.join(published, HOST_PREPARATION_RECIPES));
    assert.throws(
      () => admitPublishedHostBuildGeneration(root, build),
      /incomplete: missing host-preparation-recipes\.json/u
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
      "connectionProcess.cjs",
      "adblock-engine-worker.cjs",
      "browserPrivacyPreload.cjs",
      "browserTransport.js",
      "fs-disk-worker.cjs",
      ...Object.values(NATIVE_WORKSPACE_ENTRIES),
      "dependency-content-maintenance.cjs",
      "internal-do-programs.json",
      "host-build-fingerprint.json",
    ])
      fs.writeFileSync(path.join(root, "dist", entry), entry);
    for (const entry of ["headless-host", "assets"]) fs.mkdirSync(path.join(root, "dist", entry));
    fs.writeFileSync(path.join(root, "dist/main.cjs"), "main-a");
    fs.writeFileSync(path.join(root, "dist/panelPreload.cjs"), "preload-a");
    fs.writeFileSync(path.join(root, "dist/workerd-programs/router.mjs"), "router-a");
    writeSourcePrerequisites(root, "a");
    const first = publishFixtureGeneration(root, {
      kind: "desktop",
      mode: "development",
      fingerprint: "a".repeat(64),
      inputCount: 1,
    });
    const source = publishFixtureGeneration(root, {
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
      "connectionProcess.cjs",
      "adblock-engine-worker.cjs",
      "browserPrivacyPreload.cjs",
      "browserTransport.js",
      "fs-disk-worker.cjs",
      ...Object.values(NATIVE_WORKSPACE_ENTRIES),
      "dependency-content-maintenance.cjs",
      "internal-do-programs.json",
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
    const second = publishFixtureGeneration(root, {
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
      "connectionProcess.cjs",
      "adblock-engine-worker.cjs",
      "server-electron.cjs",
      "panelPreload.cjs",
      "browserPrivacyPreload.cjs",
      "browserTransport.js",
      "fs-disk-worker.cjs",
      ...Object.values(NATIVE_WORKSPACE_ENTRIES),
      "dependency-content-maintenance.cjs",
      "internal-do-programs.json",
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
    const originalDesktop = publishFixtureGeneration(originalRoot, {
      kind: "desktop",
      mode: "production",
      fingerprint: desktopFingerprint,
      inputCount: 3,
    });
    publishFixtureGeneration(originalRoot, {
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

    const nextDesktop = publishFixtureGeneration(restoredRoot, {
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
      "internal-do-programs.json",
      "host-build-fingerprint.json",
    ])
      fs.writeFileSync(path.join(root, "dist", entry), entry);
    fs.mkdirSync(path.join(root, "dist/headless-host"));
    writeSourcePrerequisites(root, "failure");
    const first = publishFixtureGeneration(root, {
      kind: "source",
      mode: "development",
      fingerprint: "a".repeat(64),
      inputCount: 1,
    });
    fs.rmSync(path.join(root, "dist/browserTransport.js"));
    assert.throws(
      () =>
        publishFixtureGeneration(root, {
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
        publishFixtureGeneration(root, {
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
