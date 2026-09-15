# Architecture Review — 2026-07

Status: REMEDIATED (review captured 2026-07-12; remediation integrated 2026-07-13)

A comprehensive structural review of the vibestudio system, produced by a
seven-track parallel exploration of the codebase: server core, Electron/CLI
clients, `packages/`, `apps/`, the RPC/service boundary layer, build/test
infrastructure, and the panel/userland system. Line counts and file references
are as of commit `a0911dce` on `main`.

Related docs: [multi-user-workspaces-plan.md](multi-user-workspaces-plan.md),
[provenance-aware-diff-merge-plan.md](provenance-aware-diff-merge-plan.md),
[typed-service-client-boundaries.md](typed-service-client-boundaries.md),
[../BUILD_SYSTEM.md](../BUILD_SYSTEM.md).

---

## Remediation record — 2026-07-13

The findings below are retained as the point-in-time evidence that drove the
work. Their concrete fixes are now integrated:

- Service schemas live in `@vibestudio/service-schemas`; exhaustive typed
  handler tables derive arguments from those schemas, validate exact method
  coverage, and replace the handler casts/switch defaults. JSON-shaped return
  values now have structural schemas and a recursive contract guard rejects
  weak return roots.
- `@vibestudio/shared` has an explicit export map. Identity, SQLite,
  credentials, workspace contracts/runtime, shell core, and service schemas
  have cohesive package homes with a tested acyclic package graph.
- All eight hand-maintained contract/build duplications in §3.3 now derive
  from canonical data or have exact drift guards. The pairing grammar is a
  generated dependency-free artifact rather than a second implementation.
- The listed god files were decomposed through required collaborators: server
  bootstrap modules, credential mechanisms plus a connection coordinator,
  RPC connection/HTTP/streaming components, typed workerd programs, VCS
  command/repository/memory components, startup/application-window lifecycle,
  compositor recovery, panel resource/lease controllers, AppHost platform
  adapters, owner panel-tree bridging, and headless CLI bootstrap. Replaced
  implementations and state were deleted; no fallback path was retained.
- CLI infrastructure moved out of Electron main; DO abstractions, identity
  subject ownership, `hostCore`, declared state layout, structured unary and
  streaming errors, and cross-build contract-version negotiation now form
  explicit boundaries.
- Host and workspace build documentation is split and cross-linked. Preload
  builds share a factory and run independent stages in parallel; worker
  tsconfigs, Vitest aliases, smoke-build fingerprints, package build profiles,
  and per-package test scripts are canonical and guarded.
- Panel shells share one storage-injected shell core. The native/mobile app
  split is documented. Dead packages/artifacts, stale names/tests/docs, the
  obsolete `apps/well-known` tree, and legacy smoke invite calls were removed.

The VCS boundary has since been replaced destructively by the provenance-native
semantic authority in
[provenance-aware-diff-merge-plan.md](provenance-aware-diff-merge-plan.md).
That cutover removes the obsolete provisional-integration lifecycle instead of forwarding it and is
the sole current VCS architecture record.

---

## 1. Overall verdict

The **macro-architecture is sound and largely matches its documentation**:
hub control plane → process-per-workspace children → host services behind a
single dispatch choke point → workerd Durable Objects, with a
checker-enforced host/userland boundary and a genuinely shared RPC core
across desktop, CLI, mobile, and browser surfaces. **No import cycles were
found anywhere** — not in the package graph, the server tiers, or the client
tiers.

The problems are almost all **meso-scale**: a handful of god files where
whole subsystems live in one lexical scope, a `shared` package whose boundary
has dissolved, a typed service contract that stops one step short of the
handlers, and a family of hand-synced duplications (some security-critical)
held together only by comments and parity tests.

One deliberate non-recommendation: this review does **not** propose
inter-user isolation work. The trusted-team model (shared panel forest,
mutual inspectability, roles gating only host administration) is a stated
design decision and the code honors it consistently.

## 2. What is healthy (preserve these while refactoring around them)

- **The service dispatch choke point.** Every ingress path (WS, HTTP,
  streaming, WebRTC) funnels into `ServiceDispatcher.dispatch()`
  (`packages/shared/src/serviceDispatcher.ts:435`), which performs policy
  check, Zod argument validation, and read-only containment in one place.
  The golden policy matrix
  (`src/server/services/__servicePolicyMatrix.golden.json` +
  `servicePolicyMatrix.test.ts`) and the schema hygiene test
  (`packages/shared/src/serviceSchemas/contract.test.ts` — every one of ~381
  methods must declare args, returns, description, sensitivity; zero
  `z.any()`) are excellent boundary artifacts.
