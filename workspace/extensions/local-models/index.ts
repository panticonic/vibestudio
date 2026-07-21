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
import { createModelLibrary, estimateFit } from "./library.js";
import { createServerSupervisor } from "./supervisor.js";
import { runModelBenchmark } from "./benchmark.js";
import {
  FALLBACK_MODEL,
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
  buildTag: "b9895", // verified live 2026-07-07; asset names locked by engine tests
  checksums: {
    "cudart-llama-bin-win-cuda-12.4-x64.zip":
      "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6",
    "cudart-llama-bin-win-cuda-13.3-x64.zip":
      "1462a050eb4c684921ba51dcc4cc488a036674c3e73e9945ee705b854808d03e",
    "llama-b9895-bin-android-arm64.tar.gz":
      "362f72212ea6bcc779f977ced45e172bc59a5d9c084939e6ebbec1bf24035963",
    "llama-b9895-bin-macos-arm64.tar.gz":
      "cd4a629d1bcdc0292bdb3ec4f4c3fd6c4632de85feb0524caac646d0659bc3ef",
    "llama-b9895-bin-macos-x64.tar.gz":
      "27808d34265f29fd16a2a3ab3c326d771be384a120afb5bd185bbff87bd61415",
    "llama-b9895-bin-ubuntu-arm64.tar.gz":
      "2b77400f6e795d3f3accaff62aa93b84eab1f655c9b14854d9c8535fe53fac45",
    "llama-b9895-bin-ubuntu-openvino-2026.2.1-x64.tar.gz":
      "a8bd4e47a337338b8aeb6cbe2ae30b4dc003cb25cea4a6f4a774e8b8b26fa27b",
    "llama-b9895-bin-ubuntu-rocm-7.2-x64.tar.gz":
      "168a45c556b4d68751279de329f8c23febc7b83a0d73b8feb51b373263e64f3c",
    "llama-b9895-bin-ubuntu-s390x.tar.gz":
      "91230a6a610a934aee955d376f7de928f5daa7329da57881e8fa67b4b3424870",
    "llama-b9895-bin-ubuntu-sycl-fp16-x64.tar.gz":
      "cd17bfa882db66d27f8a6d0c0add58850d9ca1c2fa6c803d442219a9a0594d8e",
    "llama-b9895-bin-ubuntu-sycl-fp32-x64.tar.gz":
      "12a5ffd3afeb05d8424b1b1b381e38d2ff88a68a104160630603a35a1923c51e",
    "llama-b9895-bin-ubuntu-vulkan-arm64.tar.gz":
      "a3038e4053a705d578c09d62bad6e92b911cf71976504fdaaaeeda5832d9290d",
    "llama-b9895-bin-ubuntu-vulkan-x64.tar.gz":
      "f0e26a2daa227e78253b837596718306afc75dad241e7980fbcabc61bdcb2d6c",
    "llama-b9895-bin-ubuntu-x64.tar.gz":
      "910b574007d0848a99eb6cefd3c715c68deccc3e17f53cea27ffbaf1bf46ea16",
    "llama-b9895-bin-win-cpu-arm64.zip":
      "a36c43da9126c977709e2c6ed4af5afe7ded9c3178d920ffe295f7c08b80f4b0",
    "llama-b9895-bin-win-cpu-x64.zip":
      "a69d92ae6a3e352c5c389f3798b6c287d73100d84612753506dc55b10f517c05",
    "llama-b9895-bin-win-cuda-12.4-x64.zip":
      "b9511fba86de6abc6707c8d855ea26910a5bf416dd57cb8ddfb0b64dc2e0fe99",
    "llama-b9895-bin-win-cuda-13.3-x64.zip":
      "2032c87ca594b3f3e07f0d3444ffd3e78a3b953cc7c02e3fbb32559b1ef247c8",
    "llama-b9895-bin-win-hip-radeon-x64.zip":
      "e57386790fc94a1e65bfe9bac66797f2a52f1de78a3f0f9ced9539253d1a7d02",
    "llama-b9895-bin-win-opencl-adreno-arm64.zip":
      "524744001f1fff431fdf85b6031cf9e61a333a35ac59e3dd22bc9a7dce90f765",
    "llama-b9895-bin-win-openvino-2026.2.1-x64.zip":
      "f6acc6ca670ec1401d0ef67a9c3855da982d58e81e06829d676e21aab4fe4cad",
    "llama-b9895-bin-win-sycl-x64.zip":
      "33e0a3a37debd23908b7b3b8d9c03ce3e06ff95c74ac64121d109478cac47dee",
    "llama-b9895-bin-win-vulkan-x64.zip":
      "8db79022bcfe0fae5a2a9b466e6c6f4a47fe29c0fe4865a9a562a681ae1cd438",
    "llama-b9895-ui.tar.gz": "6a1771fd5f50585350ae659810b3e859c204249d4b13b48a224416c15825aa60",
    "llama-b9895-xcframework.zip":
      "886c75728c7e20c4d7bca819fa5219a5a2d642fb45a04044528a6515305e64a2",
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
      "gpu-mid": "Q4_K_M",
      "gpu-small": "Q4_K_M",
      "cpu-strong": "Q4_K_M",
      "cpu-min": "Q4_0",
    },
    sha256ByQuant: {},
    toolsCapable: true,
    blurb: "The always-available fallback: fast, tiny, agentic-tuned.",
  },
  {
    slug: "lfm2.5-230m",
    displayName: "LFM2.5 230M",
    hfRepo: "LiquidAI/LFM2.5-230M-GGUF",
    quantByTier: {
      "gpu-large": "Q8_0",
      "gpu-mid": "Q4_K_M",
      "gpu-small": "Q4_K_M",
      "cpu-strong": "Q4_K_M",
      "cpu-min": "Q4_K_M",
    },
    sha256ByQuant: {},
    toolsCapable: true,
    blurb: "The featherweight sibling — instant loads, runs on anything.",
  },
  {
    slug: "qwen3-4b-instruct",
    displayName: "Qwen3 4B Instruct",
    hfRepo: "Qwen/Qwen3-4B-Instruct-2507-GGUF",
    quantByTier: {
      "gpu-large": "Q8_0",
      "gpu-mid": "Q5_K_M",
      "gpu-small": "Q4_K_M",
      "cpu-strong": "Q4_K_M",
    },
    sha256ByQuant: {},
    toolsCapable: true,
    blurb: "Strong small generalist with solid tool calling.",
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
      await awaitInvocation(library.ensureFallback());
      if (options.scheduleFallbackBenchmark) {
        scheduleBenchmark(slug);
      }
    }
    return awaitInvocation(supervisor.ensureLoaded(slug));
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

  function scheduleBenchmarkAfterDownload(download: Promise<DownloadJob>): void {
    void download
      .then((job) => {
        scheduleBenchmark(job.slug);
      })
      .catch(() => {
        // Download failure already surfaces through the download job path.
      });
  }

  function startDownloadWithBenchmark(req: DownloadModelRequest): Promise<DownloadJob> {
    const download = library.startDownload(req);
    scheduleBenchmarkAfterDownload(download);
    return download;
  }

  async function startDownloadJobWithBenchmark(req: DownloadModelRequest): Promise<DownloadJob> {
    const job = await library.startDownloadJob(req);
    scheduleBenchmarkAfterDownload(library.startDownload(req));
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
  ): { state: LocalModelEntry["state"]; progress: number | null; error: string | null } {
    const download = downloads.find((job) => job.slug === record.slug && !job.error);
    if (download && download.phase !== "paused") {
      const progress = download.totalBytes ? download.receivedBytes / download.totalBytes : 0;
      return { state: "downloading", progress, error: null };
    }
    if (bootstrapStage === "error") {
      return {
        state: "error",
        progress: null,
        error: bootstrapError ?? "local-models bootstrap failed",
      };
    }
    const kind = serverForRecord(record);
    const server = servers[kind];
    if (server.state === "error") {
      return { state: "error", progress: null, error: server.message };
    }
    if (server.state === "running") {
      const loaded = kind === "utility" || server.loadedModels.includes(record.slug);
      return { state: loaded ? "ready" : "startable", progress: null, error: null };
    }
    // Downloaded but the server is cold: startable — ensureLoaded starts the
    // server (and, for the fallback, its lazy load) on demand.
    return { state: "startable", progress: null, error: null };
  }

  async function listModels(): Promise<LocalModelEntry[]> {
    const [records, hw] = await Promise.all([
      library.list(),
      probeHardware(false).catch(() => null),
    ]);
    const servers = supervisor.status();
    const downloads = library.listDownloads();
    const entries = records.map((record) => {
      const kind = serverForRecord(record);
      const status = recordState(record, servers, downloads);
      const contextWindow = record.config.contextLength ?? record.trainedContextLength;
      return {
        slug: record.slug,
        displayName: record.displayName,
        baseUrl: baseUrlFor(kind, servers),
        server: kind,
        contextWindow,
        maxTokens: Math.min(4096, contextWindow),
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
        downloadProgress: status.progress,
        errorMessage: status.error,
      } satisfies LocalModelEntry;
    });

    // The fallback floor must stay visible in the picker even before it is
    // downloaded (design §5/§8): it is lazy, not absent. When no record exists
    // yet, advertise it as a "startable" entry that downloads + loads on first
    // use so the catalog's guaranteed floor never disappears.
    if (!entries.some((entry) => entry.slug === FALLBACK_MODEL.slug)) {
      const fallbackDownload = downloads.find(
        (job) => job.slug === FALLBACK_MODEL.slug && !job.error
      );
      const contextWindow = FALLBACK_MODEL.contextLength;
      entries.unshift({
        slug: FALLBACK_MODEL.slug,
        displayName: FALLBACK_MODEL.displayName,
        baseUrl: baseUrlFor("utility", servers),
        server: "utility",
        contextWindow,
        maxTokens: Math.min(4096, contextWindow),
        toolsCapable: true,
        fit: {
          fit: "cpu-only",
          estTokensPerSec: null,
          contextLength: contextWindow,
          gpuLayers: 0,
          notes: ["downloads on first use"],
        },
        measuredTokensPerSec: null,
        state:
          fallbackDownload && fallbackDownload.phase !== "paused"
            ? "downloading"
            : bootstrapStage === "error"
              ? "error"
              : "startable",
        downloadProgress: fallbackDownload?.totalBytes
          ? fallbackDownload.receivedBytes / fallbackDownload.totalBytes
          : null,
        errorMessage:
          bootstrapStage === "error" ? (bootstrapError ?? "local-models bootstrap failed") : null,
      } satisfies LocalModelEntry);
    }
    return entries;
  }

  async function status(): Promise<LocalModelsStatus> {
    const servers = supervisor.status();
    const fallbackRecord = await library.get(FALLBACK_MODEL.slug);
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
        ready: Boolean(fallbackRecord),
        warm: utilityRunning,
        modelRef: FALLBACK_MODEL.ref,
        reason: fallbackRecord
          ? null
          : bootstrapStage === "ready"
            ? "fallback downloads on first use"
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
      emit({ kind: "models.changed" });
      return imported;
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

export async function deactivate(): Promise<void> {
  // Supervisor disposal happens via the activation closure's subscriptions in
  // hosts that support it; the OS-level owner lock also releases on process
  // exit, and a dead owner is taken over on the next activation (design §4.3).
}
