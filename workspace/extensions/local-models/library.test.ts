import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { detectToolsCapable, parseGgufHeader } from "./gguf.js";
import { createModelLibrary, estimateFit, type ModelLibraryDeps } from "./library.js";
import type { HardwareProfile } from "./types.js";
import { FALLBACK_MODEL } from "./types.js";

const GGUF_TYPE = {
  uint8: 0,
  int8: 1,
  uint16: 2,
  int16: 3,
  uint32: 4,
  int32: 5,
  float32: 6,
  bool: 7,
  string: 8,
  array: 9,
  uint64: 10,
  int64: 11,
  float64: 12,
} as const;

type ScalarKind = Exclude<keyof typeof GGUF_TYPE, "array">;
type ScalarValue = string | number | bigint | boolean;
type EncodedValue =
  | { kind: ScalarKind; value: ScalarValue }
  | { kind: "array"; elementKind: ScalarKind; values: ScalarValue[] };

interface RangeServer {
  baseUrl: string;
  ranges: string[];
  fetch?: typeof fetch;
  close(): Promise<void>;
}

const tempRoots: string[] = [];
const rangeServers: RangeServer[] = [];

afterEach(async () => {
  await Promise.all(rangeServers.splice(0).map((server) => server.close()));
  await Promise.all(
    tempRoots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true }))
  );
});

describe("GGUF parser", () => {
  it("parses a v3 metadata header and skips every supported value shape", () => {
    const gguf = buildGguf([
      ["general.architecture", { kind: "string", value: "llama" }],
      ["general.size_label", { kind: "string", value: "1.2B" }],
      ["llama.context_length", { kind: "uint32", value: 8192 }],
      [
        "tokenizer.chat_template",
        { kind: "string", value: "{% if tools %}{{ tool_calls }}{% endif %}" },
      ],
      ["general.file_type", { kind: "uint32", value: 15 }],
      ["test.u8", { kind: "uint8", value: 1 }],
      ["test.i8", { kind: "int8", value: -1 }],
      ["test.u16", { kind: "uint16", value: 2 }],
      ["test.i16", { kind: "int16", value: -2 }],
      ["test.i32", { kind: "int32", value: -3 }],
      ["test.f32", { kind: "float32", value: 1.5 }],
      ["test.bool", { kind: "bool", value: true }],
      ["test.u64", { kind: "uint64", value: 9000n }],
      ["test.i64", { kind: "int64", value: -9000n }],
      ["test.f64", { kind: "float64", value: 2.5 }],
      ["test.array.u32", { kind: "array", elementKind: "uint32", values: [1, 2, 3] }],
      ["test.array.string", { kind: "array", elementKind: "string", values: ["a", "b"] }],
    ]);

    expect(parseGgufHeader(gguf)).toEqual({
      arch: "llama",
      paramCountLabel: "1.2B",
      contextLength: 8192,
      chatTemplate: "{% if tools %}{{ tool_calls }}{% endif %}",
      quantLabel: "Q4_K_M",
    });
  });

  it("detects tool-capable chat templates", () => {
    expect(detectToolsCapable(null)).toBe(false);
    expect(detectToolsCapable("{{ messages }}")).toBe(false);
    expect(detectToolsCapable("{% if tools %}{{ tools }}{% endif %}")).toBe(true);
    expect(detectToolsCapable("{{ message.tool_calls }}")).toBe(true);
    expect(detectToolsCapable("<|tool_call_start|>{}")).toBe(true);
  });
});

describe("estimateFit", () => {
  it("classifies GPU and CPU fit using the 80% memory budget", () => {
    const gpuMid = hardwareProfile({
      vramMB: 8192,
      ramMB: 16384,
      usableRamMB: 8192,
      tier: "gpu-mid",
    });
    const cpuMin = hardwareProfile({
      vramMB: 0,
      ramMB: 8192,
      usableRamMB: 4096,
      tier: "cpu-min",
    });

    expect(estimateFit(modelSizeMB(700), gpuMid)).toMatchObject({
      fit: "full-gpu",
      contextLength: 32768,
      gpuLayers: 99,
      estTokensPerSec: null,
    });
    expect(estimateFit(modelSizeMB(5 * 1024), gpuMid).fit).toBe("full-gpu");
    expect(estimateFit(modelSizeMB(9 * 1024), gpuMid)).toMatchObject({
      fit: "partial-offload",
      contextLength: 16384,
      gpuLayers: -1,
    });
    expect(estimateFit(modelSizeMB(700), cpuMin)).toMatchObject({
      fit: "cpu-only",
      contextLength: 8192,
      gpuLayers: 0,
    });
    expect(estimateFit(modelSizeMB(6 * 1024), cpuMin).fit).toBe("too-big");
  });
});

