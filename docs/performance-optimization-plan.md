# Performance Optimization Plan

Status: proposed · 2026-07-23

This plan supersedes the earlier model-generated performance review. Every claim below has
been re-verified against the current source; where the original review was wrong or
imprecise, this document says so and plans against what the code actually does.

## Measurements (carried over, still valid)

| Area                             | Evidence                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------- |
| Slow (genesis) workspace startup | 43.5s gateway-to-ready; ~30.9s semantic initialization + 8.46s conduit-seeding gap |
| Established workspace startup    | 9.3s to all-services-started; ~5.6s with warm semantic state                       |
| Chat panel first load            | 2.12MB raw JS / 591KB Brotli, 724KB raw CSS, ~675KB Brotli across ~20 assets       |
| Other panels                     | News 605KB, Spectrolite 766KB Brotli JS — the bundle problem is shared             |
| Local caches                     | 14GB build cache, 7GB external deps, ~1GB extension deps, 610MB CAS                |

These are local artifact/log measurements. Per-panel byte attributions (e.g. "405KB Radix
icon chunk") were **not** independently verified and should be re-derived from the esbuild
metafile once budgets exist (WS4).

## Corrections to the original review

Verified inaccuracies and omissions — these change the plan:

1. **Genesis graph work is 9×, not 8×.** Besides the 8 concurrent conduit-unit
   resolutions (`src/server/index.ts:1379-1398`), `initBuildSystemV2` itself does a full
   `discoverGraph` + hash + EV pass at boot (`src/server/buildV2/index.ts:378-410`). Up to
   9 full passes over the same immutable state.
2. **The redundancy is CPU, not disk.** `materializeStateForGraphDiscovery` holds a
   per-state lock, so tree materialization is effectively single-flighted; graph parsing,
   hashing maps, and EV computation are what run 8–9× (`src/server/vcsHost/workspaceVcs.ts:811-850`).
3. **semanticWorkspace does not directly block "every service."** Only `buildSystem`
   (`src/server/index.ts:1369`) and `vcsGcScheduler` depend on it directly — but
   `buildSystem` is the hub everything interactive hangs off, so it still transitively
   gates readiness. The fix target is the `semanticWorkspace → buildSystem` edge.
4. **The full source re-hash is a genesis-only worst case.** `hashFiles` consults a
   `.gad/CHECKOUT.json` mtime sidecar and skips unchanged files on subsequent boots
   (`src/server/vcsHost/contentProjectionStore.ts:330-337`). The 30.9s cost is dominated by
   first-run hashing + DO import/publish, not a per-boot tax. This makes **pre-seeding on
   copy/create** (WS1) the right fix rather than a boot-path rewrite.
5. **Entities are resolved twice per open slot per refresh** — once in
   `fetchPanelTree` (`packages/shell-core/src/panelManager.ts:1139-1145`, authority fields
   discarded) and again in `hydrateExecutionAuthority`
   (`src/server/ownerPanelTreeBridge.ts:421-427`). The original review saw the second pass
   but not that it is pure redundancy.
6. **A tree revision counter already exists** (`packages/shared/src/panelRegistry.ts:73`,
   embedded in every snapshot at `:125`), and desktop already gates on it
   (`PanelTreeContext.tsx:477-480`). The real defect is that **server and client registries
   keep independent counters**, which is exactly why desktop spins a 40-attempt
   shape-comparison poll loop instead of comparing revisions
   (`PanelTreeContext.tsx:505-531`). "Add revisions" is wrong; "unify the revision
   authority" is the fix.
7. **Mobile's 60s MainScreen timer is local-only** — it reads the in-memory registry
   mirror and issues no RPC (`apps/mobile/src/components/MainScreen.tsx:363-381,799`). Its
   cost is React re-render churn (which matters because `PanelWebView` is unmemoized), not
   network. The RPC-bearing poll is the 30s one in
   `apps/mobile/src/services/shellClient.ts:945-950`.
8. **Serve-time compression is cached** in-memory per artifact+encoding
   (`src/server/panelHttpServer.ts:107,877-885`) — but at speed-tuned quality (brotli 4,
   gzip best-speed, `:186-189`) and the cache dies with the process. The durable win is a
   persistent, integrity-keyed **transport derivative cache**, populated after a build is
   usable; inline max-quality compression would make cold panel builds slower and must not
   enter the sealed build manifest.
9. **Build GC has a retention-invariant gap, not just a coverage gap.** `buildStore.gc`
   preserves only the current-EV build keys the caller enumerates
   (`src/server/buildV2/index.ts:1380-1391`); rollback builds use older EVs
   (`src/server/appHost.ts:680-689,1011`), so a local GC run can delete artifacts a
   rollback depends on. With shared central storage the shared-cache fallback in
   `buildStore.get()` (`buildStore.ts:566-582`) currently masks this; it is dangerous
   today only where no shared cache is configured, and becomes universally dangerous once
   central GC exists (see WS5). Additionally, the central artifact pool and central
   build-result cache (`buildStore.ts:184-190`) are never scanned by any GC at all.

## Cross-cutting principle: mobile parity by construction

Every workstream must state where its win lands for mobile. Preference order:

1. **Shared infrastructure** — fix it in the layer both clients consume
   (`packages/shell-core`, `packages/shared`, WorkspaceDO, the builder). Mobile drives
   tree sync through the same `shell-core` `panelManager` desktop uses
   (`workspace/apps/mobile/src/services/shellClient.ts` → `panels.refresh()` →
   `fetchPanelTree`), so shared-layer fixes land on both clients automatically.
2. **Mirrored client change** — where the consuming code is platform-specific (desktop
   `PanelTreeContext`, mobile `shellClient`/`MainScreen`), both sides are enumerated as
   explicit tasks in the same workstream; neither ships as "done" with only one client
   converted.
3. **Mobile-specific work** — mobile has constraints desktop doesn't: panel assets are
   proxied over the WebRTC pipe via streaming `gateway.fetch` with gzip on the wire
   (`workspace/apps/mobile/src/services/panelAssetFacade.ts`), cached in a 256MiB
   in-memory LRU keyed by URL path + forwarded headers (`panelAssetFacade.ts:253-262` —
   safe because artifact URLs are content-hashed) plus the WebView HTTP cache keyed to a
   stable persisted loopback origin. Bundle bytes therefore cost mobile _more_ than
   desktop (pipe throughput + memory-cache pressure), and content-addressed/immutable
   asset URLs are what make its two cache layers effective.

## Priorities

Ordered by measured impact ÷ implementation risk:

| #   | Workstream                                                                       | Attacks                                                | Expected effect                                                                       |
| --- | -------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| WS0 | Startup + interaction instrumentation                                            | startup/interaction attribution blindness              | validates the dependency-ready scheduler already in the worktree; staged prerequisite |
| WS1 | Startup: batch resolution + semantic pre-seed (genesis) + warm path              | 8.46s + bulk of 30.9s; 5.6s warm                       | genesis start approaches warm start; warm start shrinks                               |
| WS2 | Panel-tree: one bootstrap query + DO-persisted revision                          | N+1 fan-out, 40-poll loop, mobile refresh storms       | best shared desktop/mobile latency win                                                |
| WS3 | Panel bundles: lazy exposes + shared vendor CSS + transport-cache precompression | ~600–770KB Brotli JS + ~812KB duplicated CSS per panel | first-paint payload cut by well over half                                             |
| WS4 | Build measurement + budgets (metafile-based)                                     | attribution, then regression prevention                | baselines WS3, then locks it in                                                       |
| WS5 | Cache retention: reachability + disposable-cache LRU                             | 22GB+ unbounded growth + rollback-retention gap        | disk/DX + correctness fix                                                             |

---

## WS0 — Instrumentation first

The 30.9s semantic phase and the 43.5s total are still too coarsely attributed. The
current worktree has already replaced dependency-depth barriers with per-node,
dependency-ready service scheduling and logs starts taking at least 500ms
(`packages/shared/src/serviceContainer.ts:110-179`). The plan must therefore validate and
measure that scheduler, not propose a second conditional scheduling path.

1. **Structured per-service timing** — use a monotonic clock to record dependency-ready,
   actual-start, and completion times for every service, including fast services. Keep
   concise human logs, but make the complete timing set available as one structured
   startup report.
2. **Realized dependency-DAG report and scheduler validation.** Record each service's
   critical predecessor, start duration, and scheduler queue delay; report the realized
   critical path plus slow independent services. Add a test proving a fast
   root→dependent chain starts while an unrelated slow root is unresolved. Preserve and
   explicitly test cycle/missing-dependency detection, optional-dependency ordering,
   single start, fail-fast with a hung sibling, transitive dependency-failure
   propagation, cleanup of late completions, partial-start abort, and
   reverse-topological stop. This is one scheduler migration, never a feature flag or
   parallel implementation.
3. **Split semantic activation spans** — separate timings inside
   `activateWorkspaceFromSource` for: pending-effect recovery, source scan/hash, CAS
   mirror, `vcsImportSnapshot`, `semanticWorkspaceInitializationPush`, config read,
   materialization (`src/server/vcsHost/workspaceVcs.ts:617-698`).
4. **Interaction spans** — click → RPC dispatched → op queued → slot reserved → entity
   prepared → view allocated → first response → first panel paint. Fix the Electron marks:
   server-spawned/server-connected are recorded consecutively and post-connect ends at a
   window-created mark that can predate connection (`src/main/index.ts:2807`).
5. **Mobile interaction spans, same schema** — tap → bridge RPC dispatched → façade asset
   fetch → WebView load → first panel paint. Emit through the same span vocabulary as
   desktop so the two are comparable. Direct façade counters are: requests, memory-LRU
   hits/misses, in-flight single-flight joins, remote fetches, compressed pipe bytes
   counted once before the stream is teed, loopback response bytes, evictions,
   oversized-cache skips, and fetch failures. The façade **cannot** observe WebView
   HTTP-cache hits because those requests never reach it. Treat avoided façade
   requests/pipe bytes against the known asset closure as the canonical warm-cache
   measure; Resource Timing is supplemental visibility, not a fabricated WebView hit
   counter.
6. **Cross-process correlation** — the interaction path crosses renderer, Electron main,
   server, BrowserView/WebView, and possibly a mobile device; raw timestamps from
   different clocks can't be joined. Propagate a launch correlation ID from click through
   RPC, lifecycle preparation, view creation, asset requests, and first-paint ack, and
   record structured parent/child spans with locally-monotonic durations per process.

Stage WS0 rather than treating it as one small prerequisite:

- **WS0a** — service/semantic timings and dependency-scheduler validation; ship before
  or with WS1a.
- **WS0b** — cross-process desktop/mobile interaction tracing; ship before judging WS2/WS3
  user-visible results, but do not make it block the self-contained WS1a cache fix.

## WS1 — Genesis startup

### 1a. Batched build-unit resolution (kills the 8.46s gap)

`resolveBuildUnit` with an explicit `state:` ref bypasses both the in-memory
`StateTransitionTrigger` cache and the persisted-EV fast path
(`src/server/buildV2/index.ts:970-982`), so each of the 8 conduit seeds — plus init
itself — re-runs discover + hash + EV.

- Add `resolveBuildUnits(unitPaths: string[], stateRef)` in `src/server/buildV2/index.ts`:
  one `discoverGraph`, one `contentHashesAt`, one `computeEffectiveVersions`, then map all
  paths against the shared `{stateHash, graph, evMap}`. `resolveBuildUnitIdentity`
  (`:1011-1024`) already computes exactly this shape for one unit.
- Convert conduit seeding (`src/server/index.ts:1384-1385`) to one batched call.
- Additionally memoize the `(stateHash → GraphView)` result single-flight so _any_
  concurrent explicit-state resolver shares it. Lifecycle: a `stateHash` is immutable, so
  entries are never _invalidated_ — not on head advance (rollback and explicit-state
  resolution legitimately need old states, `src/server/buildV2/index.ts:969-982`) — only
  _evicted_ by a bounded LRU/reachability policy. And because `initBuildSystemV2` computes
  its initial `{stateHash, graph, evMap}` outside `resolveBuildUnit`
  (`index.ts:378-410`), the cache must be **explicitly seeded** from that initial pass —
  a cache declared at the resolver layer won't capture it automatically. The eight conduit
  lookups are the redundancy; the initial ninth pass is the baseline that populates the
  cache.

Expected: the 8.46s "build-identity" phase collapses to ~1 pass (~1s).

### 1b. Pre-seeded semantic snapshot — built at packaging time, not create time

Genesis pays full scan + hash + mirror + DO import + publish inline during boot, gating
`buildSystem`. Two constraints shape the fix:

- **Do not move the cost onto the create path.** `initWorkspace`
  (`packages/workspace/src/loader.ts:359`) is fully synchronous and sits directly on the
  user-visible create/open flow (`:615,:638`); scanning and hashing there would just turn
  a slow first boot into a 30s "Create Workspace" click. The metric to improve is
  **create click → usable workspace**, not gateway-to-ready in isolation.
- **Copying the sidecar alone doesn't work.** The `.gad/CHECKOUT.json` fast path requires
  exact size _and_ mtime matches (`contentProjectionStore.ts:327-332`), and the copy path
  uses `copyFileSync` which stamps fresh mtimes (`loader.ts:452`). The sidecar also holds
  none of the semantic DO's imported/published state — it is purely a hash-projection
  cache.

Design:

- Generate a versioned `PreparedWorkspaceSource` for the shipped template **at packaging
  time** (when the template is built), not per-create and not per-boot. It contains the
  state hash, a path-sorted file inventory (`path`, mode, size, digest), and the reachable
  CAS root/tree/object inventory. Packaging verifies it once and ships the prepared
  content artifact instead of treating the raw template directory as the source of truth.
- Replace "copy, then convince the cache" with **one canonical materialization
  primitive**. Extract the existing editable-checkout materialization rules from
  `ContentProjectionStore.materializeInto` into a neutral shared content-addressing
  module; both semantic materialization and workspace creation call that implementation.
  It imports and verifies reachable CAS objects into staged state, materializes the
  checkout, writes the destination sidecar from the known hashes plus the _actual_
  destination stats, validates the completed workspace, and atomically renames the
  staging directory into place. This guarantees source files, CAS objects, manifest, and
  sidecar describe the same bytes — unlike mtime-preserving copies, which merely satisfy
  the size/mtime trust shortcut without validating anything.
- Use the same prepared-source primitive for templates, forks, and ephemeral workspaces,
  retiring `copyDirRecursive` rather than retaining a scan/copy fallback. A missing or
  corrupt prepared artifact is a packaging or creation failure, not permission to enter
  the old slow path.
- Define how a new workspace identity obtains its genesis semantic event and protected
  main ref from the prepared manifest — the DO import/push
  (`workspaceVcs.ts:676-697`) is per-identity and cannot be copied; the goal is to feed it
  precomputed hashes/objects so it stops being O(tree-scan).
- For forks/ephemeral dev workspaces, reuse the immutable source state but mint a new
  workspace-local semantic identity.

The prepared artifact is content only: never copy a workspace ID, semantic context/event
IDs, semantic DO database, or protected refs. Every new workspace still mints its opaque
identity, creates its workspace-local initialization event, performs idempotent import,
and publishes its own protected main ref. Pre-seeding can remove scan/hash/CAS-mirror
work; it cannot erase the per-identity DO import/push. If WS0 shows that import itself
dominates, add one trusted initialize-from-content-state operation rather than copying
semantic state.

Implementation prerequisites, not external blockers:

- Migrate the synchronous `initWorkspace` creation chain end-to-end to async
  materialization; hiding async work behind sync filesystem calls would only block the
  event loop.
- Generate and validate prepared artifacts in packaging and dev/ephemeral flows and pass
  the prepared descriptor through to boot.
- Define idempotent retry/compensation across directory publication, workspace
  registration, semantic import, and protected-ref publication so a failed create can be
  retried without either duplicate identity state or an orphaned directory.
- Benchmark a fixed template digest/file count/byte size on cold and warm filesystems;
  measure packaging separately from the user-visible create path.

Non-goal: moving semantic activation off the dependency graph entirely. `buildSystem`
genuinely needs semantic state; the aim is to make the edge cheap, not to break it.

### 1c. Established-workspace warm path

The ~5.6s warm semantic activation (and the sub-7s established-startup target) needs its
own work; WS1a/1b are genesis-only. Warm activation runs `recoverPendingSemanticEffects`,
`ensureContext` (context + materialization repair, `workspaceVcs.ts:581-604`),
`vcsInspect` + `ensureFresh` (`workspaceVcs.ts:619-646`), config read, and config reload
(`src/server/index.ts:3289-3300`). WS0's spans attribute the 5.6s across these; optimize
the dominant contributors then (candidates: materialization repair on the happy path,
`ensureFresh` cost when nothing changed, pending-effect drain when the queue is empty).

## WS2 — Panel-tree synchronization

Propagation: 2a and 2b live in shared layers (`WorkspaceDO`, `ownerPanelTreeBridge`,
`shell-core/panelManager`, `shared/panelRegistry`) — both clients inherit them through
`panelManager` with no client forks. Only the consumption changes are per-client: desktop
(2b's `PanelTreeContext` cleanup) and mobile (2c). WS2 is not complete until both are
converted.

### 2a. One canonical bootstrap query

`WorkspaceDO`'s SQLite already holds everything a hydrated forest needs — slots
(topology), slot_history, entities (authority, build key, execution digest, titles,
source), panel_search_metadata (`packages/builtin/src/workspace-state/WorkspaceDO.ts:324-447`), all
indexed and co-located. The N+1 (`packages/shell-core/src/panelManager.ts:1124-1145`)
exists only because `panelManager` drives separate RPCs.

- Add a `panelForestSnapshot` DO method returning
  `{treeRevision, slots, histories, entities, metadata}`: **one consistent DO operation,
  not one denormalized join**. `slot_history` is unbounded per slot and fetched in full
  (`workspaceDO.ts:420-431,2104`), so a 4-way join would repeat each wide entity/authority
  row once per history entry. Inside a single transaction/snapshot, run two or three
  indexed queries returning flat arrays (slots, histories, entities+metadata) plus the
  authoritative revision (2b); `panelManager` assembles the forest from that DTO. The
  invariant that matters is one round trip and one consistent read, not one SQL statement.
  Bootstrap returns **full** history — history is navigation-correctness state, and
  truncating it safely needs an absolute-cursor + lazy-pagination design. If measurement
  shows history dominating bootstrap payloads, pagination becomes its own workstream; it
  is not a WS2a side change.
- Runtime leases do **not** live in WorkspaceDO — they are in-memory state of
  `PanelRuntimeCoordinator` (`src/server/panelRuntimeCoordinator.ts:38`). The bootstrap
  RPC is therefore a **server-composed envelope**:
  `{forest: PanelForestSnapshot, leases: RuntimeLeaseSnapshot, runtime:
PanelRuntimeStateSnapshot}`. These independently versioned sections are not one atomic
  WorkspaceDO fact and clients apply each through its own guard.
- Use it for initial load and recovery in `panelManager`; delete
  `hydrateExecutionAuthority`'s second resolve wave
  (`src/server/ownerPanelTreeBridge.ts:421-427,477-479`) — the double-resolution goes away
  as a side effect.

### 2b. Authoritative revision persisted in WorkspaceDO (kills the 40-poll loop)

The authoritative revision must live in **WorkspaceDO, not the server PanelRegistry**.
The registry's `treeRevision` is a plain in-memory field (`panelRegistry.ts:73,611`) that
resets on restart, and the registry only learns of workspace-state mutations via the
debounced asynchronous self-heal (`ownerPanelTreeBridge.ts:560-569`), so a mutation RPC
cannot reliably return a post-mutation registry revision — and after a restart a client
holding revision N would wrongly treat the new server's revision 1 as stale.

- Persist `panel_tree_revision` in WorkspaceDO's existing metadata table. Route every RPC
  that can change a field returned by `panelForestSnapshot` through one
  `mutatePanelForest` transaction helper, which changes the state and increments the
  revision in the same SQLite transaction, then returns `{result, treeRevision}`. Search
  access counters and runtime/view state do not increment it.
- Generalize the current slot-only change callback to
  `onPanelForestChanged(revision)`. Title/index changes must use the same revisioned
  forest update path; `panel-title-updated` cannot remain an unversioned competing
  channel. Add a contract test covering every workspace-state mutation: the revision
  changes if and only if the canonical forest DTO changes.
- `panelForestSnapshot` (2a) and mutation responses return the DO revision; every
  PanelRegistry (server and client) becomes a revision-stamped projection. A mutation
  response's revision is an **observation/wait watermark**, not proof that the client
  holds all forest state through that revision. `appliedTreeRevision` advances only when
  the client applies a state-bearing full snapshot or contiguous delta. Otherwise a
  client could optimistically apply its revision-12 mutation, skip another client's
  revision 11, and then incorrectly discard the complete revision-12 snapshot.
- Clients wait for a state-bearing DO revision instead of shape-comparing. This deletes the
  40 × 25ms topology-compare loop (`apps/shell/shell/hooks/PanelTreeContext.tsx:509-531`)
  and the comment explaining why revisions can't be trusted (`:505-508`) becomes obsolete.
- Every `panel-tree-updated` broadcast carries `{revision, ...payload}`. Recovery rules —
  chosen so that snapshot coalescing and gap detection don't fight each other (one logical
  navigation performs several DO mutations; the debounce may collapse revisions 11–13 into
  one snapshot at 13, and a client at 10 has lost nothing):
  - Initialize `appliedTreeRevision` to `null`, not zero, so an initial empty revision-zero
    snapshot is applied.
  - Full snapshot with `null` applied revision or a newer revision: apply directly — full
    snapshots are self-contained, so skipped intermediate revisions are not a gap.
  - Full snapshot with an equal/older revision: discard.
  - Delta (phase 2) whose `fromRevision` ≠ applied revision: fetch a recovery snapshot.
    A delta carries both `fromRevision` and `toRevision`.
  - Mutation watermarks may jump arbitrarily but never update `appliedTreeRevision`.
    This is event-driven recovery — no steady-state polling and no clocks.
- **Separate version domains for forest state vs runtime overlays.** The `Panel` type
  serialized into tree snapshots mixes persistent forest state with fields explicitly
  marked "runtime only" — artifacts/build progress, navigation, lease-derived state
  (`packages/shared/src/types.ts:345,371-374,181-192,238-242`) — and lease changes
  (`panelRegistry.ts:563-583`) and build-progress changes (`panelManager.ts:388,413`)
  fire tree notifications of their own. If runtime churn rode the DO tree revision, two
  same-revision snapshots with different runtime content could apply out of order and an
  older one would win. Define the split concretely:
  - `treeRevision`: DO-persisted topology, history, title, owner, position, state args,
    and durable execution identity.
  - existing `RuntimeLeaseVersion`: the lease stream
    (`packages/shared/src/panel/panelLease.ts:36`, `panelRegistry.ts:72`).
  - `PanelRuntimeStateVersion`: server preparation/build/artifact status, scoped by a
    server-owner epoch so restart/reset cannot compare as an old numeric revision.
  - Host navigation: host-local, not globally broadcast. Focus, collapse,
    `selectedChildId`, theme, pins, and other client/view state: excluded from the durable
    forest DTO.
    Lease/runtime records carry both `slotId` and `runtimeEntityId`. A client retains the
    newest overlay by identity and merges it only when it matches the forest's current
    entity, so an overlay arriving before its forest commit cannot attach to the wrong
    panel.
- **Make PanelRegistry a projection, not a revision authority.**
  `applyForestSnapshot` performs the revision guard, rebuilds the persistent projection,
  and stores the supplied DO revision. The existing 16ms coalescer may retain and publish
  the newest complete authoritative snapshot, but never mint a revision.
  Lease/runtime updates use their own apply methods and UI callback; local
  navigation/view mutations use a local callback only.
- **Deltas are phase 2, not phase 1.** Revision-tagged full snapshots plus the 16ms
  coalescing already in `panelRegistry.ts:618` may be cheap enough once the N+1 reload is
  gone; measure before building a delta/patch channel. If forests grow large, add
  revisioned deltas then, keeping full snapshots for bootstrap/gap recovery only.
- Move pins out of the tree-apply path: dedicated event/store instead of a
  `listPinnedPanelIds` RPC on every accepted snapshot (`PanelTreeContext.tsx:462-483`).

### 2c. Mobile: apply events, stop polling, memoize

- Close the subscribe/bootstrap race explicitly:
  1. construct the manager/registry;
  2. register and subscribe tree, lease, and runtime handlers;
  3. fetch the server-composed `panelBootstrap`;
  4. apply its three independently versioned sections; and
  5. apply any concurrently received events through the same guards.
- Apply the `panel-tree-updated` payload directly instead of discarding it and running a
  full refresh (`apps/mobile/src/services/shellClient.ts:771-773` → full N+1 + lease RPC
  per broadcast today).
- Remove the 30s poll (`shellClient.ts:945-950`). Recovery is driven by lifecycle events —
  reconnect, foreground, subscription failure, revision gap — not by a timer. Remove its
  lifecycle/LoginScreen callers and the 60s local republish timer as part of the same
  migration.
- Include runtime leases beside the forest in `panelBootstrap` (and maintain their
  revisioned event stream) so the separate `syncRuntimeLeases` RPC disappears from the
  steady state.
- Rendering: wrap `PanelWebView` in `React.memo` (`apps/mobile/src/components/PanelWebView.tsx:408`)
  and extract the WebView deck (`MainScreen.tsx:1698`) from MainScreen so unrelated
  lease/view updates stop re-rendering up to five WebViews. Perform stack/pin pruning once
  per accepted forest application, not in competing refresh paths.

## WS3 — Panel bundle composition

Propagation: all of WS3 is builder/server-side, so both clients inherit it — and mobile
gains the most. Every initial byte crosses the WebRTC pipe through the loopback façade,
occupies the 256MiB in-memory LRU, and competes with app memory; cutting first-paint
payload cuts mobile's slowest and most constrained path. Mobile-specific requirements
folded into the sub-items below:

- **Content-hashed URLs are the mobile cache contract.** The façade's LRU keys on URL
  path (+ forwarded headers) and the WebView cache keys on the stable loopback origin —
  both rely on artifact URLs being immutable content-hashed paths. The shared
  vendor CSS (3b) and split chunks (3a) must be immutable, digest-addressed assets with
  long-lived cache headers so a panel switch or app relaunch pays zero pipe bytes for
  shared assets.
- **Precompression (3c) must emit gzip alongside brotli.** The pipe deliberately ships
  gzip (`x-vibestudio-content-gzip`, translated to `Content-Encoding: gzip` at the
  façade), and the WebView loads over loopback HTTP where brotli content-encoding is not
  accepted. Brotli serves desktop/https; precompressed gzip serves the mobile pipe and
  removes the gateway's on-the-fly compression from the mobile hot path too.

### 3a. Async expose modules

`generateExposeModuleCode` turns every `exposeModules` entry into an eager top-level
`import * as` evaluated before mount (`src/server/buildV2/builder.ts:1288-1306`,
`adapters/react.ts:22-28`). Every React panel exposes the full `@radix-ui/react-icons`,
`@radix-ui/themes`, and `@workspace/ui` barrels; chat's own entry imports only
`@workspace/ui/panel` and no icons at all (`workspace/panels/chat/index.tsx:32-33`).

- Generate exposed modules as a **table of literal lazy loaders**, not through the
  existing `__vibestudioRequireAsync__` as-is: that primitive executes `import(id)` with a
  runtime string (`builder.ts:1277`), which esbuild cannot statically analyze (no
  deterministic chunks) and a browser cannot resolve for bare specifiers like
  `@workspace/ui` (the importmap covers externals only, `builder.ts:1210-1213`). Instead
  emit per-panel generated code like
  `__vibestudioModuleLoaders__ = { "@workspace/ui": () => import("@workspace/ui"), ... }`
  — literal `import("...")` calls that esbuild's existing `splitting: true`
  (`builder.ts:1827-1859`) turns into real lazy chunks — and make
  `__vibestudioRequireAsync__` resolve in this order: already-loaded synchronous module
  map → existing single-flight promise → literal loader → native `import(id)` only for
  URL/import-map-resolvable externals. Bare workspace specifiers without a generated
  loader are an error, not a browser-dependent fallback. The sandbox loader is already
  async (`workspace/packages/eval/src/sandbox.ts:296-325`), so consumers cope.
  Panel-target only; the workerd target keeps eager exposes.
- **Ordering hazard:** the eager expose file currently registers runtime-derived shims —
  fs aliases pulled off the `@workspace/runtime` namespace (`builder.ts:1311-1326`). Once
  exposes are lazy, wrap the `@workspace/runtime` loader so its successful completion
  atomically registers runtime plus `fs`, `node:fs`, `fs/promises`, and
  `node:fs/promises`. Register all alias loader keys against that same single-flight
  promise; otherwise the first request for an fs alias has no route to load runtime.
- Split exposed barrels into separate chunks so first paint loads only the panel entry's
  actual imports; sandbox code pulls barrels on demand.
- Lazy-load within panels: markdown extensions, Mermaid, diff/highlighting (shiki is a
  dependency of the `@workspace/ui` barrel), model dialogs, sandbox compilation.

### 3b. Shared vendor CSS

The react adapter injects `@radix-ui/themes/styles.css` — **812KB raw** — into every
panel's own hashed CSS artifact (`adapters/react.ts:22`, `builder.ts:1856,1894-1919`), so
each of ~7 panels ships its own copy of essentially the same stylesheet.

- Add an explicit `FrameworkAdapter.sharedStyles` contract for globally order-safe base
  styles only; the React adapter declares Radix themes + `@workspace/ui` tokens and stops
  injecting the Radix import into every entry. Do not overload
  `reactAdapter.dedupePackages` (`adapters/react.ts:7-14`): that controls JS
  module-resolution identity (`builder.ts:687,1783`), and arbitrary CSS extraction would
  change cascade semantics.
- The builder externalizes exactly those declared base styles, emits one immutable
  digest-addressed asset, links it **before** residual panel CSS, and records
  `{digest, contentType, url}` in build metadata/execution identity. Moving CSS outside
  the per-panel artifact without retaining this logical reference would allow style
  changes without an execution-identity change and let GC delete a live style.
  Cache hit across panels means the second panel opened pays ~0 vendor CSS bytes.

### 3c. Precompression as a background transport cache (not a build artifact)

Compression currently happens on first request per artifact at brotli quality 4, cached
only in process memory (`src/server/panelHttpServer.ts:848-885,186-189`). Two constraints
rule out naive "max-quality compression in the build":

- **Panels build on demand** (`src/server/buildV2/index.ts:413-415,941`; the HTTP server
  awaits `getBuild` on first open) — brotli-11 inline would add seconds of CPU to a cold
  panel open to save ~tens of ms of first-request compression.
- **Compressed variants must stay out of execution identity.** The artifact manifest is
  hashed into `executionDigest` (`buildStore.ts:437-475`); adding `.br`/`.gz` entries
  would change execution digests. Compression is a transport derivative of already-sealed
  bytes, not a logical artifact.

Design: a persistent transport cache keyed by the original artifact's integrity hash,
encoding, and codec-policy version, stored outside the build manifest (shareable
centrally), atomically published, and verified before use. Populate it in **bounded
background work after the build is usable**; keep the current quality-4 on-demand path as
the cold fallback; benchmark qualities 6–9 (both brotli and gzip — the mobile pipe's wire
format; see the propagation note above) rather than assuming 11 is optimal. Survives
restarts and removes steady-state first-request latency without touching cold-build
latency or identity.

The current mobile gateway asks for gzip, fetches loopback HTTP, then recompresses through
`CompressionStream`; merely caching gzip in `PanelHttpServer` would not remove that work.
Add one encoded-byte route: for gzip requests, gateway fetch uses raw Node HTTP (avoiding
transparent decompression), sends `Accept-Encoding: gzip`, translates upstream
`Content-Encoding: gzip` to `x-vibestudio-content-gzip`, and streams those encoded bytes
unchanged. It falls back to gateway compression only when upstream returns identity.
Both `PanelHttpServer` and this raw gateway path consume the same transport-cache entry.

## WS4 — Budgets (report-only first, before WS3)

`metafile: true` is already set (`builder.ts:1849`) and largest-chunk/main-bundle/CSS
metrics are already computed but only logged verbosely (`builder.ts:1871-1894`).

Land WS4 in **report-only mode before WS3 restructuring** so each WS3 change (async
exposes, shared CSS, panel-local lazy loading) has attributable before/after numbers.
Split by determinism — noisy runtime benchmarks must never gate a deterministic build:

- **WS4a — deterministic metafile budgets** (CI-enforceable): per panel, initial static
  dependency closure vs total lazy payload, initial request count, CSS bytes, largest
  chunk, compressed-size estimates. Define the initial closure mechanically as recursive
  non-external, non-dynamic output imports from the entry. Compressed sizes remain
  informational unless the Node/zlib toolchain is pinned. Report-only first; flip stable
  metrics to fail/warn on regression once WS3 lands.
- **WS4b — runtime benchmark suite** (trend reporting, not build failure): pinned
  workspace/panel fixtures, cold and warm HTTP cache, desktop loopback vs mobile pipe
  (direct and relayed), p50/p95 over repeated runs, stated hardware and build-cache
  state.

The absolute targets in the success criteria are aspirations until this baseline exists;
convert them to evidence-backed thresholds from the report-only data.

## WS5 — Cache retention

Current state: `buildStore.gc` scans only the per-workspace builds dir and preserves only
caller-enumerated **current-EV** keys (`buildStore.ts:755-773`,
`src/server/buildV2/index.ts:1380-1391`); it is RPC-triggered only, with no scheduler.
External dep installs are never evicted (`externalDeps.ts` has no eviction path), and the
central artifact pool + central build-result cache (`buildStore.ts:184-190`) are outside
any GC.

Design principle: **retention by reachability, not by clock.** Liveness facts belong to
the subsystems that understand them: app history owns the rollback window
(`src/server/appHost.ts:680-689`), unit registries own active EVs and pinned/current
conduit builds, extension runtime state owns runtime dependency keys, and workspace
blob storage owns non-build CAS roots. Those owners publish durable retention manifests;
the central GC owns their union. A workspace becoming inactive does not erase its
manifest — only an explicit lifecycle change such as history advancement or workspace
deletion does. Size budgets decide _how many unreachable_ candidates to drop (LRU by
coarsely persisted last access), never whether a reachable item is live.

Dependency caches need **two policies, not one**, because reachability from builds is not
currently derivable for the generic case: only extension builds record a
`runtimeDepsKey` in their metadata (`buildStore.ts:89-96`); generic panel/worker builds
don't, and `ensureExternalDeps` computes its key internally and returns only a path
(`externalDeps.ts:386-397`).

- **External build dependencies** are disposable and reinstallable: apply size-bounded
  LRU, with a cross-process, expiry-fenced active-use lease spanning the entire build.
  The existing `.ready`/in-flight-install protocol ends before esbuild finishes reading
  the directory, so install protection alone is insufficient. Expose a
  `withExternalDeps`-style ownership API rather than returning an unleased path.
- **Extension runtime dependencies** affect active/rollback execution: retain by the
  explicitly recorded `runtimeDepsKey`, plus an active-use lease while a runtime reads
  them.

Only if retained builds genuinely must pin external install caches would the key need
recording in all build metadata; default to not doing that.

1. **Close the rollback-retention gap** (invariant fix, independent of GC policy): app
   history and unit registries publish the complete active + rollback-window + current-EV
   build references as one durable workspace retention manifest; the build layer
   validates keys and resolves them to artifacts, but does not pretend it can derive app
   history it does not own. Severity note: for managed workspaces with shared central
   storage this is currently masked, because
   `buildStore.get()` falls back to the untouched shared cache on local miss
   (`buildStore.ts:566-582`). It is dangerous **today** only for configurations without
   shared storage — and becomes universally dangerous the moment central GC (below)
   exists. Fix it before item 4.
2. **Central GC must be owned centrally.** The sole sweeper is the hub process holding
   the live `HubProcessLease`, not an arbitrary `CentralDataManager` or workspace server.
   A per-workspace server cannot compute
   reachability over caches other concurrently-running workspace servers are using
   (multiple servers genuinely share one central dir — `buildStore.ts:183-215`). The hub
   sweeps a transactionally read snapshot of all durable manifests. Per-key,
   cross-process, expiry-fenced use leases/locks cover build-result reads,
   `publishSharedBuild`, artifact streaming, external-dependency use, and extension
   runtime use against rename-to-trash/deletion. Last-access updates are batched/coarse,
   not a disk write per cache hit.
3. Run sweeps as incremental, IO-bounded background work after the interactive launch
   window (not immediately at `All services started`), and on lifecycle events that
   actually change reachability: workspace deletion, EV transition, rollback window
   advance.
4. Scope and policy:
   - per-workspace and central build results: manifest reachability, then size-bounded LRU
     among unreachable entries;
   - shared style/build artifacts: union of every retained build reference;
   - extension runtime dependencies: `runtimeDepsKey` reachability;
   - external build dependencies: active-use leases + size-bounded LRU, no build
     reachability requirement;
   - central CAS: union of build artifacts **and workspace blobstore roots**. If the
     blobstore cannot publish a complete durable reference domain in this phase, defer
     central CAS deletion rather than sweeping from build reachability alone.

This is a disk/DX/backup win, not a panel-latency fix — priority ordered accordingly, but
item 1 is an invariant gap that must land before any central GC does.

## Sequencing

1. **WS0a** (startup timings + scheduler contract) together with **WS1a**
   (self-contained, biggest quick win), **WS4a in report-only mode** (deterministic
   baseline before bundle work), and **WS5.1** (rollback-retention invariant).
2. **WS2a+2b** (bootstrap query + DO-persisted revision) — one coherent change across
   WorkspaceDO, bridge, and shared panelManager; convert desktop and mobile (**2c**)
   consumers in the same phase — the workstream is not done with one client migrated.
   Land **WS0b** before claiming the user-visible WS2/WS3 result, but do not make its
   cross-process tracing block WS1a.
3. **WS3a–c** against the WS4a baseline — builder-side, independent of WS2; can proceed
   in parallel. Flip stable WS4a metrics to enforcement once WS3 lands. Run **WS4b** as a
   trend benchmark; never gate deterministic builds on its network/device variance.
4. **WS1b** after its async-creation, packaged-artifact, and retry/compensation
   prerequisites are designed; **WS1c** once WS0a spans attribute the 30.9s / 5.6s paths.
   Then land **WS5.2–4**, with central CAS deletion last and only after every reference
   domain is complete.

There are no known external blockers. The prerequisites above are semantic contracts:
they must be solved in the owning layer and must not be bypassed with a raw-copy fallback,
dual revision authority, timer-based reconciliation, feature flag, or unsafe best-effort
GC path.

## Success criteria

- Genesis workspace: **create click → usable workspace** under ~15s (from ~43.5s
  gateway-to-ready plus the synchronous create) — measured end to end so cost moved onto
  the create path counts against the target; conduit-seeding phase under 1.5s (from
  8.46s). Startup targets remain provisional until WS0a produces fixed-fixture cold/warm
  filesystem p50/p95 measurements; workspace create/fork retry and failure recovery must
  not regress.
- Established workspace: no regression from 9.3s; target under 7s.
- Chat first load: under 250KB Brotli JS initial, one shared cached vendor CSS asset;
  second panel opened pays near-zero vendor bytes. Bundle thresholds remain provisional
  until WS4a establishes deterministic baselines.
- Mobile: second panel opened (and any warm-cache reopen) transfers near-zero pipe bytes
  for vendor assets; cold panel open pipe payload cut proportionally to the desktop
  bundle reduction; measured by the directly observable façade counters and avoided
  requests/pipe bytes against the known asset closure.
- Steady state: zero periodic tree polling on mobile and desktop; one RPC round trip for a
  tree bootstrap; no shape-compare convergence loops; mobile applies tree broadcasts
  in-place with no per-broadcast full refresh; concurrent mutation watermarks cannot skip
  forest state; runtime overlays never regress or attach to a superseded entity.
- Disk: retained and actively leased artifacts always survive; rollback is restorable;
  unreachable build/extension entries and disposable external-dependency installs are
  bounded by their specified size policies; central CAS is not swept from an incomplete
  reference domain.
