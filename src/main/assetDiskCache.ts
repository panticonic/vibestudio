/**
 * assetDiskCache — content-addressed on-disk cache for the desktop panel-asset
 * façade (WebRTC RPC v2, plan §6).
 *
 * Panel bundles are digest-addressed immutable artifacts: the gateway marks them
 * `Cache-Control: public, max-age=31536000, immutable`, and their cache key (the
 * façade's URL path plus any request dimensions it forwards upstream) never
 * changes content without changing the key.
 * That lets the façade skip the pipe entirely for a repeat request:
 *
 *   request cache key ──index──► content digest ──blob──► bytes on disk (zero pipe bytes)
 *
 * Storage layout under `dir`:
 *   index.json           { "<cache key>": { digest, metadataKey }, ... }
 *   blobs/<digest>       raw body bytes (as received over the pipe)
 *   metadata/<key>.json  sidecar: { status, statusText, gzip, contentType, replayHeaders, size }
 *
 * Digest source: the cache hashes the body (sha-256) on first receipt — a
 * digest-on-write cache. A server-supplied `x-vibestudio-content-digest` header is
 * treated only as advisory metadata; filenames are always derived from the
 * actual bytes. Because artifacts are immutable, a changed
 * build changes the bytes → a new digest → the index entry for that path is
 * rewritten on the next fetch. Stale blobs age out via the LRU cap.
 *
 * Only responses the façade flags `cacheable` (immutable marker + 200) are
 * persisted; `no-store` HTML entry documents are never cached. Concurrent misses
 * for the same path are single-flighted so two webview requests trigger one pipe
 * fetch. Size-capped (default 1 GiB), LRU by blob mtime, pruned on write.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB

class CachePopulationTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`cacheable asset exceeded cache byte budget (${maxBytes} bytes)`);
    this.name = "CachePopulationTooLargeError";
  }
}

/**
 * A normalized upstream response, produced by the façade from the pipe Response.
 * The cache is transport/HTTP-agnostic: the façade decides `cacheable`, `gzip`,
 * `contentType`, and which `replayHeaders` to keep; the cache only stores/serves.
 */
export interface FetchedResponse {
  status: number;
  statusText: string;
  /** Body bytes are gzip-encoded → replay `Content-Encoding: gzip` to the webview. */
  gzip: boolean;
  contentType: string;
  /** Extra response headers to replay (hop headers already stripped). */
  replayHeaders: Record<string, string>;
  /** Upstream marked this immutable-cacheable (immutable Cache-Control + 200). */
  cacheable: boolean;
  /** Optional server-supplied content digest; advisory only. */
  digest?: string;
  body: ReadableStream<Uint8Array> | null;
}

/** A fully-buffered asset ready to write to the webview response in one shot. */
export interface ServedAsset {
  status: number;
  statusText: string;
  gzip: boolean;
  contentType: string;
  replayHeaders: Record<string, string>;
  body: Buffer;
}

export type ServeOutcome =
  /** Served from disk hit or freshly persisted (buffered). */
  | { kind: "asset"; asset: ServedAsset }
  /** Uncacheable upstream — stream `response.body` straight through, do not cache. */
  | { kind: "passthrough"; response: FetchedResponse };

interface Sidecar {
  status: number;
  statusText: string;
  gzip: boolean;
  contentType: string;
  replayHeaders: Record<string, string>;
  size: number;
}

const CONTENT_DIGEST = /^[a-f0-9]{64}$/;

interface IndexEntry {
  digest: string;
  metadataKey: string;
}

export class AssetDiskCache {
  private readonly dir: string;
  private readonly blobsDir: string;
  private readonly metadataDir: string;
  private readonly indexPath: string;
  private readonly maxBytes: number;
  /** path → content digest + per-path metadata key */
  private readonly index = new Map<string, IndexEntry>();
  /** Single-flight: path → in-flight population (resolves to the persisted asset, or null if uncacheable). */
  private readonly inflight = new Map<string, Promise<ServedAsset | null>>();
  /** Serializes index writes + prune so concurrent persists don't clobber index.json. */
  private writeChain: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(opts: { dir: string; maxBytes?: number }) {
    this.dir = opts.dir;
    this.blobsDir = path.join(opts.dir, "blobs");
    this.metadataDir = path.join(opts.dir, "metadata");
    this.indexPath = path.join(opts.dir, "index.json");
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async init(): Promise<void> {
    await Promise.all([
      fsp.mkdir(this.blobsDir, { recursive: true }),
      fsp.mkdir(this.metadataDir, { recursive: true }),
    ]);
    try {
      const raw = await fsp.readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        const entry = parseIndexEntry(v);
        if (entry) this.index.set(k, entry);
      }
    } catch {
      // No index yet (or corrupt) → start empty; blobs are re-derivable from the pipe.
    }
    this.ready = true;
  }

