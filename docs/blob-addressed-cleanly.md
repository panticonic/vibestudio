 STATUS (2026-07-03): steps 1–6 of the migration plan below are IMPLEMENTED; step 7 (this cleanup) is done. The gad EVICTION IS COMPLETE (P5a–P5d all landed): `src/server/gadVcs` is DELETED, the VCS semantics live in the gad-store DO behind the userland `vcs` service, and the permanent host surfaces are re-homed under `src/server/vcsHost/`.

  Landed pieces:

  - Shared canonical tree hashing: `packages/shared/src/contentTree/` (`buildWorktreeManifest`, tree objects, golden-vector cross-implementation tests against the DO's SQL hashing).
  - Content store tree APIs: `src/server/services/blobstoreService.ts` — tree objects, `resolveTreePath`, `listTree`, `diffTrees`, `materializeTree`. The content store is the tree authority.
  - State mirroring invariant: every state hash the system hands out resolves to a full mirrored tree in the content store (eager on scan/snapshot via `mirrorWorktreeTree`, lazy via `GadVcs.ensureStateMirrored`).
  - Protected refs + gating: `src/server/services/refService.ts` is the sole `main`-ref authority (durable CAS `advanceRef`, approval-gated, wired in `index.ts`); `WorkspaceVcs` advances main only through it.
  - Build-from-content-store: buildV2 reads trees, unit hashes, and build sources exclusively from the content store (tree-hash keyed; no GAD manifest reads).
  - Server-computed diffs: `vcs.diff` / change detection use content-store `diffTrees` (`WorkspaceVcs.diffStates`); callers never supply changed paths.
  - Step 7 cleanup (this change): deleted the dead DO subtree RPCs (`getSubtreeHash`/`getSubtreeHashes`), the dead `GadVcs.diffStates` DO passthrough, and the dead `WorkspaceVcs.materializeWorkspace`; test oracles now pin the content store against the shared reference implementation. The gad DO keeps provenance/edit-ops/merge-bookkeeping only; its manifest tables are a private index.

  - P5a (freshness inversion, landed): the build/freshness path is fully gad-free. `ensureFresh` scans locally
    (shared worktree hashing + eager content-store mirror), advances the protected ref, and returns — the gad DO
    records the transition AFTERWARD via the async per-repo `GadProvenanceFollower`
    (now `src/server/vcsHost/provenanceFollower.ts`; retry + reconcile; a DO failure delays history, never builds).
    Composed workspace/candidate views are minted server-side (`composeRepoStatesLocal`), and state
    listings/reads (`listStateFiles`/`readFile`/`listFiles`/diffs) resolve content-store-first. Drift healing is
    two-sided: `adoptMainFromStore` (DO→ref, git import) and the ref→DO reconciler (attach + on-demand from
    `mainWorktreeHead`), which closes the "ref advanced but provenance unrecorded" crash window. The DO's
    `expectedRefStateHash` on `vcs:repo:* @ main` ingests is now a KNOWN-PREDECESSOR guard, not a head CAS
    (main is ref-owned; the store is a follower). User-initiated VCS ops (commit/push/merge) keep synchronous
    DO semantics until the userland move.

  - P5b (partial — refs surface + merge semantics userland, landed): the protected-ref store is now
    RPC-exposed to userland as the `refs` service (`packages/shared/src/serviceSchemas/refs.ts`:
    readRef/listRefs/readRefLog/advanceRef; advanceRef flows through the SAME main-advance approval
    gate with the verified caller as gate context) — the host primitive a userland VCS uses to
    request `main` advancement. The MERGE ENGINE moved userland: `@workspace/vcs-engine`
    (workspace/packages/vcs-engine — vendored diff3 + dep-injected 3-way MergeEngine, workerd-safe)
    is consumed by the gad-store DO's new `computeMerge` RPC (DO-local manifest listings with a
    content-store `blobstore.listTree` fallback for server-minted states; blob bytes over
    `blobstore.getBase64`/`putBase64`). Host `src/server/gadVcs/merge.ts` + `diff3.ts` are DELETED;
    `WorkspaceVcs.mergeHeads`/push divergence dry-runs call the DO.
    `metaChangeSummary`'s mixed-path branch (unreachable under per-repo advances) was deleted.

  - P5c part 1 (edit/commit composition userland + disk-projection inversion + first
    userland-dispatched vcs.* methods, landed):
    * EDIT/COMMIT/REVERT COMPOSITION moved into the gad-store DO. `@workspace/vcs-engine` gained
      the EDIT ENGINE (editEngine.ts: op application over working file maps, provenance-hunk
      derivation via computeReplaceHunks, applyReplaceHunks, conflict-marker probe) and the
      edit-boundary path policy (paths.ts). The DO's `applyEditOps` / `commitWorking` /
      `revertWorking` / `resolveWorkingState` compose ENTIRELY store-side: compose-base resolution
      (ctx head → pinned-base slice via `blobstore.listTree` → protected `main` via the NEW
      `refs.readRef` bridge), working-row replay, engine op application (blob bytes over
      `blobstore.getBase64`/`putBase64`), two-part CAS insert, conflict-marker refusal, commit
      ingest + row re-key, and content-store MIRRORING of every composed state (bottom-up
      `blobstore.putTree` — the DO upholds the mirroring invariant for states it mints). Host
      `replaceHunks.ts`, `buildEditOpRows`, `applyReplaceHunks`, `composeWorkingFileMap`,
      `stageFiles`, `resolveComposeBase`, `assertNoConflictMarkers`, revert inversion and the
      old `insertWorkingEditOps`/`commitRepo` DO wire methods are DELETED.
    * DISK PROJECTION INVERTED: `diskProjection.ts` (DiskProjector; now `src/server/vcsHost/diskProjector.ts`) is the ONE
      host module that writes working trees — a follower invoked post-operation with the state
      hash the (userland) semantics decided (project/removeRepo/writeConflictSummary). No
      projection logic remains inlined in operations; the projector decides WHERE a state lands,
      never WHAT the tree is.
    * FIRST USERLAND-DISPATCHED vcs.* METHODS: the `vcs` service is declared in
      workspace/meta/vibez1.yml (protocol `vibez1.vcs.v1`, gad-store DO singleton). The
      read/history traversals — commitEdits, fileHistory, commitAncestors, editsByActor,
      editsByTurn, editsByInvocation, log — were REMOVED from the host vcs service/schema and are
      served by the DO's `vcs*` methods (camelCase rows, positional args), reached through
      `workers.resolveService` (runtime `createVcsClient` history section; CLI `vcs log`).
      Userland `vcs.log` defaults to `main` — caller-context head defaulting does not cross the
      userland boundary; pass a ctx head explicitly.

  - P5c part 2 (git interchange evicted to the git-bridge extension, landed):
    * GIT INTERCHANGE moved to the trusted `git-bridge` workspace extension
      (workspace/extensions/git-bridge — a Node child process with disk access), built on
      platform primitives only: `@vibez1/git` for git ops, the userland `vcs` service
      (gad-store DO, `vcsLog`/`ingestWorktreeState`/`listStateFiles`, now extension-admitted)
      for VCS reads + import provenance, `blobstore.*` for gad-side content (import mirrors the
      scanned tree bottom-up via `putTree`; export materializes checkouts from `listTree` +
      `getBase64` with the extension's own disk writes — no `GadVcs.materializeState`), and
      `refs.readRef` for the import no-op check against the protected main. Export markers +
      checkout tracking maps live in extension storage (the DO's generic `getMarker`/`setMarker`
      KV methods are DELETED). Consumers reach it via `extensions.invoke`.
    * The ONE new host method: `vcs.adoptImportedRepo(repoPath)` — the narrow repo-lifecycle
      remnant (chrome/extension callers only) that reconciles a repo's protected `main` onto the
      store lineage a git-import ingest advanced (delegates to `adoptMainFromStore`; never a
      general seed).
    * Host `gitInterop` stays as a thin POLICY/DISPATCH shim (stable service name for the
      runtime `git.*` namespace + startup dependency completion): approvals, egress-proxied
      clone, and meta/vibez1.yml writes are host substrate; its repo-log init hook now invokes
      the extension. It carries ZERO gadVcs imports (structural tree-scanner type).
      `src/server/gadVcs/gitBridge.ts` (+ test) and `WorkspaceVcs.gadCall` are DELETED.
    * `blobstore`/`refs`/userland-`vcs` service policies admit `extension` callers.

  - P5d (final eviction, landed) — `src/server/gadVcs` is DELETED:
    * LAST SEMANTIC MOVES into the gad-store DO (behind the userland `vcs` service):
      STATUS — `vcsStatus`/`vcsPushStatus` own the unpublished-delta-vs-protected-main
      computation and the dirty/ahead/diverged/deleted definitions (host
      `unpublishedDelta`/`statusHead`/`pushStatus` bodies deleted; the host methods are pure
      dispatches). MERGE — `vcsMerge` owns ctx-target merge orchestration end-to-end
      (pending/working preconditions, ours/theirs resolution with the protected-ref
      main check, upstream-commit walk, the merge COMMIT on clean, the staged+mirrored
      provisional + parked pending merge on conflict); `vcsAbortMerge` consumes the pending;
      `markPendingMergeMaterialized` is the host's projection acknowledgement (the
      crash-recovery flag flip — the host no longer writes pending-merge records for ctx
      targets). CONTEXTS — `vcsPinContext` / `vcsResolveContextView` /
      `vcsComposedViewWithRepoAt` / `vcsContextRepoStates` / `vcsContextStatus` /
      `vcsRebaseContext` / `vcsDropContext`: the DO owns the durable pinned base, the
      self-invalidating composed working view, per-repo status semantics, rebase
      (per-repo `vcsMerge` + the conflicted-pin rule) and atomic teardown; the host
      `ContextManager` is DELETED and the host keeps only sparse materialization tracking
      + the projector. RECALL scoping is solely the DO's `pathPrefixes` query pushdown
      (the host's redundant client-side re-filter is deleted). Supporting: the DO's refs
      bridge gained `listRefs` (workspace-view composition from protected repo mains) and
      `@workspace/vcs-engine` gained the repo-taxonomy twin (`repos.ts`:
      `discoverRepoPaths`, the userland mirror of the host section taxonomy).
    * HOST REMNANTS (permanent, by design): push (build gate + protected-ref group CAS +
      projection), `mergeGroup` entries targeting `main` (`mergeIntoMainHead` — the same
      ref-gated push-class advance), fork/delete/restore disk+refs+build-settle steps
      (their provenance semantics — forkLog/archiveRepoMain/restoreRepoMain — are DO
      methods), scan/freshness, `vcs.adoptImportedRepo`, disk projection, and the
      build/reactive event stream. Host wrappers for merge/rebase drain the provenance
      follower BEFORE dispatching (a `main` source must be in lockstep with the ref) and
      FOLLOW the DO's outcome with projection + events.
    * SUPERSEDED (2026-07-03, narrow-host VCS P1–P5 — see `docs/narrow-host-vcs-plan.md`):
      the "HOST REMNANTS (permanent, by design)" bullet ABOVE is no longer accurate.
      Push/merge orchestration, FF/clean-source/divergence policy, and provenance
      recording are NOT permanent host remnants — they moved into the gad-store DO
      (userland VCS). `vcs.adoptImportedRepo` / `WorkspaceVcs.adoptMainFromStore` are
      DELETED (git import now ingests onto a staging head and publishes via the ordinary
      DO push path). Public `refs.advanceRef` and the generic `(repo, ref)` namespace are
      DELETED. What actually remains host-side now:
      - content store (validity + owner-derived GC);
      - the narrowed ref table — `refs.readMain` / `listMains` / `updateMains` (atomic
        group CAS + delete, approval-gated, single-writer = the vcs DO) + the single
        post-advance reaction (`setOnMainsUpdated`: projection + build trigger);
      - build service over tree hashes (`build.validate` / `build.statusAt`), decoupled
        from ref advancement;
      - disk projection + context instantiation (`composeRepoStatesLocal`);
      - the host-owned approval gate (server-computed diffs, on-behalf-of attribution,
        batch-shaped, delete/restore severe prompts);
      - fork lifecycle + bootstrap `seedMain` seeding (movement-limited: set-if-absent /
        new repo paths only, never moves an existing main);
      - `ensureFresh` on-disk scan adoption, still backed by `ProvenanceFollower` for the
        SCAN path only (self-heal-from-refs for user-on-disk edits — NOT push provenance,
        which the DO now owns via write-ahead publish intents);
      - `mergeIntoMainHead` reduced to a THIN DO dispatcher (the merge-to-main advance
        flows through the DO's push path → `refs.updateMains`).
    * READ SURFACE DECISION: `vcs.readFile`/`listFiles`/`diff`/`resolveHead` stay a SLIM
      HOST READ SURFACE over the content store + RefService — per the Target Shape these
      are content/tree/ref reads (not VCS semantics), they must work pre-workerd (the
      build system builds the gad-store worker itself), and a workerd hop per hot-path
      read would buy zero authority.
    * RE-HOME: the permanent host surfaces moved from `src/server/gadVcs/` to
      `src/server/vcsHost/` — `paths.ts` (repo log ids, head names, ignore sets,
      path-safety guards), `worktreeStore.ts` (`WorktreeStore`, ex-`GadVcs`: worktree scan
      → CAS, editable checkout, `ensureStateMirrored`, narrow DO passthroughs),
      `diskProjector.ts` (`DiskProjector`), `provenanceFollower.ts` (`ProvenanceFollower`,
      ex-`GadProvenanceFollower`), `repoDiscovery.ts`, `workspaceTreeScanner.ts`, and
      `workspaceVcs.ts` (the orchestrator; still buildV2's `WorkspaceStateSource` +
      `BuildSourceProvider`). buildV2's `WorkspaceStateSource` dropped the never-called
      `diffPaths` member (and `WorkspaceVcs.diffPaths` with it); buildV2 imports the
      section taxonomy from `@vibez1/shared/runtime/entitySpec` directly.
    * PROVIDER SLOT DELETED: `providers.vcsStore` is gone from the manifest schema
      (`WorkspaceVcsStoreProviderDecl`), the config parser, and `meta/vibez1.yml`. The
      host resolves the store DO from the userland `vcs` SERVICE declaration (protocol
      `vibez1.vcs.v1` + its `singletonObjects` row) via `resolveVcsStoreBinding` — the
      SAME row `workers.resolveService` resolves for userland dispatch, so the store the
      host attaches/records into is by construction the store the `vcs` service serves.
      workerd's bootstrap-main-bound predicate derives from the same declaration.

  The eviction is COMPLETE — no gad code remains in the host outside the re-homed
  content/projection/ref/build surfaces above, and `vcs.*` semantics are served by the
  gad-store DO.

  ---

GAD currently uses blob-addressed content, but the generic blob store is not yet a full tree store.

  Right now, file bytes are content-addressed blobs, but the meaningful worktree shape is still GAD-owned metadata: manifests, file versions, manifest nodes, state hashes. The build system also still works from materialized directories. So GAD is too
  central: it owns both version semantics and too much of the content/tree representation.

  The cleaner architecture would be:

  Target Shape

  Server owns:

  - protected refs, especially repo -> main
  - approval-gated ref advancement
  - disk projection/materialization when needed
  - build orchestration for a requested tree hash
  - caller identity and capability grants

  Generic content store owns:

  - blobs
  - immutable trees
  - tree diffs
  - tree materialization
  - path reads/listing
  - GC roots

  GAD owns:

  - userland VCS semantics
  - commit/merge/provenance/history
  - proposing new tree hashes
  - requesting main advancement through the server API

  Build system owns:

  - “build this unit/subtree at this tree hash”
  - cache keys based on content hashes
  - no dependency on GAD internals

  So the server would not be “the GAD server.” It would maintain protected refs and accept build/projection requests for content-addressed trees.

  Blob Store Extension

  I would promote the blob store into a small generic content store.

  Add first-class immutable objects:

  BlobObject = sha256(file bytes)

  TreeObject = hash(canonical entries)
  entry = {
    name,
    type: "file" | "tree",
    hash,
    size?,
    executable?,
  }

  Then expose APIs like:

  putBlob(bytes) -> blobHash
  getBlob(blobHash) -> stream

  putTree(entries) -> treeHash
  getTree(treeHash) -> entries

  readFile(treeHash, path) -> blobHash | bytes
  listTree(treeHash, prefix?) -> entries
  diffTrees(baseTree, nextTree) -> changedPaths
  materializeTree(treeHash, outDir, options)

  The content store should not know about GAD commits, branches, merges, authorship, or approval semantics. It should only know immutable content.

  Tree metadata could be stored as canonical JSON blobs, or in indexed tables for performance, but the abstraction should be generic: a tree hash represents a filesystem tree.

  Ref Model

  Then the server maintains refs:

  repo/main -> treeHash
  repo/context/<id> -> treeHash // maybe, depending on whether contexts remain server-visible

  Main advancement becomes a compare-and-swap operation:

  advanceRef({
    repo,
    ref: "main",
    expectedOldTree,
    nextTree,
    caller,
    reason,
  })

  The server computes the diff itself from expectedOldTree to nextTree, then gates it.

  For ordinary repos, that uses the general workspace-repo-write approval path.

  For the meta repo, the server additionally derives semantic unit changes from the diff/tree contents and shows the special meta approval prompt.

  The caller should not be trusted to supply the changed paths. It can supply a proposed summary, but the server/content store should compute the authoritative diff.

  Build Model

  Builds should become:

  requestBuild({
    repo,
    treeHash,
    unitPath,
    target,
  })

  The builder can still materialize to a temp directory initially, because most JS tooling expects files. The important architectural change is that the build source is a tree hash, not “whatever GAD says this state contains.”

  Later, we can optimize with virtual reads, partial materialization, or package-level snapshots. But the first win is decoupling: build works from the content store, not GAD.

  Migration Plan

  1. Extract a generic ContentStore/TreeStore beside the current blob store.
     Reuse the existing file blob hashes and canonical worktree hashing where possible.

  2. Move tree/list/diff/materialize operations out of GAD into this store.
     GAD can still call them, but no longer owns them.

  3. Change build source resolution to consume treeHash.
     Keep filesystem materialization as an implementation detail.

  4. Change GAD state outputs to point at content-store tree hashes.
     GAD keeps commits/history/merge state, but not private worktree manifests as the system source of truth.

  5. Introduce protected server refs.
     main is just a protected ref pointing to a tree hash.

  6. Gate all main ref advances in one path.
     General repos use normal repo-write approval. Meta repo gets the richer semantic prompt.

  7. Shrink WorkspaceVcs.
     It should stop being the privileged mega-owner and eventually become either a thin projection service or disappear behind ContentStore + RefService + BuildService.

  Caveats

  We need atomic ref updates, durable refs, object validation, GC roots, and strict path normalization. Userland should not be able to claim a tree hash unless the content store has all referenced objects and the tree is valid.


