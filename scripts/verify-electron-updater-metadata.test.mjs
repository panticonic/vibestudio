import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { verifyElectronUpdaterMetadata } from "./verify-electron-updater-metadata.mjs";

async function fixture(names = ["Vibestudio-Setup-x64.exe"]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "updater-metadata-"));
  const artifacts = [];
  const files = [];
  for (const name of names) {
    const artifactPath = path.join(root, name);
    const bytes = Buffer.from(`artifact:${name}`);
    await fs.writeFile(artifactPath, bytes);
    artifacts.push(artifactPath);
    files.push({
      url: name,
      sha512: createHash("sha512").update(bytes).digest("base64"),
      size: bytes.length,
    });
  }
  const metadataPath = path.join(root, names.length === 1 ? "latest.yml" : "latest-mac.yml");
  const metadata = {
    version: "1.2.3",
    files,
    path: names[0],
    sha512: files[0].sha512,
  };
  const write = () => fs.writeFile(metadataPath, stringify(metadata));
  await write();
  return { root, artifacts, metadataPath, metadata, write };
}

async function withFixture(names, run) {
  const value = await fixture(names);
  try {
    await run(value);
  } finally {
    await fs.rm(value.root, { recursive: true, force: true });
  }
}

test("accepts Windows and macOS metadata bound to the exact release artifacts", async () => {
  for (const names of [
    ["Vibestudio-Setup-x64.exe"],
    ["Vibestudio-1.2.3-arm64-mac.zip", "Vibestudio-arm64.dmg"],
  ]) {
    await withFixture(names, async ({ metadataPath, artifacts }) => {
      const result = await verifyElectronUpdaterMetadata({
        metadataPath,
        expectedVersion: "v1.2.3",
        artifactPaths: artifacts,
      });
      assert.equal(result.version, "1.2.3");
      assert.deepEqual(result.artifacts, [...names].sort());
    });
  }
});

test("rejects a manifest for another release", async () => {
  await withFixture(undefined, async ({ metadataPath, artifacts }) => {
    await assert.rejects(
      verifyElectronUpdaterMetadata({
        metadataPath,
        expectedVersion: "1.2.4",
        artifactPaths: artifacts,
      }),
      /version .* does not match/u
    );
  });
});

test("rejects missing, extra, duplicate, and non-local artifact references", async () => {
  for (const mutate of [
    (value) => value.metadata.files.pop(),
    (value) => value.metadata.files.push({ ...value.metadata.files[0], url: "missing.exe" }),
    (value) => value.metadata.files.push({ ...value.metadata.files[0] }),
    (value) => (value.metadata.files[0].url = "subdirectory/Vibestudio-Setup-x64.exe"),
  ]) {
    await withFixture(undefined, async (value) => {
      mutate(value);
      await value.write();
      await assert.rejects(
        verifyElectronUpdaterMetadata({
          metadataPath: value.metadataPath,
          expectedVersion: "1.2.3",
          artifactPaths: value.artifacts,
        })
      );
    });
  }
});

test("rejects size, file digest, and primary digest mismatches", async () => {
  for (const mutate of [
    (value) => (value.metadata.files[0].size += 1),
    (value) => (value.metadata.files[0].sha512 = Buffer.alloc(64, 1).toString("base64")),
    (value) => (value.metadata.sha512 = Buffer.alloc(64, 2).toString("base64")),
  ]) {
    await withFixture(undefined, async (value) => {
      mutate(value);
      await value.write();
      await assert.rejects(
        verifyElectronUpdaterMetadata({
          metadataPath: value.metadataPath,
          expectedVersion: "1.2.3",
          artifactPaths: value.artifacts,
        }),
        /size|SHA-512/u
      );
    });
  }
});

test("rejects a published artifact omitted from the manifest", async () => {
  await withFixture(["Vibestudio-1.2.3-arm64-mac.zip", "Vibestudio-arm64.dmg"], async (value) => {
    value.metadata.files.pop();
    await value.write();
    await assert.rejects(
      verifyElectronUpdaterMetadata({
        metadataPath: value.metadataPath,
        expectedVersion: "1.2.3",
        artifactPaths: value.artifacts,
      }),
      /unreferenced/u
    );
  });
});

test("publication revalidates exact metadata and artifact bytes from the candidate receipt", async () => {
  await withFixture(undefined, async (value) => {
    const receiptPath = path.join(value.root, "updater-metadata-windows.json");
    await verifyElectronUpdaterMetadata({
      metadataPath: value.metadataPath,
      expectedVersion: "1.2.3",
      artifactPaths: value.artifacts,
      writeReceiptPath: receiptPath,
    });
    await verifyElectronUpdaterMetadata({
      metadataPath: value.metadataPath,
      expectedVersion: "v1.2.3",
      artifactPaths: value.artifacts,
      receiptPath,
    });

    await fs.appendFile(value.metadataPath, "# changed after candidate verification\n");
    await assert.rejects(
      verifyElectronUpdaterMetadata({
        metadataPath: value.metadataPath,
        expectedVersion: "1.2.3",
        artifactPaths: value.artifacts,
        receiptPath,
      }),
      /metadata bytes differ/u
    );
  });
});

test("publication rejects artifact replacement after candidate verification", async () => {
  await withFixture(undefined, async (value) => {
    const receiptPath = path.join(value.root, "updater-metadata-windows.json");
    await verifyElectronUpdaterMetadata({
      metadataPath: value.metadataPath,
      expectedVersion: "1.2.3",
      artifactPaths: value.artifacts,
      writeReceiptPath: receiptPath,
    });
    await fs.writeFile(value.artifacts[0], "replacement with different bytes");
    await assert.rejects(
      verifyElectronUpdaterMetadata({
        metadataPath: value.metadataPath,
        expectedVersion: "1.2.3",
        artifactPaths: value.artifacts,
        receiptPath,
      }),
      /size differs|SHA-512 differs/u
    );
  });
});
