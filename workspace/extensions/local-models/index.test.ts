import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FALLBACK_MODEL } from "./types.js";

interface TestDownloadJob {
  id: string;
  slug: string;
  hfRepo: string;
  file: string;
  totalBytes: number | null;
  receivedBytes: number;
  phase: "active" | "queued" | "paused";
  error: string | null;
}

const modelLibraryMock = vi.hoisted(() => {
  const initialJob = (id = "job-1"): TestDownloadJob => ({
    id,
    slug: "lfm2.5-1.2b",
    hfRepo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
    file: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
    totalBytes: 100,
    receivedBytes: 25,
    phase: "active",
    error: null,
  });

  let pendingDownload: {
    job: TestDownloadJob;
    promise: Promise<TestDownloadJob>;
    resolve(job: TestDownloadJob): void;
  } | null = null;
  const state = {
    downloads: [] as TestDownloadJob[],
    nextDownloadOrdinal: 1,
    resolveDownload(job: TestDownloadJob): void {
      const pending = pendingDownload;
      pendingDownload = null;
      pending?.resolve(job);
    },
    reset(): void {
      state.downloads = [];
      state.nextDownloadOrdinal = 1;
      pendingDownload = null;
      state.library.startDownload.mockClear();
      state.library.startDownloadJob.mockClear();
      state.library.listDownloads.mockClear();
    },
    library: {
      list: vi.fn(async () => []),
      get: vi.fn(async () => null),
      ensureFallback: vi.fn<() => Promise<unknown>>(async () => {
        throw new Error("not used");
      }),
      startDownload: vi.fn(() => ensureDownload().promise),
      startDownloadJob: vi.fn(async () => ({ ...ensureDownload().job })),
      pauseDownload: vi.fn(async () => {}),
      resumeDownload: vi.fn(async () => {}),
      cancelDownload: vi.fn(async () => {}),
      listDownloads: vi.fn(() => state.downloads.map((job) => ({ ...job }))),
      remove: vi.fn(async () => {}),
      importDir: vi.fn(async () => []),
      setModelConfig: vi.fn(async () => {}),
      setBenchmark: vi.fn(async () => {}),
    },
  };
  function ensureDownload(): {
    job: TestDownloadJob;
    promise: Promise<TestDownloadJob>;
    resolve(job: TestDownloadJob): void;
  } {
    if (pendingDownload) return pendingDownload;
    const job = initialJob(`job-${state.nextDownloadOrdinal}`);
    state.nextDownloadOrdinal += 1;
    state.downloads = [...state.downloads, job];
    let resolve!: (job: TestDownloadJob) => void;
    const promise = new Promise<TestDownloadJob>((resolvePromise) => {
      resolve = resolvePromise;
    });
    pendingDownload = { job, promise, resolve };
    return pendingDownload;
  }
  return state;
});

const engineMock = vi.hoisted(() => {
  const state = {
    fail: false,
    ensureInstalled: vi.fn(async () => {
      if (state.fail) throw new Error("engine install failed");
      return {
        pin: { buildTag: "test", checksums: {} },
        cpu: null,
        gpu: null,
        degradedReason: null,
      };
    }),
    reset(): void {
      state.fail = false;
      state.ensureInstalled.mockClear();
    },
  };
  return state;
});

vi.mock("./library.js", () => ({
  createModelLibrary: vi.fn(() => modelLibraryMock.library),
  estimateFit: vi.fn(() => ({
    fit: "cpu-only",
    estTokensPerSec: null,
    contextLength: 8192,
    gpuLayers: 0,
    notes: [],
  })),
}));

vi.mock("./hardware.js", () => ({
  createHardwareProfiler: vi.fn(() => ({
    probe: vi.fn(async () => ({
      os: "linux",
      arch: "x64",
      gpus: [],
      cpu: { cores: 8, features: [] },
      ramMB: 16_384,
      usableRamMB: 8192,
      chosenBackend: "cpu",
      chosenGpu: null,
      tier: "cpu-min",
      notes: [],
    })),
  })),
}));

vi.mock("./engine.js", () => ({
  createEngineInstaller: vi.fn(() => ({
    ensureInstalled: engineMock.ensureInstalled,
  })),
}));

vi.mock("./supervisor.js", () => ({
  createServerSupervisor: vi.fn(() => ({
    activate: vi.fn(async () => {}),
    ensureLoaded: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:8080/v1" })),
    status: vi.fn(() => ({
      utility: { state: "stopped" },
      main: { state: "stopped" },
    })),
    ownerInfo: vi.fn(() => null),
    role: vi.fn(() => "owner"),
    apiKey: vi.fn(async () => "test-key"),
    restart: vi.fn(async () => {}),
    tailLog: vi.fn(() => []),
  })),
}));

vi.mock("./benchmark.js", () => ({
  runModelBenchmark: vi.fn(async () => null),
}));