describe("ModelLibrary", () => {
  it("downloads a GGUF from an HF resolve URL and records trusted checksum metadata", async () => {
    const root = await tempRoot();
    const body = modelBytes("tiny", 64 * 1024);
    const server = await startRangeServer({ "Tiny-Q4_K_M.gguf": body });
    const { library, events } = createTestLibrary(root, server);

    const job = await library.startDownload({
      hfRepo: "Acme/Tiny-GGUF",
      file: "Tiny-Q4_K_M.gguf",
      expectedSha256: sha256Hex(body),
      displayName: "Tiny Model",
    });

    expect(job).toMatchObject({
      slug: "tiny-q4-k-m",
      totalBytes: body.byteLength,
      receivedBytes: body.byteLength,
      error: null,
    });
    expect(server.ranges).toEqual([""]);
    expect(events.some((event) => event.kind === "models.changed")).toBe(true);

    const records = await library.list();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      slug: "tiny-q4-k-m",
      displayName: "Tiny Model",
      hfRepo: "Acme/Tiny-GGUF",
      sizeBytes: body.byteLength,
      quant: "Q4_K_M",
      paramCount: "1.2B",
      arch: "llama",
      trainedContextLength: 8192,
      toolsCapable: true,
      sha256: sha256Hex(body),
      importedInPlace: false,
      config: { contextLength: null, gpuLayers: null },
    });
  });

  it("starts a download job without waiting for the model transfer to complete", async () => {
    const root = await tempRoot();
    const body = modelBytes("nonblocking", 1024 * 1024);
    const server = await startRangeServer(
      { "Async-Q4_K_M.gguf": body },
      { chunkSize: 16 * 1024, chunkDelayMs: 5 }
    );
    const { library } = createTestLibrary(root, server);
    const request = {
      hfRepo: "Acme/Async-GGUF",
      file: "Async-Q4_K_M.gguf",
      expectedSha256: sha256Hex(body),
      displayName: "Async Model",
    };

    const job = await library.startDownloadJob(request);

    expect(job).toMatchObject({
      slug: "async-q4-k-m",
      receivedBytes: 0,
      phase: "active",
      error: null,
    });
    expect(library.listDownloads()[0]).toMatchObject({ id: job.id, slug: job.slug });

    await expect(library.startDownload(request)).resolves.toMatchObject({
      id: job.id,
      receivedBytes: body.byteLength,
      error: null,
    });
    expect(server.ranges).toEqual([""]);
  });

  it("resumes a paused download with an HTTP Range request", async () => {
    const root = await tempRoot();
    const body = modelBytes("resume", 1024 * 1024);
    const server = await startRangeServer(
      { "Resume-Q4_K_M.gguf": body },
      { chunkSize: 16 * 1024, chunkDelayMs: 5 }
    );
    const { library } = createTestLibrary(root, server);

    const download = library.startDownload({
      hfRepo: "Acme/Resume-GGUF",
      file: "Resume-Q4_K_M.gguf",
      expectedSha256: sha256Hex(body),
    });

    await waitUntil(() => (library.listDownloads()[0]?.receivedBytes ?? 0) > 0);
    const active = library.listDownloads()[0];
    if (!active) {
      throw new Error("Expected an active download");
    }
    await library.pauseDownload(active.id);
    await waitUntil(() => library.listDownloads()[0]?.phase === "paused");

    const partPath = path.join(root, "models", "Acme", "Resume-GGUF", "Resume-Q4_K_M.gguf.part");
    const partialSize = (await fsp.stat(partPath)).size;
    expect(partialSize).toBeGreaterThan(0);
    expect(partialSize).toBeLessThan(body.byteLength);

    await library.resumeDownload(active.id);
    await expect(download).resolves.toMatchObject({
      slug: "resume-q4-k-m",
      receivedBytes: body.byteLength,
      error: null,
    });
    expect(server.ranges.some((range) => /^bytes=\d+-$/.test(range))).toBe(true);
    expect(await pathExists(partPath)).toBe(false);
  });

  it("rejects checksum mismatches and removes the partial file", async () => {
    const root = await tempRoot();
    const body = modelBytes("bad-checksum", 32 * 1024);
    const server = await startRangeServer({ "Bad-Q4_K_M.gguf": body });
    const { library } = createTestLibrary(root, server);

    await expect(
      library.startDownload({
        hfRepo: "Acme/Bad-GGUF",
        file: "Bad-Q4_K_M.gguf",
        expectedSha256: "0".repeat(64),
      })
    ).rejects.toThrow(/Checksum mismatch/);

    const partPath = path.join(root, "models", "Acme", "Bad-GGUF", "Bad-Q4_K_M.gguf.part");
    expect(await pathExists(partPath)).toBe(false);
    expect(await library.list()).toEqual([]);
  });

  it("refuses to remove the fallback model", async () => {
    const root = await tempRoot();
    const { library } = createTestLibrary(root);

    await expect(library.remove(FALLBACK_MODEL.slug)).rejects.toThrow(
      /Refusing to remove fallback model/
    );
  });

  it("imports GGUF files in place and skips paths already indexed", async () => {
    const root = await tempRoot();
    const importRoot = path.join(root, "imports");
    const nested = path.join(importRoot, "nested");
    await fsp.mkdir(nested, { recursive: true });
    const file = path.join(nested, "Imported-Q4_K_M.gguf");
    await fsp.writeFile(file, modelBytes("imported", 4096));
    await fsp.writeFile(path.join(nested, "notes.txt"), "not a model", "utf8");
    const { library, events } = createTestLibrary(root);

    const records = await library.importDir(importRoot);

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      slug: "imported-q4-k-m",
      hfRepo: null,
      file,
      importedInPlace: true,
      quant: "Q4_K_M",
      arch: "llama",
      toolsCapable: true,
    });
    expect(events.some((event) => event.kind === "models.changed")).toBe(true);
    await expect(library.importDir(importRoot)).resolves.toEqual([]);
    await expect(library.list()).resolves.toHaveLength(1);
  });

  it("keeps separate workspace processes coherent over the shared model index", async () => {
    const root = await tempRoot();
    const importRoot = path.join(root, "imports");
    await fsp.mkdir(importRoot, { recursive: true });
    await fsp.writeFile(path.join(importRoot, "Shared-Q4_K_M.gguf"), modelBytes("shared", 4096));
    const attached = createTestLibrary(root).library;
    const owner = createTestLibrary(root).library;

    // Prime the attached process before the owner changes the shared index.
    await expect(attached.list()).resolves.toEqual([]);
    await owner.importDir(importRoot);

    await expect(attached.get("shared-q4-k-m")).resolves.toMatchObject({
      slug: "shared-q4-k-m",
      importedInPlace: true,
    });
  });

  it("serializes concurrent record mutations before reading their snapshots", async () => {
    const root = await tempRoot();
    const importRoot = path.join(root, "imports");
    await fsp.mkdir(importRoot, { recursive: true });
    await fsp.writeFile(path.join(importRoot, "First-Q4_K_M.gguf"), modelBytes("first", 4096));
    await fsp.writeFile(path.join(importRoot, "Second-Q4_K_M.gguf"), modelBytes("second", 4096));
    const { library } = createTestLibrary(root);
    await library.importDir(importRoot);

    await Promise.all([
      library.setModelConfig("first-q4-k-m", { contextLength: 2048, gpuLayers: 1 }),
      library.setModelConfig("second-q4-k-m", { contextLength: 4096, gpuLayers: 2 }),
    ]);

    await expect(library.get("first-q4-k-m")).resolves.toMatchObject({
      config: { contextLength: 2048, gpuLayers: 1 },
    });
    await expect(library.get("second-q4-k-m")).resolves.toMatchObject({
      config: { contextLength: 4096, gpuLayers: 2 },
    });
  });

  it("persists benchmark metadata on model records", async () => {
    const root = await tempRoot();
    const importRoot = path.join(root, "imports");
    await fsp.mkdir(importRoot, { recursive: true });
    await fsp.writeFile(path.join(importRoot, "Bench-Q4_K_M.gguf"), modelBytes("bench", 4096));
    const { library, events } = createTestLibrary(root);

    await library.importDir(importRoot);
    await library.setBenchmark("bench-q4-k-m", { tokensPerSec: 42.5, measuredAt: 1234 });

    await expect(library.get("bench-q4-k-m")).resolves.toMatchObject({
      benchmark: { tokensPerSec: 42.5, measuredAt: 1234 },
    });
    const reloaded = createTestLibrary(root).library;
    await expect(reloaded.get("bench-q4-k-m")).resolves.toMatchObject({
      benchmark: { tokensPerSec: 42.5, measuredAt: 1234 },
    });
    expect(events.filter((event) => event.kind === "models.changed")).toHaveLength(2);
  });
});

