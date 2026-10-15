import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { createDevLogger } from "@vibestudio/dev-log";
import { encodeBlobRecord } from "@vibestudio/shared/panel/blobBundle";
import { ArtifactBodyCache } from "./artifactBodyCache.js";
import { writeHttpBytes } from "./httpStreamWrite.js";
import type { BuildArtifactManifestEntry, BuildMetadata } from "./buildV2/buildStore.js";
import {
  TransportDerivativeCache,
  compressTransport,
  type TransportEncoding,
} from "./buildV2/transportDerivativeCache.js";
import type { PanelRuntimeHelperSet } from "./panelRuntimeHelpers.js";

const log = createDevLogger("BuildArtifactTransport");

/** What the transport needs of a build: where its bytes live and what it holds. */
export interface TransportBuild {
  dir: string;
  artifacts: readonly BuildArtifactManifestEntry[];
  metadata: Pick<BuildMetadata, "bundleReport" | "kind">;
}

export interface BuildArtifactStore {
  readArtifactBytes(
    build: Pick<TransportBuild, "dir">,
    artifact: BuildArtifactManifestEntry
  ): Promise<Buffer>;
  artifactFilePath(
    build: Pick<TransportBuild, "dir">,
    artifact: BuildArtifactManifestEntry
  ): string;
}

/** The encoding an `Accept-Encoding` header selects, honoring q-values. */
export function preferredContentEncoding(
  value: string | string[] | undefined
): TransportEncoding | null {
  if (!value) return null;
  const accepted = (Array.isArray(value) ? value.join(",") : value)
    .split(",")
    .map((part) => {
      const [name, ...parameters] = part.trim().toLowerCase().split(";");
      const q = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));
      return { name, quality: q ? Number(q.slice(2)) : 1 };
    })
    .filter(({ quality }) => Number.isFinite(quality) && quality > 0);
  const quality = (encoding: TransportEncoding) =>
    Math.max(0, ...accepted.filter(({ name }) => name === encoding).map(({ quality }) => quality));
  const brotliQuality = quality("br");
  const gzipQuality = quality("gzip");
  if (brotliQuality === 0 && gzipQuality === 0) return null;
  return brotliQuality >= gzipQuality ? "br" : "gzip";
}

/**
 * The shared byte-moving core of build-pinned serving: artifact bytes, their
 * canonical compressed representations, the inventory a client prefetches
 * from, and the framed bundle that delivers many artifacts in one response.
 * Panels and apps are served from the same instance, so one build's bytes are
 * read, compressed and cached once however it is asked for.
 */
export class BuildArtifactTransport {
  // The measured five-app artifact working set is about 32 MiB. Historical
  // builds share this budget; disk remains the authority after eviction.
  private readonly bodies = new ArtifactBodyCache(32 * 1024 * 1024);

  constructor(
    private readonly store: () => BuildArtifactStore,
    private readonly derivatives = new TransportDerivativeCache()
  ) {}

  close(): Promise<void> {
    return this.derivatives.close();
  }

  readBytes(build: Pick<TransportBuild, "dir">, artifact: BuildArtifactManifestEntry) {
    const key = `identity:${build.dir}:${artifact.path}:${artifact.integrity ?? ""}`;
    return this.bodies.get(key, () => this.store().readArtifactBytes(build, artifact));
  }

  /**
   * The content's compressed form: the warm derivative if there is one, else
   * compressed once under the same codec policy and kept within the byte
   * budget. Returns null when compression fails; the caller sends identity.
   */
  async compressed(
    integrity: string | undefined,
    name: string,
    body: Buffer,
    encoding: TransportEncoding = "gzip"
  ): Promise<Buffer | null> {
    const cacheKey = `encoded:${encoding}:${integrity ?? createHash("sha256").update(body).digest("hex")}`;
    try {
      return await this.bodies.get(cacheKey, async () => {
        if (integrity) {
          const derivative = await this.derivatives.get(integrity, encoding);
          if (derivative) return derivative;
        }
        return compressTransport(body, encoding);
      });
    } catch (error) {
      log.warn(`Failed to ${encoding}-compress ${name}: ${String(error)}`);
      return null;
    }
  }

  /** Warm the encoded form of the artifacts a first load actually needs. */
  warm(build: TransportBuild): void {
    const initialArtifacts = new Set(build.metadata.bundleReport?.initialArtifacts ?? []);
    for (const artifact of build.artifacts) {
      if (
        artifact.role === "html" ||
        artifact.encoding !== "utf8" ||
        (artifact.byteLength ?? 0) < 1_024 ||
        (artifact.role !== "shared-style" && !initialArtifacts.has(artifact.path)) ||
        !artifact.integrity
      ) {
        continue;
      }
      this.derivatives.scheduleFile(
        artifact.integrity,
        this.store().artifactFilePath({ dir: build.dir }, artifact)
      );
    }
  }

