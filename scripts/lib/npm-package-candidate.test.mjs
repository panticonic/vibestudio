import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import {
  packNpmPackageCandidate,
  readVerifiedNpmPackageCandidate,
} from "./npm-package-candidate.mjs";

void test("packs one npm candidate and verifies its source, identity, length, and digest", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-package-candidate-"));
  try {
    const packageRoot = path.join(root, "package");
    const outputDirectory = path.join(root, "candidate");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@example/candidate", version: "1.2.3", files: ["index.mjs"] })
    );
    fs.writeFileSync(path.join(packageRoot, "index.mjs"), `export const ready = true;\n`);

    const sourceSha = "a".repeat(40);
    const produced = await packNpmPackageCandidate({ packageRoot, outputDirectory, sourceSha });
    assert.equal(produced.receipt.sourceSha, sourceSha);
    assert.equal(produced.receipt.packageName, "@example/candidate");
    assert.equal(produced.receipt.packageVersion, "1.2.3");
    assert.ok(produced.receipt.byteLength > 0);

    const accepted = await readVerifiedNpmPackageCandidate(produced.receiptPath, {
      sourceSha,
      packageName: "@example/candidate",
      packageVersion: "1.2.3",
    });
    assert.equal(accepted.tarballPath, produced.tarballPath);
    assert.equal(accepted.receipt.sha256, produced.receipt.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("streams large structured npm pack output to disk without losing its receipt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-package-candidate-large-output-"));
  try {
    const packageRoot = path.join(root, "package");
    const outputDirectory = path.join(root, "candidate");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@example/large-candidate", version: "3.4.5" })
    );
    const sourceSha = "f".repeat(40);
    const fakePack = (_command, args, options) => {
      assert.deepEqual(args.slice(0, 3), ["pack", "--json", "--pack-destination"]);
      const tarballName = "large-candidate.tgz";
      const script = `
        const fs = require("node:fs");
        const path = require("node:path");
        const destination = ${JSON.stringify(outputDirectory)};
        const files = Array.from({ length: 30000 }, (_, index) => ({
          path: "files/" + String(index).padStart(6, "0") + ".js",
          size: 1,
          mode: 420
        }));
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(path.join(destination, ${JSON.stringify(tarballName)}), "candidate bytes");
        process.stdout.write(JSON.stringify([{
          name: "@example/large-candidate",
          version: "3.4.5",
          filename: ${JSON.stringify(tarballName)},
          files
        }]));
      `;
      return spawn(process.execPath, ["-e", script], options);
    };

    const candidate = await packNpmPackageCandidate({
      packageRoot,
      outputDirectory,
      sourceSha,
      spawnProcess: fakePack,
    });
    assert.equal(candidate.receipt.packageName, "@example/large-candidate");
    assert.equal(candidate.receipt.packageVersion, "3.4.5");
    assert.equal(candidate.receipt.sourceSha, sourceSha);
    assert.deepEqual(fs.readdirSync(outputDirectory).sort(), [
      "candidate-receipt.json",
      "large-candidate.tgz",
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("keeps bounded npm pack failure diagnostics and the original exit error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-package-candidate-pack-failure-"));
  try {
    const packageRoot = path.join(root, "package");
    const outputDirectory = path.join(root, "candidate");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@example/failing-candidate", version: "1.0.0" })
    );
    const spawnFailingPack = (_command, _args, options) =>
      spawn(
        process.execPath,
        [
          "-e",
          `process.stderr.write("x".repeat(100000) + "\\nFINAL PACK DIAGNOSTIC\\n"); process.exitCode = 17;`,
        ],
        options
      );

    await assert.rejects(
      packNpmPackageCandidate({
        packageRoot,
        outputDirectory,
        sourceSha: "e".repeat(40),
        spawnProcess: spawnFailingPack,
      }),
      (error) => {
        assert.match(error.message, /last 16384 bytes/u);
        assert.match(error.message, /FINAL PACK DIAGNOSTIC/u);
        assert.match(error.cause.message, /status 17/u);
        assert.deepEqual(fs.readdirSync(outputDirectory), []);
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("rejects a candidate from another source or package identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-package-candidate-"));
  try {
    const packageRoot = path.join(root, "package");
    const outputDirectory = path.join(root, "candidate");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@example/candidate", version: "1.2.3" })
    );
    fs.writeFileSync(path.join(packageRoot, "index.js"), "module.exports = true;\n");
    const produced = await packNpmPackageCandidate({
      packageRoot,
      outputDirectory,
      sourceSha: "b".repeat(40),
    });

    await assert.rejects(
      readVerifiedNpmPackageCandidate(produced.receiptPath, {
        sourceSha: "c".repeat(40),
        packageName: "@example/candidate",
        packageVersion: "1.2.3",
      }),
      /does not match this source and package identity/u
    );
    await assert.rejects(
      readVerifiedNpmPackageCandidate(produced.receiptPath, {
        sourceSha: "b".repeat(40),
        packageName: "@example/other",
        packageVersion: "1.2.3",
      }),
      /does not match this source and package identity/u
    );

    fs.appendFileSync(produced.tarballPath, "tampered");
    await assert.rejects(
      readVerifiedNpmPackageCandidate(produced.receiptPath, {
        sourceSha: "b".repeat(40),
        packageName: "@example/candidate",
        packageVersion: "1.2.3",
      }),
      /does not match its receipt integrity values/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("rejects receipt filenames that escape their own directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-package-candidate-"));
  try {
    const receiptPath = path.join(root, "candidate-receipt.json");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        schemaVersion: 1,
        sourceSha: "d".repeat(40),
        packageName: "@example/candidate",
        packageVersion: "1.2.3",
        tarball: "../candidate.tgz",
        byteLength: 1,
        sha256: "e".repeat(64),
      })
    );
    await assert.rejects(
      readVerifiedNpmPackageCandidate(receiptPath, {
        sourceSha: "d".repeat(40),
        packageName: "@example/candidate",
        packageVersion: "1.2.3",
      }),
      /does not match this source and package identity/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
