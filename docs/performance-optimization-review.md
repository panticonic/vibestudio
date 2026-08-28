# Performance optimization review ledger

This ledger records choices made during the repository-wide performance and
codebase-slimming campaign that deserve explicit UX, compatibility, or
maintainability review. It is intentionally kept even when the implementation
is otherwise validated.

## Entry format

- **Track / date**
- **Choice**
- **Why it is questionable**
- **Evidence and validation**
- **Recommended follow-up**

## Open choices

- **Build track, tranche 3 / 2026-07-27**
  - **Choice:** Reuse infrastructure package outputs only when a package's
    transitive local-source closure, root build configuration, lockfile,
    platform/Node identity, compiler bytes, build environment, and exact output
    manifest still match a mode-0600 atomic cache record.
  - **Why it is questionable:** Local build speed now depends on a generated
    cache record and on package manifests accurately declaring local dependency
    edges. The runner preserves source-only packages in pnpm's scheduling graph
    and fails closed for a missing, extra, or changed output, but future build
    tools or environment-sensitive scripts must be added to the common input
    contract.
  - **Evidence and validation:** The former infrastructure critical path was
    about 9.3 seconds, led by extension (2.87 seconds) and extension-host (2.78
    seconds). A cache-cold full build took 12.09 seconds; a verified no-change
    full build took 1.66--1.81 seconds, with package verification alone taking
    0.11 seconds. A real extension source mutation selected exactly extension
    and extension-host. Corrupting extension's emitted JS selected only
    extension and restored both original package SHA-256 values. Two concurrent
    source-prerequisite builds serialized: one built while the other waited and
    reused the committed snapshot. All host/userland/mobile type checks, npm
    staging, both npm publish dry-runs, 41 focused package/build tests, and
    4,652 of 4,653 runnable host tests pass; the sole host failure is the
    unchanged container denial of bubblewrap UID-map setup.
  - **Recommended follow-up:** Keep new emitting packages inside the declared
    local dependency graph and extend the common input contract when adding a
    compiler or build-time environment variable. On macOS and Windows, repeat
    cache-cold, exact-reuse, output-corruption, and concurrent-build probes to
    exercise platform filesystem and atomic-rename semantics.

- **UI track, tranche 4 / 2026-07-27**
  - **Choice:** Keep the public full chat contexts while routing resident
    message actions, stable input actions, and composer runtime through narrow
    provider slices; stabilize the fork-lineage action projection across
    ordinary streaming message changes.
  - **Why it is questionable:** Internal chat components now rely on
    `ChatProvider`, rather than a hand-written raw `ChatContext.Provider`, to
    receive the narrow projections. Custom consumers of the public full
    context intentionally retain broad update behavior, and the optimization
    depends on action callbacks preserving their documented stable identities.
  - **Evidence and validation:** In a real 200-card transcript render, the
    initial 200 content renders are followed by exactly one render for a
    streaming tail update and zero additional renders for a composer
    keystroke. Separate probes keep 200 resident action consumers and the
    composer at their initial counts while the full-context consumer advances,
    and the fork action projection remains reference-stable when a non-fork
    message streams. All 212 agentic-chat userland tests pass, including
    scrolling, receipts, outbox, tool/invocation, subagent, composer, and
    transcript coverage. Workspace TypeScript and changed-file lint pass; 12
    Chromium browser tests pass under Xvfb.
  - **Recommended follow-up:** Capture a packaged desktop and physical-mobile
    React Profiler trace with a long rich transcript, open participant menus,
    simultaneous agent streams, and active typing. Custom layouts should use
    `ChatProvider`; if raw provider composition is meant to be supported,
    promote the narrow providers to an explicit public composition API rather
    than reintroducing full-context subscriptions.