  /**
   * The build's inventory: every artifact a client could need in one JSON body,
   * so it can decide what it lacks without a request per file. `initial` marks
   * what a first load touches; prefetching everything would move far more bytes
   * than the saved round trips are worth. A pure function of an immutable build
   * key, so as cacheable as the artifacts it describes.
   */
  writeManifest(
    res: ServerResponse,
    build: TransportBuild,
    runtimeHelpers?: PanelRuntimeHelperSet
  ): void {
    const initialArtifacts = new Set(build.metadata.bundleReport?.initialArtifacts ?? []);
    const body = JSON.stringify({
      artifacts: build.artifacts.map((artifact) => ({
        path: artifact.path,
        contentType: artifact.contentType,
        ...(artifact.byteLength === undefined ? {} : { byteLength: artifact.byteLength }),
        ...(artifact.integrity === undefined ? {} : { integrity: artifact.integrity }),
        ...(artifact.role === "shared-style" || initialArtifacts.has(artifact.path)
          ? { initial: true }
          : {}),
      })),
      ...(runtimeHelpers
        ? {
            runtimeHelpers: runtimeHelpers.helpers.map((helper) => ({
              path: helper.path,
              version: runtimeHelpers.version,
              contentType: helper.contentType,
              byteLength: helper.body.byteLength,
              integrity: `sha256-${helper.integrity}`,
              initial: true,
            })),
          }
        : {}),
    });
    res.writeHead(200, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "content-length": String(Buffer.byteLength(body)),
    });
    res.end(body);
  }

  /**
   * Stream the requested artifacts as one framed blob bundle. Selection is by
   * index into the manifest, and out-of-range or duplicate indices are ignored
   * so a partly stale client still gets the bytes it can use. With `gzip`, each
   * text-like record carries its compressed form beside the digest of the raw
   * bytes it encodes, so a record's identity is the same either way and a
   * mixed response stays readable per record.
   */
  async writeBundle(
    req: IncomingMessage,
    res: ServerResponse,
    build: TransportBuild,
    options: { gzip: boolean; runtimeHelpers?: PanelRuntimeHelperSet }
  ): Promise<void> {
    const query = new URL(req.url ?? "/", "http://build-artifacts.invalid").searchParams;
    const indices = (name: string, limit: number) => [
      ...new Set(
        (query.get(name) ?? "")
          .split(",")
          .map((raw) => Number.parseInt(raw, 10))
          .filter((index) => Number.isInteger(index) && index >= 0 && index < limit)
      ),
    ];
    const helpers = options.runtimeHelpers?.helpers ?? [];
    const wanted = indices("want", build.artifacts.length);
    const wantedHelpers = indices("helpers", helpers.length);
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "cache-control": "no-store",
      "x-vibestudio-bundle-encoding": options.gzip ? "gzip" : "identity",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const write = async (digest: string, raw: Buffer, encoded: Buffer | null) => {
      await writeHttpBytes(
        res,
        encoded
          ? encodeBlobRecord(
              digest,
              new Uint8Array(encoded),
              createHash("sha256").update(encoded).digest("hex")
            )
          : encodeBlobRecord(digest, new Uint8Array(raw))
      );
    };
    for (const index of wanted) {
      const artifact = build.artifacts[index]!;
      if (!artifact.integrity) continue;
      // Reading re-verifies integrity, so a corrupt build fails here rather
      // than shipping bytes under a digest they do not match.
      const raw = await this.readBytes(build, artifact);
      // Compression is decided per record: already-compressed binaries are not
      // gzipped again, and tiny bodies are not worth the header.
      const encoded =
        options.gzip && artifact.encoding !== "base64" && raw.length >= 1_024
          ? await this.compressed(artifact.integrity, artifact.path, raw)
          : null;
      await write(artifact.integrity.replace(/^sha256-/u, ""), raw, encoded);
    }
    for (const index of wantedHelpers) {
      const helper = helpers[index]!;
      const encoded =
        options.gzip && helper.body.byteLength >= 1_024
          ? await this.compressed(`sha256-${helper.integrity}`, helper.path, helper.body)
          : null;
      await write(helper.integrity, helper.body, encoded);
    }
    res.end();
  }
}