- **The RPC core is shared, not duplicated.** Desktop preload, CLI, mobile,
  and headless-host all use the same `createRpcClient` /
  `wsClientTransport` / `createPairedConnection` primitives from
  `@vibestudio/rpc`. The signaling worker is the *server* of that protocol,
  not a re-implementation; framing primitives (`streamCodec`,
  `controlFraming`, `bulkMux`, `frameScheduler`) are reused across the
  WebRTC and HTTP paths.
- **`apps/headless-host` as a separate app is correct.** It is a spawned
  child-process bundle with only a process contract
  (`src/server/headlessHostManager.ts`); the server never imports it. Do not
  fold it into `src/server`.
- **The host/userland boundary checker**
  (`scripts/check-host-workspace-imports.mjs`, `check:host-boundary`)
  enforces the split in both directions, with a ~36-entry soft allowlist.
- **buildV2** (`src/server/buildV2/`, ~13,000 lines), the in-server
  content-addressed panel/worker build system, is sophisticated and
  well-documented by `BUILD_SYSTEM.md`.
- **Consistent service shape.** 57 `createXService()` factories returning
  `ServiceDefinition`s, registered through the DI container — the pattern is
  uniform and worth keeping as the god files are decomposed around it.
- **Preload is thin and interface-driven** (`ipcTransport` and `wsTransport`
  share the `TransportBridge` interface); test density on the client side is
  high (58 test files against 87 sources in `src/cli` + `src/main`).
- **`apps/signaling` and `apps/webhook-relay` having no `workspace:*` deps is
  intentional** (edge build isolation), not an oversight.

## 3. The six structural problems that matter

### 3.1 The schema→handler type gap (highest-leverage fix in the repo)

The Zod schema tables in `packages/shared/src/serviceSchemas/` are the single
source of truth for *clients* (`createTypedServiceClient`,
`packages/shared/src/typedServiceClient.ts:79-145` derives all types via
`z.infer`), but server handlers re-declare argument types by hand:

- **125 unchecked `args as [...]` casts** across `src/server/services/*.ts`
  (representative: `src/server/services/runtimeService.ts:1064`). These are a
  second, independent copy of the schema's arg types with no compile-time
  link to the Zod tuple. If schema and cast drift, nothing catches it.
- **45 runtime-only `default: throw new Error("Unknown ... method")`**
  branches. A method declared in the schema table (and therefore exposed on
  the typed client and the capability catalog) but not implemented in the
  handler switch fails only at runtime. `contract.test.ts` checks the schema
  side only; no test verifies handler ⊇ schema coverage.
- **32 methods declare `returns: z.custom()/z.unknown()`** — TS-typed but
  performing no runtime validation, so their return values cross the wire
  unvalidated despite `shouldValidateServiceReturns`. Weak-node
  concentration: `serviceSchemas/panelTree.ts` (21), `workspace.ts` (16),
  `docs.ts` (11). Totals: 72 `z.unknown()` and 35 `z.custom<T>()` nodes.

**Recommendation.** Introduce a typed handler-table helper — e.g.
`defineHandlers(methods, { createEntity: (ctx, [spec]) => ... })` — where
each handler's parameters are inferred from `z.infer<methods[K].args>` and
the map is exhaustiveness-checked against `keyof methods`. This eliminates
the cast drift class and the unimplemented-method-at-runtime class in one
move. As a cheap interim, add a contract test asserting that every schema
method dispatches without hitting the "Unknown method" default, and replace
the weak `returns` schemas with real ones where the payloads are JSON-shaped.

### 3.2 `@vibestudio/shared` is a 48k-line grab-bag with no boundary

- 255 files / ~48.3k lines — larger than every other package combined;
  imported by **451 files** and 5 packages.
- Exports via wildcard: `"./*": "./src/*.ts"` in
  `packages/shared/package.json`. There is no entry index; **155 distinct
  deep-import subpaths** and zero bare `@vibestudio/shared` imports exist.
  The package boundary is meaningless — deep-import reaching is
  institutionalized by design.
- It contains whole subsystems, each a merge/extract candidate:
  `serviceSchemas/` (45 files, 9,146 lines), `workspace/` (3,449),
  `shell/` (2,171 incl. `panelManager.ts` at 1,515), `credentials/` (2,004),
  `users/` (1,326), `panel/` (894) plus 115 top-level files.
