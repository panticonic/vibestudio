import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { list as listTarArchive } from "tar";
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
    const entries = [];
    await listTarArchive({
      file: produced.tarballPath,
      onReadEntry(entry) {
        entries.push(entry.path);
      },
    });
    assert.deepEqual(entries, ["package/index.mjs", "package/package.json"]);

    const installRoot = path.join(root, "install");
    fs.mkdirSync(installRoot);
    fs.writeFileSync(path.join(installRoot, "package.json"), '{"private":true}\n');
    execFileSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        produced.tarballPath,
      ],
      { cwd: installRoot, stdio: "pipe" }
    );
    assert.equal(
      fs.readFileSync(path.join(installRoot, "node_modules/@example/candidate/index.mjs"), "utf8"),
      "export const ready = true;\n"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("creates the same archive from the same staged bytes regardless of source mtimes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-package-candidate-reproducible-"));
  try {
    const candidates = [];
    for (const [index, mtime] of [new Date(1_000), new Date(2_000)].entries()) {
      const packageRoot = path.join(root, `package-${index}`);
      const outputDirectory = path.join(root, `candidate-${index}`);
      fs.mkdirSync(path.join(packageRoot, "lib"), { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "lib/z.mjs"), "export const z = 1;\n");
      fs.writeFileSync(path.join(packageRoot, "lib/a.mjs"), "export const a = 1;\n");
      fs.writeFileSync(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@example/reproducible", version: "3.4.5", files: ["lib"] })
      );
      for (const file of ["package.json", "lib/a.mjs", "lib/z.mjs"])
        fs.utimesSync(path.join(packageRoot, file), mtime, mtime);
      candidates.push(
        await packNpmPackageCandidate({
          packageRoot,
          outputDirectory,
          sourceSha: "f".repeat(40),
        })
      );
    }
    assert.equal(candidates[0].receipt.sha256, candidates[1].receipt.sha256);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("stores hard-linked staged files as independent regular archive entries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-package-candidate-hard-links-"));
  try {
    const packageRoot = path.join(root, "package");
    const outputDirectory = path.join(root, "candidate");
    fs.mkdirSync(path.join(packageRoot, "blobs"), { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@example/no-links", version: "1.0.0", files: ["blobs"] })
    );
    fs.writeFileSync(path.join(packageRoot, "blobs/first"), "shared bytes\n");
    fs.linkSync(path.join(packageRoot, "blobs/first"), path.join(packageRoot, "blobs/second"));

    const produced = await packNpmPackageCandidate({
      packageRoot,
      outputDirectory,
      sourceSha: "a".repeat(40),
    });
    const entries = [];
    await listTarArchive({
      file: produced.tarballPath,
      onReadEntry(entry) {
        entries.push({ path: entry.path, type: entry.type, size: entry.size });
      },
    });
    assert.deepEqual(
      entries.filter((entry) => entry.path.startsWith("package/blobs/")),
      [
        { path: "package/blobs/first", type: "File", size: 13 },
        { path: "package/blobs/second", type: "File", size: 13 },
      ]
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("removes a partial archive while preserving an archive creation failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-package-candidate-pack-failure-"));
  try {
    const packageRoot = path.join(root, "package");
    const outputDirectory = path.join(root, "candidate");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({
        name: "@example/failing-candidate",
        version: "1.0.0",
        files: ["index.js"],
      })
    );
    fs.writeFileSync(path.join(packageRoot, "index.js"), "module.exports = true;\n");
    const archiveFailure = new Error("archive writer failed");

    await assert.rejects(
      packNpmPackageCandidate({
        packageRoot,
        outputDirectory,
        sourceSha: "e".repeat(40),
        async createArchive({ tarballPath }) {
          fs.writeFileSync(tarballPath, "partial archive");
          throw archiveFailure;
        },
      }),
      (error) => {
        assert.equal(error, archiveFailure);
        assert.deepEqual(fs.readdirSync(outputDirectory), []);
        return true;
      }
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

void test("rejects archive roots outside the staged package before writing output", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "npm-package-candidate-unsafe-root-"));
  try {
    const packageRoot = path.join(root, "package");
    const outputDirectory = path.join(root, "candidate");
    fs.mkdirSync(packageRoot);
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@example/unsafe", version: "1.0.0", files: ["../secret"] })
    );
    await assert.rejects(
      packNpmPackageCandidate({
        packageRoot,
        outputDirectory,
        sourceSha: "e".repeat(40),
      }),
      /unsafe file root/u
    );
    assert.deepEqual(fs.readdirSync(outputDirectory), []);
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
      JSON.stringify({ name: "@example/candidate", version: "1.2.3", files: ["index.js"] })
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
