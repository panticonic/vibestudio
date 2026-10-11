import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { formatRpcFailure } from "@vibestudio/rpc";

import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";

export type TransportEncoding = "br" | "gzip";

interface DerivativeMetadata {
  version: 1;
  sourceIntegrity: string;
  encoding: TransportEncoding;
  policy: string;
  byteLength: number;
  digest: string;
}

const POLICY = "p1-br6-gzip6";

function failureFrom(errors: unknown[], message: string): unknown {
  const unique = errors.filter((error, index) => errors.indexOf(error) === index);
  if (unique.length === 1) return unique[0];
  return new AggregateError(unique, message, { cause: unique[0] });
}

async function withCleanup<T>(
  operation: () => Promise<T>,
  cleanup: () => void | Promise<void>,
  message: string
): Promise<T> {
  let value!: T;
  const failures: unknown[] = [];
  try {
    value = await operation();
  } catch (error) {
    failures.push(error);
  }
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length > 0) throw failureFrom(failures, message);
  return value;
}

function isMissingFile(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceDigest(integrity: string): string | null {
  const match = integrity.match(/^sha256-([0-9a-f]{64})$/u);
  return match?.[1] ?? null;
}

function compress(body: Buffer, encoding: TransportEncoding): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const callback = (error: Error | null, result: Buffer) =>
      error ? reject(error) : resolve(result);
    if (encoding === "br") {
      zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } }, callback);
    } else {
      zlib.gzip(body, { level: 6 }, callback);
    }
  });
}

/**
 * Persistent, verified transport derivatives. These files are deliberately
 * outside build manifests: changing codec policy cannot change execution
 * identity, and every workspace can reuse the same encoded representation.
 */
export class TransportDerivativeCache {
  private coordinator: DerivedCacheCoordinator | undefined;
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly scheduled = new Set<string>();
  private active = 0;
  private closed = false;
  private closing: Promise<void> | undefined;
  private readonly failures: unknown[] = [];

