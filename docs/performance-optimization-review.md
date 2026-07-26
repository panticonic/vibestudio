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

- **Runtime track, tranche 3 / 2026-07-27**
  - **Choice:** Rotate active WebRTC scheduler keys with an indexed,
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
