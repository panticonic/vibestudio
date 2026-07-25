/**
 * local-models extension — installs and supervises llama.cpp, serves local
 * GGUF models to the agent harness as the `local` provider, and guarantees
 * the LFM2.5 fallback floor (design: docs/local-models-extension-design.md).
 *
 * Extension-owned engine pattern (git-bridge precedent): all operational
 * logic lives here; the host only forwards events and the model-settings
 * worker only projects `listModels()` into the catalog.
 *
 * Modules: hardware.ts (probe) · engine.ts (llama.cpp install) · library.ts
 * (GGUF library/downloads) · supervisor.ts (servers + single-owner lock).
 */

import { execFile, spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createHardwareProfiler } from "./hardware.js";
import { createEngineInstaller } from "./engine.js";
import {
  createModelLibrary,
  estimateFit,
  isCurrentFallbackRecord,
} from "./library.js";
import { createServerSupervisor } from "./supervisor.js";
import { runtimeContextLengthFor } from "./runtime-profiles.js";
import { runModelBenchmark } from "./benchmark.js";
import {
  FALLBACK_MODEL,
  ROOT_LAYOUT,
  type CuratedModel,
  type DownloadJob,
  type EnginePin,
  type EngineState,
  type HardwareProfile,
  type LocalModelEntry,
  type LocalModelsEvent,
  type LocalModelsStatus,
  type ModelRecord,
  type ModelRuntimeConfig,
  type ServerKind,
  type ServerState,
} from "./types.js";

/**
 * Pinned llama.cpp build (design §4.2, risk #3): bumped with extension
 * updates, validated by the e2e suite on every bump. Every installable release
 * asset must have a pinned checksum; missing checksums fail closed before
 * extraction/execution.
 */
const ENGINE_PIN: EnginePin = {
  buildTag: "b10107", // published 2026-07-24; asset names locked by engine tests
  checksums: {
    "cudart-llama-bin-win-cuda-12.4-x64.zip":
      "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
    "cudart-llama-bin-win-cuda-13.3-x64.zip":
      "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e",
    "llama-b10107-bin-android-arm64.tar.gz":
      "aec87eb7ca00f0e331e13312c90a9ff0aa0e310f2eb12f97b9d2763ef5a2f10c",
    "llama-b10107-bin-macos-arm64.tar.gz":
      "b9554ab4c9f6e91199f48387cb4ab27466fb1d724881f81463ef03f6370cfa32",
    "llama-b10107-bin-macos-x64.tar.gz":
      "6f35c90a6e9f33c905d09694946b82a29b4ab530a358226d95d832262f526ea2",
    "llama-b10107-bin-ubuntu-arm64.tar.gz":
      "1f93c35122865287824ef0dc040e24190b18edc6e163152be9ac10b8aaeafeef",
    "llama-b10107-bin-ubuntu-openvino-2026.2.1-x64.tar.gz":
      "828ed66fc7936c4b49bda2c667bf5ef38acb0f77de02c75955af666a94858667",
    "llama-b10107-bin-ubuntu-rocm-7.2-x64.tar.gz":
      "c7a3c6332add60718a26e2986ede21f74ce658ac8beb04630b65409f485699ad",
    "llama-b10107-bin-ubuntu-s390x.tar.gz":
      "274af6f7fe0b40f6053b1f3e7e1659228ba24cc8aa638467644b6f3669804ee5",
    "llama-b10107-bin-ubuntu-sycl-fp16-x64.tar.gz":
      "8bc558d669c0769859fd7617e1870706ea82e86e4a0ab20c362464ac985b5d59",
    "llama-b10107-bin-ubuntu-sycl-fp32-x64.tar.gz":
      "58fe78ef6d6f77b87c7e580262bc03e98b69d6711aa8939c778f1286c8bdc98d",
    "llama-b10107-bin-ubuntu-vulkan-arm64.tar.gz":
      "c786b0f5269964e6c9385bf68ffeb275c070b5a5bfcc7d9cea0d8ae6d6790bc1",
    "llama-b10107-bin-ubuntu-vulkan-x64.tar.gz":
      "28f86dfce8c3723d4e9fd971b8456d946e09324708880533091399d284fe9add",
    "llama-b10107-bin-ubuntu-x64.tar.gz":
      "afe1ae0b706c4a0830b218a9249037b7a6cc723f81deb78825662128b25453e6",
    "llama-b10107-bin-win-cpu-arm64.zip":
      "5fc3757d28de88902665091c27d34011fa4fe569d7b57b19fcc9c3431bb02a06",
    "llama-b10107-bin-win-cpu-x64.zip":
      "52133a0a5a8f6035b1bdd2f89c3425ea8b742413d9bdb9a2dee30e3a1681b18c",
    "llama-b10107-bin-win-cuda-12.4-x64.zip":
      "1e43bbec9691cd0bc636603c366769148fa6265fd261c5f7c67050b450bbc237",
    "llama-b10107-bin-win-cuda-13.3-x64.zip":
      "ee48a48839f07b8ac3b5929783bf0320dc370e7ff6cfa567473c8ca11c9b2336",
    "llama-b10107-bin-win-hip-radeon-x64.zip":
      "b55e43c94c80c222de5854db32e6ac00e0f27cd6cba1d41c04de585aab623014",
    "llama-b10107-bin-win-opencl-adreno-arm64.zip":
      "1adca072b5ef8203409bb75258faa5ab7476d93fcf1bd38fbc44cb68cb3b1eef",
    "llama-b10107-bin-win-openvino-2026.2.1-x64.zip":
      "2d67cb0b3970a08b668d4fee056a5fdacdaeb54163a20b40fdd0acec9f48a60b",
    "llama-b10107-bin-win-sycl-x64.zip":
      "8232f68d1e6e8b29dcc4cf8a3b1832cd155652062de92292e443b426f47e910c",
    "llama-b10107-bin-win-vulkan-x64.zip":
      "c5b3a5ee8319b1eccbb748a54390aa806bbf7d1aceeea452e4c57921d113e53e",
    "llama-b10107-ui.tar.gz": "eb661eb8709398e3d825663d261847dea73708c09db540bb5fa267cb04224a91",
    "llama-b10107-xcframework.zip":
      "d640b6679bb7092832dcd96dc7b78af1bee4af54582f85edf990ce4444c2401e",
  },
};