function buildGguf(kvs: Array<[string, EncodedValue]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  pushBytes(chunks, Buffer.from("GGUF", "ascii"));
  pushUint32(chunks, 3);
  pushUint64(chunks, 0n);
  pushUint64(chunks, BigInt(kvs.length));
  for (const [key, value] of kvs) {
    pushString(chunks, key);
    pushUint32(chunks, GGUF_TYPE[value.kind]);
    writeValue(chunks, value);
  }
  return Buffer.concat(chunks);
}

function writeValue(chunks: Uint8Array[], value: EncodedValue): void {
  if (value.kind === "array") {
    pushUint32(chunks, GGUF_TYPE[value.elementKind]);
    pushUint64(chunks, BigInt(value.values.length));
    for (const item of value.values) {
      writeScalar(chunks, value.elementKind, item);
    }
    return;
  }
  writeScalar(chunks, value.kind, value.value);
}

function writeScalar(chunks: Uint8Array[], kind: ScalarKind, value: ScalarValue): void {
  switch (kind) {
    case "uint8":
      pushUInt(chunks, value, 1);
      break;
    case "int8":
      pushInt(chunks, value, 1);
      break;
    case "uint16":
      pushUInt(chunks, value, 2);
      break;
    case "int16":
      pushInt(chunks, value, 2);
      break;
    case "uint32":
      pushUInt(chunks, value, 4);
      break;
    case "int32":
      pushInt(chunks, value, 4);
      break;
    case "float32":
      pushFloat(chunks, value, 4);
      break;
    case "bool":
      pushUInt(chunks, value === true ? 1 : 0, 1);
      break;
    case "string":
      pushString(chunks, String(value));
      break;
    case "uint64":
      pushUint64(chunks, BigInt(value));
      break;
    case "int64":
      pushInt64(chunks, BigInt(value));
      break;
    case "float64":
      pushFloat(chunks, value, 8);
      break;
  }
}

