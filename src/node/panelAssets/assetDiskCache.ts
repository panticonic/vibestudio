/**
 * assetDiskCache — content-addressed on-disk cache for the desktop panel-asset
 * façade (Iroh RPC v2, plan §6).
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
 * fetch. The default retained-cache cap is 64 GiB; pruning is LRU by blob mtime
 * and runs on write. Live responses are not truncated to that retention budget.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

// Retained-cache budget, not a response-size limit. Live bodies stream to disk
// and never occupy this many bytes in JavaScript memory.
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024 * 1024; // 64 GiB

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

/** A persisted asset ready to stream from disk to the webview. */
export interface ServedAsset {
  status: number;
  statusText: string;
  gzip: boolean;
  contentType: string;
  replayHeaders: Record<string, string>;
  bodyPath: string;
  size: number;
}

export interface VerifiedCacheEntry {
  cacheKey: string;
  bytes: Uint8Array;
  /** SHA-256 of the exact stored bytes (compressed representation when gzip). */
  payloadDigest: string;
  status?: number;
  statusText?: string;
  gzip: boolean;
  contentType: string;
  replayHeaders?: Record<string, string>;
}

export type ServeOutcome =
  /** Served from a disk hit or freshly persisted stream. */
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

function waitForAsset<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  release: () => void
): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const aborted = () => {
      release();
      reject(signal.reason);
    };
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

function ownAssetBody(
  body: ReadableStream<Uint8Array>,
  release: () => void,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let retired = false;
  let bodyController!: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (retired) return;
    retired = true;
    signal?.removeEventListener("abort", aborted);
    release();
    reader.releaseLock();
  };
  const aborted = () => {
    if (retired) return;
    bodyController.error(signal?.reason);
    void reader.cancel(signal?.reason).then(finish, finish);
  };
  const owned = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        bodyController = controller;
      },
      async pull(controller) {
        try {
          const next = await reader.read();
          if (retired) {
            controller.error(signal?.reason);
            return;
          }
          if (next.done) {
            finish();
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          finish();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          finish();
        }
      },
    },
    { highWaterMark: 0 }
  );
  signal?.addEventListener("abort", aborted, { once: true });
  if (signal?.aborted) aborted();
  return owned;
}

/** One producer and independently paced readers of a growing immutable file. */
class AssetPopulation {
  private written = 0;
  private ended = false;
  private failure: unknown;
  private readers = 0;
  private readonly changed = new Set<() => void>();
  private readonly source: ReadableStreamDefaultReader<Uint8Array>;
  private resolveDone!: () => void;
  private rejectDone!: (error: unknown) => void;
  private resolvePublication!: () => void;
  private rejectPublication!: (error: unknown) => void;
  private readonly publication = new Promise<void>((resolve, reject) => {
    this.resolvePublication = resolve;
    this.rejectPublication = reject;
  });
  readonly done = new Promise<void>((resolve, reject) => {
    this.resolveDone = resolve;
    this.rejectDone = reject;
  });

  private constructor(
    private readonly response: FetchedResponse & { body: ReadableStream<Uint8Array> },
    private readonly tmp: string,
    private readonly writer: fsp.FileHandle,
    private readonly maxBytes: number,
    private readonly signal: AbortSignal,
    private readonly publish: (streamed: {
      digest: string;
      blobPath: string;
      size: number;
    }) => Promise<ServedAsset>
  ) {
    this.source = response.body.getReader();
    this.signal.addEventListener("abort", this.abort, { once: true });
    if (this.signal.aborted) this.abort();
    void this.done.catch(() => undefined);
    void this.publication.catch(() => undefined);
  }

  static async create(
    response: FetchedResponse & { body: ReadableStream<Uint8Array> },
    tmp: string,
    maxBytes: number,
    signal: AbortSignal,
    publish: AssetPopulation["publish"]
  ): Promise<AssetPopulation> {
    try {
      return new AssetPopulation(
        response,
        tmp,
        await fsp.open(tmp, "wx+"),
        maxBytes,
        signal,
        publish
      );
    } catch (error) {
      await response.body.cancel(error);
      throw error;
    }
  }

