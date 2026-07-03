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
 *   index.json           { "<cache key>": "<digest>", … }  (cache key → digest)
 *   blobs/<digest>       raw body bytes (as received over the pipe)
 *   blobs/<digest>.json  sidecar: { status, statusText, gzip, contentType, replayHeaders, size }
 *
 * Digest source: the façade prefers an `x-vibez1-content-digest` header if the
 * server ever surfaces one; otherwise it hashes the body (sha-256) on first
 * receipt — a digest-on-write cache. Either way the digest is opaque to this
 * module; it just keys blobs by it. Because artifacts are immutable, a changed
 * build changes the bytes → a new digest → the index entry for that path is
 * rewritten on the next fetch. Stale blobs age out via the LRU cap.
 *
 * Only responses the façade flags `cacheable` (immutable marker + 200) are
 * persisted; `no-store` HTML entry documents are never cached. Concurrent misses
 * for the same path are single-flighted so two webview requests trigger one pipe
 * fetch. Size-capped (default 1 GiB), LRU by blob mtime, pruned on write.
 */

import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024; // 1 GiB

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
  /** Optional server-supplied content digest; when absent the cache hashes the body. */
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

const SAFE_DIGEST = /^[A-Za-z0-9._-]{1,128}$/;

export class AssetDiskCache {
  private readonly dir: string;
  private readonly blobsDir: string;
  private readonly indexPath: string;
  private readonly maxBytes: number;
  /** path → digest */
  private readonly index = new Map<string, string>();
  /** Single-flight: path → in-flight population (resolves to the persisted asset, or null if uncacheable). */
  private readonly inflight = new Map<string, Promise<ServedAsset | null>>();
  /** Serializes index writes + prune so concurrent persists don't clobber index.json. */
  private writeChain: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(opts: { dir: string; maxBytes?: number }) {
    this.dir = opts.dir;
    this.blobsDir = path.join(opts.dir, "blobs");
    this.indexPath = path.join(opts.dir, "index.json");
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async init(): Promise<void> {
    await fsp.mkdir(this.blobsDir, { recursive: true });
    try {
      const raw = await fsp.readFile(this.indexPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && SAFE_DIGEST.test(v)) this.index.set(k, v);
      }
    } catch {
      // No index yet (or corrupt) → start empty; blobs are re-derivable from the pipe.
    }
    this.ready = true;
  }

  /**
   * Serve `cacheKey`, fetching over the pipe only on a miss.
   *  - Disk hit (index → digest → blob) → `{kind:"asset"}`, `fetcher` NOT called.
   *  - Miss → single-flighted `fetcher()`. If the response is `cacheable`, its body
   *    is buffered, hashed/keyed, persisted, and returned as an asset. Otherwise the
   *    live response is returned for the façade to stream through untouched.
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
        return { kind: "passthrough", response };
      }
      const asset = await this.persist(cacheKey, response);
      settle(asset);
      return { kind: "asset", asset };
    } catch (err) {
      settle(null);
      throw err;
    } finally {
      this.inflight.delete(cacheKey);
    }
  }

  /** Current path→digest index size (test/observability helper). */
  get indexSize(): number {
    return this.index.size;
  }

  /** Digest currently mapped for a path, if any (test helper). */
  digestFor(cacheKey: string): string | undefined {
    return this.index.get(cacheKey);
  }

  // -------------------------------------------------------------------------

  private async readByPath(cacheKey: string): Promise<ServedAsset | null> {
    const digest = this.index.get(cacheKey);
    if (!digest) return null;
    const blobPath = path.join(this.blobsDir, digest);
    let body: Buffer;
    let sidecar: Sidecar;
    try {
      [body, sidecar] = await Promise.all([
        fsp.readFile(blobPath),
        fsp.readFile(`${blobPath}.json`, "utf-8").then((raw) => JSON.parse(raw) as Sidecar),
      ]);
    } catch {
      // Blob evicted or sidecar missing → treat as a miss; drop the dangling entry.
      this.index.delete(cacheKey);
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
    const body = await streamToBuffer(response.body!);
    const provided =
      response.digest && SAFE_DIGEST.test(response.digest) ? response.digest : undefined;
    const digest = provided ?? createHash("sha256").update(body).digest("hex");

    const blobPath = path.join(this.blobsDir, digest);
    const sidecar: Sidecar = {
      status: response.status,
      statusText: response.statusText,
      gzip: response.gzip,
      contentType: response.contentType,
      replayHeaders: response.replayHeaders,
      size: body.length,
    };

    // Content-addressed: an existing blob with this digest already holds these bytes.
    try {
      await fsp.access(blobPath);
    } catch {
      const tmp = `${blobPath}.${process.pid}.tmp`;
      await fsp.writeFile(tmp, body);
      await fsp.rename(tmp, blobPath);
    }
    await fsp.writeFile(`${blobPath}.json`, JSON.stringify(sidecar));

    this.index.set(cacheKey, digest);
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
    const obj: Record<string, string> = {};
    for (const [k, v] of this.index) obj[k] = v;
    const tmp = `${this.indexPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(obj));
    await fsp.rename(tmp, this.indexPath);
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
      if (name.endsWith(".json") || name.endsWith(".tmp")) continue;
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
    const stillReferenced = new Set(this.index.values());
    for (const blob of blobs) {
      if (total <= this.maxBytes) break;
      const blobPath = path.join(this.blobsDir, blob.digest);
      await fsp.rm(blobPath, { force: true });
      await fsp.rm(`${blobPath}.json`, { force: true });
      total -= blob.size;
      // Drop every index path pointing at the evicted digest.
      if (stillReferenced.has(blob.digest)) {
        for (const [p, d] of this.index) if (d === blob.digest) this.index.delete(p);
      }
    }
    await this.writeIndex();
  }
}

async function streamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