- **UI track, tranche 3 / 2026-07-27**
  - **Choice:** Split desktop navigation state into layout, lazy-breadcrumb,
    and stable-action subscriptions, memoize the resident panel stack, and
    keep the tree sidebar eager until it has a retry-safe chunk boundary.
  - **Why it is questionable:** The render boundary relies on shell-to-stack
    callbacks retaining stable identities, while the sidebar still contributes
    meaningful eager evaluation work. A nested `React.lazy` boundary would
    currently cache a rejected import even after the root chunk-error retry,
    and desktop tree mode needs the sidebar immediately in the common case.
  - **Evidence and validation:** A breadcrumb-publication render probe now
    records one render each for layout and action consumers while the intended
    lazy-data consumer advances from one to two. The focused navigation,
    panel-stack, and approval suites pass 28 tests; shell TypeScript and lint
    also pass. A standalone unminified PanelStack bundle measured 1,256,951
    bytes, with about 34,325 bytes attributed directly to the sidebar, 43,592
    to TanStack virtual core, and 8,940 to dnd-kit sortable; no speculative
    chunk split was shipped.
  - **Recommended follow-up:** Capture a React Profiler trace in a packaged
    desktop session during title, breadcrumb, drag/drop, and focus changes.
    Split the sidebar only after chunk retry ownership is explicit and a
    packaged cold-start trace shows that deferring its evaluation wins overall.

- **Build track, tranche 2 / 2026-07-27**
  - **Choice:** Load `esbuild-svelte` and the Svelte compiler only when the
    first Svelte unit build requests its adapter plugins.
  - **Why it is questionable:** This removes a compiler from every server
    startup but moves its one-time module load onto the first Svelte build.
  - **Evidence and validation:** Standalone and Electron server bundles both
    retain one literal dynamic `import("esbuild-svelte")`, contain no static
    import or bundled `svelte/compiler`, and shrink from about 8.0 MiB to
    6.27 MiB. Five standalone help samples improve from 0.21–0.25 seconds and
    about 120 MiB RSS to 0.17–0.21 seconds and about 110 MiB RSS. Five isolated
    cold imports put the transferred one-time compiler load at 33–46 ms. The
    focused Svelte panel test compiles a real `.svelte` component, npm staging
    declares and resolves `esbuild-svelte`, and both CJS and ESM artifacts pass
    their build contracts.
  - **Recommended follow-up:** Observe first-Svelte-panel build latency in a
    packaged desktop session; keep the lazy boundary unless the one-time load
    produces a visible transition delay.

- **Build track, tranche 2 / 2026-07-27**
  - **Choice:** Stop emitting headless-host source maps in production and clean
    its package-owned `dist/` before each build.
  - **Why it is questionable:** Production crash investigation no longer has
    the two shipped maps available locally, although the runtime did not enable
    source-map stack translation and therefore never loaded them.
  - **Evidence and validation:** Development builds still produce both maps;
    a following production build removes them. Production `dist/` now contains
    zero maps instead of 2.01 MiB across two files, enforced by the build
    artifact checker. All 71 focused headless-host/framework tests pass.
  - **Recommended follow-up:** If production symbolication is introduced,
    upload maps as private release artifacts instead of placing them on every
    installed client.

- **Build track, tranche 2 / 2026-07-27**
  - **Choice:** Remove five unreferenced runtime packages, move type-only
    dependencies out of the published runtime surface, remove redundant direct
    lint/type dependencies, and allow the composite typecheck package to reuse
    TypeScript's incremental build state instead of forcing every compilation.
  - **Why it is questionable:** An undocumented external workflow could have
    relied on the private root manifest as an undeclared dependency provider;
    incremental compilation also trusts TypeScript's build-info contract.
  - **Evidence and validation:** Literal, dynamic-import, package-manifest, and
    packaging searches found no consumer for the removed runtime packages.
    The root published runtime surface falls from 57 to 50 dependencies;
    reconciliation removes 307 packages and adds 45 after type ownership
    changes (net 262 fewer), while deleting 763 lockfile lines.
    Required JSON-schema, WebSocket, and sql.js types now belong to their actual
    consuming packages. A real typecheck source mutation rebuilt its emitted
    module and reverting restored the original artifact byte-for-byte.
    Concurrent source-prerequisite builds serialized correctly: one built and
    the waiter reused the completed exact fingerprint. Full host, userland, and
    mobile typechecks plus npm staging/package tests pass.
  - **Recommended follow-up:** Do not skip the remaining infrastructure package
    build wholesale until a package-specific cache verifies both inputs and
    output-tree integrity; it remains about 9.3 seconds of the host build.