- Worse, it is the **escape hatch through the host/userland boundary**: the
  boundary checker deliberately exempts `@vibestudio/shared`, and
  `shell/panelManager.ts` is imported simultaneously by `src/main` (system),
  `src/server/panelRuntimeRegistration.ts` (system), and
  `workspace/apps/mobile` (userland). The userland line runs *through* the
  shell, not around it. This is the root cause of the panel-logic scatter
  and the shell-core fork described in §3.7.
- Two "shared types" homes overlap: `packages/types` (236 lines, zero-dep)
  vs `packages/shared/src/types.ts` (549 lines, which re-exports
  `@vibestudio/types` and adds manifest types).
- A stray compiled artifact `packages/shared/src/typedServiceClient.js` is
  checked in next to its `.ts` source in a source-only package.

**Recommendation.** (a) Replace the wildcard export with an explicit
`exports` map and a curated index — this alone stops arbitrary deep reaching
and reveals the real public surface. (b) Extract cohesive subtrees into real
packages: `service-schemas`, `identity` (`users/`), `workspace`, and merge
`credentials/` with `credential-client`. (c) Decide whether panel-tree logic
(`shell/`) is system or userland and enforce it — today it is neither.
(d) Consolidate the two types homes. (e) Delete the stray `.js` artifact.

### 3.3 Split-brain duplications held together by hand

Contracts that exist in two-plus hand-synced copies, enumerated:

1. **Security-critical — pairing grammar.**
   `scripts/cli/lib/connect-utils.mjs` (295 lines) is a hand-maintained,
   dependency-free copy of `packages/shared/src/connect.ts`
   (fingerprint/loopback/version-gate validation). Its own header
   (lines 8–11) says the copies "must be held byte-identical … any
   divergence is a pairing-security bug"; only a parity test
   (`packages/shared/src/connect.test.ts`) polices it. Fix: build a tiny
   no-dep ESM artifact from `connect.ts` that both the TS world and the
   bare-node `scripts/cli/*.mjs` world import. The same fix retires the
   duplicated `resolveSignalingUrl`/`parseSignalingEndpoint`/
   `normalizeFingerprint`.
2. **Signaling wire types.** `apps/signaling/src/protocol.ts:1-23`
   re-declares `RtcSessionDescription`/`RtcIceCandidate`/`RtcIceServer`
   from `packages/rpc/src/transports/webrtcPeer.ts` "field-for-field" —
   deliberate (edge build isolation is sound) but unenforced. Fix: a
   type-level assertion test (`satisfies`/`expectTypeOf`) run by the
   umbrella vitest; keep the deploy boundary, kill the silent drift.
3. **Workspace-template taxonomy, triplicated.**
   `scripts/build-npm-packages.mjs:50-61` (`WORKSPACE_TEMPLATE_DIRS`),
   `electron-builder.yml:32-48` (`extraResources` filters), and the TS
   `WORKSPACE_SOURCE_DIRS` constant. A drift test covers one pair; the
   electron-builder copy has **no** guard. Fix: generate the
   electron-builder filter or extend the drift test.
4. **Build-artifact banner strings.** `scripts/check-build-artifacts.mjs`
   (e.g. lines 36-40, 83-86) asserts byte-exact substrings duplicated from
   the `banner` injected at `build.mjs:133-142`. Fix: derive both from one
   shared constant.
5. **Config/credential paths re-derived.** `scripts/cli/remote-doctor.mjs:83-105`
   hand-rolls the XDG config root and credential path that
   `src/cli/configPaths.ts` and `credentialStore.ts` own (the latter's
   comment at line 51 explicitly warns doctor must agree).
6. **Hardcoded routing list.** `ELECTRON_LOCAL_SERVICE_NAMES`
   (`packages/rpc/src/types.ts:544`, 12 entries) must be hand-edited when a
   local service is added or routing silently defaults to the server.
   Fix: derive routing from service registration metadata.
7. **npm dependency allowlists.** `computeHostDependencies()` plus
   `HOST_BUILD_DEV_DEPS`/`SERVER_EXTRA_DEPS`
   (`scripts/build-npm-packages.mjs:34-41,416`) silently go stale as root
   deps change.
8. **Node-builtins set.** `bootstrapExternalsPlugin`'s hardcoded 39-entry
   set (`build.mjs:317-356`) must track Node's actual builtins.

### 3.4 God files that are really unstructured subsystems

