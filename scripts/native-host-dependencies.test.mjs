import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { prepareNativeDependencyFiles } from "./native-host-dependencies.mjs";

test(
  "prepares the shipped macOS PTY executable without changing its bytes",
  { skip: process.platform === "win32" },
  () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), "native-pty-metadata-"));
    try {
      const root = path.join(cwd, "node_modules", "node-pty");
      const directory = path.join(root, "prebuilds", "darwin-arm64");
      mkdirSync(directory, { recursive: true });
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "node-pty" }));
      const helper = path.join(directory, "spawn-helper");
      const payload = "#!/bin/sh\nprintf 'helper-ready'\n";
      writeFileSync(helper, payload, { mode: 0o664 });
      assert.equal(spawnSync(helper).error?.code, "EACCES");
      prepareNativeDependencyFiles({ cwd, platform: "darwin", arch: "arm64" });
      assert.equal(readFileSync(helper, "utf8"), payload);
      assert.equal(statSync(helper).mode & 0o777, 0o755);
      const child = spawnSync(helper, { encoding: "utf8" });
      assert.equal(child.status, 0);
      assert.equal(child.stdout, "helper-ready");
      prepareNativeDependencyFiles({ cwd, platform: "darwin", arch: "arm64" });
      assert.equal(readFileSync(helper, "utf8"), payload);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
);
