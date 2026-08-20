import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blobCasPath,
  ensureBlobCasLayout,
  linkBlobFile,
  putBlobBytes,
  putBlobBytesSync,
  verifyBlob,
} from "./blobCas.js";

describe("blobCas", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-blob-cas-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it("syncs source bytes before linking and the target directory after linking", async () => {
    ensureBlobCasLayout(rootDir);
    const probePath = path.join(rootDir, "tmp", "file-handle-probe");
    const probe = await fsp.open(probePath, "wx");
    const fileHandlePrototype = Object.getPrototypeOf(probe) as {
      sync: () => Promise<void>;
    };
    await probe.close();
    await fsp.unlink(probePath);

    const sync = vi.spyOn(fileHandlePrototype, "sync");
    const link = vi.spyOn(fsp, "link");
    await putBlobBytes(rootDir, Buffer.from("durable content", "utf8"));

    const linkOrder = link.mock.invocationCallOrder[0];
    expect(linkOrder).toBeDefined();
    expect(sync.mock.invocationCallOrder.some((order) => order < linkOrder!)).toBe(true);
    expect(sync.mock.invocationCallOrder.some((order) => order > linkOrder!)).toBe(true);
  });

  it("applies the same durable publication protocol to already-hashed files", async () => {
    ensureBlobCasLayout(rootDir);
    const sourcePath = path.join(rootDir, "tmp", "streamed-source");
    const bytes = Buffer.from("streamed durable content", "utf8");
    const digest = createHash("sha256").update(bytes).digest("hex");
    await fsp.writeFile(sourcePath, bytes);

    await expect(linkBlobFile(rootDir, digest, sourcePath)).resolves.toBe(
      blobCasPath(rootDir, digest)
    );
    await expect(fsp.readFile(blobCasPath(rootDir, digest))).resolves.toEqual(bytes);
  });

  it("keeps the synchronous writer idempotent and verifiable", async () => {
    const bytes = Buffer.from("synchronous durable content", "utf8");
    const first = putBlobBytesSync(rootDir, bytes);
    const second = putBlobBytesSync(rootDir, bytes);

    expect(second).toEqual(first);
    await expect(verifyBlob(rootDir, first.digest)).resolves.toBe(true);
    await expect(fsp.readdir(path.join(rootDir, "tmp"))).resolves.toEqual([]);
  });

  it("fails closed for malformed existing objects and verifies bytes against their address", async () => {
    const bytes = Buffer.from("integrity", "utf8");
    const stored = await putBlobBytes(rootDir, bytes);
    const objectPath = blobCasPath(rootDir, stored.digest);
    await expect(verifyBlob(rootDir, stored.digest)).resolves.toBe(true);

    await fsp.writeFile(objectPath, Buffer.from("x", "utf8"));
    await expect(putBlobBytes(rootDir, bytes)).rejects.toThrow(/CAS object size mismatch/);

    await fsp.writeFile(objectPath, Buffer.from("corrupt!!", "utf8"));
    await expect(putBlobBytes(rootDir, bytes)).rejects.toThrow(/CAS object digest mismatch/);
    await expect(verifyBlob(rootDir, stored.digest)).rejects.toThrow(/CAS object digest mismatch/);

    await fsp.unlink(objectPath);
    await expect(verifyBlob(rootDir, stored.digest)).resolves.toBe(false);
  });
});