The pattern repeats across every tier; section-banner comments already mark
the seams in most of them.

| File | Lines | What is fused together |
|---|---|---|
| `src/server/services/credentialService.ts` | 5,392 | OAuth1 (`oauth1AuthorizationHeader:4583`), OAuth2, JWT (`signJwtAssertion:4520`), SSH (`openSshEd25519PublicKey:4564`), API-key templating (`renderApiKeyMaterialTemplate:4439`) inside one ~3,800-line factory |
| `src/server/index.ts` | 4,957 | one `main()` spanning `:308-4908`; ~15 file-backed stores; 55 `container.register*` calls; ordering dependencies documented only via "lazily built once doDispatch is resolvable" comments (`:261-276,440-445,607-610`) |
| `src/server/rpcServer.ts` | 4,419 | one `RpcServer` class (`:568`→EOF), 83+ methods: transport, session lifecycle, caller-subject resolution, upload preopen, streaming |
| `src/cli/agent/vcsCommands.ts` | 1,602 | ~12 vcs subcommands, 67 command entries, 49 helpers |
| `src/main/index.ts` | 3,300 | crash-recovery argv parsing (`:52-77`), GPU flags, diagnostics (`:231-248`), window creation (`:1554+`), lifecycle wiring (`:1761+`); module-level `let` singletons |
| `src/server/appHost.ts` | 3,108 | unit/build/workspace hosting + token minting + residual panel wiring |
| `src/server/workerdManager.ts` | 2,815 | includes ~3 worker programs embedded as untyped template strings: `generateWorkerHostCode:1661`, `generateUniversalDOCode:1739`, `generateRouterCode:1557` |
| `src/server/vcsHost/workspaceVcs.ts` | 2,620 | substantial host-side VCS logic despite the narrow-host plan's "dumb primitives" target |
| `src/main/viewManager.ts` | 2,534 | — |
| `src/main/panelOrchestrator.ts` | 2,087 | — |
| `src/server/panelRuntimeRegistration.ts` | 1,640 | header says "panel trees no longer live here" — residual code from a migrated ownership |
| `src/cli/client.ts` | 1,327 | entrypoint + three command registries + ~200 lines of headless-host WebRTC bootstrap (`:836-1033`) |

The god files also carry god test files (`rpcServer.test.ts` 2,994,
`appHost.test.ts` 2,693).

**Recommendation.** Decompose along seams that already exist:
`index.ts` into `wireCredentials()`/`wireVcs()`/`wirePanels()`/`wireWorkerd()`
bootstrap modules each taking the container; `credentialService` by auth
mechanism (the subsystems share no mutable state); `RpcServer` continuing the
`rpcServer/sessionRegistry.ts` split precedent; and move the workerd
embedded worker JS into real `.ts` files built through the existing pipeline
so the generated worker code is type-checked and linted. For `appHost.ts`
and `panelRuntimeRegistration.ts`, the target decomposition is already
captured by the current subsystem architecture documents.

### 3.5 Layering leaks

- **CLI → Electron main.** `src/cli/webrtcClient.ts:135` imports
  `../main/webrtc/nodeDatachannelPeer.js`; `src/cli/client.ts:845` imports
  `../main/panelAssetFacade.js`. Both are shared infrastructure that
  physically lives under `main/`. Move the datachannel peer factory toward
  `@vibestudio/rpc` and the asset facade to a neutral module so the CLI does
  not transitively pull the Electron tree.
- **Services → DO transport concretions.** Seven services type-import
  `DODispatch`/`DORef` from `../doDispatch.js` (`alarmDriver.ts:2`,
  `lifecycleDriver.ts:2,5`, `cleanupReaper.ts:11`, `evalService.ts:4`,
  `entityTitleService.ts:21`, `recurringRegistry.ts:10`,
  `workspaceStateService.ts:18`). Define a narrow `DoDispatcher` interface
  in shared so `doDispatch.ts`/`workerdManager.ts` become implementation
  details.
- **Domain type owned by the transport file.** `UserSubjectSource` is
  defined at `rpcServer.ts:111` and imported upward by
  `services/userSubjectSource.ts:27`. Move the interface out of the
  transport module.
- **Hub ↔ child sharing has no named home.** `hubServer.ts:60-65`
  value-imports workspace-child service modules (`accountService`,
  `RoutedRoomStore`, `services/auth/*`). Sanctioned by
  `multi-user-workspaces-plan.md:108-110`, but there is no shared `hostCore`
  module separating "what both processes use" from "what the child
  registers."
