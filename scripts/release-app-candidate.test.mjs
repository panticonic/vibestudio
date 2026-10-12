import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createReleaseAppProvenance,
  verifyReleaseAppProvenance,
} from "./release-app-candidate.mjs";
import { AFTER_PACK_COMPLETION_FORMAT } from "./lib/after-pack-completion.mjs";

test("macOS candidate provenance binds the archive, afterPack receipt, version, and source", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "macos-release-candidate-"));
  try {
    const archivePath = path.join(root, "packaged-app.zip");
    const receiptPath = path.join(root, "after-pack.json");
    const provenancePath = path.join(root, "provenance.json");
    const packagePath = path.join(root, "package.json");
    const sourceSha = "0123456789abcdef0123456789abcdef01234567";
    fs.writeFileSync(archivePath, "exact signed app archive");
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        format: AFTER_PACK_COMPLETION_FORMAT,
        platform: "darwin",
        arch: 3,
        appOutDir: "mac-arm64",
      })
    );
    fs.writeFileSync(packagePath, JSON.stringify({ version: "1.2.3" }));

    const manifest = await createReleaseAppProvenance({
      archivePath,
      receiptPath,
      packagePath,
      releaseTag: "v1.2.3",
      sourceSha,
      signingMode: "developer-id",
    });
    fs.writeFileSync(provenancePath, JSON.stringify(manifest));

    assert.equal(
      (
        await verifyReleaseAppProvenance({
          archivePath,
          provenancePath,
          packagePath,
          releaseTag: "v1.2.3",
          sourceSha,
        })
      ).sourceSha,
      sourceSha
    );
    fs.writeFileSync(archivePath, "different archive");
    await assert.rejects(
      () =>
        verifyReleaseAppProvenance({
          archivePath,
          provenancePath,
          packagePath,
          releaseTag: "v1.2.3",
          sourceSha,
        }),
      /provenance does not match/u
    );
    fs.writeFileSync(
      receiptPath,
      JSON.stringify({
        format: AFTER_PACK_COMPLETION_FORMAT,
        platform: "darwin",
        arch: 1,
        appOutDir: "mac-arm64",
      })
    );
    await assert.rejects(
      () =>
        createReleaseAppProvenance({
          archivePath,
          receiptPath,
          packagePath,
          releaseTag: "v1.2.3",
          sourceSha,
          signingMode: "developer-id",
        }),
      /invalid afterPack completion receipt/u
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