- **Primary legacy cleanup / 2026-07-27**
  - **Choice:** Remove the upstream `AgentTool.prepareArguments` compatibility
    hook and validate the provider-emitted argument object exactly as journaled.
  - **Why it is questionable:** No in-repository production tool has ever
    implemented the hook, but an out-of-tree tool compiled against the exported
    vendored interface could have relied on silently converting a legacy shape.
  - **Evidence and validation:** Repository-wide reference search found only
    the runtime hook, vendored declaration, and a test-created fake. The
    remaining five boundary tests prove valid arguments pass and malformed or
    incorrectly discriminated arguments fail before execution. The vendoring
    script and provenance now reproduce the tightened contract explicitly.
  - **Recommended follow-up:** Announce the contract tightening to any external
    tool authors; tools must advertise the schema they actually accept.

- **Primary legacy cleanup / 2026-07-27**
  - **Choice:** Remove the invalid-gateway URL fallback from panel link
    construction.
  - **Why it is questionable:** A malformed injected server URL now fails
    immediately instead of producing a root-relative link, but the old link
    could silently navigate to the wrong workspace.
  - **Evidence and validation:** The canonical configured and mobile link tests
    remain green, and a new regression test requires invalid configuration to
    fail loudly.
  - **Recommended follow-up:** None; injected runtime configuration must be a
    valid URL.

- **Build track / 2026-07-26**
  - **Choice:** Make a full host build clean every `dist/` entry except the
    separately produced `baked-app/` payload and the active prerequisite lock,
    and remove the workspace `build` script that selected 94 packages but ran
    no package build scripts.
  - **Why it is questionable:** `dist/` is contractually generated output, but
    an undocumented local packaging workflow could have placed custom files
    there. Likewise, external automation might still invoke the former
    workspace command even though it was a measured no-op.
  - **Evidence and validation:** A development-to-production build previously
    retained 94.61 MiB across 16 source maps and produced a 128 MiB `dist/`.
    The cleaned production build is 24 MiB with only the two intentionally
    emitted headless-host maps (2.01 MiB). The removed phase reported “None of
    the selected packages has a build script” and cost 0.76 seconds. Build
    artifact contracts and the npm staging/package dependency tests pass.
  - **Recommended follow-up:** Confirm no release automation deposits
    undocumented inputs under `dist/`; approved app bakes must continue to use
    the preserved `dist/baked-app/` boundary.

- **Build track / 2026-07-26**
  - **Choice:** Defer TypeScript, the full `@vibestudio/typecheck` service, and
    workspace RPC AST parsing until a worker build or exact-state typecheck
    report first requests them.
  - **Why it is questionable:** This removes substantial server bootstrap work
    but transfers the one-time module load to the first relevant build/report,
    which may make that first operation slightly slower.
  - **Evidence and validation:** Production server bundles fell from about
    14.1 MiB to 8.0 MiB. Five standalone `--help` samples improved from
    0.37–0.40 seconds and 168–169 MiB RSS to 0.21–0.25 seconds and about
    120 MiB RSS. Both standalone ESM and Electron CJS server artifacts parse
    and run; focused worker catalog, typecheck fold, framework build, npm
    staging, package dependency, host typecheck, and build-contract checks
    pass. The staged npm server contains the vendored typecheck package and
    declares TypeScript.
  - **Recommended follow-up:** Profile first Svelte/worker build and first
    exact-state build report in a packaged desktop session; retain the lazy
    boundary unless that one-time latency is user-visible.

