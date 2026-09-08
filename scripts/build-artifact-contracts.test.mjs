import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applicationSourceMaps } from "./build-artifact-contracts.mjs";

test("release map checks inspect application output without entering retained hosts or stock runtimes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-artifacts-"));
  try {
    for (const dir of ["assets", "node", "host-generations/live"]) fs.mkdirSync(path.join(root, dir), { recursive: true });
    for (const file of ["assets/app.js.map", "node/npm.js.map", "host-generations/live/server.js.map"]) fs.writeFileSync(path.join(root, file), "{}");
    fs.symlinkSync(root, path.join(root, "host-generations/live/recursive"), "dir");
    fs.symlinkSync(path.join(root, "absent"), path.join(root, "host-generations/live/absent"), "dir");
    assert.deepEqual(applicationSourceMaps(root), [path.join("assets", "app.js.map")]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
