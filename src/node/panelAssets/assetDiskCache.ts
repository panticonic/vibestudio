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
 *   index.db             SQLite request index, blob sizes, and access ordering
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
 * fetch. The default retained-cache cap is 2 GiB; pruning is LRU by indexed access order
 * and runs on write. Live responses are not truncated to that retention budget.
 */

import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { AssetIndex, type AssetIndexEntry as IndexEntry } from "./assetIndex.js";

/** Publish completed bytes without replacing an immutable inode held by readers. */
async function publishAssetBlob(source: string, destination: string, size: number): Promise<void> {
  try {
    await fsp.link(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await fsp.lstat(destination);
    if (!stat.isFile() || stat.size !== size) {
      throw new Error("Published asset blob has an invalid file type or size");
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(destination)) hash.update(chunk);
    if (hash.digest("hex") !== path.basename(destination)) {
      throw new Error("Published asset blob does not match its content digest");
    }
  }
}

// Retained-cache budget, not a response-size limit. Live bodies stream to disk
// and never occupy this many bytes in JavaScript memory.
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024; // 64x the measured five-app working set

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
  body: import("node:fs").ReadStream;
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
  private stage: "upstream" | "spool" | "publication" | "retirement" = "upstream";
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
    }) => Promise<void>
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

  diagnostics() {
    return {
      id: path.basename(this.tmp),
      stage: this.stage,
      writtenBytes: this.written,
      readers: this.readers,
      ended: this.ended,
      failed: this.failure !== undefined,
    };
  }

  serve(release: () => void, callerSignal?: AbortSignal): ServeOutcome {
    const signal = callerSignal ? AbortSignal.any([callerSignal, this.signal]) : this.signal;
    this.readers++;
    let offset = 0;
    let retired = false;
    let cancelled = false;
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
      cancelled = true;
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
            await retire();
            // EOF retires the file reader before joining publication. That is
            // successful reader retirement, not cancellation of this response:
            // a publication failure must still settle its pending body read.
            if (!cancelled) controller.error(error);
          }
        },
        cancel: () => {
          cancelled = true;
          return retire();
        },
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
          this.stage = "upstream";
          const next = await this.source.read();
          if (this.failure !== undefined) throw this.failure;
          if (next.done) break;
          let offset = 0;
          while (offset < next.value.byteLength) {
            this.stage = "spool";
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
      this.stage = "publication";
      const blobPath = path.join(path.dirname(this.tmp), digest);
      if (this.written <= this.maxBytes) {
        // Readers keep the population-owned handle. Linking completed bytes
        // publishes one immutable inode without replacing an existing winner,
        // including when Windows still has readers of that winner open.
        await publishAssetBlob(this.tmp, blobPath, this.written);
        await this.publish({ digest, blobPath, size: this.written });
      }
      this.resolvePublication();
      // The retention budget is not a response-size limit. Oversized spools retire below.
    } catch (error) {
      this.failure ??= error;
      this.rejectPublication(error);
      throw error;
    } finally {
      this.stage = "retirement";
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
  private index!: AssetIndex;
  private closing: Promise<void> | undefined;
  private readonly reads = new Set<Promise<ServedAsset | null>>();
  private readonly streams = new Set<import("node:fs").ReadStream>();
  private readonly pins = new Map<string, number>();
  private cleanupFailure: unknown;
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
  /** Serializes index publication and pruning. */
  private writeChain: Promise<void> = Promise.resolve();
  private ready = false;

  diagnostics() {
    return {
      inFlight: this.inflight.size,
      populations: [...this.populations].slice(0, 50).map((population) => population.diagnostics()),
    };
  }

  constructor(opts: { dir: string; maxBytes?: number }) {
    this.blobsDir = path.join(opts.dir, "blobs");
    this.metadataDir = path.join(opts.dir, "metadata");
    this.indexPath = path.join(opts.dir, "index.db");
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  }

  async init(): Promise<void> {
    await Promise.all([
      fsp.mkdir(this.blobsDir, { recursive: true }),
      fsp.mkdir(this.metadataDir, { recursive: true }),
    ]);
    this.index = new AssetIndex(this.indexPath);
    try {
      const legacy = path.join(path.dirname(this.indexPath), "index.json");
      try {
        const parsed = JSON.parse(await fsp.readFile(legacy, "utf-8")) as Record<string, unknown>;
        this.index.transaction(() => {
          for (const [key, value] of Object.entries(parsed)) {
            const entry = parseIndexEntry(value);
            if (entry) this.index.set(key, entry);
          }
        });
      } catch (error) {
        if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
          throw error;
      }
      // Startup reconciliation preserves the persisted access order. Publication
      // updates thereafter touch only the affected records.
      const files = new Set<string>();
      for (const name of await fsp.readdir(this.blobsDir)) {
        if (!CONTENT_DIGEST.test(name)) continue;
        const stat = await fsp.stat(path.join(this.blobsDir, name));
        files.add(name);
        this.index.reconcileBlob(name, stat.size, Math.floor(stat.mtimeMs));
      }
      for (const digest of this.index.digests()) {
        if (!files.has(digest)) {
          for (const key of this.index.forgetBlob(digest)) {
            await fsp.rm(path.join(this.metadataDir, `${key}.json`), { force: true });
          }
        }
      }
      await fsp.rm(legacy, { force: true });
      await this.prune();
      this.ready = true;
    } catch (error) {
      this.index.close();
      throw error;
    }
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
    if (signal?.aborted) {
      hit?.body.destroy();
      signal.throwIfAborted();
    }
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
          const retire = () => {
            if (this.inflight.get(cacheKey) === flight) this.inflight.delete(cacheKey);
            this.populations.delete(population);
          };
          void population.done.then(retire, retire);
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
      this.index.transaction(() => {
        for (const item of prepared) {
          this.index.recordBlob(item.actual, item.body.byteLength);
          this.index.set(item.entry.cacheKey, {
            digest: item.actual,
            metadataKey: item.metadataKey,
          });
        }
      });
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
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.ready = false;
    for (const flight of this.inflight.values())
      flight.controller.abort(new Error("Asset cache closed"));
    return (this.closing = (async () => {
      await Promise.allSettled([...this.reads]);
      await Promise.all(
        [...this.streams].map(
          (stream) =>
            new Promise<void>((resolve) => {
              stream.once("close", resolve);
              stream.destroy(new Error("Asset cache closed"));
            })
        )
      );
      await Promise.allSettled([...this.inflight.values()].map((flight) => flight.ready));
      const results = await Promise.allSettled(
        [...this.populations].map((population) => population.done)
      );
      try {
        await this.writeChain;
      } finally {
        this.index.close();
      }
      const rejected = results.find((result) => result.status === "rejected");
      if (rejected?.status === "rejected") throw rejected.reason;
      if (this.cleanupFailure !== undefined) throw this.cleanupFailure;
    })());
  }

  /** Digest currently mapped for a path, if any (test helper). */
  digestFor(cacheKey: string): string | undefined {
    return this.index.get(cacheKey)?.digest;
  }

  // -------------------------------------------------------------------------

  private readByPath(cacheKey: string): Promise<ServedAsset | null> {
    const read = this.openAsset(cacheKey);
    this.reads.add(read);
    const retire = () => this.reads.delete(read);
    void read.then(retire, retire);
    return read;
  }

  private async openAsset(cacheKey: string): Promise<ServedAsset | null> {
    const entry = this.index.get(cacheKey);
    if (!entry) return null;
    if (!CONTENT_DIGEST.test(entry.digest) || !CONTENT_DIGEST.test(entry.metadataKey)) {
      this.index.delete(cacheKey);
      return null;
    }
    const digest = entry.digest;
    this.pins.set(digest, (this.pins.get(digest) ?? 0) + 1);
    const release = () => {
      const references = (this.pins.get(digest) ?? 1) - 1;
      if (references === 0) this.pins.delete(digest);
      else this.pins.set(digest, references);
    };
    let handle: fsp.FileHandle | undefined;
    try {
      handle = await fsp.open(path.join(this.blobsDir, digest), "r");
      const sidecar = JSON.parse(
        await fsp.readFile(path.join(this.metadataDir, `${entry.metadataKey}.json`), "utf-8")
      ) as Sidecar;
      const stat = await handle.stat();
      if (stat.size !== sidecar.size) {
        this.index.delete(cacheKey);
        await handle.close();
        release();
        return null;
      }
      this.index.touch(digest);
      const body = handle.createReadStream();
      // Unclaimed responses still own a handle until shutdown; retain their
      // failure on the stream without emitting an unhandled process error.
      body.on("error", () => undefined);
      this.streams.add(body);
      body.once("close", () => {
        this.streams.delete(body);
        release();
        void this.enqueueWrite(() => this.prune()).catch((error) => {
          this.cleanupFailure ??= error;
        });
      });
      return { ...sidecar, body };
    } catch (error) {
      await handle?.close();
      release();
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
      this.index.delete(cacheKey);
      return null;
    }
  }

  private async publish(
    cacheKey: string,
    response: FetchedResponse,
    streamed: { digest: string; blobPath: string; size: number }
  ): Promise<void> {
    const { digest, size } = streamed;
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

    await this.enqueueWrite(async () => {
      this.index.recordBlob(digest, size);
      this.index.set(cacheKey, { digest, metadataKey });
      await this.prune();
    });
  }

  private enqueueWrite(task: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(task, task);
    // Keep the chain alive even if a task throws (swallow into the chain, surface via next).
    this.writeChain = next.catch(() => {});
    return next;
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify(value));
      await fsp.rename(tmp, filePath);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  private async writeBlobIfAbsent(blobPath: string, body: Buffer): Promise<void> {
    const tmp = `${blobPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await fsp.writeFile(tmp, body, { flag: "wx" });
      await publishAssetBlob(tmp, blobPath, body.byteLength);
    } finally {
      await fsp.rm(tmp, { force: true });
    }
  }

  /** Eviction walks the indexed oldest candidates, without rescanning every file. */
  private async prune(): Promise<void> {
    let total = this.index.bytes;
    while (total > this.maxBytes) {
      const blob = this.index.oldest(new Set(this.pins.keys()));
      if (!blob) break;
      await fsp.rm(path.join(this.blobsDir, blob.digest), { force: true });
      const metadataKeys = this.index.forgetBlob(blob.digest);
      for (const key of metadataKeys) {
        await fsp.rm(path.join(this.metadataDir, `${key}.json`), { force: true });
      }
      total -= blob.bytes;
    }
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
