import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fsp from "node:fs/promises";
import path from "node:path";
import { detectToolsCapable, parseGgufHeader } from "./gguf.js";
import type {
  DownloadJob,
  FitEstimate,
  HardwareProfile,
  ModelBenchmarkResult,
  ModelRecord,
  ModelRuntimeConfig,
  QuantName,
} from "./types.js";
import { FALLBACK_MODEL, ROOT_LAYOUT } from "./types.js";

export interface ModelLibraryDeps {
  rootDir: string;
  fetch: typeof fetch;
  log(msg: string, data?: unknown): void;
  emit(event: { kind: "models.changed" } | { kind: "download.progress"; job: DownloadJob }): void;
  now(): number;
}

interface DownloadRequest {
  hfRepo: string;
  file: string;
  expectedSha256?: string;
  displayName?: string;
  /** Curated-catalog slug (design §4.3): callers that know the canonical slug
   *  (curated entries, tests) pass it so records match "local:<slug>" refs;
   *  ad-hoc pulls fall back to the derived repo+quant slug. */
  slug?: string;
}

interface DownloadOptions {
  slugOverride?: string;
  onProgress?: (job: DownloadJob) => void;
}

interface StartedDownloadTask {
  job: DownloadJob;
  done: Promise<DownloadJob>;
}

interface DownloadTask {
  job: DownloadJob;
  req: DownloadRequest;
  targetPath: string;
  partPath: string;
  done: Promise<DownloadJob>;
  resolve(job: DownloadJob): void;
  reject(error: Error): void;
  controller: AbortController | null;
  pauseRequested: boolean;
  cancelRequested: boolean;
  lastProgressEmitAt: number;
  onProgress?: (job: DownloadJob) => void;
}

interface BuildRecordInput {
  slug: string;
  displayName: string;
  hfRepo: string | null;
  file: string;
  sha256: string;
  importedInPlace: boolean;
}

const HEADER_READ_BYTES = 8 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 500;
const RECORDS_FILE = "records.json";

const KNOWN_QUANTS = [
  "Q4_0_4_4",
  "Q4_0_4_8",
  "Q4_0_8_8",
  "Q4_K_M",
  "Q4_K_S",
  "Q5_K_M",
  "Q5_K_S",
  "Q3_K_L",
  "Q3_K_M",
  "Q3_K_S",
  "Q2_K_S",
  "IQ2_XXS",
  "IQ3_XXS",
  "IQ2_XS",
  "IQ3_XS",
  "IQ4_XS",
  "IQ4_NL",
  "IQ1_M",
  "IQ1_S",
  "IQ2_M",
  "IQ2_S",
  "IQ3_M",
  "IQ3_S",
  "TQ1_0",
  "TQ2_0",
  "Q2_K",
  "Q6_K",
  "Q4_0",
  "Q4_1",
  "Q5_0",
  "Q5_1",
  "Q8_0",
  "BF16",
  "F16",
  "F32",
] as const;

class PausedDownload extends Error {
  constructor() {
    super("Download paused");
  }
}

class CancelledDownload extends Error {
  constructor() {
    super("Download cancelled");
  }
}