- **UI track, tranche 2 / 2026-07-26**
  - **Choice:** Gate mobile drawer profile polling on React Navigation's open
    drawer lifecycle and deduplicate managed-WebView theme delivery by document
    URL and theme mode.
  - **Why it is questionable:** Unit coverage proves the timer and delivery
    lifecycles, but native drawer transition timing and WebView process/document
    replacement behavior can differ between Android and iOS release builds.
    The implementation refreshes immediately whenever the drawer opens and
    explicitly invalidates theme delivery on ref loss, unmount, URL change, and
    theme change.
  - **Evidence and validation:** Timer tests show zero polling work outside the
    visible lifecycle; theme tests show activity timestamp changes do not
    reinject while theme/document changes do. Mobile TypeScript and all 25
    mobile suites (167 tests) pass. Chat row isolation remains in normal
    document flow and its existing scroll-anchor suites pass.
  - **Recommended follow-up:** On physical Android and iOS release builds,
    repeatedly open/close the drawer across profile changes and verify managed
    panel theme after background process eviction, reload, navigation, and
    light/dark changes.

- **UI track / 2026-07-26**
  - **Choice:** Defer evaluation of the authenticated React Native shell and
    settings route with React Navigation's `getComponent` boundary, keeping
    only the login route eager at cold start.
  - **Why it is questionable:** This is the intended React Navigation lazy
    route API and preserves route state, but Metro's release-bundle evaluation
    behavior and the first login-to-main transition cannot be exercised on an
    Android emulator in this environment. Deferring work may move a small
    amount of module initialization onto that first transition.
  - **Evidence and validation:** Mobile TypeScript passed; all 23 mobile suites
    (163 tests) passed. The route boundary is synchronous and does not introduce
    a second navigation path or loading state.
  - **Recommended follow-up:** On physical Android and iOS release builds,
    compare cold-start-to-login timing and verify login → main, main → settings,
    back navigation, and process-restored authenticated startup.

## Resolved choices

- **Runtime track, tranche 5 / 2026-07-27**
  - **Choice:** Replace panel-tree startup reconstruction with one revisioned
    WorkspaceDO transaction containing every open slot, its full history, and
    each current entity record; hydrate runtime authority and preparation state
    from that same result instead of re-resolving entities in the owner bridge.
  - **Why it is questionable:** This makes the aggregate the sole startup
    contract and adds SQLite revision triggers over every row that can change
    its projection. A missing trigger or partial aggregate would strand a
    client on stale state, while retaining a fallback would conceal the defect
    and restore the fanout.
  - **Evidence and validation:** The 64-panel regression measures one
    workspace-state invocation instead of the prior 193
    (1 slot list + 64 histories + 64 reconstruction entity reads + 64 owner
    hydration entity reads), a 99.5% reduction and one transport latency wave
    instead of four. Exact WorkspaceDO tests cover creation, navigation,
    current state/title changes, transaction rollback, and monotonic revision;
    owner tests prove no legacy startup read is dispatched. All 332 broad
    shell-core, service-schema, WorkspaceDO, service, and owner-bridge tests
    pass, as do the generated authority and runtime-document checks.
  - **Recommended follow-up:** Preserve the aggregate-only startup assertion
    and add a revision trigger whenever the durable projection gains another
    table or field.