const BENCHMARK_RECENT_MS = 7 * 24 * 60 * 60 * 1000;

/** Curated, hardware-tier-filtered starter catalog (design §4.3). Hashes are
 *  trust-on-first-download until pinned here. */
const CURATED_CATALOG: CuratedModel[] = [
  {
    slug: FALLBACK_MODEL.slug,
    displayName: FALLBACK_MODEL.displayName,
    hfRepo: FALLBACK_MODEL.hfRepo,
    quantByTier: {
      "gpu-large": "Q8_0",
      "gpu-mid": "Q4_0",
      "gpu-small": "Q4_0",
      "cpu-strong": "Q4_0",
      "cpu-min": "Q4_0",
    },
    sha256ByQuant: {},
    toolsCapable: true,
    blurb: "The bundled fallback: fast, compact, and available for one-click installation.",
  },
  {
    slug: "qwen3-4b",
    displayName: "Qwen3 4B",
    hfRepo: "Qwen/Qwen3-4B-GGUF",
    quantByTier: {
      "gpu-large": "Q8_0",
      "gpu-mid": "Q5_K_M",
      "gpu-small": "Q4_K_M",
      "cpu-strong": "Q4_K_M",
    },
    sha256ByQuant: {},
    toolsCapable: true,
    blurb: "Official agent-capable local model with native tool calling.",
  },
  {
    slug: "qwen3-8b",
    displayName: "Qwen3 8B",
    hfRepo: "Qwen/Qwen3-8B-GGUF",
    quantByTier: { "gpu-large": "Q8_0", "gpu-mid": "Q4_K_M" },
    sha256ByQuant: {},
    toolsCapable: true,
    blurb: "The mid-GPU sweet spot: full offload on 8 GB cards at Q4.",
  },
  {
    slug: "gpt-oss-20b",
    displayName: "GPT-OSS 20B",
    hfRepo: "ggml-org/gpt-oss-20b-GGUF",
    quantByTier: { "gpu-large": "Q8_0", "gpu-mid": "Q4_K_M" },
    sha256ByQuant: {},
    toolsCapable: true,
    blurb: "Larger reasoning-capable model; partial offload on mid GPUs.",
  },
];

type BootstrapStage = "idle" | "probing" | "engines" | "ready" | "error";

interface DownloadModelRequest {
  hfRepo: string;
  file: string;
  expectedSha256?: string;
  displayName?: string;
  slug?: string;
}

interface ExtensionInvocationLike {
  caller?: { kind?: string; id?: string };
  userlandCaller?: { kind?: string; id?: string };
}

/** Structural slice of ExtensionContext we use (git-bridge precedent: keep
 *  the extension decoupled from host packages via structural typing). */
interface Ctx {
  log: { info(msg: string, data?: unknown): void; warn?(msg: string, data?: unknown): void };
  emit(event: string, payload: unknown): void;
  health?: {
    healthy(detail?: unknown): void;
    degraded(detail: unknown): void;
    unhealthy(detail: unknown): void;
  };
  invocation?: {
    current(): ExtensionInvocationLike | null;
    signal?(): AbortSignal | null;
  };
  workspace?: { getInfo(): Promise<{ id: string }> };
  subscriptions?: { push(disposable: { dispose(): void }): void };
}

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@vibestudio/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/local-models": Api;
  }
}

function defaultRootDir(): string {
  const override = process.env["VIBESTUDIO_LOCAL_MODELS_DIR"];
  if (override && override.trim()) return override.trim();
  // Machine-global by design (§4.3): models/engines are hardware assets, not
  // workspace state. Location is configurable via the panel/env override.
  return path.join(os.homedir(), ".vibestudio", "local-models");
}