export function createModelLibrary(deps: ModelLibraryDeps): {
  list(): Promise<ModelRecord[]>;
  get(slug: string): Promise<ModelRecord | null>;
  ensureFallback(onProgress?: (job: DownloadJob) => void): Promise<ModelRecord>;
  startDownload(req: {
    hfRepo: string;
    file: string;
    expectedSha256?: string;
    displayName?: string;
    slug?: string;
  }): Promise<DownloadJob>;
  startDownloadJob(req: {
    hfRepo: string;
    file: string;
    expectedSha256?: string;
    displayName?: string;
    slug?: string;
  }): Promise<DownloadJob>;
  pauseDownload(id: string): Promise<void>;
  resumeDownload(id: string): Promise<void>;
  cancelDownload(id: string): Promise<void>;
  listDownloads(): DownloadJob[];
  remove(slug: string): Promise<void>;
  importDir(dir: string): Promise<ModelRecord[]>;
  setModelConfig(slug: string, cfg: ModelRuntimeConfig): Promise<void>;
  setBenchmark(slug: string, result: ModelBenchmarkResult): Promise<void>;
} {
  const modelsDir = path.join(deps.rootDir, ROOT_LAYOUT.modelsDir);
  const recordsFile = path.join(modelsDir, RECORDS_FILE);
  const downloads = new Map<string, DownloadTask>();
  const queue: DownloadTask[] = [];
  let activeTask: DownloadTask | null = null;
  let recordsCache: ModelRecord[] | null = null;
  let writeChain: Promise<void> = Promise.resolve();

  async function ensureStorage(): Promise<void> {
    await fsp.mkdir(modelsDir, { recursive: true });
  }

  async function loadRecords(): Promise<ModelRecord[]> {
    if (recordsCache !== null) {
      return recordsCache;
    }

    await ensureStorage();
    try {
      const raw = await fsp.readFile(recordsFile, "utf8");
      recordsCache = JSON.parse(raw) as ModelRecord[];
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        recordsCache = [];
      } else {
        throw error;
      }
    }
    return recordsCache;
  }

  async function saveRecords(records: ModelRecord[]): Promise<void> {
    recordsCache = records;
    const write = writeChain.catch(() => undefined).then(async () => {
      await ensureStorage();
      const tmp = path.join(modelsDir, `${RECORDS_FILE}.${process.pid}.${randomUUID()}.tmp`);
      await fsp.writeFile(tmp, `${JSON.stringify(records, null, 2)}\n`, "utf8");
      await fsp.rename(tmp, recordsFile);
    });
    writeChain = write;
    await write;
  }

  function emitModelsChanged(): void {
    deps.emit({ kind: "models.changed" });
  }

  function emitProgress(task: DownloadTask, force = false): void {
    const now = deps.now();
    if (!force && now - task.lastProgressEmitAt < PROGRESS_INTERVAL_MS) {
      return;
    }
    task.lastProgressEmitAt = now;
    const job = copyJob(task.job);
    deps.emit({ kind: "download.progress", job });
    task.onProgress?.(job);
  }

  async function startDownloadTask(req: DownloadRequest, options: DownloadOptions = {}): Promise<StartedDownloadTask> {
    validateDownloadRequest(req);
    await ensureStorage();
    const records = await loadRecords();
    const targetPath = modelTargetPath(modelsDir, req.hfRepo, req.file);
    const existing = records.find((record) => path.resolve(record.file) === path.resolve(targetPath));
    if (existing) {
      const job: DownloadJob = {
        id: randomUUID(),
        slug: existing.slug,
        hfRepo: req.hfRepo,
        file: req.file,
        totalBytes: existing.sizeBytes,
        receivedBytes: existing.sizeBytes,
        phase: "active",
        error: null,
      };
      return { job, done: Promise.resolve(copyJob(job)) };
    }

    const existingTask = findMatchingDownloadTask(req);
    if (existingTask) {
      return { job: copyJob(existingTask.job), done: existingTask.done };
    }

    const usedSlugs = new Set([
      ...records.map((record) => record.slug),
      ...Array.from(downloads.values()).map((task) => task.job.slug),
    ]);
    const slug = options.slugOverride ?? uniqueSlug(downloadSlugBase(req.hfRepo, req.file), usedSlugs);
    const job: DownloadJob = {
      id: randomUUID(),
      slug,
      hfRepo: req.hfRepo,
      file: req.file,
      totalBytes: null,
      receivedBytes: 0,
      phase: "queued",
      error: null,
    };
    let resolve!: (job: DownloadJob) => void;
    let reject!: (error: Error) => void;
    const done = new Promise<DownloadJob>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const task: DownloadTask = {
      job,
      req,
      targetPath,
      partPath: `${targetPath}.part`,
      done,
      resolve,
      reject,
      controller: null,
      pauseRequested: false,
      cancelRequested: false,
      lastProgressEmitAt: 0,
      onProgress: options.onProgress,
    };

    downloads.set(job.id, task);
    queue.push(task);
    emitProgress(task, true);
    pumpQueue();
    return { job: copyJob(task.job), done: task.done };
  }

  async function startDownloadInternal(req: DownloadRequest, options: DownloadOptions = {}): Promise<DownloadJob> {
    return (await startDownloadTask(req, options)).done;
  }

  async function startDownloadJobInternal(req: DownloadRequest, options: DownloadOptions = {}): Promise<DownloadJob> {
    const started = await startDownloadTask(req, options);
    void started.done.catch(() => {
      // The job starter is intentionally nonblocking; callers observe failures
      // through listDownloads()/download.progress or the streaming API.
    });
    return started.job;
  }

  function findMatchingDownloadTask(req: DownloadRequest): DownloadTask | null {
    for (const task of downloads.values()) {
      if (task.req.hfRepo === req.hfRepo && task.req.file === req.file) return task;
    }
    return null;
  }

  function pumpQueue(): void {
    if (activeTask !== null) {
      return;
    }

    const task = queue.shift();
    if (!task) {
      return;
    }

    activeTask = task;
    task.job.phase = "active";
    task.job.error = null;
    emitProgress(task, true);
    void runDownload(task)
      .then((job) => {
        downloads.delete(task.job.id);
        task.resolve(job);
      })
      .catch((error: unknown) => {
        if (error instanceof PausedDownload) {
          if (task.job.phase !== "queued") {
            task.job.phase = "paused";
          }
          task.controller = null;
          emitProgress(task, true);
          return;
        }

        downloads.delete(task.job.id);
        const normalized = normalizeError(error);
        task.job.error = normalized.message;
        task.reject(normalized);
      })
      .finally(() => {
        if (activeTask === task) {
          activeTask = null;
        }
        pumpQueue();
      });
  }

  async function runDownload(task: DownloadTask): Promise<DownloadJob> {
    await fsp.mkdir(path.dirname(task.targetPath), { recursive: true });
    task.pauseRequested = false;
    task.cancelRequested = false;
    const controller = new AbortController();
    task.controller = controller;

    let resumeFrom = await fileSize(task.partPath);
    task.job.receivedBytes = resumeFrom;
    const headers = new Headers();
    if (resumeFrom > 0) {
      headers.set("Range", `bytes=${resumeFrom}-`);
    }

    const url = hfResolveUrl(task.req.hfRepo, task.req.file);
    deps.log("local-models: download start", {
      url,
      rangeStart: resumeFrom,
      target: task.targetPath,
    });

    try {
      const response = await deps.fetch(url, { headers, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`Model download failed with HTTP ${response.status}`);
      }

      const resumed = resumeFrom > 0 && response.status === 206;
      if (resumeFrom > 0 && !resumed) {
        await unlinkIfExists(task.partPath);
        resumeFrom = 0;
        task.job.receivedBytes = 0;
      }

      task.job.totalBytes = responseTotalBytes(response, resumeFrom);
      emitProgress(task, true);
      await preflightDiskSpace(path.dirname(task.targetPath), task.job.totalBytes, task.job.receivedBytes);

      const hash = createHash("sha256");
      if (resumed) {
        await updateHashFromFile(hash, task.partPath);
      }

      const body = response.body;
      if (!body) {
        throw new Error("Model download response had no body");
      }

      const handle = await fsp.open(task.partPath, resumed ? "a" : "w");
      try {
        const reader = body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }
            if (task.pauseRequested) {
              throw new PausedDownload();
            }
            if (task.cancelRequested) {
              throw new CancelledDownload();
            }
            if (value.byteLength === 0) {
              continue;
            }

            await handle.write(value);
            hash.update(value);
            task.job.receivedBytes += value.byteLength;
            emitProgress(task);
          }
        } finally {
          reader.releaseLock();
        }
      } finally {
        await handle.close();
      }

      const digest = hash.digest("hex");
      if (task.req.expectedSha256 && digest.toLowerCase() !== task.req.expectedSha256.toLowerCase()) {
        await unlinkIfExists(task.partPath);
        throw new Error(
          `Checksum mismatch for ${task.req.hfRepo}/${task.req.file}: expected ${task.req.expectedSha256}, got ${digest}`
        );
      }

      await fsp.rename(task.partPath, task.targetPath);
      const record = await buildRecord({
        slug: task.job.slug,
        displayName: task.req.displayName ?? displayNameForDownload(task.req.hfRepo, task.req.file),
        hfRepo: task.req.hfRepo,
        file: task.targetPath,
        sha256: digest,
        importedInPlace: false,
      });
      const records = await loadRecords();
      await saveRecords([...records.filter((item) => item.slug !== record.slug), record]);
      task.job.totalBytes = record.sizeBytes;
      task.job.receivedBytes = record.sizeBytes;
      emitProgress(task, true);
      emitModelsChanged();
      deps.log("local-models: download complete", {
        hfRepo: task.req.hfRepo,
        file: task.req.file,
        slug: record.slug,
        sha256: digest,
      });
      return copyJob(task.job);
    } catch (error) {
      if (task.pauseRequested || isAbortError(error)) {
        throw new PausedDownload();
      }
      if (task.cancelRequested || error instanceof CancelledDownload) {
        await unlinkIfExists(task.partPath);
        throw new CancelledDownload();
      }
      await unlinkIfExists(task.partPath);
      throw error;
    } finally {
      task.controller = null;
    }
  }

  async function buildRecord(input: BuildRecordInput): Promise<ModelRecord> {
    const stat = await fsp.stat(input.file);
    const meta = parseGgufHeader(await readFilePrefix(input.file, HEADER_READ_BYTES));
    const quant = (meta.quantLabel ?? quantFromFilename(input.file) ?? "unknown") as QuantName;
    return {
      slug: input.slug,
      displayName: input.displayName,
      hfRepo: input.hfRepo,
      file: path.resolve(input.file),
      sizeBytes: stat.size,
      quant,
      paramCount: meta.paramCountLabel ?? inferParamCount(input.displayName, input.file),
      arch: meta.arch,
      trainedContextLength:
        meta.contextLength ?? (input.slug === FALLBACK_MODEL.slug ? FALLBACK_MODEL.contextLength : 4096),
      toolsCapable: detectToolsCapable(meta.chatTemplate),
      sha256: input.sha256,
      importedInPlace: input.importedInPlace,
      config: { contextLength: null, gpuLayers: null },
      benchmark: null,
      addedAt: deps.now(),
    };
  }

  return {
    async list(): Promise<ModelRecord[]> {
      return (await loadRecords()).map(copyRecord);
    },

    async get(slug: string): Promise<ModelRecord | null> {
      return copyRecord((await loadRecords()).find((record) => record.slug === slug) ?? null);
    },

    async ensureFallback(onProgress?: (job: DownloadJob) => void): Promise<ModelRecord> {
      const existing = (await loadRecords()).find((record) => record.slug === FALLBACK_MODEL.slug);
      if (existing) {
        return copyRecord(existing);
      }

      const file = fallbackFileName();
      await startDownloadInternal(
        {
          hfRepo: FALLBACK_MODEL.hfRepo,
          file,
          displayName: FALLBACK_MODEL.displayName,
        },
        { slugOverride: FALLBACK_MODEL.slug, onProgress }
      );
      const record = (await loadRecords()).find((item) => item.slug === FALLBACK_MODEL.slug);
      if (!record) {
        throw new Error("Fallback model download completed without creating a record");
      }
      return copyRecord(record);
    },

    startDownload(req: DownloadRequest): Promise<DownloadJob> {
      return startDownloadInternal(req, req.slug ? { slugOverride: req.slug } : {});
    },

    startDownloadJob(req: DownloadRequest): Promise<DownloadJob> {
      return startDownloadJobInternal(req, req.slug ? { slugOverride: req.slug } : {});
    },

    async pauseDownload(id: string): Promise<void> {
      const task = mustFindDownload(id);
      if (task.job.phase === "paused") {
        return;
      }
      removeFromQueue(queue, task);
      task.job.phase = "paused";
      task.pauseRequested = true;
      task.controller?.abort();
      emitProgress(task, true);
    },

    async resumeDownload(id: string): Promise<void> {
      const task = mustFindDownload(id);
      if (task.job.phase !== "paused") {
        return;
      }
      task.pauseRequested = false;
      task.cancelRequested = false;
      task.job.phase = "queued";
      task.job.error = null;
      queue.push(task);
      emitProgress(task, true);
      pumpQueue();
    },

    async cancelDownload(id: string): Promise<void> {
      const task = mustFindDownload(id);
      removeFromQueue(queue, task);
      task.cancelRequested = true;
      task.controller?.abort();
      downloads.delete(id);
      await unlinkIfExists(task.partPath);
      task.reject(new CancelledDownload());
    },

    listDownloads(): DownloadJob[] {
      return Array.from(downloads.values()).map((task) => copyJob(task.job));
    },

    async remove(slug: string): Promise<void> {
      if (slug === FALLBACK_MODEL.slug) {
        throw new Error(`Refusing to remove fallback model ${FALLBACK_MODEL.ref}; it is required for local models.`);
      }

      const records = await loadRecords();
      const record = records.find((item) => item.slug === slug);
      if (!record) {
        return;
      }

      if (!record.importedInPlace) {
        await unlinkIfExists(record.file);
      }
      await saveRecords(records.filter((item) => item.slug !== slug));
      emitModelsChanged();
    },

    async importDir(dir: string): Promise<ModelRecord[]> {
      const root = path.resolve(dir);
      const records = await loadRecords();
      const indexedPaths = new Set(records.map((record) => path.resolve(record.file)));
      const usedSlugs = new Set(records.map((record) => record.slug));
      const ggufs = await findGgufFiles(root);
      const added: ModelRecord[] = [];

      for (const file of ggufs) {
        const resolved = path.resolve(file);
        if (indexedPaths.has(resolved)) {
          continue;
        }

        const header = parseGgufHeader(await readFilePrefix(resolved, HEADER_READ_BYTES));
        const quant = header.quantLabel ?? quantFromFilename(resolved) ?? "gguf";
        const slug = uniqueSlug(importSlugBase(resolved, quant), usedSlugs);
        usedSlugs.add(slug);
        const record = await buildRecord({
          slug,
          displayName: displayNameForFile(resolved),
          hfRepo: null,
          file: resolved,
          sha256: await sha256File(resolved),
          importedInPlace: true,
        });
        added.push(record);
        indexedPaths.add(resolved);
      }

      if (added.length > 0) {
        await saveRecords([...records, ...added]);
        emitModelsChanged();
      }

      return added.map(copyRecord);
    },

    async setModelConfig(slug: string, cfg: ModelRuntimeConfig): Promise<void> {
      const records = await loadRecords();
      const index = records.findIndex((record) => record.slug === slug);
      if (index === -1) {
        throw new Error(`Model ${slug} is not installed`);
      }

      const next = records.slice();
      const record = records[index];
      if (!record) {
        throw new Error(`Model ${slug} is not installed`);
      }
      next[index] = {
        ...record,
        config: {
          contextLength: cfg.contextLength,
          gpuLayers: cfg.gpuLayers,
        },
      };
      await saveRecords(next);
      emitModelsChanged();
    },

    async setBenchmark(slug: string, result: ModelBenchmarkResult): Promise<void> {
      if (!Number.isFinite(result.tokensPerSec) || result.tokensPerSec <= 0) {
        throw new Error(`Invalid benchmark tokens/sec for ${slug}: ${result.tokensPerSec}`);
      }
      if (!Number.isFinite(result.measuredAt) || result.measuredAt <= 0) {
        throw new Error(`Invalid benchmark timestamp for ${slug}: ${result.measuredAt}`);
      }

      const records = await loadRecords();
      const index = records.findIndex((record) => record.slug === slug);
      if (index === -1) {
        throw new Error(`Model ${slug} is not installed`);
      }

      const next = records.slice();
      const record = records[index];
      if (!record) {
        throw new Error(`Model ${slug} is not installed`);
      }
      next[index] = {
        ...record,
        benchmark: {
          tokensPerSec: result.tokensPerSec,
          measuredAt: result.measuredAt,
        },
      };
      await saveRecords(next);
      emitModelsChanged();
    },
  };

  function mustFindDownload(id: string): DownloadTask {
    const task = downloads.get(id);
    if (!task) {
      throw new Error(`Download ${id} not found`);
    }
    return task;
  }
}