- **Runtime track, tranche 4 / 2026-07-27**
  - **Choice:** Reuse GAD's authoritative in-transaction log-head snapshot and
    its first known-missing replay lookup, and maintain the RPC registry's
    oldest-live-connection choice as a derived admission/removal index.
  - **Why it is questionable:** Both optimizations remove repeated defensive
    work from correctness-sensitive paths: append ordering and idempotent replay
    depend on the exact durable head, while RPC routing must preserve oldest
    connection selection and closed/replaced socket fallback.
  - **Evidence and validation:** Durable Object transactions are synchronous
    and single-writer, so neither the head row nor a known-missing event can
    change between the removed reads. Query-count stress tests cover 128 fresh
    and 128 established appends; an established one-event append now performs
    two log-head reads instead of five and one event lookup instead of two.
    Five 500-append samples improved from a 112.81 ms median to 67.93 ms
    (39.8%). Primary-connection lookup medians improved from 34/164/1,937 ns
    with 1/8/128 connections to 15/16/16 ns, while a 2,000-connection ordering,
    removal, and late-admission regression passes. All 55 semantic control-plane
    and five connection-registry focused tests pass.
  - **Recommended follow-up:** Keep the query-count assertions and primary-index
    lifecycle stress test. Panel-tree reconstruction should separately replace
    its multi-RPC fanout with one revisioned WorkspaceDO aggregate read; do not
    add an aggregate alongside the old reconstruction path.

- **Runtime track, tranche 3 / 2026-07-27**
  - **Choice:** Rotate active Iroh scheduler keys with an indexed,
    periodically compacted array and tombstones for cancelled keys; fast-path
    an already-present immutable CAS namespace target with an existence check
    before recursive directory creation and hardlink convergence.
  - **Why it is questionable:** Both changes replace simple filesystem/array
    operations with stateful fast paths whose fairness, cancellation, race,
    and cross-process behavior must remain exact.
  - **Evidence and validation:** One million frames across 50,000 streams
    improved from 5187.45 ms to 445.23 ms while exact three-round order across
    10,000 streams and deep-key cancellation pass. One thousand repeated CAS
    writes improved from 639.31 ms to 360.14 ms; `mkdirat` calls fell from
    1,020 to 20 and `linkat` calls from 1,002 to 2. All 277 RPC tests and 57
    blobstore tests pass, including backpressure, recovery, concurrency,
    symlink, and content-integrity cases.
  - **Recommended follow-up:** Retain the scheduler compaction threshold,
    tombstone cancellation test, and link-after-miss/EEXIST convergence path
    when evolving transport queues or CAS namespaces.

- **Runtime track, tranche 2 / 2026-07-26**
  - **Choice:** Treat matching non-zero filesystem device/inode identity as
    sufficient proof that a materialized target is the exact immutable CAS
    file, without re-reading and hashing it. Filesystems that do not expose
    usable identity, copied files, executables, and edited targets retain the
    existing size-plus-content-hash verification path.
  - **Why it is questionable:** This makes repeated materialization depend on
    filesystem identity semantics for the hardlink fast path.
  - **Evidence and validation:** A hardlink's matching device/inode identifies
    the same underlying file, which is stronger than equal bytes. A 500-file,
    500 MiB repeated materialization improved from 1845.55 ms to 97.62 ms;
    all 56 blobstore tests, including copied, executable, edited, and symlink
    cases, pass. Concurrent agent blob-cache misses are also now single-flight;
    the focused test proves 32 simultaneous reads issue one RPC and reuse the
    immutable result.
  - **Recommended follow-up:** Preserve the non-zero identity guard and content
    hashing fallback when extending materialization to other filesystems.

- **Runtime track / 2026-07-26**
  - **Choice:** No questionable UX, compatibility, or message-semantics choices
    were required in the first runtime/data optimization tranche.
  - **Evidence and validation:** The tranche changes internal queue
    representation, caches a delivery-only projection with exact invalidation
    on participant routing changes, and coalesces only concurrent reads of the
    same immutable content-addressed blob. Wire shapes, ordering, durability,
    replay, error, and delivery semantics remain unchanged.
  - **Recommended follow-up:** Keep the focused ordering, channel lifecycle,
    and stored-value hydration tests in regression coverage.

- **Primary / 2026-07-26**
  - **Choice:** Hoist the filesystem dispatch method sets to module scope.
  - **Why it is questionable:** It changes allocation lifetime, but not the
    immutable method membership or any filesystem routing and sandbox policy.
  - **Evidence and validation:** All 90 focused filesystem service tests pass.
  - **Recommended follow-up:** None.
