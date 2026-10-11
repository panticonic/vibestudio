import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SERVER_RUNTIME_ARTIFACTS,
  stageDarwinProcessObserverArtifacts,
  withOwnedCleanup,
} from "./build-server-npm-package.mjs";
import { SOURCE_SERVER_PREREQUISITE_ARTIFACTS } from "./server-runtime-artifacts.mjs";

test("stages every standalone child required by source-server readiness", () => {
  assert.ok(SERVER_RUNTIME_ARTIFACTS.includes("dist/dependency-content-maintenance.cjs"));
  for (const artifact of SERVER_RUNTIME_ARTIFACTS) {
    assert.ok(
      SOURCE_SERVER_PREREQUISITE_ARTIFACTS.includes(artifact),
      `${artifact} must be required before a source-server launch`
    );
  }
});

test("owned release cleanup attempts every resource and preserves operation and cleanup failures", async () => {
  const operationFailure = new Error("template preparation failed");
  const firstCleanupFailure = new Error("node_modules cleanup failed");
  const secondCleanupFailure = new Error("runtime cleanup failed");
  const attempted = [];

  await assert.rejects(
    withOwnedCleanup(
      async () => {
        throw operationFailure;
      },
      [
        async () => {
          attempted.push("node_modules");
          throw firstCleanupFailure;
        },
        async () => {
          attempted.push("runtime");
          throw secondCleanupFailure;
        },
        async () => {
          attempted.push("lockfile");
        },
      ],
      "release cleanup failed"
    ),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        [...error.errors],
        [operationFailure, firstCleanupFailure, secondCleanupFailure]
      );
      assert.equal(error.cause, operationFailure);
      return true;
    }
  );

  assert.deepEqual(attempted.sort(), ["lockfile", "node_modules", "runtime"]);
});

test("owned cleanup rethrows a lone preparation failure unchanged", async () => {
  const operationFailure = new Error("installation failed");
  await assert.rejects(
    withOwnedCleanup(
      async () => {
        throw operationFailure;
      },
      [],
      "unused"
    ),
    (error) => error === operationFailure
  );
});

function prepareObserverFixture(root, arch) {
  const sourcePath = path.join(root, "native", "owned-process-group", "darwin.c");
  const executable = path.join(
    root,
    "dist",
    "native-process-observer",
    `darwin-${arch}`,
    "owned-process-group-observer"
  );
  const source = Buffer.from("static const int observerSource = 1;\n");
  const binary = Buffer.alloc(32);
  binary.writeUInt32LE(0xfeedfacf, 0);
  binary.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(sourcePath, source);
  // GitHub Actions artifact extraction does not preserve executable mode.
  fs.writeFileSync(executable, binary, { mode: 0o644 });
  fs.writeFileSync(
    `${executable}.source.json`,
    `${JSON.stringify({
      version: 2,
      sourceDigest: createHash("sha256").update(source).digest("hex"),
      binaryDigest: createHash("sha256").update(binary).digest("hex"),
      targetArch: arch === "arm64" ? "arm64" : "x86_64",
    })}\n`
  );
  return { executable, binary };
}

test("stages both source-attested Darwin observers from prepared inputs on any host", () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-observer-inputs-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-observer-package-"));
  try {
    const arm = prepareObserverFixture(appRoot, "arm64");
    const x64 = prepareObserverFixture(appRoot, "x64");
    stageDarwinProcessObserverArtifacts(packageRoot, appRoot);

    for (const [arch, expected] of [
      ["arm64", arm],
      ["x64", x64],
    ]) {
      const staged = path.join(
        packageRoot,
        "dist",
        "native-process-observer",
        `darwin-${arch}`,
        "owned-process-group-observer"
      );
      assert.deepEqual(fs.readFileSync(staged), expected.binary);
      assert.deepEqual(
        fs.readFileSync(`${staged}.source.json`),
        fs.readFileSync(`${expected.executable}.source.json`)
      );
      assert.equal(fs.statSync(staged).mode & 0o111, 0o111);
    }
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});

test("rejects a Darwin observer candidate whose executable no longer matches its receipt", () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-observer-tamper-"));
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "darwin-observer-rejected-"));
  try {
    prepareObserverFixture(appRoot, "arm64");
    const x64 = prepareObserverFixture(appRoot, "x64");
    fs.appendFileSync(x64.executable, Buffer.from([0x01]));

    assert.throws(
      () => stageDarwinProcessObserverArtifacts(packageRoot, appRoot),
      /does not match its source receipt/u
    );
    assert.equal(fs.existsSync(path.join(packageRoot, "dist/native-process-observer")), false);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
    fs.rmSync(packageRoot, { recursive: true, force: true });
  }
});