export function estimateFit(
  record: Pick<ModelRecord, "sizeBytes" | "trainedContextLength">,
  profile: HardwareProfile
): FitEstimate {
  const sizeMB = record.sizeBytes / (1024 * 1024);
  const gpu = profile.chosenGpu ?? profile.gpus[0] ?? null;
  let fit: FitEstimate["fit"];

  if (gpu && gpu.vramMB > 0) {
    if (sizeMB <= gpu.vramMB * 0.8) {
      fit = "full-gpu";
    } else if (sizeMB <= (gpu.vramMB + profile.usableRamMB) * 0.8) {
      fit = "partial-offload";
    } else {
      fit = "too-big";
    }
  } else if (sizeMB <= profile.usableRamMB * 0.8) {
    fit = "cpu-only";
  } else {
    fit = "too-big";
  }

  const contextLimit =
    fit === "full-gpu" ? 32768 : fit === "partial-offload" ? 16384 : fit === "cpu-only" ? 8192 : 8192;
  const trainedContextLength = record.trainedContextLength > 0 ? record.trainedContextLength : contextLimit;
  const gpuLayers = fit === "full-gpu" ? 99 : fit === "partial-offload" ? -1 : 0;
  const notes =
    fit === "too-big"
      ? ["Model weights exceed the configured VRAM/RAM fit budget."]
      : [`Fit class ${fit} uses an 80% memory budget for model weights.`];

  return {
    fit,
    estTokensPerSec: null,
    contextLength: Math.min(trainedContextLength, contextLimit),
    gpuLayers,
    notes,
  };
}