- **Undeclared state layout.** ~15 stores each hand-`path.join(statePath, …)`
  their own subdirectory (`index.ts:740,742,924,953,1008,2319,4764`, …).
  Introduce a single `stateLayout(statePath)` module that names every
  subdirectory, turning the on-disk contract into a declared, greppable
  surface.
- **RPC error contract is flattened.** The server has a typed error
  hierarchy (`ServiceError`/`ServiceAccessError`,
  `serviceDispatcher.ts:355-391`) but the wire carries only
  `{ error, errorCode?, errorStack? }` (`packages/rpc/src/types.ts:69`) and
  the client reconstructs a plain `Error` (`client.ts:283-287`); streaming
  errors take a different shape again (`client.ts:334`). Add a structured
  `errorKind` discriminator shared by unary and streaming paths.

### 3.6 Two build systems, drifting docs

- There are **two entirely separate build systems**: the host/desktop build
  (`build.mjs`, 662 lines — 15 esbuild config literals, 9 near-identical
  preload configs at `:179-281`, three inline plugins, fully serial despite
  the comment at `:577` claiming parallelism) and the runtime workspace
  build (`src/server/buildV2/`, ~13k lines). `BUILD_SYSTEM.md` documents
  only the latter and opens with "all builds run in the server process" —
  false for the build a newcomer running `pnpm build` actually hits.
- **Docs described both today and target with no reconciliation.** The obsolete
  narrow-host plans have now been deleted; the destructive semantic VCS
  cutover is specified in `provenance-aware-diff-merge-plan.md`.
  `multi-user-workspaces-plan.md` mandates a big-bang cutover, yet
  user-principal scaffolding already leaks into `index.ts:370-402` ahead of
  it. The typed-service-client migration still carries a 28-entry raw
  `.call("main", …)` allowlist (`tests/typed-service-client-guard.test.ts:32`).
  `PERMISSIONS.md` is an explicit stub. `docs/audit/06-http-webhooks-external.md:364,374,514-517`
  references files deleted with `apps/well-known`'s source.
- **Test config sprawl.** Four vitest configs + playwright + jest (mobile);
  ~60 lines of comments across the vitest configs work around one root
  cause (pnpm hoisted-linker duplicate React). The tsconfig-alias transform
  is copy-pasted verbatim between `vitest.config.ts:14-35` and
  `vitest.browser.config.ts:20-34`. Only one package (`browser-data`)
  declares a `test` script despite `shared` holding 73 test files — testing
  is centralized but undiscoverable from packages.
- **Inconsistent package build models.** Four strategies across 16 packages
  (tsc, tsc --build, custom `build.mjs`, source-only) with mixed
  `dist/`-vs-raw-TS entries and inconsistent tsconfig pairs; the two
  Cloudflare Worker tsconfigs are byte-identical but standalone while
  `headless-host` extends root; `type-check:cloudflare` hardcodes the Worker
  list (root `package.json:45`).

### 3.7 Panel logic scatter and the shell-core fork (corollary of 3.2)

Panel-tree/navigation/hosting responsibility spans at least five roots with
no single owner: `packages/shared/src/shell/` (2,171) +
`packages/shared/src/panel*` (~894 + 16 loose files) + `src/main/` (6,857 in
panel/view/shell-named files) + `src/server/` (3,197) +
`workspace/apps/shell` (15,609, userland) + `workspace/apps/mobile` (14,225,
userland). Fifty panel-named source files exist repo-wide.

Concrete fork: `src/main/shellCore/localViewState.ts` (53) and
`workspace/apps/mobile/src/shellCore/localViewState.ts` (68) are parallel
implementations of the same `LocalPanelViewStateStore` interface (identical
shape; only fs vs AsyncStorage differs), as are
`createElectronShellCore.ts` (113) vs `createMobileShellCore.ts` (112).
Collapse onto one injectable core parameterized by a storage adapter.

Also non-obvious and worth documenting: `apps/mobile` is only the native
shell + recovery surface; the real mobile app is `workspace/apps/mobile`
(hot-updatable bundle). This split is explained only in a comment at the top
of `apps/mobile/index.js`.

## 4. Additional findings (smaller, concrete)

- **`apps/well-known/` is dead.** Only an untracked `dist/` remains; source
  was removed in commit `137ed036`; webhook-relay is the single apex owner
  per [webrtc-deployment.md](webrtc-deployment.md). Delete the directory and
  fix the dangling audit-doc references.