  private readonly abort = () => {
    if (this.ended) return;
    this.failure = this.signal.reason;
    void this.source.cancel(this.failure).catch(() => undefined);
    this.notify();
  };

  get canPublish(): boolean {
    return this.ended && this.readers === 0;
  }

  serve(release: () => void, signal?: AbortSignal): ServeOutcome {
    this.readers++;
    let offset = 0;
    let retired = false;
    let retiring: Promise<void> | undefined;
    let reading: Promise<{ bytes: Buffer; bytesRead: number }> | undefined;
    let wake: (() => void) | null = null;
    const retire = (): Promise<void> => {
      if (retiring) return retiring;
      retired = true;
      wake?.();
      retiring = (async () => {
        try {
          // Cancellation joins this consumer's positioned read before releasing
          // its reference to the population-owned file handle.
          await reading?.catch(() => undefined);
        } finally {
          this.readers--;
          signal?.removeEventListener("abort", aborted);
          release();
          this.notify();
        }
      })();
      return retiring;
    };
    let bodyController!: ReadableStreamDefaultController<Uint8Array>;
    const aborted = () => {
      if (retired) return;
      bodyController.error(signal?.reason);
      void retire().catch(() => undefined);
    };
    const body = new ReadableStream<Uint8Array>(
      {
        start(controller) {
          bodyController = controller;
        },
        pull: async (controller) => {
          try {
            for (;;) {
              if (retired) return;
              if (this.failure !== undefined) throw this.failure;
              if (offset < this.written) {
                reading = (async () => {
                  const bytes = Buffer.allocUnsafe(Math.min(64 * 1024, this.written - offset));
                  const { bytesRead } = await this.writer.read(bytes, 0, bytes.length, offset);
                  return { bytes, bytesRead };
                })();
                const { bytes, bytesRead } = await reading;
                reading = undefined;
                if (bytesRead === 0) throw new Error("Asset spool ended before committed bytes");
                offset += bytesRead;
                if (!retired) controller.enqueue(bytes.subarray(0, bytesRead));
                return;
              }
              if (this.ended) {
                await retire();
                await this.publication;
                controller.close();
                return;
              }
              await new Promise<void>((resolve) => {
                wake = resolve;
                this.changed.add(resolve);
              });
              if (wake) this.changed.delete(wake);
              wake = null;
            }
          } catch (error) {
            const cancelled = retired;
            await retire();
            if (!cancelled) controller.error(error);
          }
        },
        cancel: retire,
      },
      { highWaterMark: 0 }
    );
    signal?.addEventListener("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
    return { kind: "passthrough", response: { ...this.response, cacheable: false, body } };
  }

  start(): void {
    void this.pump().then(this.resolveDone, this.rejectDone);
  }

  private notify(): void {
    for (const resolve of this.changed) resolve();
    this.changed.clear();
  }

  private async pump(): Promise<void> {
    const hash = createHash("sha256");
    try {
      try {
        for (;;) {
          const next = await this.source.read();
          if (this.failure !== undefined) throw this.failure;
          if (next.done) break;
          let offset = 0;
          while (offset < next.value.byteLength) {
            // Readers and the producer share this handle. Positioned reads on
            // Windows restore its cursor, so writes must also name their offset.
            const { bytesWritten } = await this.writer.write(
              next.value,
              offset,
              next.value.byteLength - offset,
              this.written + offset
            );
            if (bytesWritten === 0) throw new Error("Asset cache write made no progress");
            offset += bytesWritten;
          }
          hash.update(next.value);
          this.written += next.value.byteLength;
          this.notify();
        }
      } catch (error) {
        this.failure = error;
        await this.source.cancel(error).catch(() => undefined);
      } finally {
        this.ended = true;
        this.notify();
        this.source.releaseLock();
        this.signal.removeEventListener("abort", this.abort);
      }
      if (this.failure !== undefined) {
        this.rejectPublication(this.failure);
        return;
      }
      const digest = hash.digest("hex");
      const blobPath = path.join(path.dirname(this.tmp), digest);
      if (this.written <= this.maxBytes) {
        // Every reader uses the population-owned handle with an explicit file
        // position. Rename preserves that handle, including for late readers,
        // without copying bytes or waiting for slow consumers to finish.
        await fsp.rename(this.tmp, blobPath);
        await this.publish({ digest, blobPath, size: this.written });
      }
      this.resolvePublication();
      // The retention budget is not a response-size limit. Oversized spools retire below.
    } catch (error) {
      this.rejectPublication(error);
      throw error;
    } finally {
      try {
        while (this.readers > 0) await new Promise<void>((resolve) => this.changed.add(resolve));
      } finally {
        try {
          await this.writer.close();
        } finally {
          await fsp.rm(this.tmp, { force: true });
        }
      }
    }
  }
}

export class AssetDiskCache {
  private readonly blobsDir: string;
  private readonly metadataDir: string;
  private readonly indexPath: string;
  private readonly maxBytes: number;
  /** path → content digest + per-path metadata key */
  private readonly index = new Map<string, IndexEntry>();
  /** One owned upstream fetch per immutable path, with independent consumers. */
  private readonly inflight = new Map<
    string,
    {
      controller: AbortController;
      references: number;
      claimed: boolean;
      ready: Promise<AssetPopulation | FetchedResponse>;
    }
  >();
  private readonly populations = new Set<AssetPopulation>();
  /** Serializes index writes + prune so concurrent persists don't clobber index.json. */
  private writeChain: Promise<void> = Promise.resolve();
  private ready = false;