function validateDownloadRequest(req: DownloadRequest): void {
  const parts = req.hfRepo.split("/");
  if (parts.length !== 2 || parts.some((part) => !isSafePathSegment(part))) {
    throw new Error(`Invalid Hugging Face repo id: ${req.hfRepo}`);
  }
  if (!isSafePathSegment(req.file) || !req.file.toLowerCase().endsWith(".gguf")) {
    throw new Error(`Invalid GGUF file name: ${req.file}`);
  }
}

function isSafePathSegment(segment: string): boolean {
  return segment.length > 0 && segment !== "." && segment !== ".." && !segment.includes("/") && !segment.includes("\\");
}

function modelTargetPath(modelsDir: string, hfRepo: string, file: string): string {
  const [publisher, repo] = hfRepo.split("/");
  if (publisher === undefined || repo === undefined) {
    throw new Error(`Invalid Hugging Face repo id: ${hfRepo}`);
  }
  return path.join(modelsDir, publisher, repo, file);
}

function hfResolveUrl(hfRepo: string, file: string): string {
  return `https://huggingface.co/${hfRepo}/resolve/main/${encodeURIComponent(file)}?download=true`;
}

function responseTotalBytes(response: Response, resumeFrom: number): number | null {
  const contentRange = response.headers.get("content-range");
  if (contentRange) {
    const match = /^bytes\s+\d+-\d+\/(\d+|\*)$/i.exec(contentRange.trim());
    if (match?.[1] && match[1] !== "*") {
      return Number(match[1]);
    }
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength)) {
    const length = Number(contentLength);
    return response.status === 206 ? resumeFrom + length : length;
  }

  return null;
}

