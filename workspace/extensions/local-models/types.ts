/**
 * Shared contracts for the local-models extension.
 *
 * Design: docs/local-models-extension-design.md. Module boundaries:
 *   hardware.ts   — HardwareProfiler (§4.1)
 *   engine.ts     — EngineInstaller (§4.2)
 *   library.ts    — ModelLibrary (§4.3)
 *   supervisor.ts — ServerSupervisor + single-owner lock (§3, §4.4)
 *   index.ts      — activate() wiring + extension API (§4.5)
 *
 * Everything here is serializable (crosses the extension RPC boundary).
 * The loopback api-key must NEVER appear in any of these types except
 * LoopbackAuth, which is returned only by getLoopbackAuth() (§6.3).
 */

// ---------------------------------------------------------------- hardware

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple";
export type EngineBackend = "cuda-12.4" | "cuda-13.3" | "vulkan" | "rocm" | "metal" | "cpu";

export interface GpuInfo {
  vendor: GpuVendor;
  name: string;
  vramMB: number;
  backend: EngineBackend;
  discrete: boolean;
  /** Identifier usable with llama-server --device, when known. */
  deviceSelector?: string;
}

export type HardwareTier =
  | "gpu-large" // >= 20 GB VRAM
  | "gpu-mid" // 8–20 GB VRAM
  | "gpu-small" // < 8 GB VRAM
  | "cpu-strong" // no usable GPU, >= 16 GB RAM
  | "cpu-min"; // everything else

export interface HardwareProfile {
  os: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  gpus: GpuInfo[];
  cpu: { cores: number; features: string[] };
  ramMB: number;
  /** RAM the fit estimator may plan against (total minus a 4 GB floor). */
  usableRamMB: number;
  /** Backend chosen for the main server build (discrete GPU preferred; §4.1). */
  chosenBackend: EngineBackend;
  /** The GPU backing chosenBackend, if any. */
  chosenGpu: GpuInfo | null;
  tier: HardwareTier;
  probedAt: number;
  /** Non-fatal notes from probing (missing tools, degradations). */
  notes: string[];
}

// ------------------------------------------------------------------ engine

/** Pinned llama.cpp build; bumped with extension updates (§4.2, risk #3). */
export interface EnginePin {
  buildTag: string; // e.g. "b9894"
  /** sha256 per release asset name, from the release's checksums. */
  checksums: Record<string, string>;
}

export interface InstalledEngine {
  buildTag: string;
  backend: EngineBackend;
  /** Absolute dir containing llama-server (and cudart on win-cuda). */
  dir: string;
  serverBinPath: string;
  smokeTestedAt: number;
}

export interface EngineState {
  pin: EnginePin;
  /** Universal CPU build — utility server (§3). Always present after bootstrap. */
  cpu: InstalledEngine | null;
  /** Hardware-optimal build — main server; null while tier is cpu-*. */
  gpu: InstalledEngine | null;
  /** Why gpu degraded from HardwareProfile.chosenBackend, if it did (§4.2). */
  degradedReason: string | null;
}

// ----------------------------------------------------------------- library

export type QuantName =
  | "Q4_0"
  | "Q4_K_M"
  | "Q5_K_M"
  | "Q6_K"
  | "Q8_0"
  | "BF16"
  | "F16"
  | (string & {});

/** One installed GGUF (§4.3). Metadata read from the GGUF header. */
export interface ModelRecord {
  /** Stable slug used in "local:<slug>" refs (derived from repo+file). */
  slug: string;
  displayName: string;
  hfRepo: string | null; // null for imported loose files
  file: string; // absolute path to the .gguf
  sizeBytes: number;
  quant: QuantName;
  paramCount: string; // human form, e.g. "1.2B"
  arch: string; // GGUF general.architecture
  trainedContextLength: number;
  /** From chat-template inspection — gates tool schemas (§6.4). */
  toolsCapable: boolean;
  /** sha256; pinned (curated) or captured at download start (ad-hoc). */
  sha256: string;
  importedInPlace: boolean;
  /** User/auto-fit overrides. */
  config: ModelRuntimeConfig;
  /** Real decode throughput measured from a local llama.cpp completion. */
  benchmark?: ModelBenchmarkResult | null;
  addedAt: number;
}

export interface ModelRuntimeConfig {
  contextLength: number | null; // null → auto-fit
  gpuLayers: number | null; // null → auto-fit
}

export interface ModelBenchmarkResult {
  tokensPerSec: number;
  measuredAt: number;
}