  constructor(opts: { dir: string; maxBytes?: number }) {
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
   *  - Miss → one bounded network-to-disk population. Every caller streams from
   *    its own position in that growing file, including a demand joining prewarm.
   *    Lagging consumers retain disk bytes rather than an unbounded tee queue.
   */
  async serve(
    cacheKey: string,
    fetcher: (signal: AbortSignal) => Promise<FetchedResponse>,
    signal?: AbortSignal
  ): Promise<ServeOutcome> {
    if (!this.ready) throw new Error("AssetDiskCache.init() not called");
    signal?.throwIfAborted();
    const hit = await this.readByPath(cacheKey);
    signal?.throwIfAborted();
    if (hit) return { kind: "asset", asset: hit };

    let flight = this.inflight.get(cacheKey);
    if (!flight) {
      const controller = new AbortController();
      flight = {
        controller,
        references: 0,
        claimed: false,
        ready: Promise.resolve().then(async () => {
          const response = await fetcher(controller.signal);
          if (!response.cacheable || !response.body) {
            this.inflight.delete(cacheKey);
            return response;
          }
          const population = await AssetPopulation.create(
            response as FetchedResponse & { body: ReadableStream<Uint8Array> },
            path.join(this.blobsDir, `.stream.${process.pid}.${randomUUID()}.tmp`),
            this.maxBytes,
            controller.signal,
            (streamed) => this.publish(cacheKey, response, streamed)
          );
          this.populations.add(population);
          // Every waiting caller acquires its reader before the producer starts.
          queueMicrotask(() => population.start());
          void population.done
            .then(() => {
              if (this.inflight.get(cacheKey) === flight) this.inflight.delete(cacheKey);
              this.populations.delete(population);
            })
            .catch(() => undefined);
          return population;
        }),
      };
      this.inflight.set(cacheKey, flight);
      void flight.ready.catch(() => {
        if (this.inflight.get(cacheKey) === flight) this.inflight.delete(cacheKey);
      });
    }
    const owned = flight;
    owned.references++;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      owned.references--;
      if (owned.references === 0) owned.controller.abort(new Error("All asset consumers closed"));
    };
    try {
      const resource = await waitForAsset(owned.ready, signal, release);
      if (resource instanceof AssetPopulation) {
        if (resource.canPublish) {
          release();
          await resource.done;
          return this.serve(cacheKey, fetcher, signal);
        }
        return resource.serve(release, signal);
      }
      if (owned.claimed) {
        release();
        return this.serve(cacheKey, fetcher, signal);
      }
      owned.claimed = true;
      if (!resource.body) {
        release();
        return { kind: "passthrough", response: resource };
      }
      return {
        kind: "passthrough",
        response: {
          ...resource,
          body: ownAssetBody(resource.body, release, signal),
        },
      };
    } catch (error) {
      release();
      throw error;
    }
  }

