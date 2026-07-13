import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AssetDiskCache, type FetchedResponse } from "./assetDiskCache.js";

function streamOf(bytes: Uint8Array | string): ReadableStream<Uint8Array> {
  const buf = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(buf);
      controller.close();
    },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function immutableResponse(body: string, over: Partial<FetchedResponse> = {}): FetchedResponse {
  return {
    status: 200,
    statusText: "OK",
    gzip: false,
    contentType: "text/javascript; charset=utf-8",
    replayHeaders: { "cache-control": "public, max-age=31536000, immutable" },
    cacheable: true,
    body: streamOf(body),
    ...over,
  };
}

describe("AssetDiskCache", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "asset-cache-test-"));
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  async function newCache(maxBytes?: number): Promise<AssetDiskCache> {
    const cache = new AssetDiskCache({ dir, maxBytes });
    await cache.init();
    return cache;
  }

  it("serves a miss then a hit without a second fetch (zero pipe bytes)", async () => {
    const cache = await newCache();
    const fetcher = vi.fn(async () => immutableResponse("console.log(1)"));

    const first = await cache.serve("/assets/app-abc.js", fetcher);
    expect(first.kind).toBe("passthrough");
    if (first.kind === "passthrough") {
      expect((await readStream(first.response.body!)).toString()).toBe("console.log(1)");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Second request: served from disk, fetcher NOT called again.
    const second = await cache.serve("/assets/app-abc.js", fetcher);
    expect(second.kind).toBe("asset");
    if (second.kind === "asset") {
      expect(second.asset.body.toString()).toBe("console.log(1)");
      expect(second.asset.contentType).toBe("text/javascript; charset=utf-8");
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("streams the first immutable miss before cache population finishes", async () => {
    const cache = await newCache();
    let sourceController!: ReadableStreamDefaultController<Uint8Array>;
    const fetcher = vi.fn(async () =>
      immutableResponse("unused", {
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            sourceController = controller;
          },
        }),
      })
    );

    const first = await cache.serve("/assets/streaming-abc.js", fetcher);
    expect(first.kind).toBe("passthrough");
    if (first.kind !== "passthrough") return;

    const reader = first.response.body!.getReader();
    sourceController.enqueue(Buffer.from("first "));
    const head = await reader.read();
    expect(Buffer.from(head.value!).toString()).toBe("first ");
    expect(head.done).toBe(false);

    sourceController.enqueue(Buffer.from("response"));
    sourceController.close();
    const tail = await reader.read();
    expect(Buffer.from(tail.value!).toString()).toBe("response");
    expect((await reader.read()).done).toBe(true);

    const hit = await cache.serve("/assets/streaming-abc.js", fetcher);
    expect(hit.kind).toBe("asset");
    if (hit.kind === "asset") expect(hit.asset.body.toString()).toBe("first response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("caches ONLY immutable-cacheable responses (no-store passes through, refetches)", async () => {
    const cache = await newCache();
    const fetcher = vi.fn(async () =>
      immutableResponse("<html>", {
        cacheable: false,
        contentType: "text/html; charset=utf-8",
        replayHeaders: { "cache-control": "no-store" },
      })
    );

    const first = await cache.serve("/apps/shell/", fetcher);
    expect(first.kind).toBe("passthrough");
    expect(cache.indexSize).toBe(0);

    // Not cached → a second request fetches again.
    await cache.serve("/apps/shell/", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("persists across instances (index + blobs survive a reopen)", async () => {
    const cache = await newCache();
    const first = await cache.serve(
      "/assets/x-1.js",
      vi.fn(async () => immutableResponse("A"))
    );
    if (first.kind === "passthrough") await readStream(first.response.body!);
    await cache.serve(
      "/assets/x-1.js",
      vi.fn(async () => immutableResponse("unexpected"))
    );

    const reopened = await newCache();
    const fetcher = vi.fn(async () => immutableResponse("A"));
    const hit = await reopened.serve("/assets/x-1.js", fetcher);
    expect(hit.kind).toBe("asset");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("derives blob filenames from bytes, not advisory upstream digests", async () => {
    const cache = await newCache();
    const siblingSidecar = `${dir}.json`;
    try {
      const first = await cache.serve(
        "/assets/unsafe.js",
        vi.fn(async () => immutableResponse("safe bytes", { digest: ".." }))
      );
      if (first.kind === "passthrough") await readStream(first.response.body!);
      await cache.serve(
        "/assets/unsafe.js",
        vi.fn(async () => immutableResponse("unexpected"))
      );

      const digest = cache.digestFor("/assets/unsafe.js");
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.existsSync(siblingSidecar)).toBe(false);
      expect(fs.existsSync(path.join(dir, "blobs", digest!))).toBe(true);
      expect(await fsp.readFile(path.join(dir, "blobs", digest!), "utf8")).toBe("safe bytes");
    } finally {
      await fsp.rm(siblingSidecar, { force: true });
    }
  });

  it("keeps response metadata per cache key when bodies share a digest", async () => {
    const cache = await newCache();
    const firstA = await cache.serve(
      "/assets/shared-a.js",
      vi.fn(async () =>
        immutableResponse("same bytes", {
          contentType: "text/javascript; charset=utf-8",
          gzip: false,
          replayHeaders: { "x-asset": "a" },
        })
      )
    );
    if (firstA.kind === "passthrough") await readStream(firstA.response.body!);
    await cache.serve(
      "/assets/shared-a.js",
      vi.fn(async () => immutableResponse("unexpected"))
    );
    const firstB = await cache.serve(
      "/assets/shared-b.css",
      vi.fn(async () =>
        immutableResponse("same bytes", {
          contentType: "text/css; charset=utf-8",
          gzip: true,
          replayHeaders: { "x-asset": "b" },
        })
      )
    );
    if (firstB.kind === "passthrough") await readStream(firstB.response.body!);
    await cache.serve(
      "/assets/shared-b.css",
      vi.fn(async () => immutableResponse("unexpected"))
    );

    expect(cache.digestFor("/assets/shared-a.js")).toBe(cache.digestFor("/assets/shared-b.css"));

    const fetchA = vi.fn(async () => immutableResponse("refetch-a"));
    const fetchB = vi.fn(async () => immutableResponse("refetch-b"));
    const hitA = await cache.serve("/assets/shared-a.js", fetchA);
    const hitB = await cache.serve("/assets/shared-b.css", fetchB);

    expect(fetchA).not.toHaveBeenCalled();
    expect(fetchB).not.toHaveBeenCalled();
    expect(hitA.kind).toBe("asset");
    expect(hitB.kind).toBe("asset");
    if (hitA.kind === "asset" && hitB.kind === "asset") {
      expect(hitA.asset.contentType).toBe("text/javascript; charset=utf-8");
      expect(hitA.asset.gzip).toBe(false);
      expect(hitA.asset.replayHeaders).toEqual({ "x-asset": "a" });
      expect(hitB.asset.contentType).toBe("text/css; charset=utf-8");
      expect(hitB.asset.gzip).toBe(true);
      expect(hitB.asset.replayHeaders).toEqual({ "x-asset": "b" });
    }
  });

  it("single-flights concurrent misses for the same path into one fetch", async () => {
    const cache = await newCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetcher = vi.fn(async () => {
      await gate;
      return immutableResponse("shared");
    });

    const a = cache.serve("/assets/one-abc.js", fetcher);
    const b = cache.serve("/assets/one-abc.js", fetcher);
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([ra.kind, rb.kind].sort()).toEqual(["asset", "passthrough"]);
    if (ra.kind === "passthrough") {
      expect((await readStream(ra.response.body!)).toString()).toBe("shared");
    } else if (rb.kind === "passthrough") {
      expect((await readStream(rb.response.body!)).toString()).toBe("shared");
    } else {
      throw new Error("expected one concurrent caller to receive the live response");
    }
  });

  it("handles concurrent same-digest writes for different cache keys", async () => {
    const cache = await newCache();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchA = vi.fn(async () => {
      await gate;
      return immutableResponse("shared-concurrent", { contentType: "text/plain; a" });
    });
    const fetchB = vi.fn(async () => {
      await gate;
      return immutableResponse("shared-concurrent", { contentType: "text/plain; b" });
    });

    const a = cache.serve("/assets/concurrent-a.txt", fetchA);
    const b = cache.serve("/assets/concurrent-b.txt", fetchB);
    release();
    const [ra, rb] = await Promise.all([a, b]);

    expect(fetchA).toHaveBeenCalledTimes(1);
    expect(fetchB).toHaveBeenCalledTimes(1);
    expect(ra.kind).toBe("passthrough");
    expect(rb.kind).toBe("passthrough");
    if (ra.kind === "passthrough") await readStream(ra.response.body!);
    if (rb.kind === "passthrough") await readStream(rb.response.body!);
    const hitA = await cache.serve(
      "/assets/concurrent-a.txt",
      vi.fn(async () => immutableResponse("unexpected"))
    );
    const hitB = await cache.serve(
      "/assets/concurrent-b.txt",
      vi.fn(async () => immutableResponse("unexpected"))
    );
    expect(cache.digestFor("/assets/concurrent-a.txt")).toBe(
      cache.digestFor("/assets/concurrent-b.txt")
    );
    const blobNames = (await fsp.readdir(path.join(dir, "blobs"))).filter((name) =>
      /^[a-f0-9]{64}$/.test(name)
    );
    expect(blobNames).toHaveLength(1);
    if (hitA.kind === "asset" && hitB.kind === "asset") {
      expect(hitA.asset.contentType).toBe("text/plain; a");
      expect(hitB.asset.contentType).toBe("text/plain; b");
    }
  });

  it("rewrites the index for a path when its content digest changes", async () => {
    const cache = await newCache();
    const first = await cache.serve(
      "/assets/rev.js",
      vi.fn(async () => immutableResponse("v1"))
    );
    if (first.kind === "passthrough") await readStream(first.response.body!);
    await cache.serve(
      "/assets/rev.js",
      vi.fn(async () => immutableResponse("unexpected"))
    );
    const digest1 = cache.digestFor("/assets/rev.js");
    expect(digest1).toBeTruthy();

    // Simulate the blob being evicted so the next request is a genuine miss, and
    // the new build serves different bytes → a new digest → index rewrite.
    await fsp.rm(path.join(dir, "asset-cache-nonexistent"), { force: true });
    await fsp.rm(path.join(dir, "blobs", digest1!), { force: true });

    const fetcher = vi.fn(async () => immutableResponse("v2-longer-bytes"));
    const out = await cache.serve("/assets/rev.js", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(out.kind).toBe("passthrough");
    if (out.kind === "passthrough") {
      expect((await readStream(out.response.body!)).toString()).toBe("v2-longer-bytes");
    }
    await cache.serve("/assets/rev.js", fetcher);

    const digest2 = cache.digestFor("/assets/rev.js");
    expect(digest2).toBeTruthy();
    expect(digest2).not.toBe(digest1);
    // Old digest blob is gone; new one exists.
    expect(fs.existsSync(path.join(dir, "blobs", digest1!))).toBe(false);
    expect(fs.existsSync(path.join(dir, "blobs", digest2!))).toBe(true);
  });

  it("passes through oversized immutable responses without caching them", async () => {
    const cache = await newCache(100);
    const fetcher = vi.fn(async () => immutableResponse("x".repeat(500)));

    const first = await cache.serve("/assets/big-abc.js", fetcher);
    expect(first.kind).toBe("passthrough");
    if (first.kind === "passthrough") {
      expect((await readStream(first.response.body!)).toString()).toBe("x".repeat(500));
    }
    expect(cache.digestFor("/assets/big-abc.js")).toBeUndefined();

    const second = await cache.serve("/assets/big-abc.js", fetcher);
    expect(second.kind).toBe("passthrough");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("prunes oldest-by-mtime blobs when over the size cap", async () => {
    // Cap holds ~2 of the 100-byte blobs. Distinct content per path → distinct
    // digests → distinct blobs (identical content would content-address to one).
    const cache = await newCache(250);

    const firstA = await cache.serve(
      "/assets/a-1.js",
      vi.fn(async () => immutableResponse("a".repeat(100)))
    );
    if (firstA.kind === "passthrough") await readStream(firstA.response.body!);
    await cache.serve(
      "/assets/a-1.js",
      vi.fn(async () => immutableResponse("unexpected"))
    );
    await new Promise((r) => setTimeout(r, 15));
    const firstB = await cache.serve(
      "/assets/b-2.js",
      vi.fn(async () => immutableResponse("b".repeat(100)))
    );
    if (firstB.kind === "passthrough") await readStream(firstB.response.body!);
    await cache.serve(
      "/assets/b-2.js",
      vi.fn(async () => immutableResponse("unexpected"))
    );
    await new Promise((r) => setTimeout(r, 15));
    const firstC = await cache.serve(
      "/assets/c-3.js",
      vi.fn(async () => immutableResponse("c".repeat(100)))
    );
    if (firstC.kind === "passthrough") await readStream(firstC.response.body!);
    await cache.serve(
      "/assets/c-3.js",
      vi.fn(async () => immutableResponse("unexpected"))
    );

    // Total 300 > 250 → the oldest (a) is evicted; its index entry is dropped.
    const digestA = cache.digestFor("/assets/a-1.js");
    expect(digestA).toBeUndefined();

    // c (newest) is still a hit — no refetch.
    const fetcher = vi.fn(async () => immutableResponse("c".repeat(100)));
    const hitC = await cache.serve("/assets/c-3.js", fetcher);
    expect(hitC.kind).toBe("asset");
    expect(fetcher).not.toHaveBeenCalled();

    // a is a miss now → refetch.
    const refetchedA = await cache.serve("/assets/a-1.js", fetcher);
    if (refetchedA.kind === "passthrough") await readStream(refetchedA.response.body!);
    await cache.serve("/assets/a-1.js", fetcher);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