  /**
   * Serve `cacheKey`, fetching over the pipe only on a miss.
   *  - Disk hit (index → digest → blob) → `{kind:"asset"}`, `fetcher` NOT called.
   *  - Miss → single-flighted `fetcher()`. A cacheable body is teed so the first
   *    caller can stream immediately while hashing and persistence finish in the
   *    background. Otherwise the live response is streamed through untouched.
   */
  async serve(cacheKey: string, fetcher: () => Promise<FetchedResponse>): Promise<ServeOutcome> {
    if (!this.ready) throw new Error("AssetDiskCache.init() not called");

    // 1. Disk hit.
    const hit = await this.readByPath(cacheKey);
    if (hit) return { kind: "asset", asset: hit };

    // 2. Coalesce with an in-flight population for the same key.
    const existing = this.inflight.get(cacheKey);
    if (existing) {
      const asset = await existing;
      if (asset) return { kind: "asset", asset };
      // The owner's response was uncacheable — the cache can't help. Fetch our own
      // (rare: concurrent requests for a no-store path) and stream it through.
      return { kind: "passthrough", response: await fetcher() };
    }

    // 3. We own the population for this path.
    let settle!: (asset: ServedAsset | null) => void;
    const populated = new Promise<ServedAsset | null>((resolve) => {
      settle = resolve;
    });
    this.inflight.set(cacheKey, populated);
    try {
      const response = await fetcher();
      if (!response.cacheable || !response.body) {
        settle(null);
        this.inflight.delete(cacheKey);
        return { kind: "passthrough", response };
      }
      const [cacheBody, passthroughBody] = response.body.tee();
      const passthroughResponse: FetchedResponse = {
        ...response,
        cacheable: false,
        body: passthroughBody,
      };
      // Do not hold the renderer behind hashing, disk I/O, index persistence,
      // or pruning. Concurrent callers still join `populated` and receive the
      // completed cache entry once the background branch settles.
      void this.persist(cacheKey, { ...response, body: cacheBody })
        .then((asset) => settle(asset))
        .catch((err: unknown) => {
          if (err instanceof CachePopulationTooLargeError) {
            console.warn(`[AssetDiskCache] ${err.message}; serving ${cacheKey} without caching`);
          } else {
            console.warn(`[AssetDiskCache] Failed to cache ${cacheKey}:`, err);
          }
          settle(null);
        })
        .finally(() => {
          this.inflight.delete(cacheKey);
        });
      return { kind: "passthrough", response: passthroughResponse };
    } catch (err) {
      settle(null);
      this.inflight.delete(cacheKey);
      throw err;
    }
  }

  /** Current path→digest index size (test/observability helper). */
  get indexSize(): number {
    return this.index.size;
  }

  /** Digest currently mapped for a path, if any (test helper). */
  digestFor(cacheKey: string): string | undefined {
    return this.index.get(cacheKey)?.digest;
  }

  // -------------------------------------------------------------------------

  private async readByPath(cacheKey: string): Promise<ServedAsset | null> {
    const entry = this.index.get(cacheKey);
    if (!entry) return null;
    if (!CONTENT_DIGEST.test(entry.digest) || !CONTENT_DIGEST.test(entry.metadataKey)) {
      this.index.delete(cacheKey);
      console.warn(`[AssetDiskCache] dropping invalid index entry for ${cacheKey}`);
      return null;
    }
    const blobPath = path.join(this.blobsDir, entry.digest);
    const metadataPath = path.join(this.metadataDir, `${entry.metadataKey}.json`);
    let body: Buffer;
    let sidecar: Sidecar;
    try {
      [body, sidecar] = await Promise.all([
        fsp.readFile(blobPath),
        fsp.readFile(metadataPath, "utf-8").then((raw) => JSON.parse(raw) as Sidecar),
      ]);
    } catch {
      // Blob evicted or sidecar missing → treat as a miss; drop the dangling entry.
      this.index.delete(cacheKey);
      console.warn(
        `[AssetDiskCache] dropping dangling index entry for ${cacheKey} ` +
          `(digest=${entry.digest}, metadata=${entry.metadataKey})`
      );
      return null;
    }
    // LRU-by-access: bump the blob mtime so a hot asset survives prune (best effort).
    const now = new Date();
    void fsp.utimes(blobPath, now, now).catch(() => {});
    return {
      status: sidecar.status,
      statusText: sidecar.statusText,
      gzip: sidecar.gzip,
      contentType: sidecar.contentType,
      replayHeaders: sidecar.replayHeaders,
      body,
    };
  }

