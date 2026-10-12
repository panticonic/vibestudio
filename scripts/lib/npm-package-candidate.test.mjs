import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