const ENV_BLOCKLIST = [/^LD_PRELOAD$/u, /^NODE_OPTIONS$/u, /^DYLD_/u];

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (ENV_BLOCKLIST.some((pattern) => pattern.test(key))) continue;
    env[key] = value;
  }
  return env;
}

function execAdapter(
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; env?: Record<string, string> }
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: opts?.timeoutMs ?? 30_000,
        env: opts?.env ?? cleanEnv(),
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === "number"
            ? ((error as { code?: number }).code ?? null)
            : error
              ? null
              : 0;
        resolve({ ok: !error, stdout: String(stdout), stderr: String(stderr), code });
      }
    );
  });
}

function spawnAdapter(
  bin: string,
  args: string[],
  opts: {
    env: Record<string, string>;
    onExit(code: number | null): void;
    onStdout(line: string): void;
    onStderr(line: string): void;
  }
): { pid: number; kill(signal?: string): void } {
  const child = nodeSpawn(bin, args, {
    env: { ...cleanEnv(), ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  createInterface({ input: child.stdout }).on("line", opts.onStdout);
  createInterface({ input: child.stderr }).on("line", opts.onStderr);
  child.on("exit", (code) => opts.onExit(code));
  child.on("error", () => opts.onExit(null));
  return {
    pid: child.pid ?? -1,
    kill: (signal?: string) => {
      try {
        child.kill((signal as NodeJS.Signals | undefined) ?? "SIGTERM");
      } catch {
        // already gone
      }
    },
  };
}

function jsonLineStream<T>(
  subscribe: (push: (value: T) => void, end: (error?: string) => void) => () => void
): Response {
  const encoder = new TextEncoder();
  let cleanup: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      cleanup = subscribe(
        (value) => controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`)),
        (error) => {
          if (error) controller.enqueue(encoder.encode(`${JSON.stringify({ error })}\n`));
          controller.close();
          cleanup?.();
        }
      );
    },
    cancel() {
      cleanup?.();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}

export async function activate(ctx: Ctx) {
  const rootDir = defaultRootDir();
  await fs.mkdir(rootDir, { recursive: true });
  const log = (msg: string, data?: unknown) => ctx.log.info(`local-models: ${msg}`, data);
  const emit = (event: LocalModelsEvent) => {
    try {
      ctx.emit(event.kind, event);
    } catch {
      // host not listening — events are best-effort
    }
  };

  let workspaceId = "unknown";
  try {
    workspaceId = (await ctx.workspace?.getInfo())?.id ?? "unknown";
  } catch {
    // headless/test hosts may not expose workspace info
  }

  // ── module wiring ─────────────────────────────────────────────────────
  let profile: HardwareProfile | null = null;
  let engineState: EngineState | null = null;
  let bootstrapStage: BootstrapStage = "idle";
  let bootstrapError: string | null = null;
  let bootstrapRun: Promise<void> | null = null;

  const profiler = createHardwareProfiler({
    exec: (cmd, args, timeoutMs) => execAdapter(cmd, args, { timeoutMs }),
    readFile: (file) => fs.readFile(file, "utf8"),
    platform: process.platform,
    arch: process.arch,
    totalMemBytes: os.totalmem(),
    cpuCount: os.cpus().length,
    log,
  });

  const engines = createEngineInstaller({
    rootDir,
    fetch: globalThis.fetch,
    exec: execAdapter,
    log,
  });

  const library = createModelLibrary({
    rootDir,
    fetch: globalThis.fetch,
    log,
    emit,
    now: () => Date.now(),
  });

  const supervisor = createServerSupervisor({
    rootDir,
    workspaceId,
    spawn: spawnAdapter,
    fetch: globalThis.fetch,
    log,
    emit: (event) => {
      emit(event);
      if (event.kind === "server.state") reportHealth();
    },
    engines: () => engineState,
    fallbackModel: () => library.get(FALLBACK_MODEL.slug),
    libraryModel: (slug) => library.get(slug),
    libraryModels: () => library.list(),
    now: () => Date.now(),
    killPid: (pid) => {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    },
  });

  /** Health reflects the readiness to *serve* a local model on demand, not a
   *  warm fallback: the fallback is loaded lazily (design §5), so a stopped
   *  utility server is normal, not degraded. Healthy = engines installed and
   *  the owner lock resolved; degraded during install; unhealthy only if the
   *  engine install failed or a demanded server hit its terminal error. */
  function reportHealth(): void {
    if (!ctx.health) return;
    if (bootstrapStage === "error") {
      ctx.health.unhealthy({ reason: bootstrapError, stage: "bootstrap" });
      return;
    }
    if (bootstrapStage !== "ready") {
      ctx.health.degraded({ stage: bootstrapStage });
      return;
    }
    // A server only reaches "error" after a caller demanded it and it failed
    // its retry budget — surface that as degraded (the floor is best-effort,
    // cloud providers may still be serving), never as a hard unhealthy.
    const utility = supervisor.status().utility;
    if (utility.state === "error") {
      ctx.health.degraded({ reason: utility.message, server: "utility" });
      return;
    }
    ctx.health.healthy({ fallback: FALLBACK_MODEL.ref, warm: false });
  }

  async function loadCachedProfile(): Promise<HardwareProfile | null> {
    try {
      const raw = await fs.readFile(path.join(rootDir, "hardware.json"), "utf8");
      return JSON.parse(raw) as HardwareProfile;
    } catch {
      return null;
    }
  }

  async function probeHardware(refresh: boolean): Promise<HardwareProfile> {
    if (!refresh) {
      const cached = profile ?? (await loadCachedProfile());
      if (cached) {
        profile = cached;
        return cached;
      }
    }
    const probed = await profiler.probe();
    profile = probed;
    await fs
      .writeFile(path.join(rootDir, "hardware.json"), JSON.stringify(probed, null, 2))
      .catch(() => {});
    return probed;
  }

  /** Bootstrap (design §5): probe → engines → resolve the owner lock. It does
   *  NOT download or warm the fallback: the fallback floor is loaded lazily on
   *  the first ensureLoaded() (no warm-fallback guarantee), so bootstrap only
   *  gets the machine to a state where any local model *can* be served on
   *  demand. Idempotent and restartable; failures land in bootstrapError. */
  async function bootstrap(): Promise<void> {
    try {
      bootstrapStage = "probing";
      const hw = await probeHardware(false);
      bootstrapStage = "engines";
      engineState = await engines.ensureInstalled(hw, ENGINE_PIN);
      // Resolve the single-owner lock so ports/api-key exist and this process
      // knows its role — but leave both servers cold. The utility server
      // starts on the first fallback ensureLoaded; the main server on the
      // first non-fallback ensureLoaded.
      await supervisor.activate();
      bootstrapStage = "ready";
      bootstrapError = null;
      emit({ kind: "models.changed" });
    } catch (err) {
      bootstrapStage = "error";
      bootstrapError = err instanceof Error ? err.message : String(err);
      log("bootstrap failed", { error: bootstrapError });
      throw err instanceof Error ? err : new Error(bootstrapError);
    } finally {
      reportHealth();
    }
  }

  function ensureBootstrap(): Promise<void> {
    if (bootstrapStage === "ready") return Promise.resolve();
    if (bootstrapRun && bootstrapStage !== "error") return bootstrapRun;
    bootstrapRun = bootstrap();
    return bootstrapRun;
  }

  /** Normalize a "local:slug" or bare "slug" ref to its bare slug. */
  function bareSlug(modelId: string): string {
    return modelId.startsWith("local:") ? modelId.slice("local:".length) : modelId;
  }

  /** Release this caller's wait when its RPC is cancelled. Model bootstrap is
   * supervisor-owned and may still satisfy another caller; cancellation does
   * not tear down that shared machine resource. */
  async function awaitInvocation<T>(work: Promise<T>): Promise<T> {
    const signal = ctx.invocation?.signal?.() ?? null;
    if (!signal) return work;
    const abortError = (): Error =>
      signal.reason instanceof Error ? signal.reason : new Error("local-model invocation aborted");
    if (signal.aborted) throw abortError();
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      void work.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  }

  // Fire-and-forget: activation must not block on engine install/probing. The
  // build-time activation smoke verifies the exported API against a synthetic
  // context; it must not install native engines or leave background processes.
  if (process.env["VIBESTUDIO_EXTENSION_SMOKE"] !== "1") {
    void ensureBootstrap().catch(() => {});
  }
  const benchmarkRuns = new Map<string, Promise<{ tokensPerSec: number } | null>>();
  const addValidationRuns = new Map<string, Promise<void>>();

  function hasRecentBenchmark(record: ModelRecord | null): boolean {
    const benchmark = record?.benchmark ?? null;
    return (
      benchmark !== null &&
      Number.isFinite(benchmark.tokensPerSec) &&
      benchmark.tokensPerSec > 0 &&
      Date.now() - benchmark.measuredAt < BENCHMARK_RECENT_MS
    );
  }

  async function ensureLoadedInternal(
    modelId: string,
    options: { scheduleFallbackBenchmark?: boolean } = {}
  ): Promise<{ baseUrl: string }> {
    await awaitInvocation(ensureBootstrap());
    const slug = bareSlug(modelId);
    if (slug === FALLBACK_MODEL.slug) {
      const fallback = await awaitInvocation(library.ensureFallback());
      if (fallback.runtimeValidation?.status === "pending") {
        await awaitInvocation(validateAddedModel(slug));
      } else if (fallback.runtimeValidation?.status === "error") {
        throw new Error(
          fallback.runtimeValidation.error ?? `Local model ${slug} failed installation validation`
        );
      }
      if (options.scheduleFallbackBenchmark) {
        scheduleBenchmark(slug);
      }
    } else {
      const record = await library.get(slug);
      if (record?.runtimeValidation?.status === "pending") {
        throw new Error(`Local model ${slug} is still being installed`);
      }
      if (record?.runtimeValidation?.status === "error") {
        throw new Error(
          record.runtimeValidation.error ?? `Local model ${slug} failed installation validation`
        );
      }
    }
    return awaitInvocation(supervisor.ensureLoaded(slug));
  }

  async function validateAddedModel(slug: string): Promise<void> {
    const active = addValidationRuns.get(slug);
    if (active) return active;
    const record = await library.get(slug);
    // Records created before add-time validation are preconfigured models:
    // they remain trusted and are never probed during startup or invocation.
    if (!record?.runtimeValidation || record.runtimeValidation.status === "ready") return;
    if (record.runtimeValidation.status === "error") {
      throw new Error(
        record.runtimeValidation.error ?? `Local model ${slug} failed installation validation`
      );
    }

    const run = (async () => {
      try {
        // Downloads and imports may finish while activation's native-engine
        // bootstrap is still in flight. Validation owns an isolated llama.cpp
        // process, so it must join that bootstrap before attempting to spawn.
        await ensureBootstrap();
        await supervisor.validateModel(slug);
        await library.setRuntimeValidation(slug, {
          status: "ready",
          error: null,
          validatedAt: Date.now(),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await library.setRuntimeValidation(slug, {
          status: "error",
          error: message,
          validatedAt: null,
        });
        throw error;
      }
    })();
    addValidationRuns.set(slug, run);
    try {
      await run;
    } finally {
      if (addValidationRuns.get(slug) === run) addValidationRuns.delete(slug);
    }
  }

  async function benchmarkModelInternal(
    modelId: string,
    opts: { force?: boolean } = {}
  ): Promise<{ tokensPerSec: number } | null> {
    const slug = bareSlug(modelId);
    const existingRun = benchmarkRuns.get(slug);
    if (existingRun) {
      return existingRun;
    }

    const run = (async () => {
      const record = await library.get(slug).catch(() => null);
      const recentBenchmark = record?.benchmark ?? null;
      if (opts.force !== true && hasRecentBenchmark(record) && recentBenchmark) {
        return { tokensPerSec: recentBenchmark.tokensPerSec };
      }

      return runModelBenchmark(slug, {
        fetch: globalThis.fetch,
        ensureLoaded: (candidate) => ensureLoadedInternal(candidate),
        apiKey: () => supervisor.apiKey(),
        setBenchmark: (candidate, result) => library.setBenchmark(candidate, result),
        now: () => Date.now(),
        log,
      });
    })();

    benchmarkRuns.set(slug, run);
    try {
      return await run;
    } finally {
      if (benchmarkRuns.get(slug) === run) {
        benchmarkRuns.delete(slug);
      }
    }
  }

  function scheduleBenchmark(modelId: string): void {
    void benchmarkModelInternal(modelId).catch((error: unknown) => {
      log("benchmark scheduling failed", {
        slug: bareSlug(modelId),
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async function finishModelAddition(download: Promise<DownloadJob>): Promise<DownloadJob> {
    const job = await download;
    await validateAddedModel(job.slug);
    scheduleBenchmark(job.slug);
    return job;
  }

  function startDownloadWithBenchmark(req: DownloadModelRequest): Promise<DownloadJob> {
    return finishModelAddition(library.startDownload(req));
  }

  async function startDownloadJobWithBenchmark(req: DownloadModelRequest): Promise<DownloadJob> {
    const job = await library.startDownloadJob(req);
    void finishModelAddition(library.startDownload(req)).catch((error: unknown) => {
      log("model installation validation failed", {
        slug: job.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    return job;
  }

  function matchesDownloadRequest(job: DownloadJob, req: DownloadModelRequest): boolean {
    if (req.slug && job.slug !== req.slug) return false;
    return job.hfRepo === req.hfRepo && job.file === req.file;
  }

  function downloadJobKey(job: DownloadJob): string {
    return [
      job.id,
      job.slug,
      job.hfRepo,
      job.file,
      job.totalBytes ?? "",
      job.receivedBytes,
      job.phase,
      job.error ?? "",
    ].join("\0");
  }

  function findDownloadForRequest(
    req: DownloadModelRequest,
    opts: { id?: string | null; ignoreIds?: ReadonlySet<string> } = {}
  ): DownloadJob | null {
    const matches = library.listDownloads().filter((job) => matchesDownloadRequest(job, req));
    if (opts.id) return matches.find((job) => job.id === opts.id) ?? null;
    return matches.find((job) => !opts.ignoreIds?.has(job.id)) ?? null;
  }

  function serverForRecord(record: ModelRecord): ServerKind {
    return record.slug === FALLBACK_MODEL.slug ? "utility" : "main";
  }

  function baseUrlFor(kind: ServerKind, servers: Record<ServerKind, ServerState>): string {
    const state = servers[kind];
    if (state.state === "running") return `http://127.0.0.1:${state.port}/v1`;
    const info = supervisor.ownerInfo();
    const port = info ? (kind === "utility" ? info.ports.utility : info.ports.main) : 0;
    return `http://127.0.0.1:${port}/v1`;
  }

  function recordState(
    record: ModelRecord,
    servers: Record<ServerKind, ServerState>,
    downloads: DownloadJob[]
  ): {
    state: LocalModelEntry["state"];
    download: LocalModelEntry["download"];
    error: string | null;
  } {
    const download = downloads.find((job) => job.slug === record.slug && !job.error);
    if (download) {
      return { state: "downloading", download: downloadStatus(download), error: null };
    }
    const failedDownload = downloads.find((job) => job.slug === record.slug && job.error);
    if (failedDownload) {
      return {
        state: "error",
        download: null,
        error: failedDownload.error ?? "Model download failed",
      };
    }
    if (bootstrapStage === "error") {
      return {
        state: "error",
        download: null,
        error: bootstrapError ?? "local-models bootstrap failed",
      };
    }
    if (bootstrapStage === "probing" || bootstrapStage === "engines") {
      return { state: "starting", download: null, error: null };
    }
    if (record.runtimeValidation?.status === "pending") {
      return { state: "starting", download: null, error: null };
    }
    if (record.runtimeValidation?.status === "error") {
      return {
        state: "error",
        download: null,
        error: record.runtimeValidation.error ?? "Model installation validation failed",
      };
    }
    const kind = serverForRecord(record);
    const server = servers[kind];
    if (server.state === "error") {
      return { state: "error", download: null, error: server.message };
    }
    if (server.state === "running") {
      const loaded = kind === "utility" || server.loadedModels.includes(record.slug);
      return { state: loaded ? "ready" : "startable", download: null, error: null };
    }
    // Downloaded but the server is cold: startable — ensureLoaded starts the
    // server (and, for the fallback, its lazy load) on demand.
    return { state: "startable", download: null, error: null };
  }

  function downloadStatus(job: DownloadJob): NonNullable<LocalModelEntry["download"]> {
    return {
      progress: job.totalBytes ? job.receivedBytes / job.totalBytes : 0,
      phase: job.phase,
      receivedBytes: job.receivedBytes,
      totalBytes: job.totalBytes,
    };
  }

  async function listModels(): Promise<LocalModelEntry[]> {
    const [records, hw] = await Promise.all([
      library.list(),
      probeHardware(false).catch(() => null),
    ]);
    const servers = supervisor.status();
    const downloads = library.listDownloads();
    const entries = records
      .filter(
        (record) =>
          record.slug !== FALLBACK_MODEL.slug || isCurrentFallbackRecord(record)
      )
      .map((record) => {
        const kind = serverForRecord(record);
        const status = recordState(record, servers, downloads);
        const contextWindow = runtimeContextLengthFor(record);
        return {
          slug: record.slug,
          displayName: record.displayName,
          baseUrl: baseUrlFor(kind, servers),
          server: kind,
          contextWindow,
          maxTokens: contextWindow,
          toolsCapable: record.toolsCapable,
          fit: hw
            ? estimateFit(record, hw)
            : {
                fit: "cpu-only",
                estTokensPerSec: null,
                contextLength: contextWindow,
                gpuLayers: 0,
                notes: ["hardware profile unavailable"],
              },
          measuredTokensPerSec: record.benchmark?.tokensPerSec ?? null,
          state: status.state,
          download: status.download,
          errorMessage: status.error,
        } satisfies LocalModelEntry;
      });

    // The fallback floor must stay visible in the picker even before it is
    // downloaded (design §5/§8): it is installable, not absent. An absent file
    // is explicitly not-installed; the chat/model picker starts the download
    // and blocks agent launch until the record exists.
    if (!entries.some((entry) => entry.slug === FALLBACK_MODEL.slug)) {
      const fallbackDownload = downloads.find(
        (job) => job.slug === FALLBACK_MODEL.slug && !job.error
      );
      const fallbackFailure = downloads.find(
        (job) => job.slug === FALLBACK_MODEL.slug && job.error
      );
      const contextWindow = FALLBACK_MODEL.contextLength;
      entries.unshift({
        slug: FALLBACK_MODEL.slug,
        displayName: FALLBACK_MODEL.displayName,
        baseUrl: baseUrlFor("utility", servers),
        server: "utility",
        contextWindow,
        maxTokens: contextWindow,
        toolsCapable: true,
        fit: {
          fit: "cpu-only",
          estTokensPerSec: null,
          contextLength: contextWindow,
          gpuLayers: 0,
          notes: ["explicit installation required"],
        },
        measuredTokensPerSec: null,
        state: fallbackDownload
          ? "downloading"
          : fallbackFailure
            ? "error"
            : bootstrapStage === "error"
              ? "error"
              : "not-installed",
        download: fallbackDownload ? downloadStatus(fallbackDownload) : null,
        errorMessage: fallbackFailure?.error
          ? fallbackFailure.error
          : bootstrapStage === "error"
            ? (bootstrapError ?? "local-models bootstrap failed")
            : null,
      } satisfies LocalModelEntry);
    }
    return entries;
  }

  async function status(): Promise<LocalModelsStatus> {
    const servers = supervisor.status();
    const storedFallback = await library.get(FALLBACK_MODEL.slug);
    const fallbackRecord = isCurrentFallbackRecord(storedFallback)
      ? storedFallback
      : null;
    const utilityRunning = servers.utility.state === "running";
    let diskFreeBytes = 0;
    try {
      const stats = await fs.statfs(rootDir);
      diskFreeBytes = Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // statfs unsupported — panel shows "unknown"
    }
    return {
      role: supervisor.role(),
      owner: supervisor.ownerInfo(),
      hardware: profile,
      engine: engineState,
      servers,
      fallback: {
        // ready = downloaded and loadable on demand; warm = currently serving.
        // The floor is lazy (design §5) — a downloaded-but-cold fallback is the
        // healthy default, so `ready` no longer requires the utility server.
        ready:
          Boolean(fallbackRecord) &&
          fallbackRecord?.runtimeValidation?.status !== "pending" &&
          fallbackRecord?.runtimeValidation?.status !== "error",
        warm: utilityRunning,
        modelRef: FALLBACK_MODEL.ref,
        reason:
          fallbackRecord?.runtimeValidation?.status === "pending"
            ? "installing"
            : fallbackRecord?.runtimeValidation?.status === "error"
              ? (fallbackRecord.runtimeValidation.error ?? "installation validation failed")
              : fallbackRecord
                ? null
                : bootstrapStage === "ready"
                  ? "not installed"
                  : (bootstrapError ?? `bootstrap ${bootstrapStage}`),
      },
      downloads: library.listDownloads(),
      storageRoot: rootDir,
      diskFreeBytes,
    };
  }

  /** getLoopbackAuth caller gate (design §6.3): refuse panels/apps/workers
   *  outright; among do-kind callers require the agent-vessel allowlist.
   *  Defense in depth — workspace DOs are trusted units; the key's threat
   *  model is foreign local processes. */
  function assertLoopbackAuthCaller(): void {
    const invocation = ctx.invocation?.current();
    if (!invocation) return; // direct host invocation (tests, CLI bridge)
    const caller = invocation.userlandCaller ?? invocation.caller;
    if (!caller?.kind) return;
    if (caller.kind !== "do") {
      throw new Error(`getLoopbackAuth: refused for caller kind "${caller.kind}"`);
    }
    const id = caller.id ?? "";
    const allowlisted = /agent|vessel/iu.test(id);
    if (!allowlisted) {
      throw new Error(`getLoopbackAuth: do-kind caller "${id}" is not an agent vessel`);
    }
  }

  const api = {
    async status(): Promise<LocalModelsStatus> {
      return status();
    },

    async listModels(): Promise<LocalModelEntry[]> {
      return listModels();
    },

    async ensureLoaded(modelId: string): Promise<{ baseUrl: string }> {
      // Lazy fallback (design §5): the LFM2.5 floor is downloaded on first
      // demand, not eagerly at bootstrap. ensureFallback is idempotent and a
      // no-op once the GGUF is present, so warm calls stay cheap. A completed
      // lazy fallback download schedules a background benchmark.
      return ensureLoadedInternal(modelId, { scheduleFallbackBenchmark: true });
    },

    /**
     * Start installation without waiting for the model transfer. The model
     * remains unavailable to agents until listModels() reports startable/ready.
     */
    async installModel(modelId: string): Promise<DownloadJob | null> {
      const slug = bareSlug(modelId);
      if (slug !== FALLBACK_MODEL.slug) {
        throw new Error(`Model ${modelId} is not available for one-click installation`);
      }
      if (isCurrentFallbackRecord(await library.get(slug))) return null;
      await awaitInvocation(ensureBootstrap());
      const cachedFallbackPath = path.join(
        rootDir,
        ROOT_LAYOUT.modelsDir,
        ...FALLBACK_MODEL.hfRepo.split("/"),
        FALLBACK_MODEL.file
      );
      try {
        const cached = await fs.stat(cachedFallbackPath);
        if (cached.isFile()) {
          const record = await library.ensureFallback();
          await validateAddedModel(record.slug);
          return null;
        }
      } catch (error) {
        if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
      }
      return startDownloadJobWithBenchmark({
        hfRepo: FALLBACK_MODEL.hfRepo,
        file: FALLBACK_MODEL.file,
        displayName: FALLBACK_MODEL.displayName,
        slug: FALLBACK_MODEL.slug,
      });
    },

    async getLoopbackAuth(): Promise<{ apiKey: string }> {
      assertLoopbackAuthCaller();
      await awaitInvocation(ensureBootstrap());
      return { apiKey: await awaitInvocation(supervisor.apiKey()) };
    },

    async getHardwareProfile(refresh?: boolean): Promise<HardwareProfile> {
      return probeHardware(refresh === true);
    },

    async searchCatalog(query?: string): Promise<CuratedModel[]> {
      const hw = await probeHardware(false).catch(() => null);
      const tierFiltered = CURATED_CATALOG.filter(
        (model) => !hw || model.quantByTier[hw.tier] !== undefined
      );
      if (!query || !query.trim()) return tierFiltered;
      const needle = query.trim().toLowerCase();
      return tierFiltered.filter(
        (model) =>
          model.displayName.toLowerCase().includes(needle) ||
          model.hfRepo.toLowerCase().includes(needle)
      );
    },

    /** Fire-and-forget download start for panel/CLI consumers — progress
     *  arrives via status().downloads polling and download.progress events. */
    async startDownloadJob(req: DownloadModelRequest): Promise<DownloadJob> {
      return startDownloadJobWithBenchmark(req);
    },

    /** Streaming NDJSON download progress (streamingMethods). */
    downloadModel(req: DownloadModelRequest): Response {
      return jsonLineStream<DownloadJob>((push, end) => {
        let closed = false;
        let downloadId: string | null = null;
        let lastPushedKey: string | null = null;
        let poll: ReturnType<typeof setInterval> | null = null;
        const ignoredDownloadIds = new Set(library.listDownloads().map((job) => job.id));

        const stop = (error?: string) => {
          if (closed) return;
          closed = true;
          if (poll) {
            clearInterval(poll);
            poll = null;
          }
          end(error);
        };
        const pushOnce = (job: DownloadJob) => {
          const key = downloadJobKey(job);
          if (key === lastPushedKey) return;
          lastPushedKey = key;
          push(job);
        };
        const pollOnce = () => {
          if (closed) return;
          const current = findDownloadForRequest(req, {
            id: downloadId,
            ignoreIds: ignoredDownloadIds,
          });
          if (!current) return;
          downloadId = current.id;
          pushOnce(current);
          if (current.error) {
            stop(current.error);
          }
        };

        let download: Promise<DownloadJob>;
        try {
          download = startDownloadWithBenchmark(req);
        } catch (err) {
          stop(err instanceof Error ? err.message : String(err));
          return () => {};
        }

        poll = setInterval(pollOnce, 500);
        queueMicrotask(pollOnce);
        download
          .then((job) => {
            downloadId = job.id;
            pushOnce(job);
            stop();
          })
          .catch((err) => stop(err instanceof Error ? err.message : String(err)));
        return () => {
          closed = true;
          if (poll) clearInterval(poll);
        };
      });
    },

    async pauseDownload(id: string): Promise<void> {
      await library.pauseDownload(id);
    },
    async resumeDownload(id: string): Promise<void> {
      await library.resumeDownload(id);
    },
    async cancelDownload(id: string): Promise<void> {
      await library.cancelDownload(id);
    },
    async listDownloads(): Promise<DownloadJob[]> {
      return library.listDownloads();
    },

    async removeModel(slug: string): Promise<void> {
      await library.remove(slug);
      emit({ kind: "models.changed" });
    },

    async importDir(dir: string): Promise<ModelRecord[]> {
      const imported = await library.importDir(dir);
      await Promise.all(imported.map((record) => validateAddedModel(record.slug)));
      emit({ kind: "models.changed" });
      return Promise.all(
        imported.map(async (record) => (await library.get(record.slug)) ?? record)
      );
    },

    async setModelConfig(slug: string, cfg: ModelRuntimeConfig): Promise<void> {
      await library.setModelConfig(slug, cfg);
      emit({ kind: "models.changed" });
    },

    async benchmarkModel(
      slug: string,
      opts?: { force?: boolean }
    ): Promise<{ tokensPerSec: number } | null> {
      return benchmarkModelInternal(slug, opts);
    },

    async restartServer(which: ServerKind): Promise<void> {
      await supervisor.restart(which);
    },

    /** Plain log tail for panel/CLI consumers that don't stream. */
    async tailServerLogLines(which: ServerKind, lines?: number): Promise<string[]> {
      return supervisor.tailLog(which, lines ?? 200);
    },

    /** Streaming NDJSON log tail (streamingMethods). */
    tailServerLog(which: ServerKind): Response {
      return jsonLineStream<{ line: string }>((push, end) => {
        for (const line of supervisor.tailLog(which, 200)) push({ line });
        end();
        return () => {};
      });
    },

    async openConfigPanel(): Promise<{
      opened: boolean;
      openPanel: { source: string; name: string };
    }> {
      return {
        opened: false,
        openPanel: { source: "panels/local-models", name: "Local Models" },
      };
    },
  };

  return api;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code
  );
}

export async function deactivate(): Promise<void> {
  // Supervisor disposal happens via the activation closure's subscriptions in
  // hosts that support it; the OS-level owner lock also releases on process
  // exit, and a dead owner is taken over on the next activation (design §4.3).
}
