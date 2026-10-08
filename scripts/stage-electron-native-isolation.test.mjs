import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { publishNativeArtifact } from "./stage-electron-native-isolation.mjs";

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