async function preflightDiskSpace(dir: string, totalBytes: number | null, receivedBytes: number): Promise<void> {
  if (totalBytes === null) {
    return;
  }

  const remaining = Math.max(0, totalBytes - receivedBytes);
  const stat = await fsp.statfs(dir);
  const available = Number(stat.bavail) * Number(stat.bsize);
  if (available < remaining) {
    throw new Error(
      `Insufficient disk space for model download: need ${formatBytes(remaining)}, available ${formatBytes(available)}`
    );
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

async function readFilePrefix(file: string, maxBytes: number): Promise<Uint8Array> {
  const handle = await fsp.open(file, "r");
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await updateHashFromFile(hash, file);
  return hash.digest("hex");
}

async function updateHashFromFile(hash: ReturnType<typeof createHash>, file: string): Promise<void> {
  const stream = createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk as Uint8Array);
  }
}

async function fileSize(file: string): Promise<number> {
  try {
    return (await fsp.stat(file)).size;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
}

async function unlinkIfExists(file: string): Promise<void> {
  try {
    await fsp.unlink(file);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function findGgufFiles(dir: string): Promise<string[]> {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findGgufFiles(fullPath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
      files.push(fullPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function removeFromQueue(queue: DownloadTask[], task: DownloadTask): void {
  const index = queue.indexOf(task);
  if (index !== -1) {
    queue.splice(index, 1);
  }
}

function copyJob(job: DownloadJob): DownloadJob {
  return { ...job };
}

function copyRecord<T extends ModelRecord | null>(record: T): T {
  if (record === null) {
    return record;
  }
  const copy: ModelRecord = {
    ...record,
    config: { ...record.config },
    ...(record.benchmark === undefined
      ? {}
      : { benchmark: record.benchmark ? { ...record.benchmark } : null }),
  };
  return copy as T;
}

function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function downloadSlugBase(hfRepo: string, file: string): string {
  const repoName = hfRepo.split("/").at(-1) ?? "model";
  const sansGguf = repoName.replace(/[-_.]?gguf$/i, "");
  return slugify(`${sansGguf}-${quantFromFilename(file) ?? "gguf"}`);
}

function importSlugBase(file: string, quant: string): string {
  const basename = path.basename(file, path.extname(file));
  const suffix = slugify(quant);
  const base = slugify(basename).replace(new RegExp(`-${escapeRegExp(suffix)}$`), "");
  return slugify(`${base}-${quant}`);
}

function uniqueSlug(base: string, used: Set<string>): string {
  const safeBase = base || "model";
  if (!used.has(safeBase)) {
    used.add(safeBase);
    return safeBase;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${safeBase}-${index}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\.gguf$/i, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

function quantFromFilename(file: string): string | null {
  const upper = path.basename(file).toUpperCase();
  return KNOWN_QUANTS.find((quant) => upper.includes(quant)) ?? null;
}

function inferParamCount(displayName: string, file: string): string {
  const match = /(\d+(?:\.\d+)?)\s*([BM])/i.exec(`${displayName} ${file}`);
  const count = match?.[1];
  const unit = match?.[2];
  return count && unit ? `${count}${unit.toUpperCase()}` : "unknown";
}

function displayNameForDownload(hfRepo: string, file: string): string {
  const repoName = hfRepo.split("/").at(-1) ?? "Model";
  const base = path.basename(file, path.extname(file));
  return titleize(base || repoName);
}

function displayNameForFile(file: string): string {
  return titleize(path.basename(file, path.extname(file)));
}

function titleize(value: string): string {
  return value.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

function fallbackFileName(): string {
  const repoName = FALLBACK_MODEL.hfRepo.split("/").at(-1)?.replace(/[-_.]?gguf$/i, "") ?? "model";
  return `${repoName}-${FALLBACK_MODEL.quant}.gguf`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
