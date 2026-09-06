import { createHash } from "node:crypto";
import { promises as fsp } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  blobCasPath,
  ensureBlobCasLayout,
  linkBlobFile,
  linkReconstructableBlobFile,
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

  it("flushes bytes before publication and flushes the directory where supported", async () => {
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
    // Windows FlushFileBuffers supports writable files, not directory handles.
    expect(sync.mock.invocationCallOrder.some((order) => order > linkOrder!)).toBe(
      process.platform !== "win32"
    );
  });

  it("publishes readonly reconstructable content without a writable flush handle", async () => {
    const bytes = Buffer.from("immutable reconstructable content");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const source = path.join(rootDir, "readonly-source");
    await fsp.writeFile(source, bytes);
    await fsp.chmod(source, 0o444);
    const open = vi.spyOn(fsp, "open");
    const target = await linkReconstructableBlobFile(rootDir, digest, source, bytes.length);
    expect(await fsp.readFile(target)).toEqual(bytes);
    expect((await fsp.stat(source)).mode & 0o222).toBe(0);
    expect(open).not.toHaveBeenCalled();
  });

  it("rejects a same-size corrupt reconstructable destination that wins publication", async () => {
    const bytes = Buffer.from("valid");
    const digest = createHash("sha256").update(bytes).digest("hex");
    const source = path.join(rootDir, "source");
    await fsp.writeFile(source, bytes);
    const destination = blobCasPath(rootDir, digest);
    const link = fsp.link.bind(fsp);
    vi.spyOn(fsp, "link").mockImplementationOnce(async (from, to) => {
      await fsp.writeFile(to, "wrong");
      await link(from, to);
    });
    await expect(
      linkReconstructableBlobFile(rootDir, digest, source, bytes.length)
    ).rejects.toThrow("CAS object digest mismatch");
    expect(await fsp.readFile(destination, "utf8")).toBe("wrong");
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