  /** Read an entry without opening a remote fetch. */
  async get(cacheKey: string): Promise<ServedAsset | null> {
    if (!this.ready) throw new Error("AssetDiskCache.init() not called");
    return this.readByPath(cacheKey);
  }

  /** Cheap manifest planning probe; verifies both blob and sidecar still exist. */
  async has(cacheKey: string): Promise<boolean> {
    if (!this.ready) throw new Error("AssetDiskCache.init() not called");
    const entry = this.index.get(cacheKey);
    if (!entry) return false;
    try {
      await Promise.all([
        fsp.access(path.join(this.blobsDir, entry.digest)),
        fsp.access(path.join(this.metadataDir, `${entry.metadataKey}.json`)),
      ]);
      return true;
    } catch {
      this.index.delete(cacheKey);
      return false;
    }
  }

  /**
   * Atomically publish a verified bundle. No index path becomes visible until
   * every record's payload digest has been checked and every blob/sidecar has
   * been written, so a corrupt or truncated bundle publishes nothing.
   */
  async putVerifiedBatch(entries: readonly VerifiedCacheEntry[]): Promise<void> {
    if (!this.ready) throw new Error("AssetDiskCache.init() not called");
    const prepared = entries.map((entry) => {
      const body = Buffer.from(entry.bytes);
      if (body.byteLength > this.maxBytes) throw new CachePopulationTooLargeError(this.maxBytes);
      const actual = createHash("sha256").update(body).digest("hex");
      if (actual !== entry.payloadDigest) {
        throw new Error(
          `cache payload digest mismatch for ${entry.cacheKey}: expected ${entry.payloadDigest}, got ${actual}`
        );
      }
      const metadataKey = createHash("sha256").update(entry.cacheKey).digest("hex");
      const sidecar: Sidecar = {
        status: entry.status ?? 200,
        statusText: entry.statusText ?? "OK",
        gzip: entry.gzip,
        contentType: entry.contentType,
        replayHeaders: entry.replayHeaders ?? {},
        size: body.byteLength,
      };
      return { entry, body, actual, metadataKey, sidecar };
    });
    await this.enqueueWrite(async () => {
      for (const item of prepared) {
        await this.writeBlobIfAbsent(path.join(this.blobsDir, item.actual), item.body);
        await this.writeJsonAtomic(
          path.join(this.metadataDir, `${item.metadataKey}.json`),
          item.sidecar
        );
      }
      for (const item of prepared) {
        this.index.set(item.entry.cacheKey, {
          digest: item.actual,
          metadataKey: item.metadataKey,
        });
      }
      await this.writeIndex();
      await this.prune();
    });
  }

  /** Current path→digest index size (test/observability helper). */
  get indexSize(): number {
    return this.index.size;
  }

  /**
   * Drain every cache population owned by this instance before its state root
   * may be released. The HTTP server is closed first, so no new flights can be
   * admitted while this barrier is waiting.
   */
  async close(): Promise<void> {
    await Promise.allSettled([...this.inflight.values()].map((flight) => flight.ready));
    await Promise.all([...this.populations].map((population) => population.done));
    await this.writeChain;
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
    let sidecar: Sidecar;
    try {
      const [stat, loadedSidecar] = await Promise.all([
        fsp.stat(blobPath),
        fsp.readFile(metadataPath, "utf-8").then((raw) => JSON.parse(raw) as Sidecar),
      ]);
      sidecar = loadedSidecar;
      if (stat.size !== sidecar.size) throw new Error("cached asset size mismatch");
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
      bodyPath: blobPath,
      size: sidecar.size,
    };
  }

  private async publish(
    cacheKey: string,
    response: FetchedResponse,
    streamed: { digest: string; blobPath: string; size: number }
  ): Promise<ServedAsset> {
    const { digest, blobPath, size } = streamed;
    const metadataKey = createHash("sha256").update(cacheKey).digest("hex");

    const metadataPath = path.join(this.metadataDir, `${metadataKey}.json`);
    const sidecar: Sidecar = {
      status: response.status,
      statusText: response.statusText,
      gzip: response.gzip,
      contentType: response.contentType,
      replayHeaders: response.replayHeaders,
      size,
    };

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
      bodyPath: blobPath,
      size,
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
