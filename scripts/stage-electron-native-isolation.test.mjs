import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  includeElectronRuntimeScriptClosure,
  publishNativeArtifact,
} from "./stage-electron-native-isolation.mjs";

test("publishes a new native inode while existing holders retain the old bytes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-publication-"));
  try {
    const source = path.join(root, "source"),
      destination = path.join(root, "installed");
    fs.writeFileSync(source, "new executable");
    fs.writeFileSync(destination, "running executable");
    const old = path.join(root, "old-holder");
    fs.linkSync(destination, old);
    publishNativeArtifact(source, destination, true);
    assert.equal(fs.readFileSync(destination, "utf8"), "new executable");
    assert.equal(fs.readFileSync(old, "utf8"), "running executable");
    assert.notEqual(fs.statSync(old).ino, fs.statSync(destination).ino);
    assert.ok(!fs.readdirSync(root).some((name) => name.endsWith(".tmp")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the direct electron-builder hook unpacks transitive CLI runtime helpers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "electron-script-closure-"));
  try {
    fs.mkdirSync(path.join(root, "scripts/cli"), { recursive: true });
    fs.mkdirSync(path.join(root, "scripts/lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: {} }));
    fs.writeFileSync(
      path.join(root, "scripts/cli/entry.mjs"),
      `import "../lib/owned-helper.mjs";\n`
    );
    fs.writeFileSync(path.join(root, "scripts/lib/owned-helper.mjs"), `export {};\n`);
    const config = {
      files: ["scripts/cli/**/*"],
      asarUnpack: ["scripts/cli/**/*"],
    };

    const closure = includeElectronRuntimeScriptClosure({
      packager: { projectDir: root, config },
    });
    assert.deepEqual(closure.added, ["scripts/lib/owned-helper.mjs"]);
    assert.ok(config.files.includes("scripts/lib/owned-helper.mjs"));
    assert.ok(config.asarUnpack.includes("scripts/lib/owned-helper.mjs"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