function modelBytes(label: string, paddingBytes: number): Uint8Array {
  return Buffer.concat([
    buildGguf([
      ["general.architecture", { kind: "string", value: "llama" }],
      ["general.size_label", { kind: "string", value: "1.2B" }],
      ["llama.context_length", { kind: "uint32", value: 8192 }],
      [
        "tokenizer.chat_template",
        { kind: "string", value: `{{ tools }} {{ message.tool_calls }} ${label}` },
      ],
      ["general.file_type", { kind: "uint32", value: 15 }],
    ]),
    Buffer.alloc(paddingBytes, 0x2a),
  ]);
}

function pushBytes(chunks: Uint8Array[], bytes: Uint8Array): void {
  chunks.push(bytes);
}

function pushString(chunks: Uint8Array[], value: string): void {
  const bytes = Buffer.from(value, "utf8");
  pushUint64(chunks, BigInt(bytes.byteLength));
  pushBytes(chunks, bytes);
}

function pushUint32(chunks: Uint8Array[], value: number): void {
  pushUInt(chunks, value, 4);
}

function pushUint64(chunks: Uint8Array[], value: bigint): void {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  chunks.push(buffer);
}

function pushInt64(chunks: Uint8Array[], value: bigint): void {
  const buffer = Buffer.alloc(8);
  buffer.writeBigInt64LE(value);
  chunks.push(buffer);
}

