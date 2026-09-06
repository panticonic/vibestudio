import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  inspectHostNativeDependencies,
  prepareNativeDependencyFiles,
} from "./native-host-dependencies.mjs";

test("PTY probe requires output and successful exit in either order despite retained helper handles", () => {
  let smoke;
  inspectHostNativeDependencies({
    run: (_executable, args) => {
      if (args[1].includes('require("node-pty")')) smoke = args[1];
      return { status: 0 };
    },
  });
  const cwd = mkdtempSync(path.join(os.tmpdir(), "native-pty-probe-"));
  try {
    const moduleRoot = path.join(cwd, "node_modules", "node-pty");
    mkdirSync(moduleRoot, { recursive: true });
    for (const [order, exitCode] of [
      ["data-first", 0],
      ["exit-first", 0],
      ["data-first", 7],
    ]) {
      writeFileSync(
        path.join(moduleRoot, "index.js"),
        `
        exports.spawn = () => {
          let data, exit;
          setInterval(() => {}, 1000);
          setImmediate(() => {
            if (${JSON.stringify(order)} === "data-first") {
              data("native-pty-ready"); setImmediate(() => exit({exitCode:${exitCode}}));
            } else {
              exit({exitCode:${exitCode}}); setImmediate(() => data("native-pty-ready"));
            }
          });
          return { onData(fn) { data = fn; }, onExit(fn) { exit = fn; }, kill() {} };
        };
      `
      );
      const result = spawnSync(process.execPath, ["-e", smoke], {
        cwd,
        timeout: 2000,
        encoding: "utf8",
      });
      assert.equal(result.error, undefined, result.stderr);
      assert.equal(result.status, exitCode === 0 ? 0 : 1, result.stderr);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

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
