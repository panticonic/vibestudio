import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { createHash, randomUUID } from "node:crypto";
import { getCentralDataPath } from "@vibestudio/env-paths";

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
  private readonly pending: Array<() => Promise<void>> = [];
  private readonly scheduled = new Set<string>();
  private active = 0;

  constructor(
    private readonly root = path.join(getCentralDataPath(), "transport-cache", POLICY),
    private readonly concurrency = 2
  ) {}

  async get(integrity: string, encoding: TransportEncoding): Promise<Buffer | null> {
    const key = sourceDigest(integrity);
    if (!key) return null;
    const { dataPath, metadataPath } = this.paths(key, encoding);
    try {
      const [body, rawMetadata] = await Promise.all([
        fs.promises.readFile(dataPath),
        fs.promises.readFile(metadataPath, "utf8"),
      ]);
      const metadata = JSON.parse(rawMetadata) as DerivativeMetadata;
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
    } catch {
      return null;
    }
  }

  schedule(integrity: string, body: Buffer): void {
    this.scheduleSource(integrity, async () => body);
  }

  scheduleFile(integrity: string, sourcePath: string): void {
    let source: Promise<Buffer> | undefined;
    this.scheduleSource(integrity, () => {
      source ??= fs.promises.readFile(sourcePath);
      return source;
    });
  }

  private scheduleSource(integrity: string, source: () => Promise<Buffer>): void {
    if (!sourceDigest(integrity)) return;
    for (const encoding of ["br", "gzip"] as const) {
      const jobKey = `${integrity}:${encoding}`;
      if (this.scheduled.has(jobKey)) continue;
      this.scheduled.add(jobKey);
      this.pending.push(async () => {
        try {
          if (await this.get(integrity, encoding)) return;
          await this.publish(integrity, await source(), encoding);
        } finally {
          this.scheduled.delete(jobKey);
        }
      });
    }
    this.drain();
  }

  private paths(key: string, encoding: TransportEncoding) {
    const dir = path.join(this.root, key.slice(0, 2), key);
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
    await fs.promises.writeFile(dataTemp, body, { flag: "wx" });
    await fs.promises.rename(dataTemp, paths.dataPath);
    await fs.promises.writeFile(metadataTemp, `${JSON.stringify(metadata)}\n`, {
      flag: "wx",
    });
    await fs.promises.rename(metadataTemp, paths.metadataPath);
  }

  private drain(): void {
    while (this.active < this.concurrency) {
      const job = this.pending.shift();
      if (!job) return;
      this.active++;
      void job()
        .catch(() => undefined)
        .finally(() => {
          this.active--;
          this.drain();
        });
    }
  }
}
