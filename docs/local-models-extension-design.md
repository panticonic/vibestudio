# Local Models Extension — Design

Local LLM inference as a first-class provider, delivered as a workspace extension
(`@workspace-extensions/local-models`) that installs and supervises **llama.cpp**,
auto-tunes it to the host hardware, exposes local models through the existing pi-ai
provider/catalog machinery so the chat panel and every Pi-harness agent can use them,
ships a **model manager panel**, and guarantees a tiny fallback model
(**LFM2.5-1.2B-Instruct**) — loaded lazily on demand, never kept warm — so the system
can answer even with zero working cloud providers, including on low-powered, GPU-less
machines, without paying for a resident model it may never use.

Status: committed design. This lands as **one big-bang change**: extension, provider
integration, fallback semantics, picker redesign, and panel ship together in a single
PR — no phases, no feature flags, no deferred halves, no optional variants. Every
open point below has a committed resolution; §12 lists the risks and how each is
handled *inside* this change. Companion reading: `EXTENSIONS.md`, `PANEL_SYSTEM.md`,
`docs/ws1-agent-loop-spec.md`, `docs/credential-system.md`,
`docs/multi-user-wp1-hub-control-plane.md`.

---

## 1. Goals

1. **Seamless install** — enabling the extension is the whole setup: it detects the
   hardware, downloads the right llama.cpp build and the fallback model, and local
   models simply appear in the model picker. No terminal, no flags, no Ollama.
2. **Hardware-optimal** — pick the correct backend binary (CUDA / Metal / Vulkan /
   ROCm / CPU-AVX), auto-fit GPU offload and context per model, and only offer models
   the machine can actually run well.
3. **Full harness parity** — local models are ordinary `"provider:modelId"` refs in
   `AgentSettings.model`; streaming, tool calling, and thinking flow through the same
   `model_call` executor as Anthropic/OpenAI. Agents on channels can run entirely local.
4. **Great configuration UX** — a `local-models` panel for the model library,
   downloads, server status, and hardware profile.
5. **Honest availability in the picker** — the model selection UI knows which
   providers are *actually usable right now* (credentialed cloud, running local) and
   says so, instead of listing 200 models it can't call.
6. **Guaranteed floor** — LFM2.5-1.2B-Instruct (~731 MB GGUF Q4_K_M, runs CPU-only
   under 1 GB RAM) is installed by default and kept servable at all times; when no
   other provider works, the system falls back to it automatically.
7. **E2e-testable by construction** — the local model turns the whole agentic stack
   into something CI can exercise headlessly, offline, with zero cloud keys; the app
   CLI grows the commands to drive it (§11).

### Out of scope (rejected, not deferred)