function pushUInt(chunks: Uint8Array[], value: ScalarValue, bytes: 1 | 2 | 4): void {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 1) {
    buffer.writeUInt8(Number(value));
  } else if (bytes === 2) {
    buffer.writeUInt16LE(Number(value));
  } else {
    buffer.writeUInt32LE(Number(value));
  }
  chunks.push(buffer);
}

function pushInt(chunks: Uint8Array[], value: ScalarValue, bytes: 1 | 2 | 4): void {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 1) {
    buffer.writeInt8(Number(value));
  } else if (bytes === 2) {
    buffer.writeInt16LE(Number(value));
  } else {
    buffer.writeInt32LE(Number(value));
  }
  chunks.push(buffer);
}

function pushFloat(chunks: Uint8Array[], value: ScalarValue, bytes: 4 | 8): void {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 4) {
    buffer.writeFloatLE(Number(value));
  } else {
    buffer.writeDoubleLE(Number(value));
  }
  chunks.push(buffer);
}

function hardwareProfile(input: {
  vramMB: number;
  ramMB: number;
  usableRamMB: number;
  tier: HardwareProfile["tier"];
}): HardwareProfile {
  const gpu =
    input.vramMB > 0
      ? {
          vendor: "nvidia" as const,
          name: "Test GPU",
          vramMB: input.vramMB,
          backend: "cuda-12.4" as const,
          discrete: true,
        }
      : null;
  return {
    os: "linux",
    arch: "x64",
    gpus: gpu ? [gpu] : [],
    cpu: { cores: 8, features: [] },
    ramMB: input.ramMB,
    usableRamMB: input.usableRamMB,
    chosenBackend: gpu ? "cuda-12.4" : "cpu",
    chosenGpu: gpu,
    tier: input.tier,
    probedAt: 1,
    notes: [],
  };
}

function modelSizeMB(sizeMB: number): { sizeBytes: number; trainedContextLength: number } {
  return {
    sizeBytes: sizeMB * 1024 * 1024,
    trainedContextLength: 65536,
  };
}

async function tempRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(tmpdir(), "local-models-test-"));
  tempRoots.push(root);
  return root;
}

function createTestLibrary(
  root: string,
  server?: RangeServer
): {
  library: ReturnType<typeof createModelLibrary>;
  events: Array<Parameters<ModelLibraryDeps["emit"]>[0]>;
} {
  const events: Array<Parameters<ModelLibraryDeps["emit"]>[0]> = [];
  return {
    library: createModelLibrary({
      rootDir: root,
      fetch: server ? (server.fetch ?? fetchThrough(server.baseUrl)) : fetch,
      log: vi.fn(),
      emit(event) {
        events.push(event);
      },
      now: () => Date.now(),
    }),
    events,
  };
}

function fetchThrough(baseUrl: string): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const source = new URL(fetchInputUrl(input));
    const target = new URL(`${source.pathname}${source.search}`, baseUrl);
    return fetch(target, init);
  }) as typeof fetch;
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