  private async persist(cacheKey: string, response: FetchedResponse): Promise<ServedAsset> {
    const body = await streamToBuffer(response.body!, this.maxBytes);
    const digest = createHash("sha256").update(body).digest("hex");
    const metadataKey = createHash("sha256").update(cacheKey).digest("hex");

    const blobPath = path.join(this.blobsDir, digest);
    const metadataPath = path.join(this.metadataDir, `${metadataKey}.json`);
    const sidecar: Sidecar = {
      status: response.status,
      statusText: response.statusText,
      gzip: response.gzip,
      contentType: response.contentType,
      replayHeaders: response.replayHeaders,
      size: body.length,
    };

    // Content-addressed: an existing blob with this digest already holds these bytes.
    await this.writeBlobIfAbsent(blobPath, body);
    await this.writeJsonAtomic(metadataPath, sidecar);

    this.index.set(cacheKey, { digest, metadataKey });
    await this.enqueueWrite(async () => {
      await this.writeIndex();
      await this.prune();
    });

    return {
      status: response.status,
      statusText: response.statusText,
      gzip: response.gzip,
      contentType: response.contentType,
      replayHeaders: response.replayHeaders,
      body,
    };
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task, task);
    // Keep the chain alive even if a task throws (swallow into the chain, surface via next).
    this.writeChain = next.catch(() => {});
    return next;
  }

  private async writeIndex(): Promise<void> {
    const obj: Record<string, IndexEntry> = {};
    for (const [k, v] of this.index) obj[k] = v;
    await this.writeJsonAtomic(this.indexPath, obj);
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(value));
      await fsp.rename(tmp, filePath);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  private async writeBlobIfAbsent(blobPath: string, body: Buffer): Promise<void> {
    try {
      await fsp.access(blobPath);
      return;
    } catch {
      // Missing: write below.
    }
    const tmp = `${blobPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, blobPath);
    } catch (err) {
      try {
        await fsp.access(blobPath);
        return;
      } catch {
        throw err;
      }
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  /** Evict oldest-by-mtime blobs until total blob bytes fit under the cap. */
  private async prune(): Promise<void> {
    let names: string[];
    try {
      names = await fsp.readdir(this.blobsDir);
    } catch {
      return;
    }
    const blobs: Array<{ digest: string; size: number; mtime: number }> = [];
    let total = 0;
    for (const name of names) {
      if (!CONTENT_DIGEST.test(name)) continue;
      try {
        const st = await fsp.stat(path.join(this.blobsDir, name));
        blobs.push({ digest: name, size: st.size, mtime: st.mtimeMs });
        total += st.size;
      } catch {
        // Raced with another prune; ignore.
      }
    }
    if (total <= this.maxBytes) return;

    blobs.sort((a, b) => a.mtime - b.mtime); // oldest first
    let evictedCount = 0;
    let evictedBytes = 0;
    for (const blob of blobs) {
      if (total <= this.maxBytes) break;
      const blobPath = path.join(this.blobsDir, blob.digest);
      await fsp.rm(blobPath, { force: true });
      total -= blob.size;
      evictedCount += 1;
      evictedBytes += blob.size;
      // Drop every index path pointing at the evicted digest.
      for (const [p, entry] of [...this.index]) {
        if (entry.digest === blob.digest) {
          this.index.delete(p);
          await fsp.rm(path.join(this.metadataDir, `${entry.metadataKey}.json`), { force: true });
        }
      }
    }
    if (evictedCount > 0) {
      console.warn(
        `[AssetDiskCache] pruned ${evictedCount} blob(s), ${evictedBytes} bytes; ` +
          `${total} bytes remain`
      );
    }
    await this.writeIndex();
  }
}

function parseIndexEntry(value: unknown): IndexEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const digest = record["digest"];
  const metadataKey = record["metadataKey"];
  if (
    typeof digest === "string" &&
    CONTENT_DIGEST.test(digest) &&
    typeof metadataKey === "string" &&
    CONTENT_DIGEST.test(metadataKey)
  ) {
    return { digest, metadataKey };
  }
  return null;
}

async function streamToBuffer(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        if (total + value.byteLength > maxBytes) {
          const err = new CachePopulationTooLargeError(maxBytes);
          void reader.cancel(err).catch(() => {});
          throw err;
        }
        chunks.push(Buffer.from(value));
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