  constructor(
    private readonly root = path.join(getSharedDerivedDataPath(), "transport-derivatives"),
    private readonly concurrency = 2
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("Transport cache concurrency must be a positive integer");
    }
  }

  private owner(): DerivedCacheCoordinator {
    return (this.coordinator ??= new DerivedCacheCoordinator(derivedCacheDatabasePath(this.root)));
  }

  private entryKey(key: string): string {
    return `${POLICY}-${key}`;
  }

  get(integrity: string, encoding: TransportEncoding): Promise<Buffer | null> {
    if (this.closed) return Promise.reject(new Error("Transport derivative cache is closed"));
    const job = this.read(integrity, encoding).finally(() => this.jobs.delete(job));
    this.jobs.add(job);
    return job;
  }

  private async read(integrity: string, encoding: TransportEncoding): Promise<Buffer | null> {
    const key = sourceDigest(integrity);
    if (!key) return null;
    const owner = this.owner();
    const lease = owner.acquire(this.root, this.entryKey(key));
    const { dataPath, metadataPath } = this.paths(key, encoding);
    return withCleanup(
      async () => {
        const reads = await Promise.allSettled([
          fs.promises.readFile(dataPath),
          fs.promises.readFile(metadataPath, "utf8"),
        ]);
        const readFailures = reads.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        if (readFailures.length > 0) {
          if (readFailures.every(isMissingFile)) return null;
          throw failureFrom(readFailures, "Transport derivative reads failed");
        }
        const body = (reads[0] as PromiseFulfilledResult<Buffer>).value;
        const rawMetadata = (reads[1] as PromiseFulfilledResult<string>).value;
        let metadata: DerivativeMetadata;
        try {
          metadata = JSON.parse(rawMetadata) as DerivativeMetadata;
        } catch (error) {
          if (error instanceof SyntaxError) return null;
          throw error;
        }
        if (
          metadata.version !== 1 ||
          metadata.sourceIntegrity !== integrity ||
          metadata.encoding !== encoding ||
          metadata.policy !== POLICY ||
          metadata.byteLength !== body.byteLength ||
          metadata.digest !== digest(body)
        ) {
          return null;
        }
        return body;
      },
      () => lease.release(),
      "Transport derivative read and lease release failed"
    );
  }

  schedule(integrity: string, body: Buffer): void {
    this.scheduleSource(integrity, async () => body);
  }

  scheduleFile(integrity: string, sourcePath: string): void {
    this.scheduleSource(integrity, () => fs.promises.readFile(sourcePath));
  }

  /** Stop admission and join every job owned by this cache. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = (async () => {
      const settled = await Promise.allSettled(this.jobs);
      const failures = this.failures.splice(0);
      failures.push(
        ...settled.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      );
      const coordinator = this.coordinator;
      this.coordinator = undefined;
      try {
        coordinator?.close();
      } catch (error) {
        failures.push(error);
      }
      if (failures.length > 0)
        throw failureFrom(failures, "Transport derivative cache operations failed");
    })();
    return this.closing;
  }

  private scheduleSource(integrity: string, source: () => Promise<Buffer>): void {
    if (
      this.closed ||
      !sourceDigest(integrity) ||
      this.scheduled.has(integrity) ||
      this.active >= this.concurrency
    )
      return;
    this.scheduled.add(integrity);
    // Prewarming is opportunistic: admit only work that can start now. HTTP
    // requests produce missing encodings on demand, so skipped work is not queued.
    this.active++;
    const job = (async () => {
      const owner = this.owner();
      const lease = owner.acquire(this.root, this.entryKey(sourceDigest(integrity)!));
      await withCleanup(
        async () => {
          const missing: TransportEncoding[] = [];
          for (const encoding of ["br", "gzip"] as const) {
            if (!(await this.read(integrity, encoding))) missing.push(encoding);
          }
          if (!missing.length) return;
          const body = await source();
          if (`sha256-${digest(body)}` !== integrity) {
            throw new Error(`Transport source integrity mismatch: ${integrity}`);
          }
          for (const encoding of missing) await this.publish(integrity, body, encoding);
        },
        () => lease.release(),
        "Transport derivative publication and lease release failed"
      );
      await owner.prune(this.root);
    })()
      .catch((error) => {
        this.failures.push(error);
        console.warn(`[TransportDerivativeCache] ${formatRpcFailure(error)}`);
      })
      .finally(() => {
        this.scheduled.delete(integrity);
        this.active--;
        this.jobs.delete(job);
      });
    this.jobs.add(job);
  }

  private paths(key: string, encoding: TransportEncoding) {
    const dir = path.join(this.root, this.entryKey(key));
    return {
      dir,
      dataPath: path.join(dir, `${encoding}.bin`),
      metadataPath: path.join(dir, `${encoding}.json`),
    };
  }

  private async publish(
    integrity: string,
    source: Buffer,
    encoding: TransportEncoding
  ): Promise<void> {
    const key = sourceDigest(integrity);
    if (!key) return;
    const body = await compress(source, encoding);
    const paths = this.paths(key, encoding);
    await fs.promises.mkdir(paths.dir, { recursive: true });
    const nonce = `${process.pid}-${randomUUID()}`;
    const dataTemp = `${paths.dataPath}.${nonce}.tmp`;
    const metadataTemp = `${paths.metadataPath}.${nonce}.tmp`;
    const metadata: DerivativeMetadata = {
      version: 1,
      sourceIntegrity: integrity,
      encoding,
      policy: POLICY,
      byteLength: body.byteLength,
      digest: digest(body),
    };
    await withCleanup(
      async () => {
        await fs.promises.writeFile(dataTemp, body, { flag: "wx" });
        await fs.promises.rename(dataTemp, paths.dataPath);
        await fs.promises.writeFile(metadataTemp, `${JSON.stringify(metadata)}\n`, { flag: "wx" });
        await fs.promises.rename(metadataTemp, paths.metadataPath);
      },
      async () => {
        const cleanup = await Promise.allSettled([
          fs.promises.rm(dataTemp, { force: true }),
          fs.promises.rm(metadataTemp, { force: true }),
        ]);
        const failures = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : []
        );
        if (failures.length > 0)
          throw failureFrom(failures, "Transport derivative temporary cleanup failed");
      },
      "Transport derivative publication and temporary cleanup failed"
    );
  }
}
