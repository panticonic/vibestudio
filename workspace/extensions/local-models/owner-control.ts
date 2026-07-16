import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
  DownloadJob,
  DownloadModelRequest,
  ModelBenchmarkResult,
  ModelRecord,
  ModelRuntimeConfig,
  ServerKind,
} from "./types.js";

export type OwnerLibraryRequest =
  | { operation: "ensureFallback" }
  | { operation: "startDownload"; request: DownloadModelRequest }
  | { operation: "startDownloadJob"; request: DownloadModelRequest }
  | { operation: "pauseDownload"; id: string }
  | { operation: "resumeDownload"; id: string }
  | { operation: "cancelDownload"; id: string }
  | { operation: "listDownloads" }
  | { operation: "remove"; slug: string }
  | { operation: "importDir"; dir: string }
  | { operation: "setModelConfig"; slug: string; config: ModelRuntimeConfig }
  | { operation: "setBenchmark"; slug: string; result: ModelBenchmarkResult };

export type OwnerLibraryResponse =
  | { kind: "record"; record: ModelRecord }
  | { kind: "records"; records: ModelRecord[] }
  | { kind: "download"; job: DownloadJob }
  | { kind: "downloads"; jobs: DownloadJob[] }
  | { kind: "ok" };

export type OwnerControlRequest =
  | { action: "ensureLoaded"; slug: string }
  | { action: "restart"; kind: ServerKind }
  | { action: "library"; request: OwnerLibraryRequest };

export type OwnerControlResponse =
  | { baseUrl: string }
  | { restarted: true }
  | { library: OwnerLibraryResponse };

export interface OwnerControlListener {
  port: number;
  close(): Promise<void>;
}

export interface OwnerControlTransport {
  listen(
    apiKey: string,
    handler: (request: OwnerControlRequest) => Promise<OwnerControlResponse>
  ): Promise<OwnerControlListener>;
  request(
    port: number,
    apiKey: string,
    request: OwnerControlRequest
  ): Promise<OwnerControlResponse>;
}

const MAX_REQUEST_BYTES = 16 * 1024;

/** Authenticated loopback RPC from attached workspace extensions to the one
 * process that owns the machine-global llama.cpp runtime. */
export function createHttpOwnerControlTransport(fetchImpl: typeof fetch): OwnerControlTransport {
  return {
    async listen(apiKey, handler) {
      const server = createServer((request, response) => {
        void handleRequest(request, response, apiKey, handler);
      });
      server.unref();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      const address = server.address() as AddressInfo | null;
      if (!address || typeof address.port !== "number") {
        server.close();
        throw new Error("local-models owner control server did not bind a TCP port");
      }
      return {
        port: address.port,
        close: () =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error ? reject(error) : resolve()));
          }),
      };
    },

    async request(port, apiKey, request) {
      const response = await fetchImpl(`http://127.0.0.1:${port}/control`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
      });
      const payload = (await response.json().catch(() => null)) as
        | { ok: true; value: OwnerControlResponse }
        | { ok: false; error: string }
        | null;
      if (!response.ok || !payload || payload.ok !== true) {
        const error = payload && payload.ok === false ? payload.error : `HTTP ${response.status}`;
        throw new Error(`local-models owner control request failed: ${error}`);
      }
      return payload.value;
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  apiKey: string,
  handler: (request: OwnerControlRequest) => Promise<OwnerControlResponse>
): Promise<void> {
  if (request.method !== "POST" || request.url !== "/control") {
    writeJson(response, 404, { ok: false, error: "not found" });
    return;
  }
  const authorization = request.headers.authorization;
  const candidate = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!sameSecret(candidate, apiKey)) {
    writeJson(response, 401, { ok: false, error: "unauthorized" });
    return;
  }

  try {
    const parsed = parseRequest(JSON.parse(await readBody(request)) as unknown);
    writeJson(response, 200, { ok: true, value: await handler(parsed) });
  } catch (error) {
    writeJson(response, 400, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function parseRequest(value: unknown): OwnerControlRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid owner control request");
  }
  const record = value as Record<string, unknown>;
  if (record["action"] === "ensureLoaded" && typeof record["slug"] === "string") {
    return { action: "ensureLoaded", slug: record["slug"] };
  }
  if (
    record["action"] === "restart" &&
    (record["kind"] === "utility" || record["kind"] === "main")
  ) {
    return { action: "restart", kind: record["kind"] };
  }
  if (record["action"] === "library") {
    return { action: "library", request: parseLibraryRequest(record["request"]) };
  }
  throw new Error("invalid owner control request");
}

function parseLibraryRequest(value: unknown): OwnerLibraryRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid owner library request");
  }
  const record = value as Record<string, unknown>;
  const operation = record["operation"];
  if (operation === "ensureFallback" || operation === "listDownloads") return { operation };
  if (operation === "startDownload" || operation === "startDownloadJob") {
    return { operation, request: parseDownloadRequest(record["request"]) };
  }
  if (
    operation === "pauseDownload" ||
    operation === "resumeDownload" ||
    operation === "cancelDownload"
  ) {
    if (typeof record["id"] !== "string") throw new Error("invalid owner library download id");
    return { operation, id: record["id"] };
  }
  if (operation === "remove") {
    if (typeof record["slug"] !== "string") throw new Error("invalid owner library model slug");
    return { operation, slug: record["slug"] };
  }
  if (operation === "importDir") {
    if (typeof record["dir"] !== "string") throw new Error("invalid owner library import path");
    return { operation, dir: record["dir"] };
  }
  if (operation === "setModelConfig") {
    if (typeof record["slug"] !== "string" || !isModelConfig(record["config"])) {
      throw new Error("invalid owner library model config");
    }
    return { operation, slug: record["slug"], config: record["config"] };
  }
  if (operation === "setBenchmark") {
    if (typeof record["slug"] !== "string" || !isBenchmark(record["result"])) {
      throw new Error("invalid owner library benchmark");
    }
    return { operation, slug: record["slug"], result: record["result"] };
  }
  throw new Error("invalid owner library request");
}

function parseDownloadRequest(value: unknown): DownloadModelRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid owner library download request");
  }
  const record = value as Record<string, unknown>;
  if (typeof record["hfRepo"] !== "string" || typeof record["file"] !== "string") {
    throw new Error("invalid owner library download request");
  }
  for (const field of ["expectedSha256", "displayName", "slug"] as const) {
    if (record[field] !== undefined && typeof record[field] !== "string") {
      throw new Error(`invalid owner library download ${field}`);
    }
  }
  return {
    hfRepo: record["hfRepo"],
    file: record["file"],
    ...(typeof record["expectedSha256"] === "string"
      ? { expectedSha256: record["expectedSha256"] }
      : {}),
    ...(typeof record["displayName"] === "string" ? { displayName: record["displayName"] } : {}),
    ...(typeof record["slug"] === "string" ? { slug: record["slug"] } : {}),
  };
}

function isModelConfig(value: unknown): value is ModelRuntimeConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    (config["contextLength"] === null || typeof config["contextLength"] === "number") &&
    (config["gpuLayers"] === null || typeof config["gpuLayers"] === "number")
  );
}

function isBenchmark(value: unknown): value is ModelBenchmarkResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return typeof result["tokensPerSec"] === "number" && typeof result["measuredAt"] === "number";
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error("owner control request is too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function sameSecret(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}