/** Fit estimate for a model on the current hardware (§4.1 tiering, §7.2). */
export type FitClass = "full-gpu" | "partial-offload" | "cpu-only" | "too-big";

export interface FitEstimate {
  fit: FitClass;
  estTokensPerSec: number | null;
  contextLength: number;
  gpuLayers: number;
  notes: string[];
}

export interface CuratedModel {
  slug: string;
  displayName: string;
  hfRepo: string;
  /** Recommended quant per tier; absent tier → not recommended there. */
  quantByTier: Partial<Record<HardwareTier, QuantName>>;
  /** Pinned sha256 per quant file (§10 checksums). */
  sha256ByQuant: Record<string, string>;
  toolsCapable: boolean;
  blurb: string;
}

export type DownloadPhase = "active" | "queued" | "paused";

export interface DownloadJob {
  id: string;
  slug: string;
  hfRepo: string;
  file: string;
  totalBytes: number | null;
  receivedBytes: number;
  phase: DownloadPhase;
  error: string | null;
}

export interface DownloadModelRequest {
  hfRepo: string;
  file: string;
  expectedSha256?: string;
  displayName?: string;
  slug?: string;
}

// -------------------------------------------------------------- supervisor

export type ServerKind = "utility" | "main";

export type ServerState =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; port: number; loadedModels: string[]; uptimeMs: number }
  | { state: "backoff"; attempt: number; nextRetryMs: number }
  | { state: "error"; message: string; logTail: string[] };

export interface OwnerInfo {
  pid: number;
  bootId: string;
  ports: { utility: number; main: number };
  /** Authenticated loopback RPC used by attached extension processes to ask
   * the owner to materialize a cold server. */
  controlPort: number;
  workspaceId: string;
  since: number;
  /** Live server child pids — lets a takeover reap a dead owner's orphans. */
  serverPids?: { utility?: number; main?: number };
}

export type OwnershipRole = "owner" | "attached";

// --------------------------------------------------------------- extension API

export interface LocalModelsStatus {
  role: OwnershipRole;
  owner: OwnerInfo | null;
  hardware: HardwareProfile | null;
  engine: EngineState | null;
  servers: Record<ServerKind, ServerState>;
  fallback: {
    /** Downloaded and available to load lazily on demand (NOT necessarily
     *  running — the floor is loaded on first use, not kept warm). */
    ready: boolean;
    /** Currently loaded and serving (the utility server is running). */
    warm: boolean;
    modelRef: string; // "local:lfm2.5-1.2b"
    reason: string | null;
  };
  downloads: DownloadJob[];
  storageRoot: string;
  diskFreeBytes: number;
}

/** What listModels() returns — feeds buildModelCatalog() (§6.1). Secret-free. */
export interface LocalModelEntry {
  slug: string; // ref = "local:<slug>"
  displayName: string;
  baseUrl: string; // http://127.0.0.1:<port>/v1
  server: ServerKind;
  contextWindow: number;
  maxTokens: number;
  toolsCapable: boolean;
  fit: FitEstimate;
  measuredTokensPerSec: number | null;
  state: "ready" | "startable" | "downloading" | "error";
  downloadProgress: number | null;
  errorMessage: string | null;
}

export interface LoopbackAuth {
  apiKey: string;
}

export interface CatalogHit {
  hfRepo: string;
  displayName: string;
  files: Array<{ file: string; quant: QuantName; sizeBytes: number }>;
  curated: CuratedModel | null;
  fitByQuant: Record<string, FitEstimate>;
}

/** Events emitted via ctx.emit. */
export type LocalModelsEvent =
  | { kind: "models.changed" }
  | { kind: "download.progress"; job: DownloadJob }
  | { kind: "server.state"; server: ServerKind; state: ServerState };

// ------------------------------------------------------------------ layout

/** Machine-global root layout (§4.3). All paths relative to the root. */
export const ROOT_LAYOUT = {
  ownerLock: "owner.lock",
  ownerInfo: "owner.json",
  /** Raw api-key, 0600, lock-owner-written; passed via --api-key-file (§4.4). */
  authKey: "auth.key",
  config: "config.json",
  serverLog: (kind: ServerKind) => `${kind}-server.log`,
  enginesDir: "engines",
  modelsDir: "models",
} as const;

export const FALLBACK_MODEL = {
  slug: "lfm2.5-1.2b",
  ref: "local:lfm2.5-1.2b",
  displayName: "LFM2.5 1.2B Instruct",
  hfRepo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
  quant: "Q4_K_M" as QuantName,
  contextLength: 8192,
} as const;
