import { describe, expect, it } from "vitest";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { blobPath, getBytes, putBytes, sweepUnreachableBlobs } from "./blobstoreService.js";

describe("sweepUnreachableBlobs", () => {
  it("sweeps only old unreachable objects from the workspace CAS", async () => {
    const blobsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "semantic-gc-"));
    try {
      const kept = await putBytes(blobsDir, Buffer.from("kept"));
      const swept = await putBytes(blobsDir, Buffer.from("swept"));
      const result = await sweepUnreachableBlobs(blobsDir, new Set([kept.digest]), 0);
      expect(result).toMatchObject({ scanned: 2, swept: 1 });
      await expect(getBytes(blobsDir, kept.digest)).resolves.toEqual(Buffer.from("kept"));
      await expect(getBytes(blobsDir, swept.digest)).resolves.toBeNull();
    } finally {
      await fsp.rm(blobsDir, { recursive: true, force: true });
    }
  });

  it("keeps a recently linked namespace entry whose immutable bytes have an old mtime", async () => {
    const blobsDir = await fsp.mkdtemp(path.join(os.tmpdir(), "semantic-gc-hardlink-age-"));
    try {
      const linked = await putBytes(blobsDir, Buffer.from("shared immutable bytes"));
      const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000);
      await fsp.utimes(blobPath(blobsDir, linked.digest), old, old);

      const result = await sweepUnreachableBlobs(blobsDir, new Set(), 60_000, Date.now());

      expect(result).toMatchObject({ scanned: 1, swept: 0 });
      await expect(getBytes(blobsDir, linked.digest)).resolves.toEqual(
        Buffer.from("shared immutable bytes")
      );
    } finally {
      await fsp.rm(blobsDir, { recursive: true, force: true });
    }
  });
});