async function startRangeServer(
  files: Record<string, Uint8Array>,
  options: { chunkSize?: number; chunkDelayMs?: number } = {}
): Promise<RangeServer> {
  const ranges: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    void serveRange(req, res, files, ranges, options).catch((error: unknown) => {
      if (!res.headersSent) {
        res.statusCode = 500;
      }
      res.end(error instanceof Error ? error.message : String(error));
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });
  const listenError = await new Promise<Error | null>((resolve) => {
    server.once("error", resolve);
    server.listen(0, "127.0.0.1", () => {
      server.removeAllListeners("error");
      resolve(null);
    });
  });
  if (listenError) {
    server.removeAllListeners();
    if (
      isNodeError(listenError) &&
      (listenError.code === "EPERM" || listenError.code === "EACCES")
    ) {
      const fallbackServer: RangeServer = {
        baseUrl: "http://local-range.test",
        ranges,
        fetch: rangeFetch(files, ranges, options),
        close: async () => {},
      };
      rangeServers.push(fallbackServer);
      return fallbackServer;
    }
    throw listenError;
  }
  const address = server.address() as AddressInfo;
  const rangeServer: RangeServer = {
    baseUrl: `http://127.0.0.1:${address.port}`,
    ranges,
    close: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
  rangeServers.push(rangeServer);
  return rangeServer;
}

function rangeFetch(
  files: Record<string, Uint8Array>,
  ranges: string[],
  options: { chunkSize?: number; chunkDelayMs?: number }
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const source = new URL(fetchInputUrl(input));
    const file = decodeURIComponent(source.pathname.split("/").at(-1) ?? "");
    const body = files[file];
    if (!body) {
      return new Response("missing", { status: 404 });
    }

    const requestHeaders = new Headers(init?.headers);
    const range = requestHeaders.get("range") ?? "";
    ranges.push(range);
    const match = /^bytes=(\d+)-$/i.exec(range);
    const start = match ? Number(match[1]) : 0;
    if (start >= body.byteLength) {
      return new Response(null, { status: 416 });
    }

    const headers = new Headers({
      "accept-ranges": "bytes",
      "content-length": String(body.byteLength - start),
    });
    const status = start > 0 ? 206 : 200;
    if (start > 0) {
      headers.set("content-range", `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`);
    }

    return new Response(rangeStream(body, start, options, init?.signal), { status, headers });
  }) as typeof fetch;
}

function rangeStream(
  body: Uint8Array,
  start: number,
  options: { chunkSize?: number; chunkDelayMs?: number },
  signal?: AbortSignal | null
): ReadableStream<Uint8Array> {
  let offset = start;
  let aborted = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        aborted = true;
        controller.error(new DOMException("Aborted", "AbortError"));
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          controller.error(new DOMException("Aborted", "AbortError"));
        },
        { once: true }
      );
    },
    async pull(controller) {
      if (aborted) {
        return;
      }
      if (offset >= body.byteLength) {
        controller.close();
        return;
      }
      const chunkSize = options.chunkSize ?? body.byteLength;
      const chunk = body.subarray(offset, Math.min(offset + chunkSize, body.byteLength));
      offset += chunk.byteLength;
      controller.enqueue(chunk);
      if (options.chunkDelayMs) {
        await sleep(options.chunkDelayMs);
      }
    },
  });
}

async function serveRange(
  req: IncomingMessage,
  res: ServerResponse,
  files: Record<string, Uint8Array>,
  ranges: string[],
  options: { chunkSize?: number; chunkDelayMs?: number }
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const file = decodeURIComponent(requestUrl.pathname.split("/").at(-1) ?? "");
  const body = files[file];
  if (!body) {
    res.statusCode = 404;
    res.end("missing");
    return;
  }

  const range = req.headers.range ?? "";
  ranges.push(range);
  const match = /^bytes=(\d+)-$/i.exec(range);
  const start = match ? Number(match[1]) : 0;
  if (start >= body.byteLength) {
    res.statusCode = 416;
    res.end();
    return;
  }

  res.statusCode = start > 0 ? 206 : 200;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Length", body.byteLength - start);
  if (start > 0) {
    res.setHeader("Content-Range", `bytes ${start}-${body.byteLength - 1}/${body.byteLength}`);
  }

  const chunkSize = options.chunkSize ?? body.byteLength;
  for (let offset = start; offset < body.byteLength; offset += chunkSize) {
    if (res.destroyed) {
      return;
    }
    const chunk = body.subarray(offset, Math.min(offset + chunkSize, body.byteLength));
    res.write(chunk);
    if (options.chunkDelayMs) {
      await sleep(options.chunkDelayMs);
    }
  }
  res.end();
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await sleep(10);
  }
  throw new Error("Timed out waiting for condition");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
