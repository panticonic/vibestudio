# Natlang in Vibestudio: investigation and plan

Status: proposal, 2026-10-30. Nothing here is implemented. Sources: `~/natlang` at
`464e21031` (with uncommitted dashboard work in progress by another agent), Vibestudio
`33042acfd`, templates checkout `~/vibestudio-templates`.

## 1. What each side already is

**Natlang** is TypeScript with natural-language functions. A call is a small agent: the
executor model works in a persistent TS scope through `eval`, `read_code`, `return_result`
and friends, with typed parameters, a checked return, typed host *services*, and a trace.
Relevant structure (`ts-host/src`, ~70k lines):

| Layer | Where | Platform coupling |
|---|---|---|
| Compiler (`nl` planning, lowering, policy) | `compiler/`, `scope-compiler.ts` | none; files via `ProjectFiles` |
| Kernel (tasks, invocation, callables, `iterateOn`) | `runtime/` | `AsyncLocalStorage` behind `setContextStore` |
| Interpreter (model tool loop, scope, values) | `native/` | evaluator behind `EvalEnvironment` (`native/evaluator.ts:38`) |
| Model backends | `model/` (llama manager, OpenAI-compatible, Pi) | spawn, fs, `NATLANG_*`, config dir |
| Call store | `calls/` | `node:sqlite`, home dir (WASM variant exists) |
| CLI, dashboard server | `cli/`, `dashboard/` | fully Node, CLI-subprocess jobs |

The kernel already runs in two platforms (Node, browser). The browser build proves the
seams: context store, environment factory, call-store factory, lib provider, module target.
`EvalEnvironment` is a deliberately small boundary (`execute`, `executeAsync`,
`evaluateModule`, `fork`, `close`); the browser implementation is 174 lines.

The embedding API is `createNatlangRuntime({ model: ModelDriver, models, services,
serviceDeclarations, serviceScopes, trace, onLive, calls, environment, … })`, where
`ModelDriver = (request: ModelTurnRequest /* OpenAI chat shape */, signal?, { onDelta }) =>
ModelTurn`.

**Vibestudio**'s agent `eval` runs in a per-agent `EvalDO` inside workerd
(`packages/builtin/src/eval-engine/EvalDO.ts`), compiled by sucrase and executed with the
`UNSAFE_EVAL` binding in a private-global confinement. Ambient bindings are the
`@workspace/runtime` exports plus `scope`, `db`, `ctx`, `chat`, `agent`, … There is no
`fetch`, `vm`, `child_process`, or native module. Model turns exist only as pi-durable
native tasks behind `runtime.withModelRequest` (see `NativeModelHelperTask`,
`agentic-do/src/native-model-helper.ts`). Native model credentials resolve only inside an
active authenticated native invocation (`credentialService.ts:908-920`, gated by
`model.use`). Userland never sees secrets.

**The two systems already share their deepest idea.** A natlang call is a typed sub-agent
whose only working tool is `eval` over services. A Vibestudio agent is a general agent
whose main tool is `eval` over services. The integration is therefore not "call an
external tool from eval". It is: **a natlang call is a typed, small-model child of the
eval scope that created it, running in the same realm, with a narrowed slice of that
scope's authority.**

## 2. Walls found, and the design each one forces

1. **Realm.** Pi agents' eval lives in workerd. Natlang's Node evaluator is `node:vm`. If
   natlang ran in a separate Node extension, closures, live values, and services would have
   to be proxied over RPC, and inline `nl` capture semantics would be lost.
   → Natlang gets a **third platform, workerd**, and runs *inside* the EvalDO (and inside
   any worker DO that hosts programs). Its child evals execute through Vibestudio's own
   sandbox executor, so there is one confinement implementation, not two.

2. **Credentials.** Natlang's Pi backend constructs its own `Models` over `FileCredentials`
   in `~/.config/natlang/credentials`, and offers no injection point. Vibestudio forbids
   userland secrets and binds model credentials to native invocations.
   → Natlang must not own credentials inside Vibestudio. Its `ModelDriver` becomes a thin
   client of a Vibestudio **model gateway** that runs each turn as a native model task.
   Natlang's standalone CLI keeps its own store. Two credential stores never coexist in
   one process, and no secrets are copied between them.

   This is decided (D1): Vibestudio owns credentials.