describe("local-models extension", () => {
  let tempRoot = "";

  beforeEach(() => {
    tempRoot = mkdtempSync(path.join(tmpdir(), "vibestudio-local-models-index-"));
    vi.stubEnv("VIBESTUDIO_LOCAL_MODELS_DIR", tempRoot);
    modelLibraryMock.reset();
    engineMock.reset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (tempRoot) rmSync(tempRoot, { recursive: true, force: true });
  });

  it("streams active download progress before the download promise resolves", async () => {
    const { activate } = await import("./index.js");
    const api = await activate({
      log: { info: vi.fn(), warn: vi.fn() },
      emit: vi.fn(),
    });

    const response = api.downloadModel({
      hfRepo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
      file: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
      slug: "lfm2.5-1.2b",
    });
    const lines = jsonLineReader(response);

    await expect(lines.next()).resolves.toMatchObject({
      slug: "lfm2.5-1.2b",
      receivedBytes: 25,
      totalBytes: 100,
    });
    expect(modelLibraryMock.library.startDownload).toHaveBeenCalledTimes(1);

    const finalJob = {
      ...modelLibraryMock.downloads[0]!,
      receivedBytes: 100,
    };
    modelLibraryMock.downloads = [];
    modelLibraryMock.resolveDownload(finalJob);

    await expect(lines.next()).resolves.toMatchObject({
      slug: "lfm2.5-1.2b",
      receivedBytes: 100,
      totalBytes: 100,
    });
    await expect(lines.done()).resolves.toBe(true);
  });

  it("does not stream a pre-existing matching download job", async () => {
    modelLibraryMock.downloads = [
      {
        id: "pre-existing",
        slug: "lfm2.5-1.2b",
        hfRepo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
        file: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
        totalBytes: 100,
        receivedBytes: 80,
        phase: "active",
        error: null,
      },
    ];
    const { activate } = await import("./index.js");
    const api = await activate({
      log: { info: vi.fn(), warn: vi.fn() },
      emit: vi.fn(),
    });

    const response = api.downloadModel({
      hfRepo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
      file: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
      slug: "lfm2.5-1.2b",
    });
    const lines = jsonLineReader(response);

    await expect(lines.next()).resolves.toMatchObject({
      id: "job-1",
      slug: "lfm2.5-1.2b",
      receivedBytes: 25,
    });

    const startedJob = modelLibraryMock.downloads.find((job) => job.id === "job-1")!;
    modelLibraryMock.downloads = [
      modelLibraryMock.downloads[0]!,
      { ...startedJob, receivedBytes: 100 },
    ];
    modelLibraryMock.resolveDownload({ ...startedJob, receivedBytes: 100 });

    await expect(lines.next()).resolves.toMatchObject({
      id: "job-1",
      receivedBytes: 100,
    });
    await expect(lines.done()).resolves.toBe(true);
  });

  it("surfaces bootstrap failures in model availability and retries on demand", async () => {
    engineMock.fail = true;
    const { activate } = await import("./index.js");
    const api = await activate({
      log: { info: vi.fn(), warn: vi.fn() },
      emit: vi.fn(),
    });

    await waitUntil(async () => (await api.status()).fallback.reason === "engine install failed");
    await expect(api.listModels()).resolves.toEqual([
      expect.objectContaining({
        slug: FALLBACK_MODEL.slug,
        state: "error",
        errorMessage: "engine install failed",
      }),
    ]);
    await expect(api.ensureLoaded(FALLBACK_MODEL.ref)).rejects.toThrow(/engine install failed/);

    engineMock.fail = false;
    await expect(api.getLoopbackAuth()).resolves.toEqual({ apiKey: "test-key" });
    expect(engineMock.ensureInstalled.mock.calls.length).toBeGreaterThanOrEqual(3);
    await expect(api.listModels()).resolves.toEqual([
      expect.objectContaining({
        slug: FALLBACK_MODEL.slug,
        state: "startable",
        errorMessage: null,
      }),
    ]);
  });

  it("releases a cancelled ensureLoaded caller without cancelling shared model bootstrap", async () => {
    let resolveSharedLoad!: () => void;
    const sharedLoad = new Promise<void>((resolve) => {
      resolveSharedLoad = resolve;
    });
    modelLibraryMock.library.ensureFallback.mockImplementation(async () => sharedLoad);
    const controller = new AbortController();
    const { activate } = await import("./index.js");
    const api = await activate({
      log: { info: vi.fn(), warn: vi.fn() },
      emit: vi.fn(),
      invocation: {
        current: () => null,
        signal: () => controller.signal,
      },
    });
    const pending = api.ensureLoaded(FALLBACK_MODEL.ref);
    await vi.waitFor(() => expect(modelLibraryMock.library.ensureFallback).toHaveBeenCalled());

    controller.abort(new Error("durable-object activation released"));

    await expect(pending).rejects.toThrow("durable-object activation released");
    // Shared supervisor/bootstrap work is not caller-owned. It remains live
    // and can satisfy another demand even though this invocation stopped waiting.
    resolveSharedLoad();
  });
});

function jsonLineReader(response: Response): {
  next(): Promise<unknown>;
  done(): Promise<boolean>;
} {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response body missing");
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next(): Promise<unknown> {
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          return JSON.parse(line);
        }
        const next = await Promise.race([
          reader.read(),
          new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
            setTimeout(() => reject(new Error("timed out waiting for NDJSON line")), 1000);
          }),
        ]);
        if (next.done) throw new Error("stream ended before next line");
        buffer += decoder.decode(next.value, { stream: true });
      }
    },
    async done(): Promise<boolean> {
      if (buffer.trim()) return false;
      const next = await reader.read();
      return next.done === true;
    },
  };
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1000
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}
