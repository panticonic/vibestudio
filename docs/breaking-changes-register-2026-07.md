# Breaking-changes register — boundary cleanup, blob-addressed migration, gad eviction (2026-07-02/03)

Everything below changed an existing expectation. Pre-release, no backward compatibility — nothing here is a regression to fix by default, but each item is surfaced for explicit review. Items marked **DECIDE** need an owner decision.

## A. Decisions wanted

1. **DECIDE — `@vibestudio/typecheck` Monaco infra**: `FS/PATH/GLOBAL_TYPE_DEFINITIONS` + `shared-types.ts` are public exports with zero repo consumers — unwired in-browser-TS infrastructure (a comment claims a panel consumer that doesn't exist). Wire it or delete it.
2. **DECIDE — GC subsystem**: `WorkspaceVcs.runGc` + DO `runGadGcMark`/`runGadGcSweep` form a coherent, tested GC pipeline that has never been wired to a scheduler. Related open point: GC roots for content-store tree nodes (incl. server-minted composed views) are unowned. Wire GC (recommended — the content store now accretes tree nodes) or delete it deliberately.
3. **DECIDE — `vscode-shell-integration` copy in `build.mjs`**: confirmed vestigial-but-packaged. Options: drop after verifying packaged-app terminal behavior, or vendor under `build-resources/`. Loud comment at the copy site.
4. **DECIDE — tsconfig program split**: host still type-checks with workspace path mappings via `extends`. The boundary is enforced by the checker now; splitting requires relocating the ~25 allowlisted DO-integration test imports (all under `src/server/vcsHost/*` tests). Worth doing; needs a policy for where those tests live.
5. **DECIDE — pnpm workspace separation**: host and userland still share one pnpm workspace/lockfile (`build.mjs` relies on the symlink layout). Larger infra change, unscheduled.
6. **DECIDE — over-export band**: `vcsHost` modules, `*ServiceDeps` types, and the `vcs-engine` barrel export more than external consumers need (some test-imported). Cosmetic surface-tightening pass available if wanted.

## B. Boundary & platform (first cleanup wave)

7. Boundary checker v2 gates `quality:check`: all `@workspace-*` scopes, `require()`, string literals, `build.mjs`/`tests/` scanned; allowlist at `scripts/host-boundary-allowlist.json` (50 entries: DO-integration test imports + documented contract points in `sourceDirs.ts`/`platformModules.ts` + smoke tooling).
8. Trust/providers are manifest-declared (`providers:`/`trust:`/`hostTargets:` in `workspace/meta/vibestudio.yml`): a workspace without declarations gets those features disabled with diagnostics — no hardcoded fallbacks. Shipped manifest seeded to preserve behavior. (`providers.vcsStore` later deleted again — see §E.)
9. `__vibestudioElectron` deleted repo-wide; mobile injects `__vibestudioShell`. The mobile injection line has no covering test.
10. `native.tray`/`native.globalShortcut` removed from the app preload surface (were unreachable throw-stubs).
11. `isAboutSource("about/")` (empty page) no longer counts as privileged.
12. Host writes the generated extensions-registry only into files carrying the `// @vibestudio-extension-registry-sink` directive; removing the directive opts out of generation.
13. New optional panel manifest field `vibestudio.frameworkModule`.
14. `BUILD_CACHE_VERSION` 16 → 17 (root-fingerprint derivation change; one-time rebuild). Cache keys were then proven stable across the whole migration — no further bumps.
15. Approval schema: `\n` allowed in `summary`/`detail.value`/secret-input `description` (fixes shell-extension approvals that were being rejected in production); all other control chars still rejected. Titles/labels stay single-line.
16. Preloads: dual autofill registration deduped through one shared bridge module.

## C. State/tree layer (migration P1a)

17. Strict state validation at every mint point: non-git file modes, backslash path segments, file/dir path collisions now throw (previously ingested silently).
18. `snapshotDir` asserts DO-ingest hash equals locally computed hash; fails on divergence.
19. State-minting fails if the content-store mirror fails — unmirrorable states are never handed out.
20. First read of a new composed workspace view costs one DO round-trip (then one stat per call).

## D. Build system (P2 + P5a)

21. Build reads trees/hashes exclusively from the content store; unknown state hashes fail loudly in `unitHashes` (previously null per path).
22. Graph-discovery checkouts: hardlinked, sidecar-free, keyed by state, never cleaned. Editable checkouts still use `.gad/CHECKOUT.json` (live, kept).
23. A unit path resolving to a file throws in `materializeForBuild`.
24. Bootstrap builds work pre-attach from mirrored trees (previously threw in some cases).
25. `WorkspaceStateSource.diffPaths` removed from the buildV2 seam.

## E. Refs & main advancement (P1b + P3 + P5d)

26. RefService is the sole authority for `repo → main`: durable server store (`{userData}/refs/refs.json`), atomic `refs.updateMains` group CAS/delete through the approval gate, append-only main ref log. DO heads are downstream provenance.
27. Approval prompts show **server-computed** diffs (`diffTrees` inside the gate); callers are never trusted for changed-paths. Prompt detail shows `Repo:` instead of `Head: main`.
28. Push conflicts surface as typed retryable `REF_CONFLICT`; approval-pending holds the repo's mutation locks (reads never block); mid-group denial rolls back the advanced prefix.
29. `vcs.abortMerge` on main is no longer approval-gated (nothing to gate — a pending merge never moved the ref).
30. `vcs.diff` element shape is the content-store `TreeDiff` (was DO snake_case rows).
31. Repo delete retires refs first; restore starts a fresh ref lineage at seq 1.
32. `refs.*` is a main-only userland-reachable RPC surface (`readMain`/`listMains`/`readMainLog` plus DO-only `updateMains`; updates are approval-gated and attributed from the host-resolved invocation token). Movement-limited seeding remains host-internal.
33. `providers.vcsStore` manifest slot **deleted**: the host resolves the store DO from the `vcs` service declaration (one source of truth). A manifest with a `vcs` service but no singleton row loses the durable store, loud diagnostic.

## F. Freshness & provenance (P5a)

34. Scan commits complete at ref advance; DO provenance is recorded by `WorkspaceVcs` async direct per-repo ingest backed by a durable host scan record — `vcs.log`/lineage reflect scans **eventually**; scan-commit events carry `eventId: null`.
35. Ref↔DO drift self-heals only when a covering publish intent exists; uncovered no-intent drift now fails closed at attach/on-demand.
36. DO main-head ingest validates a known predecessor instead of a strict CAS (ctx heads keep strict CAS).
37. Crash in the merge-resolution window can produce one redundant-but-convergent merge event.

## G. VCS semantics in userland (P5b + P5c + P5d)

38. The merge engine (diff3 + MergeEngine + EditEngine) lives in `@workspace/vcs-engine`; the gad DO computes merges/edits/commits/reverts internally, reading/writing through host `blobstore.*` RPC — the DO now has host-service dependencies and mirrored states are written by the DO principal.
39. `vcs` is a userland manifest service (protocol `vibestudio.vcs.v1`): history reads, status (`vcsStatus`/`vcsPushStatus`), push (`vcsPush`), ctx merges (`vcsMerge`/`vcsAbortMerge`), and context semantics (pin/view/status/rebase/drop) are DO methods — several admitting panel/shell callers (deliberate widening). Host `vcs.*` keeps fork/delete/restore orchestration, projection, and the slim read surface (readFile/listFiles/diff/resolveHead — pure content-store+ref reads, justified host-side); host `vcs.push` and `vcs.adoptImportedRepo` are not public surfaces.
40. `vcs.merge` rejects non-`ctx:`/non-`main` targets (previously attempted arbitrary heads). Main-target merges dispatch through gad and publish via the same `refs.updateMains` path as pushes.
41. `vcs.log` head-defaulting is client-side (runtime clients default to their own ctx head; CLI reads main). `vcs.recall` scoping is solely the DO's query pushdown.
42. Rebase side-effects: DO records first, host projections/events follow (previously interleaved); crash mid-rebase heals via re-materialization invariants.
43. Git interchange lives in `@workspace-extensions/git-bridge` (import/export, trailers; `branch` parameter removed — per-repo `main` only). Export markers moved to extension storage: pre-existing DO markers are orphaned (first re-export replays history as fresh commits). Import publishes through staged lineage and the ordinary gad `vcsPush`/`refs.updateMains({operation:"import"})` path; no host `vcs.adoptImportedRepo` surface remains. Existing workspaces see git-bridge in the next joint extension approval.
44. Policy widenings for the eviction: `blobstore` read/write, broad `refs` reads, the `vcs` service, and DO `vcsLog`/`ingestWorktreeState`/`listStateFiles` admit `extension` callers. `refs.updateMains` remains DO-only at the public policy layer and is narrowed further by the invocation-token check.
45. Module map: `src/server/gadVcs/` → **deleted**; permanent host surfaces live in `src/server/vcsHost/` (`WorktreeStore`, `DiskProjector`, `workspaceTreeScanner`, `repoDiscovery`, slim `workspaceVcs` orchestrator). Renames: `GadVcs`→`WorktreeStore`, `.vcs`→`.worktrees` deps. The old provenance follower class is gone; scan/freshness provenance is folded into `WorkspaceVcs` as durable host scan records plus direct per-repo DO ingest.

## H. Audit deletions (final pass)

46. `packages/types`: 22 orphaned mirrored AI/stream types deleted; 4 unused form-schema re-exports dropped; 9 vestigial committed build artifacts removed.
47. DO: `composeRepoStates` + `getSubtreeAsState` deleted (last of the subtree-RPC family); 3 tests died with them.
48. `vcsHost`: `ApplyEditsResult` deleted; `contextDir`/`resolveStateRef` privatized; 6 internal types un-exported; stale comments repointed to new homes.

## Known non-items

- `packages/rpc`/WebRTC changes in this tree belong to the concurrent WebRTC v2 session (all green; one file fails `format:check` on their side).
- `docs/` mentions of deleted APIs are changelog/design-history context, kept deliberately.

## I. Fork, workspace-template, and bridge cleanup (2026-07-04)

49. Fork seed plumbing no longer treats `appendSeed` as a privileged operation. The child channel consumes only the pending `forkSeedMarker` for one-shot/idempotent recovery; old `forkSeedAuth` state is ignored, with no migration or compatibility shim.
50. Channel and agent `postClone` now require the clone's `newContextId`. A clone that cannot be re-homed into its fresh fork context fails instead of falling back to the parent's context.
51. Subagent lifecycle rows use an explicit `starting` setup phase. Re-drive tears down stale `starting` rows; `running` rows retry the idempotent task seed; terminal publish must succeed before terminal status/teardown.
52. Dependency resolution for server-side builds now prefers a packaged `workspace-template` only when it contains dependency metadata (`package.json`, `pnpm-lock.yaml`, or `pnpm-workspace.yaml`). Source-only templates fall back to the active workspace's dependency files.
53. `refs.updateMains` requires an explicit `operation`; seed-style updates must say `operation:"seed"`. Older callers without the operation field fail schema validation.
54. The repo requires Node `>=22.13.0` in both host and userland package manifests.
55. The panel asset disk cache uses sha256 blob filenames plus per-cache-key metadata sidecars. Old cache/index layouts are not read; dangling entries are dropped and refetched.
56. Git bridge export/import state lives entirely in extension storage and uses the protected import publish path. Pre-existing host-side markers are orphaned; the first export/import under the new bridge establishes fresh markers.
