import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobCasPath } from "../storage/blobCas.js";
import { collectArtifactPool, writePooledArtifact } from "./buildArtifactPool.js";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "artifact-pool-"));
  roots.push(root);
  return { root, pool: path.join(root, "pool"), bytes: Buffer.from("immutable build bytes") };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await fs.promises.rm(root, { recursive: true, force: true });
});

describe("build artifact pool ownership", () => {
  it("collects only pool-only payloads and preserves independently owned builds", async () => {
    const { root, pool, bytes } = fixture();
    const a = path.join(root, "build-a", "bundle.js");
    const b = path.join(root, "build-b", "bundle.js");
    await writePooledArtifact(pool, a, bytes);
    await writePooledArtifact(pool, b, bytes);
    if (process.platform === "win32") {
      expect(await fs.promises.readFile(b)).toEqual(bytes);
      return;
    }
    expect((await fs.promises.stat(a)).ino).toBe((await fs.promises.stat(b)).ino);
    expect((await collectArtifactPool(pool)).removedFiles).toBe(0);
    await fs.promises.unlink(a);
    expect((await collectArtifactPool(pool)).removedFiles).toBe(0);
    await fs.promises.unlink(b);
    const dry = await collectArtifactPool(pool, { dryRun: true });
    expect(dry.reclaimableFiles).toBe(1);
    expect(dry.removedFiles).toBe(0);
    expect((await collectArtifactPool(pool)).removedFiles).toBe(1);
    await writePooledArtifact(pool, a, bytes);
    expect(await fs.promises.readFile(a)).toEqual(bytes);
  });

  it("publishes complete build files while a collector removes the pool name", async () => {
    if (process.platform === "win32") return;
    const { root, pool, bytes } = fixture();
    const first = path.join(root, "a.js");
    const second = path.join(root, "b.js");
    await writePooledArtifact(pool, first, bytes);
    await fs.promises.unlink(first);
    const pooled = blobCasPath(pool, createHash("sha256").update(bytes).digest("hex"));
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, "link").mockImplementationOnce(async (source, target) => {
      expect(source).toBe(pooled);
      await collectArtifactPool(pool);
      return link(source, target);
    });
    await writePooledArtifact(pool, second, bytes);
    expect(await fs.promises.readFile(second)).toEqual(bytes);
    expect((await collectArtifactPool(pool)).removedFiles).toBe(0);
  });

  it("keeps the build inode if collection races after its new hardlink", async () => {
    if (process.platform === "win32") return;
    const { root, pool, bytes } = fixture();
    const first = path.join(root, "a.js");
    const second = path.join(root, "b.js");
    await writePooledArtifact(pool, first, bytes);
    await fs.promises.unlink(first);
    const unlink = fs.promises.unlink.bind(fs.promises);
    vi.spyOn(fs.promises, "unlink").mockImplementationOnce(async (stored) => {
      await writePooledArtifact(pool, second, bytes);
      return unlink(stored);
    });
    await collectArtifactPool(pool);
    expect(await fs.promises.readFile(second)).toEqual(bytes);
  });

  it("keeps a completed build when its first pool insertion cannot share files", async () => {
    if (process.platform === "win32") return;
    const { root, pool, bytes } = fixture();
    const target = path.join(root, "build.js");
    const link = fs.promises.link.bind(fs.promises);
    vi.spyOn(fs.promises, "link").mockImplementation(async (source, destination) => {
      if (source === target) throw Object.assign(new Error("cross-device link"), { code: "EXDEV" });
      return link(source, destination);
    });
    await writePooledArtifact(pool, target, bytes);
    expect(await fs.promises.readFile(target)).toEqual(bytes);
    expect((await collectArtifactPool(pool)).files).toBe(0);
  });

  it("refuses corrupt pooled bytes without overwriting them", async () => {
    if (process.platform === "win32") return;
    const { root, pool, bytes } = fixture();
    const pooled = blobCasPath(pool, createHash("sha256").update(bytes).digest("hex"));
    await fs.promises.mkdir(path.dirname(pooled), { recursive: true });
    await fs.promises.writeFile(pooled, "corrupt");
    await expect(writePooledArtifact(pool, path.join(root, "build.js"), bytes)).rejects.toThrow(
      "integrity mismatch"
    );
    expect(await fs.promises.readFile(pooled, "utf8")).toBe("corrupt");
  });
});
