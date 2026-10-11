import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import {
  inspectHostNativeDependencies,
  prepareNativeDependencyFiles,
} from "./native-host-dependencies.mjs";
import {
  assertDarwinProcessObserverArtifacts,
  darwinProcessObserverPath,
  prepareDarwinProcessObserver,
} from "./owned-process-group-observer.mjs";

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
      let observerPrepared = 0;
      prepareNativeDependencyFiles({
        cwd,
        platform: "darwin",
        arch: "arm64",
        prepareObserver: ({ cwd: observerCwd, arch }) => {
          assert.equal(observerCwd, cwd);
          assert.equal(arch, "arm64");
          observerPrepared++;
        },
      });
      assert.equal(observerPrepared, 1);
      assert.equal(readFileSync(helper, "utf8"), payload);
      assert.equal(statSync(helper).mode & 0o777, 0o755);
      const child = spawnSync(helper, { encoding: "utf8" });
      assert.equal(child.status, 0);
      assert.equal(child.stdout, "helper-ready");
      prepareNativeDependencyFiles({
        cwd,
        platform: "darwin",
        arch: "arm64",
        prepareObserver: () => observerPrepared++,
      });
      assert.equal(observerPrepared, 2);
      assert.equal(readFileSync(helper, "utf8"), payload);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }
);

test("installs Windows workerd long-path metadata beside the unchanged dependency executable", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "workerd-metadata-"));
  try {
    const directory = path.join(cwd, "node_modules", "@cloudflare", "workerd-windows-64", "bin");
    mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, "workerd.exe");
    const payload = Buffer.from([0x4d, 0x5a, 0x00, 0xff]);
    writeFileSync(executable, payload);
    const manifest = readFileSync(new URL("./workerd.exe.manifest", import.meta.url), "utf8");
    for (let run = 0; run < 2; run++) {
      prepareNativeDependencyFiles({ cwd, platform: "win32", arch: "x64" });
      assert.deepEqual(readFileSync(executable), payload);
      assert.equal(readFileSync(`${executable}.manifest`, "utf8"), manifest);
    }
    assert.match(manifest, /<longPathAware[^>]*>true<\/longPathAware>/);
    assert.throws(
      () => prepareNativeDependencyFiles({ cwd, platform: "win32", arch: "arm64" }),
      /Unsupported Windows workerd architecture/
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Darwin process observer preparation is content-bound and atomically reusable", () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "darwin-process-observer-"));
  const source = path.join(cwd, "observer.c");
  writeFileSync(source, "int main(void) { return 0; }\n");
  let compilations = 0;
  let forceCompiledArch;
  const run = (executable, args) => {
    if (executable === "xcrun") return { status: 0, stdout: "/toolchain/clang\n" };
    if (args[0] === "--version") return { status: 0, stdout: "1\n" };
    compilations++;
    const compiledArch = forceCompiledArch ?? args[args.indexOf("-arch") + 1];
    const output = args[args.indexOf("-o") + 1];
    const binary = Buffer.alloc(8);
    binary.writeUInt32LE(0xfeedfacf, 0);
    binary.writeUInt32LE(compiledArch === "arm64" ? 0x0100000c : 0x01000007, 4);
    writeFileSync(output, binary, { mode: 0o700 });
    return { status: 0, stdout: "", stderr: "" };
  };
  try {
    const expected = darwinProcessObserverPath(cwd, "arm64");
    assert.equal(prepareDarwinProcessObserver({ cwd, arch: "arm64", source, run }), expected);
    assert.equal(statSync(expected).mode & 0o777, 0o755);
    const receipt = JSON.parse(readFileSync(expected + ".source.json", "utf8"));
    assert.equal(receipt.version, 2);
    assert.equal(receipt.targetArch, "arm64");
    assert.equal(receipt.binaryDigest.length, 64);
    assert.equal(compilations, 1);
    chmodSync(expected, 0o644);
    assert.equal(prepareDarwinProcessObserver({ cwd, arch: "arm64", source, run }), expected);
    assert.equal(statSync(expected).mode & 0o777, 0o755);
    assert.equal(compilations, 1);
    const x64Output = prepareDarwinProcessObserver({ cwd, arch: "x64", source, run });
    assert.equal(x64Output, darwinProcessObserverPath(cwd, "x64"));
    assertDarwinProcessObserverArtifacts(cwd, { source });
    assert.equal(compilations, 2);

    writeFileSync(x64Output, "tampered observer", { mode: 0o755 });
    assert.throws(() => assertDarwinProcessObserverArtifacts(cwd, { source }), /source receipt/u);
    prepareDarwinProcessObserver({ cwd, arch: "x64", source, run });
    assert.equal(compilations, 3);
    assertDarwinProcessObserverArtifacts(cwd, { source });

    prepareDarwinProcessObserver({ cwd, arch: "arm64", source, run });
    assert.equal(compilations, 3);

    writeFileSync(source, "int main(void) { return 1; }\n");
    prepareDarwinProcessObserver({ cwd, arch: "arm64", source, run });
    assert.equal(compilations, 4);
    assert.throws(() => assertDarwinProcessObserverArtifacts(cwd, { source }), /source receipt/u);
    prepareDarwinProcessObserver({ cwd, arch: "x64", source, run });
    assert.equal(compilations, 5);
    assertDarwinProcessObserverArtifacts(cwd, { source });

    forceCompiledArch = "x86_64";
    writeFileSync(source, "int main(void) { return 2; }\n");
    assert.throws(
      () => prepareDarwinProcessObserver({ cwd, arch: "arm64", source, run }),
      /architecture mismatch/u
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