- Training/fine-tuning, embeddings endpoints, multimodal local models (LLaVA etc.).
- Exposing the local server to other devices (bind is `127.0.0.1` only).
- Quality-tiered auto-routing ("fast local model for title generation, cloud for the
  turn") — a different feature; gets its own design if ever wanted.
- Speculative decoding / draft models; multi-machine serving.

### Design stance

We are pre-release with no external users: **nothing in the existing system is
load-bearing enough to design around**. Where the current shape makes this feature
awkward, this change refactors the current shape — journal schema, catalog types,
executor resolution, picker component — rather than adding parallel paths beside it.
Code quality and user experience are the only two currencies; backward compatibility
and migration shims buy neither. Concretely, this change refactors: model resolution
(§6.2 — journaled `modelSpec` replaces registry lookups *for all providers*), model
auth (§6.3 — an explicit per-model auth mode replaces the implicit
everything-needs-a-credential assumption), availability (§7.1 — one worker-computed
source replaces the chat panel's private heuristic), and the model picker (§7.2 —
rewritten, not patched).

---

## 2. Verified ground truth this design builds on

Codebase (paths verified 2026-07-07):

- **Extensions are trusted first-party Node processes** with full `node:child_process`
  / `node:fs` / network access, granted once by the elevated install approval
  (`EXTENSIONS.md`; context surface `packages/extension/src/index.ts:355-396`). The
  host supervises the extension process itself with crash-restart backoff
  (`packages/extension-host/src/processManager.ts`); the extension supervises its own
  external binaries — precedents: `workspace/extensions/shell/sessionManager.ts`
  (PTY/child-process supervision, `kill`/`restart`, env sanitization) and
  `workspace/extensions/git-bridge/upstream.ts` (the "extension-owned engine": all
  operational logic in the extension, host only forwards events).
- **Extensions do not render UI**; they pair with a panel in `workspace/panels/<name>/`
  and return `openPanel` descriptors (pattern: `git-bridge/upstream.ts:526`). Panels
  call back via `extensions.use("@workspace-extensions/<name>")`.
- **All models come from pi-ai** (`@earendil-works/pi-ai` v0.78.0, vendored+patched).
  `Model<TApi>` (`dist/types.d.ts:478`) carries `api`, `provider`, `baseUrl`, `compat`;
  `Provider` and `Api` are **open string types**, and `stream(model, ctx, opts)`
  dispatches purely on `model.api` (`dist/stream.js:23-29`). The
  `"openai-completions"` handler already does streaming + tool calls against an
  arbitrary `baseUrl` (`dist/providers/openai-completions.js:382`) — and **requires a
  non-empty `options.apiKey`** (throws `No API key for provider` otherwise,
  `openai-completions.js:72-74`), which §6.3 accounts for. The static registry
  (`models.generated.js`) has **no runtime injection API**.
- **The app catalog is built in one place**: `buildModelCatalog()` in
  `workspace/workers/model-settings/index.ts:41-93`, served as
  `ModelSettingsSnapshot` (protocol `vibestudio.models.v1`) to both the chat panel
  picker and agent config. Fallback default logic: `pickFallbackModel`
  (`model-settings/index.ts:203-208`), currently `openai-codex:gpt-5.5` → first
  recommended → first model.
- **The single LLM call site for agents** is
  `workspace/packages/agentic-do/src/effect-executors/model-call.ts`
  (`executeModelCall`, `:560`): resolves the model via pi-ai `getModel(provider, id)`
  (`:582`, **aborts on miss**, `:648-656`), resolves a credential by base URL
  (`:610`; missing credential → turn *suspends* with a connect card,
  `agent-vessel.ts:866-910`), then calls `stream()` (`:691-698`) with an optional
  `request.modelBaseUrl` override.
- **Credential egress**: pi-ai gets a sentinel apiKey; a patched `fetch` reroutes
  sentinel-bearing requests through `credentials.proxyFetch`
  (`workspace/packages/agentic-do/src/model-fetch-proxy.ts`). `findRoute()`
  **explicitly returns null for localhost** (`model-fetch-proxy.ts:93`), and
  non-sentinel requests pass through the original `fetch` untouched (`:212`). So a
  non-sentinel request to `http://127.0.0.1:<port>` bypasses the proxy entirely —
  local inference needs **no egress-proxy changes**, only an explicit loopback auth
  mode in the executor (§6.3).
- **"Connected" in the picker today = credential presence**, not health:
  `workspace/panels/chat/index.tsx:452-469` matches stored credential audiences
  against model `baseUrl`. Picker component:
  `workspace/packages/agentic-chat/components/ModelPicker.tsx` (React 19 + Radix).
- **Extensions are verified principals** (`packages/shared/src/principalKinds.ts`,
  commit `fadaa83d`) — they participate in capability approvals and attribution.

llama.cpp / model ecosystem (researched 2026-07-07):

- **Official prebuilt binaries** per OS/arch/backend from
  `github.com/ggml-org/llama.cpp/releases` (tags `bNNNN`, multiple per day).
  Systematic asset names, e.g. `llama-<build>-bin-ubuntu-x64-vulkan.tar.gz`,
  `llama-<build>-bin-win-cuda-12.4-x64.zip` (+ separate `cudart-…` zip),
  `llama-<build>-bin-macos-arm64.tar.gz` (Metal). Backends: CUDA 12.4/13.3, Vulkan,
  ROCm/HIP, SYCL, OpenVINO, CPU (x64/arm64).
- **`llama-server`** speaks OpenAI-compatible `/v1/chat/completions` (SSE streaming),
  `/v1/models`, plus native `/health`, `/props`, `/slots`. Tool calling via `--jinja`
  (chat-template autoparser + GBNF-constrained output, lazy grammars, streaming JSON
  healer) — production-usable, with per-model validation needed. Structured output via
  `--json-schema` / `response_format`.
- **Native auto-fit**: the `--fit` flag family projects memory use at load and fits
  `-ngl`, context, and tensor-offload overrides to available device memory; the
  standalone `llama-fit-params` tool prints optimal `-c -ngl -ts -ot` for a given
  model+hardware.
- **Router mode** (recent): `llama-server` launched without `-m` serves multiple
  models from an INI preset / `--models-dir`, loading on demand, selected by the
  request's `"model"` field; `--models-max` bounds simultaneously-loaded models.
  Caveats: eviction is on-switch (no idle TTL), still maturing.
- **LFM2.5-1.2B-Instruct (Liquid AI) — confirmed.** HF `LiquidAI/LFM2.5-1.2B-Instruct`,
  official GGUF `LiquidAI/LFM2.5-1.2B-Instruct-GGUF` (Q4_0 696 MB, Q4_K_M 731 MB,
  Q8_0 1.25 GB). 1.17 B params, hybrid conv+GQA ("lfm2" arch, supported in llama.cpp),
  32 K context, ChatML-like template, tool calling via `<|tool_call_start|>` Pythonic
  format. ~239 tok/s decode on desktop CPUs — comfortably usable with no GPU.
  **License: LFM1.0 (Liquid's own, not OSI). Decided: acceptable — we download from
  HF at install time rather than bundling, so we distribute a download URL, not the
  weights.**
- **Download ergonomics**: HF Hub supports resumable downloads; GGUF repos are
  enumerable via the HF API. Disk convention: LM Studio-style
  `publisher/repo/file.gguf` trees are human-readable and interoperable (vs Ollama's
  opaque blob store) — we adopt that.

---

## 3. Architecture overview

```
┌──────────────────────────── Electron / workspace server ────────────────────────────┐
│                                                                                      │
│  chat panel ──► ModelPicker ◄── ModelSettingsSnapshot (catalog + availability)       │
│                                        ▲                                             │
│                                        │ listCatalog / getSettings                   │
│  workspace/workers/model-settings  ────┤                                             │
│    buildModelCatalog()                 │ extensions.use("local-models")              │
│      = pi-ai registry models           │   .listModels() / .status()                 │
│      + local-models entries  ◄─────────┘   + "models.changed" events                 │
│                                                                                      │
│  agent DO (workerd) ── model_call executor ── stream(modelSpec) ── fetch ────┐       │
│                         (inline Model for provider "local",                  │       │
│                          loopback auth, no suspend)                          │       │
│                                                                              ▼       │
│  extension host ── @workspace-extensions/local-models          http://127.0.0.1:PORT │
│    ├─ HardwareProfiler   (GPU/VRAM/CPU/RAM probe, cached)            ▲       ▲       │
│    ├─ EngineInstaller    (llama.cpp release binaries per backend)    │       │       │
│    ├─ ModelLibrary       (GGUF downloads, HF, resumable)             │       │       │
│    └─ ServerSupervisor ──┬─ utility server (CPU build, LFM2.5, lazy on-demand)│       │
│                          └─ main server  (best backend, router mode, user models)    │
│                                                                                      │
│  workspace/panels/local-models  (React) ── extensions.use("local-models").*          │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

Everything operational lives in the extension (the `git-bridge` "extension-owned
engine" pattern). The host and workers only: (a) merge the extension's model list into
the catalog, (b) pass through availability, (c) call the local HTTP endpoint from the
existing executor.

### The two-server topology

The fallback must not share fate with the GPU stack (driver bugs, VRAM
exhaustion, a 13B model OOM-ing the server). So the extension runs **two**
`llama-server` processes, each started only when first demanded:

| | **Utility server** | **Main server** |
|---|---|---|
| Purpose | LFM2.5 fallback, loaded on demand | User's model library |
| Build | **CPU-only** llama.cpp (universal, zero driver risk) | Best backend for the hardware (CUDA/Metal/Vulkan/ROCm) |
| Models | `LFM2.5-1.2B-Instruct` pinned, single-model mode | Router mode over the library, load-on-demand, `--models-max 1` (configurable) |
| Footprint | 0 when cold (the default); ~0.8–1 GB RAM once loaded (Q4_K_M + small KV, `-c 8192` default) | 0 when cold; whatever the loaded model needs (auto-fit) |
| Lifecycle | **Cold until the first fallback `ensureLoaded`**; once running, restarts with backoff forever *while in use* (it is the floor) | Starts on the first non-fallback `ensureLoaded`; weights load on demand via `ensureLoaded` (§6.3); idle model unload after 15 min, implemented by the supervisor — llama.cpp's router has no native idle TTL (§2) |
| Port | `127.0.0.1:<utilityPort>` | `127.0.0.1:<mainPort>` |

On a low-powered machine (no GPU, ≤8 GB RAM) the main server is simply never
provisioned unless the user adds a model; the utility server is the local provider,
and stays cold until the first fallback is actually needed.

Both servers bind loopback only and require a random per-install api-key so other
local processes can't ride our inference; the key lives at the machine-global root
(`<root>/auth.key`, 0600, written by the lock owner — §4.3), reaches the servers via
`--api-key-file` (§4.4), and is injected executor-side at call time (§6.3). It never
leaves the machine.

---

## 4. The extension: `workspace/extensions/local-models/`

Manifest (`package.json`):

```jsonc
{
  "name": "@workspace-extensions/local-models",
  "vibestudio": {
    "displayName": "Local Models",
    "entry": "index.ts",
    "extension": {
      "activationEvents": ["*"],
      "streamingMethods": ["downloadModel", "tailServerLog"]
    }
  }
}
```

### 4.1 HardwareProfiler

Probed once at activation, cached in extension storage, re-probed on demand
(panel "Re-detect" button) and on OS/driver-version change:

- **GPU**: NVIDIA via `nvidia-smi --query-gpu=name,memory.total,driver_version
  --format=csv` (also yields the CUDA-runtime ceiling → pick the cuda-12.4 vs 13.3
  build); AMD via `rocm-smi` else Vulkan; any-vendor fallback `vulkaninfo --summary`;
  Apple via `system_profiler`/Metal (unified memory). Multi-GPU: prefer the discrete
  device (e.g. RTX 4060 over an iGPU like the Radeon 760M).
- **CPU**: core count, AVX/AVX2/AVX-512 (or arm64) from `/proc/cpuinfo` / `sysctl` —
  selects the CPU-build variant and default `--threads`.
- **RAM**: total + a conservative "usable for models" figure (total − 4 GB floor).

Output is a `HardwareProfile` (persisted, versioned):

```ts
interface HardwareProfile {
  os: "linux" | "darwin" | "win32"; arch: "x64" | "arm64";
  gpus: Array<{ vendor: "nvidia"|"amd"|"intel"|"apple"; name: string;
                vramMB: number; backend: "cuda-12.4"|"cuda-13.3"|"vulkan"|"rocm"|"metal";
                discrete: boolean }>;
  cpu: { cores: number; features: string[] };
  ramMB: number;
  chosenBackend: string;        // asset selector for the main server build
  tier: "gpu-large" | "gpu-mid" | "gpu-small" | "cpu-strong" | "cpu-min";
}
```

Tiering drives catalog recommendations (§7). Reference points: RTX 4060 Laptop 8 GB
VRAM / 12 threads / 15 GB RAM (the primary dev machine) lands in `gpu-mid` — full
offload up to ~9 B Q4_K_M, partial offload to ~14 B; a GPU-less 8 GB laptop is
`cpu-min` — LFM2.5 class only.

### 4.2 EngineInstaller

- Resolves the newest known-good llama.cpp release (a **pinned build tag** shipped
  with the extension, e.g. `b99xx`, not "latest" — llama.cpp releases many times a
  day and we want a tested pair; the pin is bumped with extension updates, with a
  panel override for opt-in newer builds).
- Downloads **two** archives from `github.com/ggml-org/llama.cpp/releases`: the
  CPU build (utility server, universal) and the `chosenBackend` build (+ `cudart`
  zip on Windows CUDA). Verified against the release's published checksums.
- Extracts to `<modelsRoot>/engines/<buildTag>/<backend>/` and smoke-tests each
  binary (`llama-server --version`, then a 1-token generation against a tiny GGUF)
  before marking it active; on GPU-build smoke-test failure it **degrades the main
  server to Vulkan, then CPU**, records why, and surfaces it in the panel rather
  than failing the install.
- Keeps exactly the current and previous build for rollback.

### 4.3 ModelLibrary

- Storage root: machine-global, shared across workspaces (models are hardware
  assets, not workspace state): `<userData>/local-models/` with
  `engines/`, `models/<publisher>/<repo>/<file>.gguf` (LM Studio-compatible layout),
  `config.json`, `server.log`. Extensions have full Node access, so a global dir is
  fine; per-workspace extension storage (`ctx.storage`) holds only small state.
  Configurable location in the panel (models are large; users have opinions about
  which disk).
- **Single owner across workspaces**: multiple open workspaces mean multiple
  extension processes over the same root, so ownership is explicit. The first
  instance takes an OS file lock (`<root>/owner.lock`) and becomes the daemon
  owner — it runs both servers and is the sole writer of `config.json`/`server.log`,
  recording `{ pid, ports, bootId }` in `owner.json` and the per-install api-key in
  `auth.key` (0600). The key is machine-global by design: per-workspace extension
  storage (`{userData}/extensions/storage/<workspaceId>/…`, `EXTENSIONS.md:46`)
  cannot back a secret that attached instances from *other* workspaces must present
  to the owner's servers. Non-owner instances attach:
  they health-check `owner.json`, use the owner's servers directly, and forward
  mutations (downloads, config changes, restarts) to the owner's loopback admin
  endpoint (guarded by the same api-key as inference). Owner exit releases the lock;
  the next activation — or any attached instance that detects a dead owner — takes
  over. Same hub-managed attach-or-spawn lifecycle as
  `docs/multi-user-wp1-hub-control-plane.md`.
- Downloads: HF `resolve` URLs with HTTP Range resumption, progress events streamed
  to the panel over the `downloadModel` streaming method, checksum verification
  (curated models: hash pinned in the extension's catalog; ad-hoc HF pulls: the
  HF-published hash captured at download start and recorded in the ModelRecord),
  atomic rename on completion, disk-space preflight.
- Each installed model gets a `ModelRecord`: repo id, file, quant, param count,
  context length and chat-template/tool-format metadata read from **GGUF header**
  (self-describing — no sidecar registry needed), plus per-model overrides (ctx,
  ngl) and the auto-fit result.
- **Curated starter catalog** shipped with the extension (id, HF repo, per-tier
  recommended quant, capability notes: tools ok / coding / long-context), filtered
  by `HardwareProfile.tier`, plus a free-form "Add from Hugging Face" (repo id or
  URL → enumerate GGUF files via HF API → pick quant with the fit estimator).
- **Import**: point the extension at existing GGUF folders — LM Studio-layout trees
  are indexed in place (we use the same layout; no copy), loose GGUF directories are
  scanned and indexed where they sit. Users with an existing local-model habit are
  productive in one dialog.

### 4.4 ServerSupervisor

- Spawns `llama-server` via `node:child_process` with sanitized env (the `shell`
  extension's `cleanEnv` pattern), captures logs to `server.log` (ring-buffered
  tail via `tailServerLog`), and supervises with exponential backoff
  (1/2/4/8/16 s within 60 s window, mirroring the host's `processManager` policy).
  The **main server** lands in `error` state with the log tail after 5 failures; the
  **utility server** is exempt from the failure cap — it is the availability floor
  (§5), so *once in use* it restarts forever with backoff clamped at 60 s (a crash
  mid-fallback must not drop the floor), surfacing repeated failures through
  `ctx.health` and the panel instead of giving up. A cold utility that has never been
  demanded simply stays stopped.
- Utility server flags:
  `llama-server -m <lfm2.5.gguf> --port <p> --host 127.0.0.1
  --api-key-file <root>/auth.key -c 8192 --jinja -np 2 --threads <cores/2>` —
  deliberately boring; no GPU flags. The key always rides `--api-key-file`, never a
  raw `--api-key` argument: `/proc/<pid>/cmdline` is world-readable on Linux, and a
  key on the command line would leak machine-wide — defeating the very thing it
  guards (inference *and* the admin endpoint).
- Main server flags: router mode (`--models-dir`/preset INI generated from the
  library, `--models-max 1` default) with per-model `-c`/`-ngl` from auto-fit
  (`--fit` at load; `llama-fit-params` for the estimator shown in the panel), plus
  `--jinja`, `-fa auto`. Router mode is the committed topology (risk #3, §12); the
  extension API below hides server topology from callers regardless.
- Health: polls `GET /health` and `/v1/models`; exposes consolidated status and
  reports into `ctx.health` so the unified status UI shows it.

### 4.5 Extension API (what the rest of the system calls)

```ts
interface LocalModelsApi {
  status(): Promise<LocalModelsStatus>;       // servers, engine, hardware, fallback readiness
  listModels(): Promise<LocalModelEntry[]>;   // → catalog entries (§6.1)
  ensureLoaded(modelId: string): Promise<{ baseUrl: string }>; // request-path start/load (§6.3)
  getLoopbackAuth(): Promise<{ apiKey: string }>; // do-kind callers only (§6.3); never in catalog/journal
  // library management (panel)
  searchCatalog(q): Promise<CatalogHit[]>;
  downloadModel(req): Response;               // streaming progress
  removeModel(modelId): Promise<void>;
  setModelConfig(modelId, cfg): Promise<void>;
  // engine/server management (panel)
  getHardwareProfile(refresh?: boolean): Promise<HardwareProfile>;
  restartServer(which: "utility" | "main"): Promise<void>;
  tailServerLog(which): Response;             // streaming
  openConfigPanel(): Promise<{ openPanel: { source: "panels/local-models" } }>;
}
```

Events (`ctx.emit`): `models.changed` (library or server availability changed — the
model-settings worker subscribes and rebuilds its snapshot), `download.progress`,
`server.state`.

---

## 5. Bootstrap & the lazy LFM2.5 floor

The fallback is a **lazy floor, not a warm guarantee**: it loads on first demand and
is never kept resident. This is the deliberate default — a machine that never falls
back to local should never pay RAM, CPU, or a 731 MB download for a model it does not
use. The floor is a *promise that it will be there when needed*, not a running process.

First activation (after the standard extension install approval, whose prompt copy
should say: *"downloads the llama.cpp inference engine (~50–300 MB) from GitHub, and
runs local inference servers on demand"*):

1. Probe hardware → `HardwareProfile` (seconds).
2. Download + smoke-test the CPU engine (and the GPU engine, if any) in the same pass,
   so the first model load is instant. The LFM2.5 GGUF is **not** downloaded here.
3. Resolve the single-owner lock (ports + api-key) → emit `models.changed`. Both
   servers stay **cold**. `local:lfm2.5-1.2b` appears in the picker as **"Available to
   start"** (loads on first use), never as a running server.

On-demand load (the first `ensureLoaded("lfm2.5-1.2b")`, e.g. when every cloud provider
fails): download the GGUF if absent (idempotent), then start the utility server and
wait out its model-load window. Time-to-first-local-token on a warm-engine cold-model
box is the model-load latency; on a fully cold box it additionally pays the one-time
731 MB download, surfaced as an in-chat progress signal.

Steady-state invariants:

- Neither server runs until demanded. The utility server starts on the first fallback
  `ensureLoaded`; the main server on the first non-fallback `ensureLoaded`. Once a
  server *is* running, the supervisor keeps it healthy — the utility server is exempt
  from the main server's failure cap and restarts forever **while it is in use** (a
  crash mid-fallback must not drop the floor). Idle unload (main) and process cold-
  start (both) return the machine to the no-resident-model default.
- The extension refuses to delete the LFM2.5 GGUF while fallback duty is assigned to
  it (the panel offers "replace fallback model" instead, gated on the replacement
  being downloaded and smoke-tested first).
- `status().fallback = { ready: boolean, warm: boolean, modelRef: "local:lfm2.5-1.2b",
  reason? }` is the single source of truth consumed by fallback selection (§8):
  `ready` = downloaded and loadable on demand; `warm` = currently serving.

---

## 6. Provider integration (pi-ai / catalog / executor / credentials)

Provider id: **`local`** (display "Local (llama.cpp)"). Model refs:
`local:lfm2.5-1.2b`, `local:<slug>` for library models (slug = stable, derived from
repo+file, e.g. `local:qwen3-8b-q4km`).

### 6.1 Catalog: append at the `buildModelCatalog()` seam — do not patch pi-ai

pi-ai's generated registry stays untouched (its patch surface is already a
maintenance cost). Instead `workspace/workers/model-settings/index.ts` merges:

```
catalog = piAiEntries(getProviders()/getModels())
        + localEntries(await extensions.use("@workspace-extensions/local-models").listModels())
```

Each `LocalModelEntry` maps to a `ModelCatalogEntry`
(`workspace/packages/model-catalog/src/catalog.ts:46`) with `ref: "local:<slug>"`,
`baseUrl: "http://127.0.0.1:<port>/v1"`, `contextWindow`/`maxTokens` from auto-fit,
`cost: 0`, and the catalog type gains three fields — **required on every entry**,
because the catalog is now the single model authority (§6.2):

```ts
interface ModelCatalogEntry {
  // ...existing...
  auth: "url-bound" | "loopback";      // explicit auth mode (§6.3)
  availability: ModelAvailability;     // §7 — live status, not credential presence
  modelSpec: PiModelSpec;              // the pi-ai Model this entry materializes to (§6.2)
  capabilities: { tools: boolean };    // §6.4 — gates tool schemas at config time
}
```

`modelSpec` is a serializable pi-ai `Model` literal:

```ts
{
  id, name, provider: "local", api: "openai-completions",
  baseUrl: "http://127.0.0.1:<port>/v1",
  reasoning: false, input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow, maxTokens,
  compat: { /* llama-server quirks; see §6.4 */ }
}
```

`modelSpec` is **secret-free by construction** — it is journaled with every request
and shipped to panels inside catalog snapshots, so the loopback api-key never rides
in it; the executor injects auth at call time (§6.3).

The worker subscribes to the extension's `models.changed` event and invalidates its
snapshot, so the picker updates live when a download finishes or a server dies.

### 6.2 Executor refactor: journaled `modelSpec` replaces registry lookups — for every provider

`model-call.ts:582` currently resolves models from pi-ai's static registry and aborts
on a miss (`:648-656`). We do not bolt a local-only side channel next to that — we
replace the resolution model outright (pre-release; the old path has no tenure):

- `ModelRequestDescriptor` gains two **required** fields, journaled together:
  `modelSpec` — a serializable pi-ai `Model` literal — and `auth` (§6.3), both
  copied from the catalog entry. Materialization happens at the impure edge where
  model settings already enter the log: the vessel resolves the catalog entry when
  settings are written or a turn is ingested and journals the pair into the turn
  config; the pure planner then copies them from `turnConfig(state)` into the
  request exactly as it already does for `provider`/`model`/`thinkingLevel`
  (`modelStartItems`, `workspace/packages/agent-loop/src/step.ts:69`). This is the
  **only** resolution path; the `getModel()` call and its `unknown model` abort are
  deleted.
- This is a win for all providers, not just local: replaying a journaled turn no
  longer depends on whichever pi-ai registry version happens to be installed — the
  exact descriptor the turn ran with (identity, compat, limits) is part of the
  journaled request. The catalog becomes the single authority on what a model
  *is*; pi-ai's generated registry is reduced to one *input* to `buildModelCatalog()`.
  One deliberate exception: for `local:*` models the journaled `baseUrl` records
  what the turn ran against, but the **live** endpoint wins at execution time
  (§6.3) — loopback ports can move across owner takeover, and a journaled port must
  never become load-bearing.
- `stream()` already dispatches purely on `model.api` (`"openai-completions"` is a
  registered builtin), so **pi-ai itself needs no changes**.

### 6.3 Auth refactor: an explicit per-model auth mode, not a fake credential

Today the executor assumes every model needs a URL-bound credential and suspends the
turn when none exists (`agent-vessel.ts:866-910`, `model-call.ts:610-635`). That
implicit assumption becomes an explicit property of the model: the catalog entry —
and therefore the journaled `modelSpec` — carries `auth: "url-bound" | "loopback"`.

- `auth: "loopback"` (all `local:*` models): the credential *system* is skipped — no
  stored credential, no audience matching, no suspended turns. But pi-ai still
  requires a non-empty `options.apiKey` (its handler throws `No API key for
  provider` otherwise, `openai-completions.js:72-74`), so the executor resolves the
  loopback api-key **at call time** through a new executor dep backed by the
  extension's `getLoopbackAuth()` (cached per DO boot) and passes it as `apiKey`.
  There is no "executor" caller kind — the extensions service is reachable by
  panel/app/worker/do/shell/server/extension callers
  (`packages/extension-host/src/service.ts:493`) — so the extension enforces the
  restriction itself via `ctx.invocation.current()`: `getLoopbackAuth()` refuses
  panels, apps, and workers outright, and among `do`-kind callers it additionally
  checks the caller id against an agent-vessel allowlist, because *every* workspace
  DO presents `callerKind: "do"` (`runtime/src/worker/durable-base.ts:389`) — kind
  alone is too broad. The residual exposure is stated, not hidden: workspace DOs
  are trusted first-party units (`docs/trusted-workspace-units.md`), and the key's
  threat model is foreign local *processes*, not intra-workspace code — the
  caller-id allowlist is defense in depth, not a security boundary. The key exists
  in exactly two places: the
  machine-global root (`auth.key`, 0600, §4.3) and the headers of in-flight
  loopback requests — never in the catalog snapshot, never in the journal, never
  in panel state.
- Before streaming a `local:*` ref, the executor calls the extension's
  `ensureLoaded(modelId)`. This is what gives `startable` models a real invocation
  path: it starts the main-server process if the supervisor isn't running it,
  triggers the router load, and returns the live `baseUrl`; for the utility server
  it is a no-op health check. Cold-start latency is bounded by the router load (§3)
  and rides the normal streaming lifecycle as a "model starting" phase. The
  returned live `baseUrl` is passed to `stream()` as the explicit endpoint override
  (the existing `request.modelBaseUrl` mechanism, `model-call.ts:694`), so a
  journaled `modelSpec.baseUrl` can never go stale across owner takeover or port
  reallocation. Ports are also allocated once and persisted in `config.json`,
  reused across restarts and takeovers — staleness is the exception, and it is
  still handled.
- The fetch proxy needs **no change**: a non-sentinel bearer falls through to the
  runtime's original `fetch` (`model-fetch-proxy.ts:212`), and localhost was never
  routable anyway (`:93`).
- `providerConnect.ts` gets **no `local` preset** — loopback providers are simply
  not "connectable"; their availability comes from health (§7).

Loopback reachability: the DOs run inside the workspace-server process on the same
machine as the extension host, so the runtime's plain `fetch` reaches
`127.0.0.1:<port>`; the first e2e test of the provider work (§11.2) verifies this
end-to-end including SSE. If the runtime turns out to block raw loopback, the fix
lands **inside this same change** — a gateway-forwarded route (`/_local-models/…` →
loopback) — which also covers remote-attach scenarios where panels run on a different
device than the server (`baseUrl` is resolved *server-side*, where the DOs run, so
remote panels work unchanged either way).

### 6.4 llama-server compat profile

pi-ai's `OpenAICompletionsCompat` (`types.d.ts:315`) is the lever for quirks. Ship a
`llamaServerCompat` constant in the extension (delivered via `modelSpec.compat`);
expected knobs based on research, to be finalized against the pinned build in the
integration test: token-usage reporting on streamed responses, tool-call streaming
shape, no `reasoning_effort`, `response_format` vs grammar exclusivity (don't send
both). Per-model capability flags (`ModelCatalogEntry.capabilities.tools`, §6.1) come from
the ModelLibrary's GGUF/template inspection, and the gate has a concrete data path:
the **vessel** consults the flag when it journals the turn config and omits the tool
schemas for tool-incapable models — so the pure planner never sets `toolSchemasHash`
(`step.ts:77`) and the executor's existing "include tools when the blob exists"
logic (`model-call.ts:640`) needs no change. Garbage-in prevention happens at the
source, not the sink.

---

## 7. Model picker redesign: availability-first

### 7.1 Availability model (new, shared)

```ts
type ModelAvailability =
  | { state: "ready"; detail?: "running" | "credentialed" }
  | { state: "startable"; detail: "will-load-on-use" }      // local, not currently loaded
  | { state: "needs-setup"; detail: "no-credential" | "not-installed" }
  | { state: "starting" }
  | { state: "downloading"; progress: number; phase: "active" | "queued" | "paused" }
  | { state: "error"; message: string };
```

Computed in the model-settings worker and shipped on every catalog entry:

- **Cloud providers**: credential presence decides `needs-setup` vs candidate, then
  a live probe confirms it — one cheap authenticated models-endpoint request per
  credentialed provider, 30-minute TTL, refreshed eagerly when the picker opens. An
  expired key or a provider outage shows as `error` in the picker *before* the user
  burns a turn discovering it. The chat panel's private `refreshConnectedRefs`
  heuristic (`panels/chat/index.tsx:452-469`) is **deleted**; the worker's
  availability is the one source for picker, agent config, and fallback logic alike.
  Probe authorization is settled at connect time, not per probe: stored-credential
  use is caller-authorized with a human-approval fallback
  (`src/server/services/credentialService.ts:3550`), so the connect flow records a
  standing grant for the model-settings worker against the provider's
  models-endpoint audience as part of the user's one connect consent — probes always
  take the already-permitted fast path and can never generate approval prompts.
- **Local models**: live, from `status()` + `models.changed` events — `ready`
  (utility server / loaded in main), `startable` (installed; the executor's
  `ensureLoaded` call starts/loads it on first use, §6.3), `downloading`, `error`
  (with the supervisor's reason).

Centralizing this **deliberately dissolves a documented boundary**: the catalog
header (`workspace/packages/model-catalog/src/catalog.ts:1-7`) promises a snapshot
with "no credentials, no connection state," and the chat panel computes connection
status locally "so it stays scoped to this panel's own credentials"
(`panels/chat/index.tsx:449-451`). What moves into the shared snapshot is
availability *states*, not credential material or audiences. Availability is
non-secret workspace state; credential authorization remains bound to the acting
user and caller. Sharing that state is required for non-panel consumers (fallback
logic, agent config, CLI) to reason about usability. Both comments are rewritten as
part of this change; per the Design stance, the old boundary has no tenure.

### 7.2 Picker UX (`ModelPicker.tsx` is rewritten, not patched)

The component is rebuilt around availability as its primary axis — grouping changes
from *Connected / Recommended / All* to **status-first**:

```
┌ Search ─────────────────────────────┐
│ ▸ Ready                             │   status dot ● green
│   ● Claude Sonnet 5     anthropic   │   badges: reasoning/vision/ctx (existing)
│   ● GPT-5.5             openai-codex│
│   ● Qwen3 8B      local · on-device │   local entries: "on-device · free" chip,
│   ● LFM2.5 1.2B   local · fallback  │   tok/s estimate from last benchmark
│ ▸ Available to start                │   ◐ amber — local models that load on use
│   ◐ Llama 3.3 70B partial-offload   │   fit hint from auto-fit estimator
│ ▸ Needs setup                       │   ○ grey — one-line CTA per provider:
│   ○ Gemini …      [Connect]         │   cloud → connect-credential flow
│   ○ More local models [Manage…]     │   local → opens the local-models panel
└─────────────────────────────────────┘
```

- Providers with zero usable models collapse to a single "Connect <provider>" row —
  the 200-model wall of unusable entries disappears.
- `error`/`downloading` states render inline (spinner + %, red dot + tooltip with the
  supervisor message and a "Open Local Models" action).
- The current selection shows a status dot in the closed trigger too, so a picked
  model that has become unavailable is visible *before* sending a message.
- `pickDefaultModel` (`agentConfigDraft.ts:71`) prefers `ready` > `startable` >
  everything else.

The same availability data drives `AgentConfigForm`/`AgentDialog` (they embed the
picker) — agents get the redesign for free.

---

## 8. Fallback semantics ("LFM2.5 is there when you need it")

The floor is **available**, not warm (§5): selection treats a downloaded-but-cold —
or not-yet-downloaded — fallback as usable, because `ensureLoaded` downloads and loads
it on demand. `isUsable` accepts `startable`, so the lazy fallback is a valid selection
target; the load cost (and any first-use download) is paid at first token, surfaced as
an in-chat progress signal, not hidden.

Selection-time (deterministic and simple):

1. `resolveSettings`/`pickFallbackModel` (`model-settings/index.ts`) runs an
   availability pass: if the stored default and `DEFAULT_AGENT_MODEL_REF` are both
   not `ready`/`startable`, fall back to the first `ready` recommended model, then to
   **`local:lfm2.5-1.2b` whenever it is present in the catalog** (the extension always
   advertises the floor entry, even before download, as `startable`). The snapshot's
   existing `defaultModelSource: "fallback"` marker lets the chat panel render a
   banner: *"No cloud provider connected — using LFM2.5 (local). Answers will be
   simpler. [Connect a provider]"*. Honest expectation-setting matters at 1.2 B.
2. New-workspace default: if no credential exists at all, the default agent config
   points at the local fallback from the start — first-run chat works with zero
   cloud credentials. The first such turn triggers the one-time GGUF download (§5)
   and then runs fully offline.

Error-time: when a `model_call` fails with a provider-level error (auth, quota,
network — classified in `workspace/packages/agent-loop/src/model-errors.ts`), the
behavior splits on whether a human is present — and **both halves ship in this
change**:

- **Interactive turns**: the failure card gains a one-click **"Retry with local
  model"** action pre-wired to the fallback ref. This is a decision, not a deferral:
  swapping a frontier model for a 1.2 B model mid-conversation is a quality cliff a
  present human should approve — and approval costs exactly one click.
- **Unattended turns** (heartbeats, scheduled agents — nobody there to click,
  `docs/agent-heartbeats-design.md`): the loop **automatically retries the turn on
  the fallback ref**, journals the switch as part of the turn record, and the
  transcript renders a visible "continued on local fallback" notice. Background work
  never silently dies because a cloud key expired overnight.

---

## 9. The panel: `workspace/panels/local-models/`

React (`default` template), talks to the extension via
`extensions.use("@workspace-extensions/local-models")`; opened from the picker's
"Manage…" row, from notifications, and via the extension's `openConfigPanel()`.

Layout (single scrolling page, Radix Themes to match the chat panel):

1. **Hardware header** — "Optimized for NVIDIA RTX 4060 Laptop (8 GB VRAM) · CUDA ·
   12 threads · 15 GB RAM", engine build tag, backend actually in use (with the
   degradation reason if the GPU build failed), Re-detect button.
2. **Fallback card** — LFM2.5 status (● Always ready · CPU · 0.8 GB), last-checked
   health, benchmark tok/s, "Test" button (one-shot prompt round-trip).
3. **Model library** — table: name, quant, size on disk, fit indicator
   (● full GPU / ◐ partial / CPU), context, tools ✓/✗, state (loaded/idle),
   per-row actions (load now, configure ctx/offload with the auto-fit numbers as
   defaults and a live VRAM budget bar, delete). Storage-location row with used/free
   disk.
4. **Add models** — curated, tier-filtered catalog cards ("Fits your GPU fully" /
   "Runs partially offloaded, ~7 tok/s est.") + HF repo search; quant picker
   defaults to the fit estimator's choice; download queue with progress/pause/resume;
   **Import** — point at existing GGUF folders (LM Studio trees indexed in place).
5. **Server** (collapsed advanced section) — per-server status, port, uptime,
   restart, log tail viewer, engine-build override, idle-stop timeout, parallel
   slots.

UX principles: every state the supervisor can be in has a visible, actionable
representation here (this panel is the "why isn't it working" destination that the
picker's red dot links to); destructive actions (delete model) confirm with size
reclaimed; nothing here requires knowing what a "quant" is — defaults are computed,
details are expandable.

---

## 10. Security & approvals

- **Install consent** covers binary download + execution + model downloads (elevated
  extension approval; explicit prompt copy in §5). Ongoing operation needs no
  per-call approvals — inference is local and egress-free.
- **Network egress** at runtime: download URLs are pinned in code to
  `github.com/ggml-org` (engine) and `huggingface.co` (models). Both redirect to
  CDN hosts (`release-assets.githubusercontent.com` / `objects.githubusercontent.com`
  for GitHub assets; `cdn-lfs*.hf.co` / xet CAS hosts for HF), so enforcement pins
  the *initial* URL and verifies every downloaded byte against the checksum regime
  below — it does not pretend the redirect chain is a fixed hostname set. Downloads
  use the extension's ambient Node networking (routing them through the credentialed
  userland path would re-trigger capability authorization for raw egress,
  `src/server/services/egressProxy.ts:959` — friction the install consent already
  paid for); every download is logged via `ctx.log` with URL and resolved hash. No
  telemetry.
- **Local server exposure**: loopback bind + per-install random `--api-key`; the
  key lives at the machine-global root (`auth.key`, 0600, lock-owner-written —
  §4.3), reaches the servers via `--api-key-file` (never a command-line argument,
  §4.4), and is injected executor-side at call time (§6.3) — it never enters the
  catalog snapshot, the journal, panel state, or `/proc/<pid>/cmdline`.
- **Checksums**: engine archives verified against the pinned release's published
  checksums; curated models against hashes pinned in the extension's catalog;
  ad-hoc HF pulls against the HF-published hash captured at download start
  (trust-on-first-download, recorded in the ModelRecord — §4.3); smoke tests before
  activation.
- **Prompt privacy** is the feature: local refs never leave the machine — worth a
  line in the picker ("on-device") and docs.
- **License**: settled — LFM1.0 is acceptable because nothing is bundled; the
  extension downloads at install time, so we distribute a URL, not the weights. The
  fallback slot stays model-agnostic regardless.

---

## 11. Testing: the local model is the app's e2e fixture

The fallback model is not just a product feature — it makes the entire agentic stack
e2e-testable for real. Until now a true end-to-end agent test needed cloud keys
(flaky, costly, non-deterministic CI) or mocked model streams (which test the mock,
not the system). This change makes **workspace-driven local model turns** the
standing e2e harness for the whole app. Local-model management remains userland:
the panel and extension APIs own install/status/download/import/benchmark flows;
the host CLI has no local-model command group and no extension-id reference.

### 11.1 Generic headless turn surface

- `vibestudio agent turn --model <ref> --message "..." [--tools <spec>] --json`
  can eventually run one full agent turn headlessly (channel -> vessel ->
  `model_call` -> reply) and print the journaled result. The command is provider
  agnostic; it should route through existing channel and agent-vessel plumbing,
  not through provider-specific host commands.

### 11.2 E2E suite (CI-runnable: headless host, no cloud keys, no network after cache warm)

Fixtures: a tiny GGUF (SmolLM2-135M-Instruct Q8, ~100 MB) for fast structural tests,
plus LFM2.5 itself for behavioral ones (tool calls, long context); both cached as CI
artifacts. The CI cache is a private download cache — CI pulls from HF and caches
exactly like a developer machine, publishing nothing — consistent with the
download-not-bundle license posture (§2). The suite drives the **real binaries end
to end** — no mocked servers.

1. **Cold bootstrap** — fresh state dir -> headless host boots, extension installs
   (auto-approved startup units) -> the extension `status()` API shows engines
   installed with **both servers cold** (`fallback.warm === false`); engine checksums
   verified. The first `ensureLoaded("lfm2.5-1.2b")` then downloads the GGUF, warms the
   utility server, and flips `fallback.warm` true — the lazy floor (§5).
2. **Full agent turn** — `agent turn --model local:lfm2.5-1.2b` → streamed deltas
   arrived as channel signals; terminal `message.completed`; journaled `modelSpec`
   matches the catalog entry **and carries no auth material** (the loopback key
   appears nowhere in the journal or in catalog snapshots).
3. **Tool round-trip** — turn with a registered tool → `toolcall` events, the
   `channel_call`/`local_tool` effect fires, tool result folds into the follow-up
   model call. This test also locks risk #2 and the `llamaServerCompat` knobs
   (risk #4) against the pinned build.
4. **Fallback semantics** — zero credentials → default resolves to the local ref and
   the turn succeeds (the offline first-run path); credential revoked mid-suite → an
   unattended heartbeat turn auto-fails-over and journals the switch; an interactive
   failure carries the retry-local action.
5. **Crash/chaos** — `SIGKILL` the utility server mid-stream → executor surfaces a
   classified model error, supervisor restarts within backoff budget, the next turn
   succeeds. Kill a download mid-flight → resume completes with matching checksum.
6. **Router behavior** — pull two library models → alternate turns between them →
   swap latency within bounds; `--models-max` eviction observed (locks risk #3).
7. **Availability truth** — the catalog snapshot (`getSettings`) mirrors reality
   through every state above: downloading → ready → error → ready.
8. **Multi-workspace ownership** — a second headless workspace attaches instead of
   spawning duplicate servers (exactly one utility server machine-wide); kill the
   owner → an attached instance takes the lock, servers recover, next turn succeeds.

Unit tests: asset-name resolution across a HardwareProfile matrix; fit estimator;
catalog merge; availability reducer; fallback-selection matrix (credentials ×
local-ready × stored-default). Manual platform passes: fresh install → offline chat
on Linux/macOS/Windows; 7B full-offload on the RTX 4060 reference box.

### 11.3 Build order (one change — order is for the implementer's sanity, not gates)

Everything in this document lands together: extension, provider refactor, fallback
semantics, availability + picker rewrite, panel, CLI, e2e suite. Nothing is flagged
off or ships half-enabled. The order below only sequences local verification:

1. **Extension core** — HardwareProfiler; EngineInstaller (CPU + GPU builds,
   degradation ladder); LFM2.5 bootstrap; utility ServerSupervisor;
   `status()`/`listModels()`; registration in `workspace/meta/vibestudio.yml`.
2. **Provider refactor** — loopback-fetch verification first (risk #1); required
   `modelSpec` on the journaled request + deletion of registry lookups (§6.2);
   explicit `auth` mode (§6.3); catalog merge + `models.changed` subscription;
   `llamaServerCompat`.
3. **Main server + library** — router-mode supervisor + auto-fit; ModelLibrary
   (HF search/download/resume, GGUF-folder import); curated catalog.
4. **Fallback semantics** — availability pass in `pickFallbackModel`; offline
   first-run default; fallback banner; retry-local card; unattended auto-failover.
5. **Availability + picker rewrite** — worker-computed availability (credential +
   TTL'd cloud probes + live local status); delete the chat panel's connected-refs
   heuristic; new `ModelPicker`.
6. **Panel** — the full §9 surface.
7. **CLI + e2e green** — §11.1 commands; §11.2 suite passing in CI; benchmarks wired
   into picker/panel; platform passes; docs (`EXTENSIONS.md` cross-link, `cli.md`,
   user docs).

## 12. Known risks (handled inside this change — none are gates)

| # | Risk | Resolution inside this change |
|---|---|---|
| 1 | Agent DO runtime can't `fetch` loopback (incl. SSE) | Verified as the first task of build step 2. If blocked, the gateway-forwarded route (`/_local-models/…` → loopback) is implemented as part of this change — and buys remote-attach support for free. |
| 2 | Pinned build's `--jinja` autoparser mishandles LFM2.5's `<|tool_call_start|>` Pythonic tool format | Locked by e2e test §11.2·3; if broken, ship a corrected template via `--chat-template-file` with the ModelRecord — in this change. |
| 3 | Router-mode rough edges on the pinned build (load latency, eviction, stability) | Router mode is the committed topology. Rough edges are resolved by choosing the pin: bump the build tag until §11.2·6 passes. The build tag is an implementation detail, not a design fork. |
| 4 | Exact `llamaServerCompat` knobs (usage reporting, tool-call streaming shape) | Locked by e2e test §11.2·3 against the pinned build; re-validated on every pin bump. |
| 5 | Multi-GPU hosts (discrete + iGPU) | Decided: discrete GPU only, pinned via `--device`; the panel shows which device was chosen. |