3. **Pi skew.** Natlang depends on `@earendil-works/pi-ai ^1.4.0`. Vibestudio runs the fork
   `@panticonic/pi-ai 1.2.0-vibestudio.3`.
   → Natlang should not import pi-ai on the embedded path at all. It exports its
   request↔Pi translation as pure functions over a structural type, and the host supplies
   the Pi instance. One translation implementation, no second Pi copy in the bundle.

4. **Process-wide singletons.** Natlang's Node and browser entries register context
   store, environment, call store, package loader, and an `unhandledRejection` listener
   globally. An EvalDO can host several owners, and Vibestudio has its own process
   handlers.
   → Replace module-level registration with an explicit `Platform` value passed to
   `createNatlangRuntime`. The Node and browser entries construct their default platform.

5. **Compilation of `nl` in host eval cells.** Inline `nl` only works after natlang's
   compiler has planned and lowered it. Uncompiled, it throws. Vibestudio cells go through
   sucrase, which strips types.
   → The eval engine gains a natlang lowering stage, run only when a cell uses `nl`. It
   needs a natlang compiler entry that types a cell against declarations for the live
   scope (derived from values, as natlang's own scope opening already does).

6. **Local models.** Natlang manages its own llama.cpp fork (decision scoring, warm-prefix
   slot restore, native states) and defaults to `LiquidAI/LFM3-1.7B`. Vibestudio's
   `local-models` extension supervises upstream llama.cpp with LFM2.5, and forbids eval
   from touching endpoints or keys.
   → One supervisor: the `local-models` extension. It upgrades its engine to natlang's fork
   (decided, D3) and lists LFM3 as a model. Natlang's slot planning and warm-prefix logic
   move into a package the extension hosts. Natlang reaches the server through the same
   model gateway as every other model.

7. **The fork's release matrix is narrower than the engine's.** `local-models/engine.ts`
   installs upstream `ggml-org/llama.cpp` release archives for several backends, chosen by
   `hardware.ts`:
   - Vulkan on Linux and Windows (Linux CUDA falls back to Vulkan, because upstream
     publishes no Linux CUDA archive);
   - CUDA 12.4 and 13.3 on Windows (`cudart` archives);
   - ROCm 7.14;
   - Metal;
   - CPU.

   Natlang's fork (`werg/llama.cpp-neuralese`, `natlang-b12067`) publishes only CPU builds
   (Linux and Windows, x64 and arm64) and Metal. Everything else it builds from source
   (`natlang runtime build`, CUDA when `nvcc` is on PATH). Switching the URL would silently
   drop GPU support for most users.
   → The fork's release workflow must publish upstream's full backend matrix, with
   upstream's asset naming, plus a SHA-256 manifest. The fork already carries upstream's
   release workflow, so the fix is to run it on `natlang-b*` tags rather than maintain a
   separate CPU-only one. The engine then changes in three places:
   - the release base URL;
   - a pinned fork tag;
   - SHA-256 verification of each archive, adopting natlang's static
     length-and-digest check, which the engine lacks today.

   There is no fallback to upstream binaries. The fork *is* the engine.

## 3. Target architecture

```
 agent eval cell (EvalDO, workerd)          natlang panel / worker / automation
   const v: Verdict = await nl`…`(note)       runs a workspace natlang program
   await briefServerLog({ since })                    │
              │                                        │
              ▼                                        ▼
      @workspace/natlang  (Base package; natlang core + workerd platform)
        - environment: Vibestudio sandbox executor (UNSAFE_EVAL, private global)
        - services:    explicit slice of the caller's bindings (fs, vcs, gad, serverLog…)
        - driver:      model gateway client ── RPC ──▶ model gateway (native task per turn)
        - calls/trace: natlang records service ◀── traces, live events (subscribed only)
                                                   │
                                   withModelRequest: policy, credentials at egress,
                                   approvals, telemetry; providers and local-models
```

### 3.1 Model gateway (new Base infrastructure)

- **Purpose.** A single service (`vibestudio.model-gateway.v1`) that performs one model
  turn for an authorized caller. Each turn is a native task, a generalization of
  `NativeModelHelperTask`: it carries tools, `tool_choice`, streaming deltas, and token
  usage, and it is attributed to the caller principal. The caller needs `model.use`.
- **Why one service, not an agent-forwarding special case.** Natlang calls come from
  agent eval, panels, automations, and workers. With one gateway there is one way for
  non-generation code to run a model. The `images` worker's hand-rolled
  `credentials.fetch` to `chatgpt.com` is a candidate to migrate onto it.
- **Attribution.** An agent-eval caller is identified by its EvalDO owner, so traces and
  usage land on the agent.
- **Cancellation.** Eval cancellation aborts the natlang task's `AbortSignal`, which
  cancels the gateway turn. That is an authoritative terminal event, not a timeout. No
  deadlines are added.
- **Main risk.** The protected request port is currently built inside `agent-vessel.ts`
  (7.2k lines). Extracting it into a harness the gateway can host is the riskiest piece of
  the whole plan, and is spike **S2**.
- **Model selection.** Natlang's `model: NAME` frontmatter and the runtime `models` map
  resolve to Vibestudio model refs. Add an `executor` role to
  `packages/shared/src/ai/modelRoles.ts` (decided, D4):
  - It resolves to the local LFM3 when `local-models` reports it `ready`.
  - Otherwise it resolves to the user's low-tier hosted model, which is billed. That
    choice is made per call from current readiness, not by retrying.
  - The resolved model ref is part of each call record and of the executor identity, so
    suites and adaptation artifacts know which model produced a result.
  - `vibestudio.models.v1` reports the role's current resolution, and the panel shows it.

### 3.2 `@workspace/natlang` (Base package)

- **Contents.** Natlang core bundled for workerd, plus four Vibestudio adapters:
  - **workerd `EvalEnvironment`.** About 200 lines, modelled on
    `ts-host/src/browser/environment.ts`. The evaluator comes from `@workspace/eval`'s
    sandbox, so natlang child code gets the same confinement, frozen module namespaces, and
    no `fetch`. The context store uses workerd's `AsyncLocalStorage`.
  - **Gateway `ModelDriver`.** It uses natlang's exported Pi translation.
  - **Service slice.** A natlang task receives only the services its program declares
    (`serviceDeclarations` are the `.d.ts` text of the Vibestudio runtime APIs). It never
    receives the full ambient set. This is natlang's own rule ("authority is the service
    record") enforced by construction: a small model writing code must not inherit the
    agent's whole authority. Approval-gated effects still prompt through the host as they
    do today. A natlang call cannot widen or pre-approve them.
  - **`CallStoreLike` client.** It reports to the records service (3.4).
- **Agent eval surface.** `nl` and `natlang` are ambient in every eval (decided, D2). No
  import is needed.
  ```ts
  const verdict: "urgent" | "normal" = await nl`Decide whether ticket is urgent.`(ticket);
  const brief = await natlang.load("@workspace-skills/server-logs/brief.nl");
  await brief({ sinceSeq });            // typed, traced, small-model
  ```
- **Lowering stage.** `@workspace/eval`'s transform runs natlang lowering when a cell
  references `nl` from this package. The checker sees declarations for current `scope`
  values. If inference would go through `any`, natlang's existing diagnostic asks for
  `nl<T>`, which is teaching in errors.
- **Persistent handles.** A natlang function value kept in `scope` keeps working across
  cells while the kernel is live. After a kernel restart it is reloaded by its definition
  ID, which natlang already records. A live-capture closure is not restorable, and fails
  with natlang's existing "belongs to its running scope" error.
- **How ambient `nl` is provided.** One implementation, owned by Base, with the host
  carrying no natlang code:
  1. `meta/vibestudio.yml` declares a third eval provider beside `evalEngine` and
     `evalRuntime`: `providers.natlang: @workspace/natlang`. The EvalDO resolves it like
     the others (`requireDeclaredProviderSource`).
  2. `"nl"` and `"natlang"` join `EVAL_AMBIENT_ONLY`
     (`packages/service-schemas/src/runtime/runtimeSurface.eval.ts`). The EvalDO injects
     them from the provider. That file is the single source of truth for import validation
     and mirroring, so the owner-local `@workspace/runtime` import form follows
     automatically.
  3. Loading is lazy. A cell that never mentions `nl` loads neither the natlang bundle nor
     the TypeScript compiler. The engine's transform runs natlang lowering only when the
     cell's AST references the ambient `nl` symbol. A local declaration named `nl` shadows
     it as ordinary JS scoping, and natlang resolves `nl` by symbol, so shadowing is
     respected.
  4. `help("nl")` and `help("natlang")` return the declarations and the authoring
     summary. The sandbox skill's `EVAL.md` gets a natlang section, and
     `skills/natlang-authoring` becomes a Base skill.
  5. Evals with no owning agent (panel, CLI) get the same bindings. Their gateway caller
     is the panel or user principal.

### 3.3 Natlang programs as workspace source

- **Loading (revised during implementation).** `.nl` files, callable folders, and
  `natlang.d/` are loaded by `natlang.load(path)`. The provider reads workspace source and
  compiles it with natlang's own `compileVirtualProject`, cached by content hash.
  - I dropped the Build V2 esbuild plugin from the original plan. It would have put
    natlang's compiler into host build code, a second compile path, while the provider
    already carries the compiler.
  - Static checking is a test helper in `@workspace/natlang`. It compiles every workspace
    natlang program and runs through `pnpm test:userland`.
- **Authority of inline `nl` in agent eval.** An inline child has no default services.
  Authority flows only through what the cell explicitly passes, as arguments or as
  bindings the instructions mention (natlang capture semantics). Named programs receive
  exactly the services their `natlang:services` imports declare, taken by name from the
  caller's bindings.
- **Ambient task.** When a cell uses natlang, the EvalDO runs the cell inside the owner's
  natlang `runtime.run`, so every call finds its task. The provider is loaded once per
  isolate, and compiled programs bind to that same instance.
- **Suites.** Natlang's evaluation and adaptation APIs are Node-only, because they use
  fresh worker isolation. They run from the host through a host-owned projection of the
  template sources, `pnpm natlang:eval -- --template T --suite PATH`, using a staged Node
  bundle. Suites use recorded service fixtures and run on the same model and engine as
  the executor role (the local fork with LFM3). Agentic system tests cover the integrated
  path.
- **Skill format convergence.** Natlang's function-local skills (`foo/skills/x/SKILL.md`)
  already use the same `SKILL.md` format as Vibestudio skills. A Vibestudio skill
  directory can be both the agent-facing skill and the natlang context for its functions.
  No second format is needed.

### 3.4 Records and observability

- **Records service.** A Base worker, `natlang-records` (protocol
  `vibestudio.natlang.v1`), stores `natlang.calls/1` records and invocation traces in DO
  SQLite, and fans out live events to subscribers.
- **Live events are pull-gated.** The runtime forwards `onLive` only while something
  subscribes, which is natlang's existing contract, and batches `model_delta`.
- **Feedback.** Marking a call good or bad, or fixing it with an expected result, writes
  tuning examples exactly as natlang's Traces page does today.

### 3.5 Dashboard and controls inside Vibestudio

- **Approach.** A `panels/natlang` panel mounts natlang's own dashboard components. It
  does not reimplement them.
- **What already composes.** `createExecutionModel/View`, `valueView`, `eventTimeline`,
  `argumentForm`, and `typedValueEditor` already take an injected `h`/`ui`. A vanilla-DOM
  mount inside a React ref wrapper is enough.
- **Pages.**
  - **Programs:** workspace natlang programs from the build, a typed run form, and the
    source editor (through `fs`/`vcs`).
  - **Runs:** live, including natlang calls started from agents' evals, grouped by agent
    and eval run.
  - **Traces:** from the records service.
  - **Playground:** natlang `ask` in-process.
  - **Evaluations:** suites and adaptation runs (section 5).
- **Models page.** It is not mounted. Provider sign-in and keys stay in Vibestudio's
  model settings and provider sign-in. The panel shows only the executor-role picker and
  readiness, backed by `vibestudio.models.v1`.

## 4. Changes to natlang

Ordered by dependency. Every semantic change must update `skills/natlang-authoring` and
`skills/natlang-integration` in the same push (natlang's AGENTS rule). Anything the
executing model sees must be measured live, with about 48 samples per variant, or be
logged in `plans/MODEL_FACING_CHANGES.md`.

| # | Change | Why | Size |
|---|---|---|---|
| N1 | **Platform value.** `createNatlangRuntime({ platform })`, where `Platform = { contextStore, environment, callStore?, libProvider, moduleTarget, packageLoader?, onUnhandled? }`. The Node and browser entries build defaults. Remove `setContextStore`/`setDefault*Factory` globals and the global `unhandledRejection` listener. | Wall 4. Several runtimes per isolate. One code path for all platforms. | M |
| N2 | **workerd platform target.** Build `@natlang/core` (compiler, kernel, interpreter, values; no CLI, sqlite, wllama, or Pyodide) as an ESM bundle that loads in workerd with `nodejs_compat`. Add a conformance job that runs the existing scripted-agent tests there. | Wall 1 | M |
| N3 | **Kernel reads no environment.** Move `NATLANG_RETURN_ERROR_TEXT`, `NATLANG_FEEDBACK_GROUP`, and the call-store env/home lookups out of `native/` and `calls/` into options supplied by the Node platform. | Embedding must be explicit | S |
| N4 | **Pi as an injected dependency.** Export `toPiContext(request)`, `fromPiAssistant(message, deltas)`, and `piToolChoice(api, choice)` as pure functions over a structural Pi type. Let `createPiModelBackend` take `{ models }`. Make pi-ai a peer dependency of `@natlang/node`. | Walls 2 and 3. Vibestudio's gateway reuses the translation instead of writing a second one. | S–M |
| N5 | **Host eval-cell compiler entry.** `lowerHostCell(source, { scopeDeclarations, services, contextFolder }) → { code, plans, diagnostics }`, reusing `compiler/inline.ts`, `holes.ts`, and `lower.ts`. | Wall 5 | M |
| N6 | **Evaluator split.** Keep TS→JS compilation (plus `restoreAfterAwait` where needed) in natlang, shared by all platforms. A platform evaluator only executes JS in a realm with bindings. Today each environment calls `ts.transpileModule` itself. | One compile implementation. The Vibestudio adapter stays tiny. | S |
| N7 | **Dashboard as components.** Views become `mount(el, ctx) → dispose`, with `ctx = { h, api: DashboardApi, navigate, toast }`. `DashboardApi` is a typed interface with the HTTP implementation for natlang's server. Runs go through a `RunHost` interface (CLI-subprocess implementation and in-process `runtime.run` implementation). CSS is scoped under a prefix and a cascade layer. Remove the stale `npm-packages/node/dashboard` copy from the tree. Coordinate first with the uncommitted dashboard work currently in `~/natlang`. | Mount pages inside Vibestudio. A cleaner standalone dashboard too. | M–L |
| N8 | **Llama manager as a package.** Extract `model/local-server.ts`, `server-slots.ts`, `scheduler.ts`, `llama-runtime.ts`, and the warm-prefix cache into `@natlang/llama`, with injected spawn, paths, and download verification. Vibestudio's `local-models` extension hosts it. | Wall 6. One supervisor. | M |
| N9 | **Decision readout through any driver.** `decide` currently depends on endpoint `prompt_logprobs`. Define a driver capability `scoreReplies?(request, candidates)` so a gateway or Pi backend can declare it, and fall back to the tool loop otherwise (as today). | Keeps finite classifiers cheap on the gateway | S |

N1, N3, N4 and N6 are independent of each other. N2 needs N1 and N6. N5 is independent.
N7 is independent but must sequence after the in-flight dashboard work. N8 is independent.

## 5. Evaluation-system integration

There are two meanings of "eval" in Vibestudio. The plan covers both.

**Agent `eval` tool (calling natlang).** Covered by 3.2. The eval result already carries
the console, return value, and an `operationJournal`. Natlang calls add:
- a compact `natlang` section in `EvalRunResult`: calls, outcomes, turns, tokens, and
  record IDs;
- each `NatlangCallError` surfaces as a user-code failure whose message is the call's
  `outcome: detail`, with the trace one `natlang.trace(callId)` away instead of pasted
  into the agent's context.

**Testing and evaluation.** Natlang has the better machinery for per-function quality:
- `defineEvaluationSuite` with train, validation, and locked test splits;
- scorers, judge roles, and budgets;
- GEPA and reflection adaptation with portable artifacts.

Vibestudio's system tests judge end-to-end agent behaviour and delivery latency. Keep both
and connect them:

1. **Every ported natlang program ships a suite** (`suite.ts` + `cases.jsonl`). The
   executor identity is the Vibestudio model ref and its settings, and the driver is the
   gateway.
2. **Wiring tests use no model.** Natlang's scripted `agent?: NativeAgent` and
   Vibestudio's `vibestudio-test:deterministic` model cover them, run under
   `pnpm test:userland`.
3. **Quality runs are explicit and budgeted.** A runner command, the equivalent of
   `natlang eval suite.ts --split validation`, runs inside a managed instance so the
   gateway and records are real. Results land in the records service, and the Evaluations
   page shows them.
4. **Adaptation artifacts** (`best.json`) are committed beside the program, bound by
   executor identity. A model change makes them stale, and they must be revalidated. That
   is natlang's existing rule, unchanged.
5. **Per-skill system tests.** For each ported skill, add one agentic system test that
   gives a user-level goal and validates that the agent used the natlang function (from
   the eval `natlang` section) and delivered the right evidence. These tests also measure
   whether delegation to the small model actually lowers latency and cost against the
   agent doing the work itself. Record `overBaseline` as usual.

## 6. Skill port plan

The inventory covered all 27 skills in Base, Personal, and System, plus `vibestudio-agent`.
About 60% of the corpus is orientation for agents building Vibestudio itself and stays as
skills. **Port sub-procedures, not skills.** The `SKILL.md` stays the agent-facing entry.
It shrinks to "when to use this" plus the typed natlang function to call. The executable
core becomes `.nl` functions in the skill directory, with `types.ts` and a suite.

**Effects rule.** A natlang program gets read services and returns *proposals* for
consequential effects (sending a report, launching an automation, an interrupting
notification, a push). The agent or a host approval commits them. Idempotent effects it
may perform go under `ONCE_EFFECTS`.

**Wave 0: pilots.** Every service needed is already eval-callable. These prove the stack.

| Skill | Natlang function(s) | Services |
|---|---|---|
| server-logs | `briefServerLog({ since?, level? }): LogBrief` (cites `seq`, `serverBootId`) | `serverLog` |
| gad-context | `inspectAgentHealth(ref): HealthReport`, `summarizeChannel(pages): ChannelSummary` | `gad` |
| local-models | `localModelReadiness(): Readiness` | `extensions` (`listModels` only) |
| problem-reporting | `classifyDefect(evidence): 'platform' \| 'user-code' \| 'refusal' \| 'transient'` (decision readout), `draftProblemReport(evidence): Draft`. `send` stays with the agent and approval. | `problemReports`, `gad` |
| github | `githubSetupRoute(status, intent): Route`, `accessLevelFor(intent)` (decision) | skill helpers, `credentials` (resolve only) |

**Wave 1: classifiers and extractors.** No new service is needed. Mostly decision
readouts and typed extraction.

- automations: `chooseExecutor(request)` (6-way decision) and `extractSchedule(request): Trigger`
- messaging: `alertRung(message)` (3-way decision)
- visualize: `chooseComponent(data, ask)` and `componentProps(data, component)`
- provenance-orientation: `provenanceMechanism(question)`
- vibestudio-vcs: `typedRecovery(error): NextStep`
- sandbox: `interactionSurface(need)`
- workspace-dev: `unitIcon(unit): IconChoice` and `diagnosePanelLoad(observation): Diagnosis`
- error→remedy lookups from three skills:
  - templates errors
  - GitHub troubleshooting
  - remote-access layer classification
- templates: `summarizeTemplate(inspection)`

**Wave 2: needs typed eval services for things that are agent tools today.** Each
service is built once for general eval use, not natlang-specific.

| Service to add | Unlocks |
|---|---|
| `vcs` compare and status as a typed declaration (the runtime form exists; it needs `serviceDeclarations`) | `semanticCommitMessage(diff)`, `summarizeChanges(compare)` |
| `web` (search, fetch, read; egress-proxied) | `researchBrief(question, sources): CitedBrief` |
| `memory` (recall) | `recallSummary(query): CitedFacts` |
| `addressees` (list, read-only) | `resolveAddressee(utterance): Ref \| Ambiguous` (the notify itself stays agent-side) |
| system-test `inspect` packet (read) | `triageFailure(packet): { class: 'infrastructure' \| 'documentation' \| 'harness' \| 'validator', evidence }` |

**Keep as agent skills.** These are open-ended coding, design, UI exploration, or
judgment over security and merges:
- architecture, capabilities (authoring and denial diagnosis), extensiondev
- clientdev, terminal-apps, sandbox UI authoring
- most of workspace-dev, agentic-development
- vcs conflict resolution, revert and push; templates selected transfer
- performance optimization
- system-test repair

**Per-port definition of done.**
1. `DECOMPOSITION.md` for the skill, in natlang's convention: for each part, a function,
   one instruction, or a crisp helper, and why.
2. `.nl` functions and `types.ts`.
3. A suite with at least train, validation, and test splits from real captured cases.
   Failing cases come from system-test trajectories.
4. A baseline score on the executor role, against the agent's own model as a reference.
5. `SKILL.md` rewritten to call the function. Sweep docs and skills that referenced the
   old procedure (memory rule: skill docs follow surface removals).
6. One agentic system test.

**Port only if the measurement says so.** If the small executor does not meet the
suite's gates, the skill stays agent-executed. The record is kept, and the case set seeds
adaptation or tuning.

## 7. Phases and dependency graph

```
S1 workerd spike ──┐
S2 gateway spike ──┼─▶ P2 @workspace/natlang ─▶ P3 eval lowering + .nl build ─▶ P5 skill waves 0→1→2
S3 Pi diff ────────┘         ▲                         │                          ▲
N1,N3,N4,N6 ─▶ N2 ───────────┘                          └─▶ P4 panel ◀── N7        │
N5 ────────────────────────────────────────────────────────▶ P3                   │
fork GPU release matrix ─▶ engine pin + SHA verify ─▶ live/benchmark parity ─▶ switch ─┐
N8 ──────────────────────────────────────────────────▶ natlang server features + LFM3 ─┴▶ P6 (improves P5; executor falls back to low-tier hosted until then)
```

**Spikes.** These run in parallel, each with a pass/fail question.
- **S1.** Load a natlang core bundle in an EvalDO. Run a scripted-`NativeAgent` natlang
  call whose child eval executes through the Vibestudio sandbox. No model involved.
- **S2.** From a non-agent worker, run one tool-carrying model turn as a native task with
  credentials injected at egress, for an API-key provider and for `openai-codex`
  subscription auth.
- **S3.** Diff the `@panticonic/pi-ai` fork API against upstream 1.4.0 for the surface N4
  uses (`Context`, tools, `stream`/`complete`, tool-choice options).

**Phases.**

| Phase | Work | Depends on |
|---|---|---|
| P1 | Natlang refactors N1–N6, in `~/natlang`, landing on main per its rules | none |
| P2 | `@workspace/natlang`, the gateway, and records | S1, S2, N1, N2, N4, N6 |
| P3 | Eval lowering and the `.nl` build plugin | P2, N5 |
| P4 | Panel | P2, N7 |
| P5 | Skill waves | P3. Wave 0 needs only P2 plus `natlang.load`. |
| P6 | Local engine unification | N8 |

P1 work in natlang and the gateway in Vibestudio have disjoint ownership and run in
parallel.

## 8. Decisions (owner, 2026-10-30)

- **D1. Credentials.** Vibestudio owns credentials. Natlang inside Vibestudio uses only
  the model gateway. Standalone natlang keeps its own store, with no cross-reading.
- **D2. Ambient `nl`.** `nl` and `natlang` are ambient in every eval, through a
  Base-owned eval provider (3.2).
- **D3. Local engine.** There is one local engine: `local-models` is upgraded to natlang's
  llama.cpp fork. This needs the fork's full GPU release matrix first (wall 7).
- **D4. Executor fallback.** When no local executor is ready, use the billed low-tier
  hosted model. The resolved model is recorded on every call.

### P6 in detail: upgrading the local engine to natlang's fork

1. **Fork releases (in `werg/llama.cpp-neuralese`).** Run upstream's release workflow on
   `natlang-b*` tags:
   - the Vulkan, ROCm, Windows CUDA (with `cudart`), Metal, and CPU matrix;
   - upstream asset names;
   - a published SHA-256 manifest.

   Natlang's `scripts/update_llama_runtime.mjs` pins from that same manifest, so natlang
   and Vibestudio pin one release.
2. **Engine (`local-models/engine.ts`).** Point `RELEASE_BASE_URL` at the fork and pin the
   tag. Verify each archive's byte length and SHA-256 from the manifest. Keep the backend
   preference and fallback order from `hardware.ts` unchanged.
3. **Compatibility check.** The existing models (Qwen 3.8 27B preferred, LFM2.5 fallback)
   must behave the same on the fork. Run `local-models`' own live tests
   (`agentic-turn.live.test.ts`, `e2e.live.test.ts`) and `benchmark.ts` on each backend
   available here, against the current upstream pin, before switching.
4. **Natlang server features.** Host `@natlang/llama` (N8) in the supervisor. It brings
   decision scoring (`prompt_logprobs`), warm-prefix slot save and restore (the cache goes
   under the extension's model root), and slot sizing.
   - **LFM3 placement:** run LFM3 as the utility server's model, or as a library model in
     router mode. This depends on whether warm-prefix restore works with router mode.
     Check that during step 4; it is not an assumption.
5. **Model and readiness.** Add LFM3-1.7B (Q8_0, SHA-pinned from natlang's stock list) to
   the library. Expose it through `listModels`, which makes the `executor` role resolve
   locally.

The sequence is 1 → 2 → 3 → switch. Steps 4 and 5 follow and depend on N8, which runs in
parallel with steps 1–3.

## 9. Risks

- **Gateway extraction (S2).** It is the only piece that touches the protected model port.
  If it can't be separated cleanly from `agent-vessel.ts`, natlang calls must route
  through the owning agent's harness. That works for agent eval only, so panels and
  automations would need a host principal.
- **Isolate memory.** The TypeScript compiler inside every EvalDO that uses natlang adds
  several MB per isolate. Measure it in S1, using the performance skill's managed-instance
  profiling.
- **Small-model code under agent authority.** It is mitigated structurally by the service
  slice and unchanged host approvals. No natlang call receives `credentials`, `vcs` write,
  or `chat` unless its program declares them, and declarations are reviewed with the
  program.
- **Model-facing text.** The Vibestudio service declarations shown to the executor are
  model-facing. They need natlang's live measurement before being adopted as defaults.
- **Concurrent natlang work.** Natlang's dashboard is mid-edit by another agent. N7 must
  start from its landed state.