- `headlessHostManager.ts:95-108` carries a 5-way fallback path search for
  the headless-host entry — pin a single build-output contract instead.
- Single-consumer packages: `extension-host` (5.5k lines, one consumer:
  `src/server`) and `port-utils` (one consumer) — fold in or justify the
  package boundary (e.g. publishing needs) explicitly.
- Git concerns are split: `packages/git` vs `shared/gitFormatting.ts` +
  `shared/serviceSchemas/vcs.ts` (959 lines) — co-locate.
- `src/cli/client.ts:1193-1208`: `wantsHelp` and `wantsScriptHelp` are
  byte-identical.
- `rpcClient.ts:267-350` repeats the same `if (this.isWebRtc)` fork across
  five methods — collapse behind one transport-selection accessor.
- Naming hazards: `refService.ts` vs `refsService.ts` (legitimately distinct,
  one character apart); `configLoader.ts` is panel bootstrap JS, not config
  loading; the lone `services/__tests__/workspaceService.test.ts` breaks the
  otherwise-uniform co-located test convention.
- No explicit contract-version negotiation exists for cross-build-boundary
  consumers (signaling, mobile, extensions); `sessionNegotiation.ts` covers
  transport sessions only. Consider a `contractVersion` in the auth/session
  handshake so incompatible peers fail loud.
- Four `test:*` smoke scripts prepend a full serial `node build.mjs`
  (`package.json:69-74`); no incremental/watch host build exists.

## 5. Prioritized roadmap

### Tier 1 — Quick wins (hours each, zero risk)

1. Delete `apps/well-known/`; fix the four dangling references in
   `docs/audit/06-http-webhooks-external.md`.
2. Delete `packages/shared/src/typedServiceClient.js`; collapse
   `wantsHelp`/`wantsScriptHelp`; relocate the lone `__tests__` test; rename
   `configLoader.ts`; disambiguate `refService.ts`/`refsService.ts`.
3. Add the handler-coverage contract test (interim for §3.1) and the
   signaling wire-type assertion test (§3.3.2) — pure test additions that
   convert silent runtime drift into CI failures.
4. Extract the duplicated vitest alias block; factory-ize the 9 preload
   esbuild configs; parallelize `build.mjs`'s independent builds
   (respecting the internal-DO read-back ordering).

### Tier 2 — High-leverage structural bets

5. **Typed handler tables** (§3.1): eliminates 125 casts and 45 runtime
   throws at the root. The single best correctness-per-effort investment in
   the repo. Then tighten the 32 weak `returns` schemas.
6. **`shared` breakup** (§3.2): explicit exports map first, then extract
   `serviceSchemas` and `users`, then decide panel-tree ownership — which
   also unlocks the shell-core de-fork (§3.7).

### Tier 3 — Debt-retirement campaign (incremental)

7. Eliminate the pairing-grammar split-brain (security-critical) and the
   other hand-synced contracts (§3.3), roughly in the numbered order given.
8. Fix the CLI→main imports and introduce the `DoDispatcher` interface seam
   and `stateLayout` module (§3.5).
9. Decompose the god files (§3.4) in order of fragility:
   `src/server/index.ts` `main()`, then `credentialService.ts`, then
   `rpcServer.ts`, then the `src/main` trio and `vcsCommands.ts` /
   `client.ts` — each along seams the existing refactor plans already name.
10. Unify the error contract across unary/streaming RPC (§3.5) and derive
    Electron-local routing from registration metadata (§3.3.6).

### Tier 4 — Hygiene

11. Reconcile the docs: scope-rename `BUILD_SYSTEM.md` (workspace build) and
    add a short host-build doc for `build.mjs`; add status/"last-reconciled"
    headers to top-level docs cross-linking active plans; document the
    `apps/mobile` vs `workspace/apps/mobile` split with a README pointer.
12. Standardize package build/test conventions: one build model per tier, a
    `test` script wherever test files exist, a shared `tsconfig.workers.json`
    for the two Cloudflare Workers, and a glob-based `type-check:cloudflare`.

---

*Method note: findings were gathered by seven parallel read-only exploration
agents (server core, clients, packages, apps, RPC boundary, build/test,
panels/userland), each reporting with file:line evidence; this document is
the cross-checked synthesis. Counts (e.g. 125 casts, 155 subpaths, 381
methods) are grep-derived at the commit noted above and will drift.*
