import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  NATIVE_CELLD_MANIFEST,
  assertNativeCelldBinary,
  nativeCelldArtifact,
  nativeCelldDigest,
  nativeCelldTarget,
  stageNativeCelld,
  stageNativeCelldCiArtifact,
} from "./native-celld-artifacts.mjs";

/** A minimal ELF header for linux-x64: the format check reads the class, endianness and machine. */
function elf(machine, extra = "") {
  const bytes = Buffer.alloc(64);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(bytes);
  bytes.writeUInt16LE(machine, 18);
  return Buffer.concat([bytes, Buffer.from(extra)]);
}

function withTarget(contents) {
  const digest = createHash("sha256").update(contents).digest("hex");
  return { platform: "linux", arch: "x64", binary: "celld", sha256: digest };
}

test("the manifest names every supported target and a digest only where a build exists", () => {
  assert.equal(NATIVE_CELLD_MANIFEST.version, 1);
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["darwin", "arm64"],
    ["win32", "x64"],
  ])
    assert.equal(nativeCelldTarget(platform, arch).arch, arch);
  assert.match(nativeCelldTarget("linux", "x64").sha256, /^[0-9a-f]{64}$/u);
  assert.equal(nativeCelldArtifact(nativeCelldTarget("win32", "x64")), "native/celld/win32-x64/celld.exe");
  assert.throws(() => nativeCelldTarget("freebsd", "x64"), /Unsupported celld runtime target/u);
});

test("stages only the binary the manifest names, for the target it names", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-celld-"));
  try {
    const good = elf(62);
    const target = withTarget(good);
    const source = path.join(root, "celld-source");
    fs.writeFileSync(source, good);
    assertNativeCelldBinary(source, target);
    const staged = stageNativeCelld(source, root, target);
    assert.equal(staged, path.join(root, "native/celld/linux-x64/celld"));
    assert.equal(nativeCelldDigest(staged), target.sha256);
    assert.ok((fs.statSync(staged).mode & 0o111) !== 0);
    // Other bytes, another architecture, or an unpublished target are refused.
    fs.writeFileSync(source, elf(62, "tampered"));
    assert.throws(() => assertNativeCelldBinary(source, target), /digest mismatch/u);
    fs.writeFileSync(source, elf(183));
    assert.throws(() => assertNativeCelldBinary(source, withTarget(elf(183))), /does not match linux-x64/u);
    assert.throws(
      () => assertNativeCelldBinary(source, { ...target, sha256: null }),
      /No celld build is published/u
    );
    // Re-staging replaces the file with a new inode; a running holder keeps the old bytes.
    fs.writeFileSync(source, good);
    const holder = path.join(root, "holder");
    fs.linkSync(staged, holder);
    stageNativeCelld(source, root, target);
    assert.notEqual(fs.statSync(holder).ino, fs.statSync(staged).ino);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("stages a CI receipt only for the commit and digest the application pins", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-celld-ci-"));
  try {
    const downloaded = path.join(root, "download");
    fs.mkdirSync(downloaded);
    const binary = elf(62);
    const target = withTarget(binary);
    const commit = "a".repeat(40);
    const manifest = { fork: { commit }, targets: [target] };
    const receiptPath = path.join(downloaded, "target.json");
    const writeReceipt = (receipt) => fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    fs.writeFileSync(path.join(downloaded, target.binary), binary);
    fs.writeFileSync(path.join(downloaded, "LICENSE"), "license");
    fs.writeFileSync(path.join(downloaded, "NOTICE"), "notice");
    writeReceipt({ ...target, commit: "b".repeat(40) });
    assert.throws(() => stageNativeCelldCiArtifact(downloaded, root, manifest, target), /pinned/u);
    writeReceipt({ ...target, commit });
    const staged = stageNativeCelldCiArtifact(downloaded, root, manifest, target);
    assert.equal(staged, path.join(root, nativeCelldArtifact(target)));
    assert.equal(nativeCelldDigest(staged), target.sha256);
    assert.equal(nativeCelldDigest(path.join(root, "native/celld/artifacts/linux-x64/celld")), target.sha256);
    assert.equal(fs.readFileSync(path.join(path.dirname(staged), "NOTICE"), "utf8"), "notice");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
