# Vibestudio on Dolt cells: data and agent systems redesign

Status: proposal, revised 2026-11-14 to the fork as it now ships (celld
`unified-fork` at `9440c29`). First written 2026-11-13. The implementation
branch is `feat/dolt-p0`, cut from `feat/celld-runtime`.

Inputs:
- the celld fork design (`celld/docs/fork/design.md`, §3b as built, decisions
  §8);
- the fork's service docs: `dolt-cells.md`, `dolt-remotes.md`,
  `object-fork.md`, `durable-object-facets.md`, `residency.md`, `egress.md`,
  `p2p.md`, and `docs/fork/codegen.md`;
- the phase-0 compatibility audit (`docs/celld-compat-audit.md` on
  `audit/celld-compat`);
- this repository and the Base template at `92001a1`.

Facts come from source reads unless they are marked *estimate*, *spike* or
*to verify*. A claim read only from the fork's documentation and not yet run
against the binary is marked *to verify*.

## Status / handoff (2026-11-14)

**Settled in this document** (the user's decisions are listed below; the rest
is proposal):
- the laws L1 to L10 (§2);
- which classes become Dolt (§2.2);
- the fork features F1 to F7, **all delivered** (§3);
- the durable base's commit discipline on F2, migrations as commits, and
  backup, restore, reset and clone through Dolt (§4);
- **GAD as decentralized work over one Dolt database**: participants on their
  own forks, merging back with Dolt fetch, push and merge (§5);
- channel and agent cells, with native forks at a commit (§6);
- eval kernels as owner facets, which deletes `EvalDO`, the lease and
  `UNSAFE_EVAL` (§7);
- Chronolog as the cross-workspace capability (§8);
- the migration order after the SQLite cutover (§9);
- the phases and gates (§10).

**User decisions (2026-11-13, restated 2026-11-14):**
- **GAD is decentralized and deeply integrated with Dolt.** It may stay one
  Dolt database if its size allows. What is decentralized is the work.
  - Participants (agents, the user, contexts, and later devices and other
    workspaces) work in parallel, each on its own fork or branch.
  - They merge back with Dolt's own fetch, push and merge (F7), and Vibestudio
    resolves conflicts semantically inside the merge (F1).
  - No single object serializes the work. The canonical database is where
    merges land, not where all work happens.
  - Chronolog membership and signing are the candidate for authorising pushes
    into a shared `main` across users and workspaces (§8).
- **Q1** (Dolt merge adopts non-conflicting changes, with provenance from the
  commit graph): yes.
- **Q2** (replay GAD's full history into Dolt commits): yes, replay.
- **Q3** (eval kernel residency): hold until an explicit end, bounded by the
  node's memory budget. No idle timer.
- **Q4** (Chronolog writes): agents write through their user's key after
  approval, as §8 proposes.
- **Q5** (`BrowserVaultDO` and `WebhookStoreDO` stay SQLite): yes.

**What this revision changed.** The fork now ships everything the first draft
asked for:
- F1 merge with a resolver, F2 `transactionSync(fn, { commit })`, F3 forks that
  carry facets, F4 `doltLocal`, F5 checkout flat in local-state size, F6 read
  access to history tables, and F7 Dolt remotes between cells (grants, fetch,
  pull, push), on one node and across the nodes of a fleet;
- Dolt facets (`celld: { storage: "dolt" }`).

Consequences:
- **P0's roll-forward is unnecessary.** With F2 there is no window between a
  write and its commit, so `committedTransaction` is designed directly on F2
  (§4.2). There is no `doltUncommitted: "commit"` recovery path and no
  `recoveredCommitMessage`.
- §3 is now a record of what the fork delivered and what it still lacks, not a
  list of requests.
- §5 is rewritten around decentralized work (§5.1 to §5.9).
- The single-writer GAD laws are re-stated for participants (§5.8).
- Checkout is flat in local-state size, but it is **7 to 15 ms with `fsync`**
  (0.7 ms without a device flush), not the 2 ms the first draft budgeted for.
  The P5 benchmark gate is restated (§10, R1).
- F7 is local and cross-node. P2P across workspaces is specified and its
  protocol and hooks exist, but the cross-workspace run is **not built**
  (`dolt-remotes.md`, "Across nodes, and over P2P"). Cross-workspace GAD waits
  for it (P6).

**Open:**
- Deletion line counts marked *estimate* still need span-level checks.
- The facet-relay path for remotes and `ondoltpush` (§5.6 and §3.2) are in
  the pinned fork (`9440c29`, tested there); a Vibestudio-side test is P5's.
  A facet loaded through a Worker Loader must pass a custom `transport`.
- The GAD database size gate (§5.1, §10 P5): a participant fork copies the
  whole file.

**Done (`feat/dolt-p0`, see `HANDOFF-dolt-redesign.md`):**
- P0 Foundations: the typed surface, `committedTransaction` on F2, schema
  install commits, the schema-guard filter and the `FakeDoltStorage` double,
  with a real-fork probe.
- The P2 prerequisites, checked on the fork (`doltEvalKernelCelld.test.ts`):
  per-isolate codegen grant, per-run commits in a kernel Dolt facet that
  survive a kill, residency holds without a timer, and revocation through the
  root (§7.4).
- **P2a: the notebook heap is held by a residency hold, and the host kernel
  lease is gone** (`7611524ef`). `EvalDO` takes `ctx.residency.hold()` when a
  run is admitted and ends it only on `reset`, a lifecycle release, or the
  node's revocation; there is no timer and no `idleExpiresAt`. On a drain or
  swap `onrevoked` gives active runs the typed `runtime_generation_lost`
  terminal; an operator revocation only ends the hold. Deleted: the lease
  coordinator and its test, `evalService`'s touch, the server's
  `eval-kernel-lease-close` stage, the three lease methods and their rows, the
  `registerLifecycleRelease({ kind: "eval-kernel" })` declaration.
- The owner-to-kernel path and the confinement probe, on the real fork
  (`ownerKernelPathCelld.test.ts`, `universalDoHost.test.ts`): §7.1 and §7.7.

**Not done:** P2b, the structural move (the kernel as a facet of the owner's
root, `evalService` and the `evalEngine` host schemas deleted). §7.7 records
why it is not a local change and the decisions it needs. `UNSAFE_EVAL` is
already gone (the cutover replaced it with `new Function` under the class's
`codegen` declaration), so only its documentation remains. P3 onward.

This document re-derives GAD, the agent system, eval, the durable base and
Chronolog integration for a runtime in which a Durable Object's state is a
versioned Dolt store. It also says what gets deleted. The runtime cutover
(`feat/celld-runtime`) moved every class to celld with SQLite cells and
facets. This redesign lands after that cutover, one class at a time, and keeps
no long-lived dual path (§9).

---


## 0. The decisions on one page

1. **One history per store.** Inside a Dolt cell, the Dolt commit graph is
   the only version mechanism. Every hand-built one is deleted: event and
   parent tables, refs and ref logs, working-head pointers, fork pointers,
   hash chains, persistent radix maps, fact roots, and clone and backup
   journals.
2. **Facts live in rows, history in commits, identity in hashes.** Semantic
   facts stay in ordinary tables, written in the same commit as the state
   change they explain. A commit's hash is the identity of that state. A
   commit message is a rendering of its rows, never the only copy of a fact.
3. **Versioned tables and local tables.** Each Dolt class splits its tables
   into two kinds:
   - *versioned*: history and knowledge, which fork, merge and reset carry;
   - *local*: identity-bound operational state (outboxes, mailboxes,
     admission receipts, caches), which a fork does not copy and a reset does
     not rewind.

   The fork supplies this split as `doltLocal` patterns (F4, §3).
4. **Each owner chooses its commit points:**
   - GAD commits once per semantic mutation;
   - a channel commits once per ledger append;
   - an agent commits once per closed turn;
   - an eval kernel commits once per finished run;
   - the schema lifecycle commits once per migration.

   The durable base commits inside the transaction that wrote the facts (F2),
   so a state and its commit are one durable step. It never uses a timer and
   has no recovery path to run.
5. **Branches give one owner alternative states, forks give new identities.**
   - A GAD context is a branch of its participant's GAD work cell.
   - A forked conversation is a fork of the channel cell and of each agent
     cell, each taken at a commit.
   - A subagent's file work is its own GAD work cell, a fork of the canonical
     database, merged back through §5.5.
6. **Dolt merges the rows, and Vibestudio resolves the meaning.** GAD
   integration is a Dolt merge. Rows that change on only one side merge
   natively, so a source change that does not conflict is adopted with its
   provenance derived from the commit graph. Conflicting file rows are
   resolved semantically (a three-way text merge with coordinate mappings, or
   a reconcile or decline decision) inside the merge's own transaction (F1).
   No merge session ever persists.
7. **File bytes stay in the content CAS.** GAD's Dolt tables hold placements,
   content hashes and coordinates, never bytes. The file-level VCS is
   semantic, not SQL row diffs.
8. **Eval kernels are Dolt facets of their owner's root cell.** The kernel
   class comes from a loaded worker that the owner's manifest grants `codegen`
   and `residency`. The owner calls its kernel directly. Deleted outright:
   `EvalDO` as an internal class, `evalService`, the kernel lease, the 20
   host-only eval authority methods, and `UNSAFE_EVAL`.
9. **Backup, restore, reset and clone are Dolt operations.** A backup is a
   branch, a restore is `reset --hard`, a reset is `reset --hard` to the
   schema commit, and a clone is `fork`. The host's maintenance journal,
   `cloneDO`, `durableObjectStorageClone.ts` and `computeWorkerdObjectIdHash`
   are deleted.
10. **Stores whose history would be a liability stay SQLite.** Secret-bearing
    stores (`BrowserVaultDO`, `WebhookStoreDO`) do not become Dolt, because a
    Dolt history retains every deleted secret. This departs from "every DO is
    Dolt" on purpose (Q5).
11. **Deterministic execution (`dolt.execute`) is used only where independent
    replicas must agree, which means Chronolog.** Nothing inside one
    workspace needs it.
12. **GAD's work is decentralized (the user's decision).** GAD stays one Dolt
    database if its size allows, and participants (agents, the user,
    contexts, later devices and other workspaces) each work on their own fork
    or branch in parallel. They merge back with Dolt fetch, pull and push (F7)
    and the F1 resolver. No object serializes the work: the canonical
    database only fast-forwards `main`.
13. **Chronolog is the substrate for data shared across workspaces.**
    - Each workspace node runs one Chronolog node.
    - A host capability exposes groups to agents, panels and userland.
    - Vibestudio users map to Chronolog principal keys.
    - Data inside one workspace stays on Dolt cells, because a single trust
      domain does not need consensus.

Section 3 records what the fork delivered (F1 to F7) and what it still does
not do. Section 10 orders the work.

---


## 1. What the runtime gives, and its constraints

From the fork docs (`dolt-cells.md`, `dolt-remotes.md`, `object-fork.md`,
`durable-object-facets.md`):

- **`ctx.storage.dolt`** is synchronous, except the three remote transfers.
  It offers:
  - `commit`, `branch.{create,delete,list,current}`, `checkout`, `reset`,
    `log`, `diff`, `hashOf`, `status`, `gc`;
  - `merge(name, { message? })`, and `merge(name, { …, resolve })` with an
    in-transaction resolver (F1);
  - `execute` and `engineDigest` (deterministic programs, Chronolog only),
    and `query` (one read-only statement under the local-read profile);
  - `remote.{add,remove,list,branches,grant,grants,revoke,serve}`, and the
    async `fetch`, `pull` and `push` (F7).
- **Transactions.** `transactionSync(fn, { commit })` and
  `transaction(fn, { commit })` make the writes and a Dolt commit one durable
  step (F2). `commit` is `{ message, author?, date?, allowEmpty? }`, a bare
  message, or a function of the callback's result that may return `null`.
  `beginTransactionSync()` returns `{ commit(), rollback() }` for adapters.
- **Forks.** `env.NS.fork(id, { at?, facets?, to?, name?, replaceUnfinished? })`
  copies a whole object, every facet with its engine, each Dolt component at
  its own commit. `env.NS.restore`, `deleteUnfinished` and `celld cell import`
  complete the set. `ctx.facets.fork(source, target, { at })` copies one Dolt
  facet within its parent.
- **Reading history.** Application SQL reads `dolt_at_<t>('<ref>')`,
  `dolt_history_<t>`, `dolt_diff_<t>`, `dolt_blame_<t>`, `dolt_log`,
  `dolt_branches`, `dolt_status`, `dolt_merge_base(a, b)`, `dolt_hashof(ref)`,
  and inside a resolver `dolt_conflicts_<t>` and
  `dolt_constraint_violations_<t>`. It cannot call versioning functions or
  write `dolt_*` tables, and it cannot create tables named `dolt_*` or
  `doltlite_*`.

**Constraints that remain and shape this design:**

| ID | Constraint | State on `9440c29` |
|---|---|---|
| **C1** | Dolt operations throw inside `transaction()` and `transactionSync()`. | Still true for every operation *except* the commit of F2: `{ commit }` is an option of the outermost transaction. It throws on a nested transaction (a savepoint) and on a SQLite cell. |
| **C2** | A plain `merge(name)` that conflicts rolls back. | Resolved by F1: pass `resolve`. A merge Dolt finishes by itself still calls it once, with empty lists, so the application can add its own rows. A fast-forward or an up-to-date merge makes no commit and does not call it (`fastForward: false` forces a merge commit). Schema conflicts cannot be resolved by a row resolver. At most 100 000 conflicting rows and violations. |
| **C3** | Writes go to the checked-out branch, and checkout moves the runtime tables. | Cost is flat in local-state size (F5). It is still a device write: **7 to 15 ms with `fsync`**, about 0.7 ms with the flush off. A transaction made with `{ commit }` leaves nothing for checkout to record, which is the faster path. |
| **C4** | `_cf_*` tables are unversioned and classes cannot declare their own. | Resolved by F4: `doltLocal` patterns. Limits in §3. |
| **C5** | A chunk file was capped at 1 GiB. | Lifted. A capture after `gc()` and a restore read the whole file into memory, and DoltLite's GC buffer limits live data to about 2 GiB. `gc()` rewrites the whole file. |
| **C6** | A fork copies the whole file and shares no storage. | Still true (copy-on-write is planned). A fork drops identity: the alarm, the id name, **and the remotes, grants and remote-tracking branches** (§3.2). |
| **C7** | Facets nest four deep, cannot set an alarm, keep the root resident when they hold sockets, and never commit atomically with their root. | Unchanged. A facet runs in its root's isolate, so facets of one root share one thread. Parallelism means separate objects (§5.1). |
| **C8** | Dolt facets did not exist. | Resolved: `ctx.facets.get(name, () => ({ class, celld: { storage: "dolt", doltLocal } }))`. The engine is fixed at creation, and a start that omits `celld.storage` on a Dolt facet is refused, so every start passes it. |

- **Capabilities.**
  - `codegen` and `residency` are per-class declarations. A loader grants
    them to a loaded worker only if the loader holds them itself.
  - `doltRemotes` and `doltLocal` are per-class declarations too (a facet
    takes the remote declaration of its root's class, and declares
    `doltLocal` in its startup options).
  - The egress hook carries the caller's identity.
  - The `p2p` binding dials Iroh peers.

DoltLite itself (0.51.11, `vendor/libsqlite3-sys/doltlite/src/sqlite3.c`)
already implemented the engine features the fork wrapped (`dolt_merge
--no-commit`, `dolt_conflicts_<t>`, `dolt_constraint_violations_<t>`,
`dolt_cherry_pick`, `dolt_revert`, `dolt_rebase`, `dolt_merge_base`,
`dolt_blame_<t>`, `dolt_at_<t>`, `dolt_history_<t>`). `dolt_revert`,
`dolt_cherry_pick` and `dolt_rebase` are **not** exposed to application SQL or
to `ctx.storage.dolt`: any design step that needs one (panel undo in P3,
purge in P5) must ask the fork for it or express it as a diff plus a commit.

---


## 2. First principles

### 2.1 Laws

- **L1. One history per store.**
  - If a table records "the previous version of X", "which state is current",
    "where this branched", or "what the hash of the prior entry was", it
    duplicates the commit graph. It is deleted.
  - The rule applies inside one store. Facts that cross cells (a GAD
    decision naming a source commit, a channel fork naming its parent
    channel) are ordinary rows that name another owner's stable identity.
- **L2. Facts in rows, history in commits.**
  - A fact a reader needs, such as "this commit is a GAD event of kind
    integration-commit caused by command K", lives in a row of the commit
    that introduces it.
  - A derived local index may map stable ids to commit hashes for speed. It
    is rebuildable from `dolt_log` and `dolt_diff` and is never identity.
  - This also keeps commit messages free to be plain human text, and it is
    what lets a transaction's commit message be rendered from the rows it
    wrote (§4.2).
- **L3. Versioned or local, decided per table.**
  - Versioned state answers "what did this owner know or produce, as of
    when?".
  - Local state answers "what is this incarnation currently obliged to do?".
    That covers outboxes, mailboxes, delivery leases, admission receipts for
    external effects, and derived caches.
  - A fork starts with empty local tables and rebuilds anything rederivable
    from versioned state. A reset rewinds versioned tables only.
  - This one rule replaces each class's fork-scrub code (`postClone`,
    `resetForFork`, and knowledge export and import).
  - The fork implements it as `doltLocal` name patterns (F4). A table that
    matches is an ordinary table to SQL and joins the same transactions.
- **L4. Commit points are semantic.** Each owner commits where a reader would
  want a state to name. The base guarantees atomicity: the writes
  and the commit are one durable step (F2).
- **L5. Branch or fork.**
  - Use a branch for alternative states of one owner's facts that will be
    compared or merged inside that owner, such as GAD contexts.
  - Use a fork when the alternative is a new entity with its own identity,
    mailbox and lifecycle, such as a forked channel or a forked agent.
- **L6. Dolt merges rows, the owner resolves meaning.** Dolt's merge works
  cell by cell on primary keys, which is exactly the semantics GAD
  hand-builds for file placement, mode and presence (`netEffectMerge.ts`).
  The meaning of conflicting text is the owner's to resolve, and it does so
  inside the merge transaction (F1).
- **L7. History is retention.**
  - Anything written to a versioned table is kept until the history is
    rewritten.
  - Secrets never enter Dolt.
  - User-requested purges are an explicit history-rewrite operation
    (risk R6).
- **L8. Determinism where replicas must agree.** `dolt.execute` exists for
  Chronolog's replicated SQL. Using it for single-owner state would add a
  contract without a consumer.
- **L9. Work is decentralized.** A branch has exactly one writer. Participants
  write their own cells and branches in parallel and meet in merges. The
  canonical database is where merges land; it never serializes work and never
  merges on a participant's behalf (§5).
- **L10. State is merge-safe.** Two forks of one database may write the same
  tables and merge later. Primary keys are ids minted without coordination
  (hashes, or participant-prefixed unique ids). No versioned table uses
  `AUTOINCREMENT`, a rowid key, a sequence or a counter row. A uniqueness
  constraint is a merge constraint: a violation is a decision for the
  resolver (F1).

### 2.2 Which classes become Dolt

| Class | Engine | Why |
|---|---|---|
| GAD (`GadWorkspaceDO`, userland facet): the canonical database and each participant's work cell | Dolt | Its whole job is versioned state with branches and merges, and its work is decentralized over forks (§5) |
| Channel (`PubSubChannel`, facet) | Dolt | A versioned ledger with native fork at a sequence |
| Agent (`AiChatWorker` family, facet) | Dolt | Fork at a turn, rewind, inspection as of a turn |
| Eval kernel (new kernel facet, replacing `EvalDO`) | Dolt | Per-run commits, reset as `reset`, forks with its owner |
| `WorkspaceDO` (internal root) | Dolt | The panel and entity tree gains undo natively (`slot_history`, `panel_close_cleanup` go). Its scheduler and lifecycle tables disappear with the cutover (§4.5) |
| `MissionsDO` (facet) | Dolt | Ordinary product state. Versioning comes free, and keeping one engine for all userland state is simpler than two |
| Other userland facets (panels, apps) | Dolt by default | One facet engine for userland. A manifest can opt out to `sqlite` for secret-bearing state |
| `BrowserVaultDO`, `WebhookStoreDO` | SQLite | They hold secrets (L7) |
| celld-internal broker cells (D1, KV, queues) | unchanged | Runtime-owned |

---


## 3. Fork features F1 to F7: delivered, with what they do not do

Each one wrapped an engine feature DoltLite already had, and each removed a
wall that would otherwise have forced a workaround in Vibestudio. All are in
`unified-fork` (fork design §3b.12 for F1 to F6, §3b.13 for F7); the build
Vibestudio pins is `9440c29`, which also fixes the hard-reset durability gap
(below) and adds `ondoltpush`.

### 3.1 What was delivered

| ID | Feature as shipped | How Vibestudio uses it |
|---|---|---|
| **F1** | `dolt.merge(name, { message, author?, date?, resolve, fastForward? })`. `resolve(merge)` runs once, synchronously, inside the merge's transaction. `merge.conflicts` holds each conflicting row (`table`, `key`, `base`, `ours`, `theirs`, `ourChange`, `theirChange`) and `merge.violations` each constraint violation. Each must be answered with `resolve()`, `keepOurs()` or `takeTheirs()`. celld then makes one 2-parent commit. A throw, a promise, or an unanswered row rolls everything back. Result: `{ hash, conflicts: [], fastForward, upToDate, resolved }`. | GAD's semantic resolution (§5.5) and every `pull` that needs it. The resolver writes rows with `ctx.storage.sql`, reads the other side with `dolt_at_<t>(ref)`, and adds its own rows (the `events` row, `decisions`). |
| **F2** | `transactionSync(fn, { commit })` and `transaction(fn, { commit })`. One root record carries the writes and the commit. A function `commit` receives the callback's result and may return `null` to leave the writes uncommitted. | `committedTransaction` (§4.2), schema install commits (§4.3), every commit point of §0. **It removes the crash window (C1), so the first draft's roll-forward is deleted from the design.** |
| **F3** | `env.NS.fork(sourceId, { at?, facets: { [name]: { at?, facets? } } })` copies the object with every facet, each Dolt component at its own commit. `ctx.facets.fork` copies one facet. Dolt facets exist. | Forked conversations (§6.4), eval kernel forks (§7.3), and **GAD work cells** (§5.7). Idempotent by target id (`to`, `name`), with `replaceUnfinished` and `deleteUnfinished` for an interrupted fork. |
| **F4** | `doltLocal` patterns: for a class in `celld.durable_objects.<C>.doltLocal`, for a facet in its startup options `celld: { storage, doltLocal }`. Local tables are never staged, shown or hashed, survive `reset` and `merge`, move with `checkout` without copying rows, and start empty in a fork. | L3 (§2.1). Outboxes, receipts, mailboxes, caches. |
| **F5** | Checkout does not copy rows (`dolt_checkout --carry-ignored`), so its cost does not depend on local-state size: 0.7 ms (flush off), **7.5 ms with nothing written and 13.8 ms after a local write** (`synchronous=NORMAL`, this NVMe), at 0, 1 000 and 10 000 local rows. | GAD's write to context B after one to context A (§5.3). |
| **F6** | `dolt_at_<t>`, `dolt_history_<t>`, `dolt_diff_<t>`, `dolt_blame_<t>`, `dolt_diff_summary`, `dolt_log`, `dolt_commit_ancestors`, `dolt_branches`, `dolt_status`, `dolt_merge_base`, `dolt_hashof*`, and in a resolver `dolt_conflicts_<t>` and `dolt_constraint_violations_<t>` are readable from application SQL. `dolt.query` reads them under the local-read profile. | Cross-branch reads without a checkout (compare, blame, eval scope history). |
| **F7** | Remotes between cells. The source issues a **grant** (`remote.grant({ label, fetch, branches, push, expiresAt?, peer? })`, a bearer token shown once, only its SHA-256 kept). The holder does `remote.add(name, { id, token })`, then `await fetch`, `pull` (fetch plus merge, with `resolve`) and `push`. A push is "ask the target to fetch": the target installs the pack as `pushed-<grant id>/<branch>` and moves the branch itself, in its own turn, **only as a fast-forward** (`ERR_DOLT_NON_FAST_FORWARD` otherwise, `ERR_DOLT_TARGET_DIRTY` if the checked-out branch has uncommitted changes). The wire is three requests (`refs`, `fetch`, `push`) over any `async (bytes) => bytes` carrier. The built-in carrier is an internal request to the source's object, so a source on another node of the fleet is reached over the inter-node channel. | Decentralized GAD (§5): participants fetch, merge and push. |

### 3.2 What they do not do (gaps found by reading, with where it bites)

- **A push that moved a branch is announced to the target** (`9440c29`,
  `ondoltpush({ remote, grant, branch, from, to, created })`, in the target's
  turn and before the pusher is answered; a handler that throws changes
  nothing). The class needs the method; a holder gets no event. This replaces
  the earlier "no hook" gap: the canonical GAD database reacts to `main`
  moving without a follow-up RPC from the pusher. Pinned by the fork's
  `examples/dolt-remotes`; *a Vibestudio-side test is P5's*.
- **A Dolt facet is a holder, and a source or push target only through its
  parent.** A facet has no id to route to. The parent relays request bytes to
  the facet's `remote.serve` through a facet call (`9440c29` tests the relay,
  with the grant, the refusals and `ondoltpush` on the facet's own class), and
  the holder passes a custom `transport`. **For a facet loaded through a Worker
  Loader that transport is mandatory**: the built-in carrier needs a namespace
  binding, and a loaded worker's env carries only service bindings (measured in
  `ownerKernelPathCelld.test.ts`, §7.1). GAD is a facet, so its canonical copy
  is served by the relay method of its root.
- **A fork starts without remotes, grants and tracking branches.** A forked
  work cell must be given a fresh grant and call `remote.add` itself
  (§5.7). That is a security feature (a fork does not inherit authority) and
  a protocol step.
- **A fork shares no storage with its source.** The cost of spawning a work
  cell is one whole-file copy and one whole upload. The first fetch of a long
  history is the whole history. A pack is one buffer in memory (2 GiB at
  most), and the source's turn is occupied while it builds one.
- **No force push, no tag transfer, no deleting a remote branch.** A
  participant cannot rewrite canonical history, and a purge (R6) cannot be
  pushed.
- **Declaration order matters for local tables.** A pattern must be declared
  before the class creates its first matching table (a table committed first
  stays tracked). A pattern cannot start with `_`, `%`, `dolt_`, `sqlite_` or
  cover `_cf_*`, so framework tables whose names start with `_vibestudio_`
  cannot be local by pattern (§4.3). `AUTOINCREMENT` is forbidden in a local
  table (`sqlite_sequence` is one tracked table). A rule added by a redeploy is
  an uncommitted change to `dolt_ignore` until the branch commits.
- **Fixed in `9440c29`: an acknowledged `reset({ hard: true })` survives a
  SIGKILL.** On `fcc7268` it was lost (P0's probe: commit twice,
  `dolt.reset({ hard: true, to: "HEAD~1" })`, answer, `kill -9`, restart: the
  rows were back at the pre-reset head; every other versioning call survived).
  The canary `src/server/doltDurableCelld.test.ts` "an acknowledged hard reset
  survives a kill" is now a plain test and passes. Backup restore (`reset
  --hard` to `backup/<op>`), GAD `discard` and schema rollback may rely on it;
  the interim rule (follow a reset with a committed write, or use a fork) is
  withdrawn.
- **`sqlite_master.sql` is re-rendered once the creating transaction ends**
  (P0 probe, now documented by the fork: `docs/services/dolt-cells.md`, "Schema
  text"). Whitespace runs become one space, none stays before `(`, `)` and `,`,
  comments are gone, a name is quoted only when it has to be, string literals
  and quoted names that need their quotes are kept, views and triggers are kept
  as written, and rendering a rendered text changes nothing. A fingerprint taken
  inside the install transaction therefore differs from the next activation's.
  The schema guard's `looseSql` (§4.3) ignores every one of those differences
  (P0 handled only the whitespace; comments and quoting are covered since
  `1afb6c862`). Also seen: `dolt_ignore` and the `sqlite_autoindex_*` of
  `_cf_*`, `dolt_ignore` and `state` are listed in `sqlite_master`, and a rowid
  is not reused after a hard reset (L10: no meaning in `INTEGER PRIMARY KEY`).
- **`dolt_revert`, `dolt_cherry_pick` and `dolt_rebase` are not exposed.**
  Undo of one commit is the reverse patch from `diff({ from, to })` applied
  with SQL (§4.5).
- **`execute` is deterministic and for Chronolog only.** `query` is the
  general read.
- **P2P across workspaces is not built.** The protocol and the hooks are
  (`peer`-bound grants, `remote.serve`, `onp2pstream`); the glue is the
  application's, and the cross-workspace run is untested.
- **Managed (control-plane) deployments do not accept Dolt classes yet.**
  This redesign targets the local node.

The engine facts above are the whole interface. Nothing in Vibestudio needs
another fork change to start P0, P2 or P4. P5 needs a Vibestudio-side test of
the facet relay and `ondoltpush` (the fork tests both).

---


## 4. Durable base

### 4.1 Typed surface (`@vibestudio/durable/dolt`)

The surface is one typed interface, `DoltStorage`, that mirrors the fork's
documented API exactly: commits, branches, checkout, reset, both forms of
`merge` (with the resolver types), `log`, `diff`, `hashOf`, `status`, `gc`,
`execute`, `query`, `engineDigest`, and the remote surface (`remote.*`,
`fetch`, `pull`, `push`). It also types the declarations (`doltLocal`
patterns, the `{ commit }` transaction option, the error codes of §3.1). Two
classes use it: the host's `DurableObjectBase` and the template's
`durable-base.ts`, which share `@vibestudio/durable/schema`.
- `doltStorageOf(storage)` returns the store or `null`.
- `DurableObjectContext.storage.dolt?` is optional, and
  `transactionSync` and `transaction` accept the F2 `{ commit }` option.
- `@vibestudio/durable/test-dolt` exports `FakeDoltStorage`, a `sql.js`
  snapshot double for unit tests. It is faithful for commit, branch,
  checkout, reset, merge with a resolver (cell-wise three-way merge,
  `UNIQUE` index violations, rollback on a throw), `{ commit }`
  transactions, local tables, forks that clear remotes, restarts,
  `dolt_at_<t>`, `dolt_log`, and remotes between fakes over a byte wire (grants,
  fast-forward-only push, the `ERR_DOLT_*` codes, custom transports). It also
  reproduces the engine's schema-text re-rendering. It does not model
  replication, durability (so not the hard-reset gap of §3.2), the output gate,
  `execute`, or the `dolt_history_*`, `dolt_diff_*`, `dolt_blame_*` and
  `dolt_conflicts_*` tables, which throw instead of answering. Its header
  lists every divergence.

There is no adapter layer and no second engine abstraction. A SQLite cell
simply has no `dolt`.

### 4.2 Commit discipline: commit in the transaction

F2 makes a SQL transaction and its Dolt commit one durable step, so the base
has one primitive and no recovery path:

```ts
protected committedTransaction<T>(
  describe: (result: T) => DoltCommitMessage | null,
  fn: () => T,
): T;
```

- `committedTransaction` is `ctx.storage.transactionSync(fn, { commit:
  describe })`. The message is rendered from the facts `fn` wrote (L2), and
  `null` leaves the writes uncommitted. On a SQLite cell (no `dolt`) it is a
  plain `transactionSync` and the commit point no-ops, so a class's code does
  not branch on the engine (§9.1).
- **A transactional class** (GAD, channels, kernels, `WorkspaceDO`) writes
  versioned state only through `committedTransaction`. Its working set is
  clean at every turn boundary. There is nothing to recover after a crash:
  the commit is in the same root record as the writes, so either both exist or
  neither does. **This deletes the first draft's `doltUncommitted: "commit"`,
  `recoveredCommitMessage` and the activation-time roll-forward.**
- **A `keep` class** (the agent) holds working-set state between commits:
  it appends conversation entries during a turn and commits when the turn
  closes, in one `committedTransaction` that also writes the turn's last
  rows. A crash mid-turn leaves the entries uncommitted, which is the
  intended resume state (a durable working set), not drift. The base does not
  touch it.
- **Drift check.** A write to a versioned table outside `committedTransaction`
  in a transactional class leaves the working set dirty. The base offers
  `assertCleanWorkingSet()` (it reads `status()` and ignores `dolt_*` and
  `_cf_*` rows, since a redeploy that adds a `doltLocal` rule dirties
  `dolt_ignore`), which tests and the dev host call after each turn. It is a
  diagnostic, not a recovery.
- **Atomicity with the rest of the object.** A facet and its root never commit
  atomically (C7). A commit point that spans both is two commits, each
  idempotent by its own rows (L2).
- **Not in a transaction.** Branch, checkout, reset, gc and the remote calls
  throw inside `transaction()` (C1). A class sequences them between
  `committedTransaction` calls, in its own turn.
- No timer, retry loop or watchdog is involved.

### 4.3 Schema migrations as commits

`installDurableObjectSchema` keeps its contract (one transaction, trusted
fingerprints, a contiguous upgrade path, fail closed). On a Dolt store it
adds three things:

1. **Before an upgrade path runs**, a dirty working set (state a `keep` class
   had not yet committed) is committed as `schema: checkpoint before
   C vN→vM`. This is a plain `dolt.commit`, taken *before* the transaction,
   because Dolt operations throw inside one (C1). The upgrade commit then
   contains exactly the migration, and the checkpoint is a known restore
   point. A crash between the checkpoint and the upgrade leaves the
   checkpoint, which is harmless.
2. **After fresh creation or an upgrade**, the transaction's result is
   committed as `schema: C vN` or `schema: C vN→vM`, **by F2**: the
   transaction runs as `transaction(fn, { commit })`, where `commit` is a
   function of what happened (fresh, upgraded, or nothing to do, which
   returns `null`). Validation and the metadata update stay inside the
   transaction, as today. If the transaction rolls back, nothing is
   committed. There is no crash window between the schema transaction and its
   commit, so **no recovery that inspects `_vibestudio_schema` or `status()`
   is needed** (this replaces the first draft's design).
3. **The schema guard ignores runtime and engine objects.** That means
   `_cf_*`, `_litestream*` and the Dolt system names `dolt_*` and
   `doltlite_*` (audit V1 and A3). The cutover already filters `_cf_*` and
   `_litestream*` (`APPLICATION_OBJECT` in `schema.ts`); P0 adds the Dolt
   names, which a Dolt store may list in `sqlite_master`.

`_vibestudio_schema` (version and shape) stays as the single current-state
fact. The commits record *when* each migration happened, not a second copy
of the version. With these commits, rolling back a deployed migration is an
operator action, `reset --hard` to the checkpoint commit. It discards the
writes made after it, and saying so is the honest cost. The guard can name
the checkpoint as an extra safe action (`restore-schema-checkpoint`) when an
older build meets a newer schema.

**Fingerprints on a Dolt store.** The engine re-renders table text after the
creating transaction (§3.2, the fork's "Schema text" rule), so on a Dolt store
every shape comparison (the persisted shape, the trusted fingerprint, the
upgrade sources and targets) goes through `looseSql`, which ignores each
difference the rendering makes: whitespace around `(`, `)` and `,`, comments,
and the quotes of a plain name; string literals and names that need their
quotes are compared as written. SQLite stores keep the exact text, so no
persisted shape changes meaning. Index definitions are compared
loosely on both engines (the declared text is code).

**Framework tables on a Dolt store.** The base's own operational tables are
identity-bound, so L3 says they are local. A `doltLocal` pattern cannot start
with `_` (§3.2), so on a Dolt store the base creates the nonce ledger as
`vsl_direct_rpc_nonces` (on SQLite it stays `_vibestudio_direct_rpc_nonces`),
and a Dolt class declares `doltLocal: doltLocalPatterns([...])`, which adds
the framework patterns `vsl_%` and `state` to its own. `state` is local by
exact name: a class that keeps versioned facts in it must move them to its own
table first. P0 implements both (`@vibestudio/durable/dolt`).

### 4.4 Backup, restore, reset and clone

| Operation | Today (`workerdManager.ts`, `durableObjectStorageClone.ts`) | On Dolt |
|---|---|---|
| Backup | Quiesce (facet abort, or a whole-process stop for internal DOs), integrity-check, then copy raw files into `do-backups/<op>` with a manifest and verify. Retain 5 and sweep | `branch.create("backup/<op>")`, in the object's own turn. O(1) |
| Restore | Journaled replace of files, then reactivate | `reset({ hard: true, to: "backup/<op>" })`, in the object's own turn. Local tables survive, so in-flight obligations are not lost (L3) |
| Reset (disposable state) | Back up, then delete files | Back up as a branch, then `reset --hard` to the latest `schema:` commit, giving the fresh schema with no rows |
| Clone (`cloneDO`) | Reservation, seal and drain relays, quiesce or cooperatively pause, `node:sqlite` backup per file, staged and digest-verified publish, receipt table | `env.NS.fork(source, { at, facets })` (F3). The new id is claimed with a conditional create, so the operation is idempotent by target id. The entity reservation in `WorkspaceDO` stays |
| Retention | `sweepDurableObjectBackups` | `branch.delete`, then `gc()` |

A branch is not a copy: it is lost with the object. A backup that must
outlive the object (the cutover's hidden fork cell `__vibestudio_backup:<op>`)
stays a fork (`env.NS.fork`). A backup can be taken without quiescing, because
the object takes it in its own turn (input gate) and the output gate covers
it. The whole
maintenance-journal state machine exists only because the host copied files
underneath a live process. That is why it all goes. Off-machine backup
belongs to the runtime: the cell's replication to its bucket (vibestore, or
a remote bucket later).

### 4.5 `WorkspaceDO` and the lifecycle protocol: what remains

The durable-base survey splits `WorkspaceDO` (3,899 lines) into three parts.

- **The domain model stays, on Dolt.** That covers `entities`,
  `runtime_resource_bindings`, `slots` and `context_edges`. `slot_history`
  and `panel_close_cleanup` are deleted: closing commits, and reopening
  reverts that commit's rows. The just-landed "closing is reversible"
  behavior becomes the reverse patch of one commit: `dolt.diff({ from:
  <closing commit>, to: <its parent> })` returns the SQL that turns the one
  state into the other, and the owner applies it with `committedTransaction`.
  (`dolt_revert` is not exposed to applications, §3.2.)
- **The alarm machinery goes with the cutover, not with Dolt.** That covers
  `do_alarms`, `do_alarm_test_policies`, the wake publication store, and
  `alarmDriver.ts` (385). They exist because workerd has no alarms for
  SQLite DOs or facets. celld has native alarms per cell (root), so the
  UniversalDO root holds its facets' schedule (C7). The same holds for the
  durable-work readiness tables, `durable_work_owners` and
  `durableWorkDriver.ts` (918): a cell schedules its own wake.
  - If the cutover does not delete these, P3 does.
  - They must never be versioned. Rewinding a scheduler's claims is wrong,
    and the wake publication header already states that invariant.
- **The lifecycle leases, epochs and ops go.** That covers `lifecycle_*`
  and `lifecycleDriver.ts` (408). They let the host quiesce DOs before
  replacing workerd. On celld:
  - a deploy is a generation swap that celld drains;
  - acknowledged writes are covered by the output gate;
  - a held resource is a residency hold with `onrevoked`.
  The one obligation that remains: a class holding residency persists what
  it can in `onrevoked` (the eval kernel, §7.4).

---


## 5. GAD on Dolt: decentralized work over one database

GAD (`workers/workspace-source/`, about 44k lines including tests) is a
change-based semantic VCS. It is hand-built on a content-addressed persistent
map in SQLite, behind one Durable Object that is the single owner of
contexts, events, changes and the command journal. Dolt is a content-addressed
persistent map with commits, branches and a merge, and (F7) a way to move
commits between cells.

The redesign keeps GAD's semantics (changes, work units, coordinate lineage,
causal ingress) and hands its storage mechanics to Dolt. **It also removes the
single owner.** That is the user's decision, and Dolt now lets it be done
without a new protocol.

### 5.1 Topology: one canonical database, many work cells

```text
                  ┌──────────────────────────┐
                  │ canonical GAD            │   main (protected)
                  │ one Dolt database        │◄───────── fast-forward pushes only
                  └─────▲──────────▲─────────┘
        fetch / push    │          │   fetch / push
              ┌─────────┴───┐  ┌───┴─────────┐   ┌─────────────┐
              │ work cell A │  │ work cell B │   │ work cell C │ … later: a device,
              │ agent run   │  │ the user    │   │ subagent    │   another workspace
              │ ctx/a1 ctx/a2   │ ctx/u1 …    │   │ ctx/c1      │
              └─────────────┘  └─────────────┘   └─────────────┘
```

- **The canonical database** is one Dolt database (a Dolt facet of one root
  object). It holds `main`, the protected branch, and branches that
  participants have published. **It never merges.** It moves `main` only when
  a push is a fast-forward (F7). It is where work lands, not where work
  happens.
- **A work cell** is one participant's whole copy of the database: a separate
  object (a UniversalDO root with the GAD Dolt facet), created by forking the
  canonical root at a commit (F3). It has its own isolate and its own turn
  queue, so participants run in parallel with no shared writer. Inside it,
  each context is a branch `ctx/<contextId>`, and the cell's single turn
  serializes only the participant's own contexts.
- **Participants.** One work cell per:
  - agent invocation (a subagent gets its own, retired when it ends);
  - user, per device or session (long-lived);
  - later, another workspace (the same protocol over the P2P carrier, §8).

  A *context* is a branch inside a cell, so a participant that works on many
  contexts uses one cell, not one per context.
- **Why a fork and not an empty cell plus a fetch:** a merge needs a common
  ancestor. A cell created empty has unrelated history, and Dolt cannot merge
  it. A fork shares every commit with its source.
- **Where the canonical copy lives** is a deployment choice that does not
  change the protocol. With the GAD database as a facet (userland), its root
  relays remote requests with `remote.serve` through a custom carrier (§3.2).
  If a Dolt root class owns it instead, the built-in carrier reaches it
  directly.
- **Size gate.** The canonical database holds placements, hashes and
  coordinates, never file bytes (§5.10), so it is small compared with the
  workspace. A work cell is a whole-file copy, so spawning one costs the file
  size once. P5 measures the replayed database of a real workspace and the
  fork latency at that size. If a participant fork exceeds its budget, the
  fallback is to shard the canonical database by repository group (one Dolt
  database per group, a work cell holding one facet per group). It is a
  fallback, not the plan.

### 5.2 The state model

Inside any cell (canonical or work), the GAD database has one branch per
context, `ctx/<contextId>`, plus `main`.

**State tables** (versioned, current-state rows):
- `repositories(repository_id PK, repo_path, presence, tombstone_change_id)`
- `files(file_id PK, repository_id, path, content_hash, mode, content_kind,
  byte_length, coordinate_extent, presence, tombstone_change_id)`, with
  `UNIQUE(repository_id, path)` over placed rows.

**Merge-safe schema rules (L10, §2.1).** Because any two participants may
write the same tables in parallel and merge later:
- every primary key is an id minted without coordination: a content hash, or
  a participant-prefixed unique id (`<participantId>:<ulid>`). Nothing uses
  `AUTOINCREMENT`, a rowid-derived key, a per-table sequence, or a versioned
  counter or singleton row (two forks would both write the same value and
  conflict forever);
- stable ids are minted by the invoking participant from the causal
  coordinate, so the same command retried on the same cell gets the same ids;
- uniqueness constraints (`UNIQUE(repository_id, path)`) are merge constraints:
  a violation the merge produces reaches the resolver as `merge.violations`
  (a placement collision), where it is a semantic decision.

How the old structures map:

| Today | On Dolt |
|---|---|
| `WorkspaceFactRoot`, persistent radix nodes and edges, file manifests | The Dolt root of the commit. A point read is `SELECT … FROM files WHERE repository_id = ? AND path = ?` (at a ref, `dolt_at_files(?)`) |
| Repository and file *state* rows with `prior_*_state_id` | The current row, plus Dolt history. "Prior state" is the row at the commit's parent. Restore reads the row before the tombstone change (`dolt_at_files(<parent>)`) |
| `contentKind`, `byteLength`, `coordinateExtent` | Unchanged columns. They are intrinsic file facts |
| Host tree hash | Still derived for materialization. It is keyed by commit hash |

### 5.3 States, applications, events and contexts

| GAD concept | On Dolt |
|---|---|
| `StateNodeRef` | A commit hash. The public `{kind: "event" \| "application"}` shape stays as a projection: a commit is an event if it introduced an `events` row |
| `WorkApplication` (one mutation) | One commit on the context branch, holding its rows: `commands`, `work_units`, `changes` (+ coordinates and counteractions), `applied_changes` (+ predicates), `content_edges` (+ mappings), and any `decisions`. The basis is the commit's first parent |
| `WorkspaceEvent` (commit) | One commit that adds a single `events(event_id, command_id, kind, message)` row. Its parents are the Dolt parents. "Applications committed by this event" is the first-parent range since the previous event |
| Integration commit | The Dolt merge commit (2 parents) produced by §5.5, which adds its `events` row inside the resolver |
| Genesis | The schema commit plus the template-installation commit, in the canonical database. Every work cell forks from a descendant of it |
| Context `committed_event_id` / `working_head` | Branch `ctx/<id>`. The working head is the branch head. The committed event is the nearest first-parent commit with an `events` row (derived, no pointer) |
| CAS on the working head | `hashOf("ctx/<id>") === expected`, checked inside the write turn **of the cell that owns the context**. The check stays local; no other cell can write that branch (§5.8) |
| `forkContext` (with uncommitted applications) | `branch.create("ctx/<child>", { from: "ctx/<parent>" })`. O(1), carrying every application commit, which is exactly GAD's "share the immutable head" rule. Within one cell |
| `discard` | `reset({ hard: true, to: <committed event> })` on the context branch |
| `destroyContext` | `branch.delete`. Reachable commits remain through other branches and merges |
| `vcs_workspace_heads`, `refs`, `ref_log` | Branches. A protected-main move is a fast-forward push, and its history is `dolt_log` of `main` in the canonical database |
| Push to protected main | Approval at the host (unchanged), which mints a short-lived push grant, then a fast-forward-only push of the committed event (§5.5, §5.6) |

A work cell is a transactional class (§4.2). Every mutation is one
`committedTransaction` on its context branch. A write to a context first
checks out its branch (**7 to 15 ms with `fsync`, §3.1 F5**: a participant
that alternates contexts pays it per switch, and the cell batches a
participant's writes to one context). Reads of other contexts use
`dolt_at_<t>(ref)` and need no checkout.

### 5.4 "Store each fact once" under Dolt

What is still a stored fact:
- the `changes` and `work_units` that express intent;
- `applied_changes` and their result predicates;
- `content_edges` and mappings that Dolt cannot see (text coordinates
  preserved through an edit, explicit copies, semantic text-merge
  incorporation);
- `decisions` for conflicts;
- `commands` with their causal invocation coordinate;
- the import work unit's external snapshot tuple.

What the commit graph now owns, so it is deleted as a stored fact:
- event parents and event-application membership;
- application basis and result root;
- context heads and refs;
- prior-state links;
- ancestry and merge bases (`dolt_merge_base`);
- the incorporation of rows merged without conflict (§5.5).

What becomes local (F4, never versioned, never merged, empty in a fork):
- `gad_effect_intents` (the host-effect outbox);
- `publication_intents` and `publication_delivery_outbox`;
- `gad_materialized_repository_states` (receipts of host observations);
- `vcs_context_projection_policies`;
- the derived `commit_index(stable_id → commit)` accelerator;
- the FTS search indexes;
- the grants a cell has issued and the remotes it holds (`_cf_*`, the runtime
  keeps them out of every commit).

`commands` stays versioned:
- It is the causal root fact ("command K caused work unit W").
- It is written in the application commit, so a retried command finds its
  row on the context branch and returns the same result. That is GAD's
  idempotency rule, and it needs no `pending` or `complete` status column.
- A command whose host effect is still pending is marked by its outbox row,
  which is local.
- Because command ids come from the causal coordinate, two participants never
  mint the same one.

### 5.5 Merge policy: adopt what does not conflict, resolve what means something

Integration happens **on the participant's side**, never on the canonical
database. There are three moves, all built from F1 and F7.

**1. Bring upstream into a context (`pull`).** A participant fetches the
canonical `main` (`origin/main`) and merges it into a context branch:

```ts
await dolt.pull("origin", "main", {
  message, author, date,
  resolve(merge) { /* §5.5.2 */ },
});
```

**2. Integrate another context or another participant's published work.**
`vcs.merge(source, { upTo?, resolutions })` is one F1 merge on the context
branch. The source is a branch in the same cell, or a branch another
participant published to the canonical database and this cell has fetched
(`origin/ctx/<id>`).

**3. Publish (`push`).** The committed event of a context is pushed to the
canonical `main` as a fast-forward (§5.6). If `main` moved, the push fails
with `ERR_DOLT_NON_FAST_FORWARD`, and the participant repeats move 1 and
pushes again. Conflicts therefore always surface where the participant's
resolver and rationale live, and the canonical database only compares a
hash and moves a ref.

#### 5.5.1 Q1: what the merge adopts

Rows that changed on only one side merge natively, including different
columns of one row (ours moved a file while theirs edited it). That is GAD's
net-effect aspect algebra (`netEffectMerge.ts` `MergeAspect`) done by the
engine. **A source change that does not conflict is adopted by the merge
itself**, and its provenance is the merge commit's second parent. No
per-change "adopted" decision is recorded for it. Decisions remain only where
meaning had to be chosen. This is a visible change to `vcs.merge`, the
`merge_subagent` tool and the skills documentation. The user confirmed it
(Q1: yes).

**Compare** stays read-only and is derived from Dolt:

1. `base = dolt_merge_base(target, source)`.
2. The source's effective changes: the `changes` rows introduced between
   `base` and `source` (`dolt_diff_changes`), minus those counteracted.
3. Classification, as GAD does today with Dolt computing the row predicates
   that `semanticWorkspace.ts` computes by hand (`mergeComparison`,
   `coordinateEndpoint*`, `maximalMergeBases`):
   - **shared**: its row exists at the target;
   - **accounted**: a `decisions` row names it;
   - **clean**: every state row it touched changed on the source side only;
   - **conflicting**: a row it touched changed on both sides to different
     values, or the merge would violate the path-uniqueness constraint;
   - **blocked**: a clean change whose prerequisite is an earlier
     conflicting change, in source order.

#### 5.5.2 Semantic resolution (F1)

The resolver runs inside the merge's transaction, from resolutions prepared
before the call:
- **adopted (text)**: GAD's three-way text merge produced new content (bytes
  already admitted to the CAS through the existing `prepareContent` effect).
  The resolver writes the `files` row and `incorporates` content edges with
  exact mappings, because Dolt cannot see text coordinates, then
  `row.resolve()`.
- **reconciled**: the target row stays (`row.keepOurs()`), and the resolver
  writes a `decisions` row with evidence and rationale.
- **declined**: the target row stays, and the resolver writes a `decisions`
  row with the rationale.
- **Constraint violations** (a path collision): resolved by moving or
  declining one placement, with a `decisions` row, then `violation.resolve()`.
- **An unresolved conflict throws, and the merge rolls back.** The caller gets
  typed conflicts. No session, no marker files, nothing persisted.
- **The resolver verifies** that the conflict set equals the prepared set. If
  the target moved between preparation and the merge (another participant
  pushed, or the context took a write), the merge throws and the caller
  recompares. This is the same CAS rule GAD uses today, now local to the cell.
- **The merge commit is the integration event.** The resolver adds its
  `events` row, even when Dolt found no conflict (it is called once with empty
  lists), so "every effective source change is accounted for" holds by
  construction: each one is either merged or decided. A fast-forward makes no
  merge commit and records no event, which is right: the context only caught
  up with events `main` already has.

**Incremental adoption** ("adopt one group, test, adopt the next") is a merge
of a *prefix* of the source, with `upTo` set to one of the source's
application commits. Each prefix merge is an ordinary integration step on the
context, and the final merge of the source event completes it. Change
identities are preserved because the rows themselves arrive. No cherry-pick
is involved: it would copy `applied_changes` ids onto a new basis, which
GAD's identity rule forbids (and `dolt_cherry_pick` is not exposed, §3.2).

#### 5.5.3 Concurrency policy

- **Within a cell**, contexts are branches written one at a time by the cell's
  turn.
- **Between cells**, writers never share a branch: each branch is written by
  exactly one cell (§5.8). The only contended object is canonical `main`, and
  the contention is a hash comparison. A loser repeats `pull` then `push`.
- **Retry bound.** The loop is bounded (N attempts), not timed. When it
  exhausts, the command fails with a typed error and the participant decides.
  Livelock needs participants publishing faster than the others can merge,
  which is a product signal, not a retry-with-backoff problem.
- **A decision stays a decision.** A `decisions` row written by one
  participant's resolver is a versioned row. Another participant merging it
  receives it, so the same conflict is not decided twice (the second merge sees
  the row and classifies the change as accounted).
- **Divergent resolutions.** Two participants resolve the same conflict
  differently and both push: the second push fails (not a fast-forward), its
  pull sees a `decisions` conflict, and the resolver must choose (keep the
  pushed decision, or record a superseding one). The rule in the resolver is
  "keep theirs for `decisions` rows unless the new one names the old one".

### 5.6 Grants, authority and the protected main

A cell lets others in only through a grant it issues itself (F7). GAD uses
them as follows. The tokens are bearer capabilities, handed over by an
authenticated Vibestudio RPC, never stored by the issuer (only the SHA-256 is
kept) and never written to a commit.

| Holder | Grant | Lifetime |
|---|---|---|
| A work cell (agent, user, subagent) | `fetch: true`, `branches: ["main", "ctx/*", "pub/*"]`, `push: ["pub/<participant>/*"]`. May fetch the canonical and publish its own branches under its own namespace | The participant's life. `expiresAt` set to a renewal horizon, `peer` set when the carrier is P2P |
| Publish to protected `main` | An **additional** short-lived grant with `push: ["main"]`, minted **after approval** and bound to one participant | Minutes, or one use (revoked after the push) |
| A reader (a panel, a CLI, another workspace's read) | `fetch: true`, `branches: ["main"]` | As needed |

- **Approval is grant issuance.** Today's "approval at the host, then a
  compare-and-swap of the protected ref" becomes "approval at the host, then a
  push grant for `main`, then a fast-forward push". The approval receipt
  already names the exact previous and proposed event ids; the grant carries
  the same label. This keeps `PublicationGate` where it is: the gate decides,
  and Dolt performs the compare-and-swap.
- **What the canonical enforces is exactly the fast-forward rule.** It does
  not run GAD code on a push. The invariants of provenance-plan §9 (parent
  reachability, validated integration events, every effective change
  accounted for) are established by the pushing cell's own code before it
  pushes, which is the same code every cell runs. The canonical's own guard
  is *after* the fact: when it learns `main` moved (the follow-up RPC or the
  next activation), it validates the pushed range (`dolt_log`,
  `dolt_diff_events`) and, on a violation, raises an operator-visible fault
  rather than rewinding `main` (a fast-forward-only store has no rewind for
  pushers). In a single trust domain this is enough. Across users and
  workspaces it is not: **Chronolog membership and signing authorize the push
  (§8), and a validator checks it.**
- **Branch namespaces keep participants apart.** A participant may push only
  under `pub/<its id>/`, so two participants never write one canonical branch
  and nothing but `main` is ever contended.
- **A revoked or expired grant** answers `ERR_DOLT_REMOTE_FORBIDDEN`. A forked
  cell holds none (F7 clears them), so authority cannot leak by forking.

### 5.7 A participant's cell: create, run, retire

**Create** (idempotent by target id, crash-resumable):
1. The requester computes `workId = gadwork:<participantId>` and calls
   `env.GAD_ROOT.fork(canonicalRoot, { name: workId, facets: { gad: { at:
   hashOf("main") } }, replaceUnfinished: true })`. A repeat finds the id
   claimed, so one cell results. An interrupted fork is taken over or deleted
   (`replaceUnfinished`, `deleteUnfinished`).
2. The canonical issues the participant's grant (§5.6) and returns the token
   through the authenticated RPC that asked for the cell.
3. On first activation the work cell runs `remote.add("origin", { id,
   token })` (with a relay `transport` if the canonical is a facet, §3.2),
   fetches `origin/main`, and branches `ctx/<id>` from `main`.
4. Local tables start empty (F4). The effect outbox and the receipts are
   rebuilt as the participant works.

**Run.** All writes are the cell's own turns. Periodically, or when the
participant asks, it publishes: it pushes its committed context tips to
`pub/<participant>/<ctx>` (this is how another participant sees its work), and
it pulls `main` into its contexts.

**Retire** (when a subagent ends, a conversation is archived, or a user
removes a device):
1. **Settle.** If the participant integrated, its work is already on `main`.
   Otherwise the committed events of its contexts that are not on `main` are
   pushed to `retired/<participant>/<ctx>`. This keeps what today's GAD keeps
   (every immutable event retains its content) and is the only retention
   path. **Uncommitted applications are dropped**, exactly as `discard` drops
   them today. A retention horizon for `retired/*` is a later product
   decision (R6: history is retention).
2. **Revoke** the grants (`remote.revoke`, which also removes the
   `pushed-<id>/…` bookkeeping refs).
3. **Delete** the work cell (the cutover's `__vibestudio_destroy` retirement).
   A crash between steps repeats them: each is idempotent by id.

**Long-lived cells** (a user's device) are never retired by the protocol;
they only pull, publish and resolve.

### 5.8 What happens to the single-writer GAD laws

The provenance plan's §8 makes the semantic workspace DO the single owner,
and its other laws assume one writer. On Dolt with work cells each law is
kept where it still has a meaning, and replaced where the single writer
disappears.

| Single-writer law (provenance plan) | Under decentralized GAD |
|---|---|
| One DO owns contexts, events, applications, decisions, lineage | **Each cell owns the branches it writes.** A branch has exactly one writer, so the invariant "one writer per branch" holds everywhere. The *database* has many cells, and the canonical owns only `main` |
| CAS on the working head, in one turn | **Kept, local.** `hashOf("ctx/<id>") === expected` inside the owning cell's turn. Cross-cell publication is a fast-forward-only push, which is a CAS on `main` performed by Dolt |
| Protected push is an approval-gated CAS of the protected ref set | **Kept.** Approval mints a short-lived `push: ["main"]` grant; the push is the CAS (fast-forward only). `PublicationGate` still decides; it no longer writes the ref |
| Push validates every traversed integration event and reachability | **Kept, at the pusher**, with an after-the-fact check on the canonical (§5.6). Reachability is a fast-forward by construction: the pushed tip contains `main` |
| Command journal and idempotency | **Kept.** A `commands` row is versioned with its application commit. Ids come from the causal coordinate, so two cells never mint one. A retry goes to the cell that owns the context |
| No persistent plan token, staging set or merge session | **Kept.** F1 resolves inside the merge's own transaction. A merge never spans turns. A failed push leaves a normal pull to run again |
| Effect outbox, no DO transaction across external I/O | **Kept, local per cell.** The outbox is a local table. Materialization of `main` is the canonical's effect; materialization of a context is its cell's |
| Neither side holds a global concurrency gate across external I/O | **Kept and strengthened.** No object holds anything for another |
| `UNIQUE(repository_id, path)` and stable file identity | **Kept as constraints, enforced at merge** (L10): a violation reaches the resolver |
| Execution and integration are independent axes (invariant 10) | **Kept.** A subagent's execution is its own cell; its code returns through §5.5 |
| Agentic log owns events, GAD indexes them | Unchanged (§6.1) |

What is *new* as a risk: the canonical's invariants hold because every cell
runs the same GAD code, so the canonical trusts its participants within one
workspace. That is the same trust the single DO had in its callers. Across
workspaces it does not hold, which is why §8 puts a validator in front.

### 5.9 Content lineage and blame

- `preserves` edges, written for ordinary edits, and `copies` edges stay.
  They are text-coordinate facts Dolt does not have.
- `incorporates` edges stay only for semantic text merges.
- **For a row merged without conflict**, the file row at the merge commit
  equals the source's row. Blame follows the parent whose row matches, as
  `git blame` does. It continues into the source's `applied_changes` and
  `content_edges`, which arrived with the merge. The `incorporates` edge was a
  stored copy of that fact and is deleted.
- **The blame walk** is unchanged in shape: from an exact state, file and
  range, to applied change, work unit, command and invocation. Its "state"
  reads use `dolt_at_*`. Because commits move between cells with their rows
  (F7 packs carry whole history), a participant can blame work another
  participant authored once it has fetched the commit.

### 5.10 The file-level VCS is not SQL data (decision)

- **Bytes stay in the workspace CAS.** Dolt rows hold `content_hash` plus the
  intrinsic coordinates. Reasons:
  - builds and materialization already read the CAS;
  - the CAS is shared across workspaces and builds;
  - text merging needs GAD's coordinate model, not row diffs;
  - large files would push a GAD chunk file toward the capture and GC limits
    (C5) and make every work-cell fork larger;
  - GC already reasons about CAS roots.
- **GC roots** are every `content_hash` reachable from any retained commit
  *in any cell that can still publish*. A local `content_roots` table holds
  them, maintained incrementally from `dolt_diff_files` at each commit and
  rebuildable from `dolt_history_files`. The canonical's roots cover `main`
  and the published and retired branches; a work cell's unpublished content is
  protected by its own roots (a content blob admitted by an active cell is
  retained until the cell is retired or its roots are released).
- **Git import and export** (`localGitMirrors.ts`, `gitInterop`) are
  unchanged. An import is still one work unit with its external snapshot
  tuple, performed by a participant and published like any work.

### 5.11 Host effects, materialization and the trajectory mirror

- **Host effects.** The outbox pattern is unchanged. A cell writes facts and
  an effect intent (local) in one transaction and commits, and the host
  executes and acknowledges.
  - `WorkspaceVcs` (2,455 lines) keeps its role: dispatch, effect drain,
    materialization and builds. Its inputs become commit hashes, and it
    addresses a work cell by `gadwork:<participantId>`.
  - `protectedRefStore.ts` (721 lines) becomes a candidate for deletion: the
    protected pointer is the canonical's `main` branch, and approval stays at
    ingress. Verify in P5 that no host consumer needs a pointer outside GAD.
- **The agentic log in GAD.**
  - `log_heads` and `log_events` with hash chains, `forkLog` and
    `forkTrajectoryBranch` go. The agent survey found no production caller of
    the fork paths.
  - The channel mirror becomes a derived projection, keyed by (channel,
    channel commit hash). It replaces the hash-for-hash verification, because
    a channel commit hash already commits the whole channel state (§6.2).
  - The `trajectory_*` projections stay as GAD's join index for provenance
    walks. They are a derived, local cache, rebuilt from channels, in the
    canonical database.
  - The `builds` log becomes a versioned table of the canonical database.

### 5.12 What GAD deletes, and what it adds

Line counts are from `wc -l` on Base `92001a1`. Partial removals are
*estimates*.

| Removed | Lines |
|---|---|
| `persistentRadix.ts` | 817 |
| `workspaceFactMap.ts` | 489 |
| `workspaceFactChangeSet.ts` (manifest member algebra) | 354 |
| `netEffectMerge.ts` aspect algebra (the three-way text merge stays) | ~200 of 311 |
| `semanticWorkspaceFacts.ts` (fact-root composition) | ~1,100 of 1,284 |
| `semanticWorkspace.ts`: event ancestor graph, maximal merge bases, merge comparison and structural constraints, decision attribution, commit and discard chain handling, working-mutation persistence | ~4,500 of 14,477 (*estimate*: spans 3021–3776, 9717–11860, 8513–9201, 4167–4433) |
| `semanticVcsStore.ts` (state and frontier persistence) | ~1,000 of 2,062 |
| `semanticVcsSchema.ts` (15 of 33 tables) | ~350 of 720 |
| `GadWorkspaceDO.ts`: log chain, `forkLog`, refs and `ref_log`, projection copy by head | ~1,500 of 7,203 |
| Tests that exercise removed mechanics | not counted |
| **Total, production code** | **~10,000** (*estimate*) |

Added (*estimate*, ~1,500 lines): the work-cell lifecycle (create, grant,
retire), the sync layer (`pull`/`publish` with the retry bound and the
divergent-decision rule), the canonical's after-the-fact guard, and the
relay method that serves the canonical facet's remote requests.

### 5.13 Gates for P5 specific to decentralization

- Two work cells, one conflicting and one clean change each, publish
  concurrently: both land, the loser's resolver runs once, `main` is a
  fast-forward chain, the commit graph has no lost write.
- A push after approval succeeds; a push without a grant, with an expired
  one, or from a fork that was not given one fails with
  `ERR_DOLT_REMOTE_FORBIDDEN`.
- Create a work cell twice with the same id (and once with the first call
  killed mid-fork): one cell results.
- Retire a work cell: its committed events are on `retired/…`, its grants are
  gone, the object is deleted.
- The canonical learns that `main` moved after a push (follow-up RPC, and again
  with the RPC dropped: reconciliation from `hashOf("main")`).
- The size gate of §5.1 is measured and recorded.

---


## 6. The agent system on Dolt

### 6.1 Ownership after the redesign

The agent survey found three stores:
- the agent DO's Pi store;
- the channel DO's hash-chained ledger;
- GAD's mirror of the channel log.

The hibernation plan's invariant 4 says "GAD owns event facts". The code
says the channel ledger is canonical and GAD mirrors it. The redesign
resolves this in favor of the code, with no copy:

- **The channel cell owns its event facts.** That is the ledger table,
  versioned.
- **The agent cell owns its knowledge.** That is Pi's conversations, entries
  and documents, versioned.
- **GAD holds a derived trajectory index** (§5.7). Invariant 4 becomes "the
  channel owns event facts, and GAD indexes them".

### 6.2 The channel cell

- **The ledger.** `channel_ledger_events` and `chunks` become a plain
  append-only versioned table. The channel is a `"commit"` class. Each
  ledger append transaction, together with the projections updated in it,
  ends in one Dolt commit. Its trailer carries the head sequence.
- **The hash chain goes.** That is `channel-ledger.ts` `head_hash` and
  `prev_hash`, and the preimage code in `agentic-protocol` (`hash.ts`,
  `prepare-log-event.ts`, 311 lines). The commit hash commits the whole
  channel state, which is stronger than a chain over events.
  - Envelope ids and deterministic delivery ids stay. They are identities,
    not integrity.
- **Versioned tables.** The ledger, `participants`, `channel_members`,
  `channel_relationships`, the receipts `delivered`, `read` and `declined`
  (facts about the conversation), and the fork projections that describe
  this channel's own children.
- **Local tables.**
  - The delivery mailbox and its leases (`channel_delivery_mailbox`,
    `channel_delivery_*` projection cursors).
  - `channel_observation_claim`, the maintenance queue, `pending_calls`,
    `provider_call_claims`, `presence_last_seen`, and metrics.
  - The mailbox is a fold over the ledger (invariant 4), so a fork rebuilds
    it from versioned state. The hibernation path already does that rebuild.

### 6.3 The agent cell

- **Pi's store runs unchanged on a Dolt facet.** It is SQL.
- **The agent is a `"keep"` class.** Entries and documents are written
  during a turn. The commit happens when the turn closes, with the channel
  anchors `{channelId, throughSequence, eventDigest}` in the commit's rows.
  Those anchors are the same values `NativeChannelKnowledge` carries today.
- **What is local:**
  - the admission and outbox documents (`channel-input-admission`,
    `channel-publication`, `authority-admission`, `eval-admission`,
    `automation-run` and the like);
  - `subscription_intents` and `do_identity`;
  - `agent_hot_path_trace`.
  - Pi stores every kind of document in one `documents` table, so this
    split needs a Pi storage change: local document kinds go to Pi tables
    under the F4 local pattern. Pi already declares `fork: "initial" |
    "asOf" | "current"` per document kind, and that declaration becomes the
    table choice.

### 6.4 Forks

A conversation fork at channel sequence N:

1. **The parent channel owns the operation.** It keeps its `fork_ops`
   journal, which is local.
2. It computes a deterministic target id, `fork:<forkId>`. It calls
   `env.NS.fork(channelRoot, { facets: { do: { at: <channel commit whose
   head sequence is N> } } })`. A repeated call finds the id already
   claimed, so the step is idempotent (F3, C6).
3. **For each agent subscribed at N**, it forks the agent root at that
   agent's last commit whose anchor for this channel is ≤ N. That is the
   last closed turn: the granularity the "trajectory re-root" rule already
   requires.
4. **On first activation of each fork**, the local tables are empty (F4),
   the mailbox is rebuilt from the ledger, and the agent re-subscribes.
5. The fork seeds the replacement message (edit-and-fork) and appends
   `channel.forked` to the parent, as today.

What this deletes:
- `postClone` truncation;
- `ChannelLedger.forkFrom`;
- `resetForFork`;
- the host's physical snapshot of the channel DO;
- `exportChannelKnowledge` and `importChannelKnowledge`, with the
  `native-import` bootstrap path (`native-channel-knowledge.ts` 642 and 80,
  plus most of `native-channel-bootstrap.ts` 668);
- the `storage: "fresh"` special case for native-owner DOs in
  `runtimeService.ts`;
- the `cloneDO` path.

`fork_ops` shrinks to the phases fork channel, fork agents, seed and
announce. Each phase is idempotent by target id.

### 6.5 Subagents

The model is unchanged: one invocation plus one task channel.
- The child's file context is a GAD branch (§5.2).
- A `mode: "fork"` child is a fork of the parent agent cell at its current
  commit (§6.4) instead of a knowledge export.
- Results come back as messages on the task channel. Code comes back through
  `vcs.merge` (§5.4). There is no DO-level merge of agent cells: agent
  knowledge is not merged, which is GAD's "execution and integration are
  independent axes" (invariant 10).

### 6.6 Hibernation-first semantics under Dolt

- **Invariants 1 to 3 and 5 to 12 are unchanged.**
- **Delivery.** It is still at-least-once with an exactly-once outcome:
  deterministic delivery ids, plus admission receipts in local tables that
  commit atomically with the effect they admit.
- **Rewind.** A deliberate reset of an agent (a "rewind to turn T" product
  action) rewinds knowledge but not receipts, so a redelivered input stays
  deduplicated. This is the correct behavior for an explicit user action.
- **Residency.** Facet sockets do not hibernate and keep the root resident
  (V12). A channel with connected clients therefore stays resident. That is
  acceptable, because presence already implies a live process. A
  hibernation-first agent holds no sockets, so it can still be evicted
  between turns.

### 6.7 What the agent system deletes

| Removed | Lines |
|---|---|
| Channel hash chain and fork boundary (`channel-ledger.ts`, mostly) | ~180 of 229 |
| Log hash preimage (`hash.ts`, `prepare-log-event.ts`) | ~300 |
| Fork saga clone, postClone and rollback (`channel-do.ts` 6504–7660, partly) | ~500 |
| `delivery-projection.ts` fork reset paths | ~150 (*estimate*) |
| Knowledge export and import (`native-channel-knowledge.ts` ×2, `native-channel-bootstrap.ts` import path) | ~1,100 |
| Channel-to-GAD hash-for-hash mirror verification (`channel-observation.ts`, `channel-do.ts` 2041–2350, partly) | ~250 |
| Host clone path for channels and agents (`cloneDO` 5109–5183, `durableObjectStorageClone.ts`) | ~310 |
| **Total** | **~2,800** (*estimate*) |

---

## 7. Eval kernels

### 7.1 Where a kernel lives

A kernel is a Dolt facet of its owner's root cell:

```ts
// inside the owner's UniversalDO root, on the owner's request:
const kernel = ctx.facets.get(`eval:${scopeKey}`, () => ({
  class: loader.get(kernelSource).getDurableObjectClass("EvalKernel"),
  celld: { storage: "dolt", doltLocal: ["local_%", "vsl_%", "state"] },
}));
```

- **The kernel class** is ordinary template code. `EvalDO`'s engine is
  already workspace-owned (`providers.evalEngine`, `packages/eval`), so the
  class moves next to it.
- **It is loaded with `celld: { codegen: true, residency: true }`**, granted
  because the owner's manifest declares the `runtime.code-execution`
  capability. That is an ordinary manifest capability with an approval, not
  a builtin flag. The UniversalDO root holds `codegen` and `residency`, so
  it can grant them (codegen.md: "A loader cannot grant more than it
  holds"). The root never runs guest code itself.
- **A facet cannot be reached from outside its root.** Ownership is
  therefore structural: no other owner can name the kernel, and no host
  check is involved. The owner's own code is a loaded worker (the `do` facet)
  that can reach nothing but what the root binds into it: measured on the
  fork (`ownerKernelPathCelld.test.ts`), a Worker Loader's `env` supports
  **only service bindings** (a namespace or the loader itself is refused with
  `DataCloneError: Worker Loader env supports only Service Binding
  capabilities`), so the owner can neither load a kernel nor grant itself
  `codegen`. The root exports a `KernelGateway` entrypoint and binds one per
  owner with `ctx.exports.KernelGateway({ props: { name } })`; its `fetch`
  forwards to the root named in its props, which the owner cannot change.
  Another owner's root is unaddressable from the first.
- **Callers without a cell** (a user's shell, the CLI) get kernels in that
  principal's session cell. That cell is an ordinary UniversalDO root keyed
  by the principal.

### 7.2 Calls

- **The owner calls its kernel directly**, through the root: owner code ->
  its `KernelGateway` binding -> the root's `/kernel/<method>` handler ->
  the kernel facet (verified end to end on the real fork, one extra hop):
  `start`, `get`, `receipt`, `events`, `cancel`, `reset`,
  `readScopeTextPage` and `deleteScopeValue`.
- **Receipts are pulled.** The owner and the kernel share a cell and fail
  together, so after a restart the owner reads the kernel's `runs` row by
  `runId`.
- **This deletes the push and redelivery machinery:**
  `eval_result_redeliveries`, its 5 s to 5 min backoff, the redelivery
  alarm, and `acknowledgeRunResult`.

### 7.3 Kernel state on Dolt

- **Versioned:** `runs`, `run_events`, `run_checkpoints`, `run_progress`,
  `run_result_artifacts`, `repl_scopes`, the user's `db` tables, and
  `eval_execution_roots`.
- **Commits.** The kernel is a transactional class (§4.2), committing once per
  finished run (`eval: <runId> <status>`). That gives "scope and db as of
  run R" for free, and `reset` becomes `reset({ hard: true, to: <schema
  commit> })`.
- **Local:** in-flight cancellation bookkeeping, and the resident channel
  memberships.
- **Forks.** A forked agent forks its kernels' durable state with it (F3).
  Heap state is never forked: it is not durable.

### 7.4 Heap residency

- **The heap is held explicitly.** A kernel takes `ctx.residency.hold()` for
  its heap and releases it at `dispose`, at `reset`, or when its owner
  releases it. celld never ends a hold by timer.
- **Revocation.** On drain, swap or operator revocation, `onrevoked`
  persists the scope snapshot (the existing `scopeManager` persistence).
  The next run reports `[kernel] Restarted` with the exact restored and lost
  keys, which is today's restart contract.
  - **The handler is registered by the owner's root, not by the kernel.** The
    kernel is a loaded-worker facet in its own isolate, and the fork does not
    run an `onrevoked` registered there (`residency.md`, "Facets"). The probe
    confirms it on `fcc7268` (`doltEvalKernelCelld.test.ts`): a drain ran the
    root's handler, which called the kernel facet to persist and commit
    (`root onrevoked: drain`), and did not run the kernel's own. The hold
    itself may be taken by the kernel's `ctx.residency.hold()` (it pins the
    root) or by the root; only the handler placement matters.
- **When the node's budget refuses a hold** (`ERR_RESIDENCY_BUDGET`), the
  run proceeds without one. The heap may be lost at eviction, and the
  restart contract reports it. This refusal is explicit, never a silent
  break.
- **Consequence.** A held kernel keeps its owner's root resident, because
  facets are part of the root (C7). A notebook heap is owner state, so this
  is honest.
- **There is no idle policy (Q3, decided).** A heap is held until an explicit
  end: `dispose`, `reset`, the owner releasing the kernel (the conversation
  is archived, or a user action), a drain, or an operator revocation. The
  node's residency budget bounds the total, and refuses a hold explicitly. The
  `[kernel] Restarted` report covers every loss. The 30-minute idle TTL
  that `EvalDO` has today is deleted, not ported.

### 7.5 Trust model

- **Codegen confinement is now enforced by the runtime, per isolate.** Only
  the kernel's loaded-worker isolate can compile. The agent, the
  UniversalDO root's facets from other sources, and every other isolate
  refuse `eval`, `new Function` and WebAssembly compile. The audit verified
  this (codegen probes).
- **SES `lockdown()` stays in the kernel isolate.** Kernels of different
  owners share one loaded-worker isolate (one per kernel class version), so
  frozen intrinsics still prevent cross-owner prototype pollution. The
  guest facade (`evalConfinement.ts`, 387 lines) stays, so guest code
  cannot reach the kernel's journal. `UNSAFE_EVAL.newFunction` becomes
  `new Function(...)` inside the confined realm (audit V7).
- **Authority.**
  - The kernel calls host services as its root's entity, carrying the run's
    execution session as today.
  - Egress from guest code goes through the egress hook. The loaded
    worker's identity names the kernel class and root, and the proxy
    attributes it to the owner. This depends on A1, which is fixed.
  - The owner-scoped gateway token minted by `evalService` goes.
  - The host never needs to authorize "may this caller reach that kernel",
    because only the owner can reach it.

### 7.6 What eval deletes

| Removed | Lines |
|---|---|
| `src/server/services/evalService.ts` (owner resolution, `ensureEvalDO`, token minting, liveness supervision with its 5 s probe, kernel lease touch) | 1,262 |
| `evalKernelLease.ts`, `evalKernelAuthority.ts`, `evalAuthorityEventJournal.ts`, `evalExecutionRootsService.ts`, `evalEventIngressService.ts` | 163 + 38 + 82 + 95 + 182 |
| `EvalDO.ts`: kernel lease (1096–1215, 3125–3176), host-only RPC wiring, redelivery (1552–1672), host-settlement paths (`appendAuthorityEvent`, `failPendingRun`), identity pinning, internal-DO packaging | ~1,300 of 4,632. The remaining ~3,300 (run, cancel, return budget, scopes, natlang, panels) move into the template kernel class |
| `packages/service-schemas/src/evalEngine.ts` (18 host-only method schemas), and the `evalEventIngress` and `evalExecutionRoots` schemas | ~420 |
| Authority ledger rows: 18 `direct:…EvalDO…` rows, 10 `host:eval.*` rows, 2 kernel callback rows, and the `runtime.code-execution.manage` review entries | generated |
| `UNSAFE_EVAL`: the `workerd.unsafeEval` catalog flag and the binding in `workerdManager.ts` | ~20 |
| Tests of removed paths (`evalService.test.ts` 2,133, `evalKernelLease.test.ts` 321, ingress and roots tests 376, plus part of `EvalDO.redelivery.test.ts` 295) | ~3,100 |
| **Total, production code** | **~3,600**, with ~3,300 moved |

The 20 host-only methods are the 18 `EvalDO` schema methods plus 2 kernel
callbacks.
- **Deleted outright:** `acquireKernelLease`, `attachKernelLeaseHolder`,
  `holdKernelLease`, `appendAuthorityEvent`, `failPendingRun`,
  `acknowledgeRunResult`, `retainExecutionRoot`,
  `listRetainedExecutionRoots`, and the callbacks
  `evalEventIngress.publish` and `evalExecutionRoots.retain`.
- **Kept as the kernel's ordinary facet methods**, callable only by the
  owner: `run`, `startRun`, `executeRun`, `getRun`, `getRunReceipt`,
  `getRunEvents`, `readScopeTextPage`, `deleteScopeValue`, `reset` and
  `cancel`.

### 7.6a What changed in the table above (as of P2a)

- The three lease methods, `evalKernelLease.ts` and its test, the lease touch,
  the shutdown stage and the `idleExpiresAt` field are **deleted** (P2a,
  `7611524ef`), together with 126 lines of authority ledger.
- `UNSAFE_EVAL` was **already gone**: the cutover replaced the binding with
  `new Function` under the class's `codegen` declaration (§1),
  and `rg UNSAFE_EVAL src packages` is empty. Only the plans in `docs/`
  mention it.
- Everything else in the table is P2b.

### 7.7 What the structural move needs (P2b): found by starting it

Reading `evalService.ts` (1,262 lines), `EvalDO.ts` (4,600) and their
consumers shows that the "owner calls its kernel directly" cut is not a
move of one class. The host `eval` service is the **admission layer** for
every execution, and §7.6 counted its lines but not these duties, each of
which needs a new home or an explicit decision to drop:

| Duty today (in `evalService` unless noted) | Needed in P2b |
|---|---|
| Owner resolution for four caller kinds: an agent (the host-verified entity binding is the owner), a shell or server naming an `owner-session`, a panel, and a worker or DO. A client-supplied owner is never honoured for an agent | **D1** The principal of a kernel call. §7.5 says "the root's entity", which is right for a DO owner. A panel, the CLI and the system-test runner have no root: §7.1's "session cell" needs an entity registration, a context binding and a lifecycle (`ensureEvalDO` does that now with `store.activate` / `advanceExecution`: lineage `parentId`, `ownerUserId`, `agentBinding`, `stateArgs`, finite or persistent lifecycle) |
| Authority admission per run: the run's `authority` intent, `normalizeAuthorityManifest`, `preauthorize` of exact operations, `executionSessions` and `taskAuthorities` registration, the causal parent an agent-bound run must carry | **D2** Where the per-run admission lives once the host does not see the call. The capability `runtime.code-execution` gives the kernel the codegen grant (a *workspace* decision); it does not replace the per-run allowlist and approvals that `eval-exact-authority`, `eval-pregranted-only` and `eval-preauthorization` test. `runtime.code-execution.manage` is a host-only builtin capability today; no Base manifest declares a `runtime.code-execution` capability yet |
| Exact source resolution (`resolveContextSource`), the panel parent (`resolveParentPanel`, panel-slot bindings), the gateway token minted per owner | Stay host services the kernel calls; the token goes (the kernel authenticates as its root) |
| Result delivery: `resultReceiver`, `onEvalComplete`, `onEvalProgress`, event-sink routes, `acknowledge` | **D3** Pull instead of push (§7.2) changes the Base agent loop: 51 files in Base reference the eval client, among them `agentic-do` (`native-eval-tool.ts`, `native-agent-owner.ts`, `agent-vessel.ts`, `rpc-contract.ts`) and `harness/src/tools/eval.ts`; the CLI (`evalCommand.ts`), panels and the system-test runner call `eval.start` through the host |
| Host-process safety: `recoverUnresponsiveSandbox` (a sandbox that starves the CPU makes the host replace the node), the liveness probe, `activity` leases for idle exit, shutdown cancellation | **D4** Each needs an owner in a world with no host service. The node's own watchdog may replace some; this has not been checked |
| `EvalDO` is a **product builtin** with `hostOnly` method authority, an internal-DO identity (`internalDOExecutionIdentity`) and an `INTERNAL_DO_ENV` provider binding for the eval engine and runtime units | **D5** The kernel class in Base (a template worker) needs the same admitted identity, the engine and runtime provider bindings, and a way to be declared Dolt and `codegen` per class by a manifest (§7.1). `celldMigration` imports legacy product objects into SQLite cells, which a Dolt kernel cannot open ("the storage engine is fixed when it is created") |

Mechanics verified on the real fork, for P2b to build on:
- a facet loaded with `celld: { codegen, residency }` and `storage: "dolt"`
  compiles, commits per run, survives a kill, holds the root resident without
  a timer, and is released by the root; its own `onrevoked` does not run, the
  root's does (`doltEvalKernelCelld.test.ts`);
- an owner's loaded worker reaches only a service binding the root gives it
  (`KernelGateway`); it cannot load a kernel or name another root
  (`ownerKernelPathCelld.test.ts`);
- a userland object in the product's UniversalDO cannot compile code
  (`universalDoHost.test.ts`, "confines code generation"). The cross-owner
  probe of §10 P2 is the second half of the gateway test.

Recommended answers (a proposal for the user to confirm, not a decision):
- **D1.** A DO owner: its own root's entity. A panel, the CLI or the
  system-test runner: a session cell, a UniversalDO keyed `session:<principal>`
  and registered through the existing `runtime.createEntity` path (what
  `ensureEvalDO` does by hand today), so no new identity mechanism exists.
- **D2.** `evalService` shrinks to an **admission function** instead of being
  deleted: authority intent, `preauthorize`, execution-session and task
  authority registration, returning the session nonce that the kernel call
  carries (about a quarter of the file). Owner resolution, `ensureEvalDO`,
  token minting, liveness supervision, dispatch and the lease are what goes.
  A kernel cannot mint its own execution session, so "no host check" holds for
  *reachability* (§7.1), not for *authority*.
- **D3.** Pull for the agent loop, with `events` as the progress channel; the
  push callbacks and `eval_result_redeliveries` go with it (§7.2).
- **D4.** Keep `recoverUnresponsiveSandbox` as a node-level watchdog call the
  gateway makes; drop the per-run liveness supervisor only after a celld
  per-isolate watchdog is shown to cover a CPU-starved loaded worker.
- **D5.** Do not migrate legacy `EvalDO` objects into the Dolt kernel: scope
  state is soft (the restart report states what is lost), and run receipts of
  a previous generation are not needed after acknowledgement. This is a
  product decision (it drops unacknowledged receipts of migrated workspaces).

Suggested order for P2b, each a complete cut that keeps the system working:
1. D1 and D2 first, as a design decision (they decide whether `evalService`
   shrinks to an admission function, as recommended, or is replaced by a
   manifest-level capability), because every later step depends on them.
2. The kernel class as a Base worker and its manifest declaration (D5), served
   by the existing UniversalDO as an ordinary userland class on its `do` facet
   with the `codegen` and `residency` grants (the `celld` options flow through
   `loadExecutable`), replacing the product `EvalDO`. This removes the
   host-only schemas and the product catalog entry.
3. The owner path (D3), one caller kind at a time, with `evalService` deleted
   when the last caller kind has moved.

---

## 8. Chronolog integration

### 8.1 Where Chronolog fits

Inside one workspace, the trust model is one trusted team on one node
(multi-user plan), and Dolt cells give history, branches and merges. A
permissioned, validator-admitted, peer-to-peer log adds nothing there.

Chronolog is the substrate for data shared **between** workspaces: different
machines, often different operators, and possibly offline. Examples:
- a team dataset;
- a shared task board across two companies' workspaces;
- cross-organization approvals;
- agent memory shared by several users' workspaces.

Approvals and provenance *inside* a workspace stay where they are. An
approval that must be visible to another workspace is a Chronolog
transaction in a group they share.

### 8.2 Placement

- **One Chronolog node per workspace node.** It is a celld deployment
  inside the same node (fork design §6, decision 1):
  - the materializer is a Dolt cell, running `dolt.execute`;
  - the feed store and node state are SQLite cells;
  - the transport is the `p2p` binding with ALPN `chronolog/1`, which can
    share the workspace server's Iroh key (p2p.md).
- **The node's signing keys** come from a host secret binding.

### 8.3 The workspace capability

A host service `chronolog` is declared in manifests like any capability:

```ts
chronolog.groups.list() / create({ name, policy }) / invite({ group, member, role }) / join(invite)
chronolog.transact({ group, program, as })        // signed, submitted; returns txId
chronolog.outcome({ txId })                       // accepted | rejected(code, statementIndex) | pending
chronolog.query({ group, sql, bindings, revision? })
chronolog.subscribe({ group, sql, bindings })     // live query results
```

- **Authority** is per group: `chronolog.read:<group>` and
  `chronolog.write:<group>`, approval-gated like any external effect.
- **Panels and userland** reach groups through the same capability. No
  userland class gets the materializer's cell.

### 8.4 Membership and identity

- **Users.** Each Vibestudio user (WP0 identity) has one Chronolog principal
  key (Ed25519). Its custody is the hub's credential store, and it is
  released to a workspace node only for that user's sessions.
- **Two separate membership systems:**
  - workspace membership is the hub's `membership` table, and it decides
    who may enter;
  - group membership is Chronolog capability revisions on key ids, and it
    decides who may read, write, validate or administer.
- **Joining.** Adding a workspace member to a group is an administrator
  revision that grants that member's key. Inviting an outsider sends an
  invite carrying the group genesis and this node's Iroh id. The outsider's
  own workspace node joins with that user's key.
- **Validators.** A node holding the validator role validates with a
  node-held validator key. The group's policy decides which nodes those
  are.
- **Agents.** An agent writes through its initiating user's key, after the
  user's approval in Vibestudio's existing approval queue. Chronolog's
  owner rows then name the user, and Vibestudio's GAD records the agent
  that caused it. **Decided (Q4): agents sign with their user's key after
  approval.** Delegated per-agent keys stay a later option.
- **Authorising pushes into a shared GAD `main`.** Inside one workspace a push
  to the canonical `main` is authorised by a short-lived grant minted after
  approval (§5.6). When a GAD database is shared by users or workspaces, the
  authority is Chronolog: membership of the group names who may push, and a
  push (or the group's validator, which checks the pushed range) is signed by
  the user's key. The Dolt push is the transport; Chronolog is the authority.
  Not built; it depends on the cross-workspace P2P carrier (§3.2) and P6.

### 8.5 What is not done

- GAD events are not published into Chronolog automatically.
- No intra-workspace store moves to Chronolog.
- No second replication path for workspace state is added. A workspace's
  durability is its cells' replication; Chronolog's is its feeds.

---

## 9. Data migration and ordering with the cutover

### 9.1 Ordering

1. **The runtime cutover** (`feat/celld-runtime`, another agent) moves every
   class to celld with **SQLite** cells and facets, and migrates workerd
   files once (audit V6). This redesign adds no work to it, apart from the
   schema-guard filter (§4.3), which both need. That filter lands in P0 and
   the cutover picks it up.
2. **Then each Dolt-bound class flips once, in its own phase:**
   - eval in P2;
   - `WorkspaceDO` in P3;
   - channel, agent and Missions in P4;
   - GAD in P5.

   A flip means the manifest declares the class's facet storage as `dolt`,
   and the class ships a one-time importer. No class runs on both engines
   in one build.
3. **When P0 lands before the cutover**, the Dolt primitives are dormant on
   SQLite (`doltStorageOf` returns `null`). Nothing branches on the engine
   except the commit points themselves, which no-op without `dolt`.

### 9.2 The importer

- **Facet classes.** The UniversalDO root sees a legacy SQLite facet (`do`)
  and no Dolt facet. It starts the new class in a Dolt facet and streams the
  legacy rows through a generic paged reader, the class's
  `importLegacyStore(reader)`.
  - The default copies its own tables row for row, commits
    `import: <class> from sqlite`, and then the root deletes the legacy
    facet.
  - A crash before that commit leaves the legacy facet intact, and the
    import restarts.
- **Internal root classes** (`WorkspaceDO`). The engine is fixed per class,
  so the Dolt class is a new class name (`new_dolt_classes`). Its first
  activation imports from the old object through an export RPC on the old
  class. That RPC ships for exactly one release.
- **GAD replays its history.** It walks events and applications in
  topological order, writes each application's fact-root state into
  `files` and `repositories` with its semantic rows, and commits. Each
  legacy event becomes an `events` row, each integration event a merge
  commit with the same parents. The legacy ids are kept as the stable
  `event_id` and `work_unit_id` values, so external references (approvals,
  publication receipts, trajectory links) still resolve through
  `commit_index`. This is lossless. **Decided (Q2): replay**, rather than
  "import heads, archive the legacy store read-only". The replay is one
  writer on the canonical database (a one-time import job, so decentralization
  does not apply to it), resumable because each commit is its checkpoint. Work
  cells are forked from the canonical only after the replay finishes.
- **Channels.** Import the ledger as one commit at the current head.
  History before the import is not forkable at a past sequence. A fork
  before the import point forks at the import commit and truncates
  (documented, one-release behavior). Replay per append is possible but not
  worth its cost.
- **Agents.** Import Pi's store as one commit. Turn-granular forks begin at
  the import.
- **Kernels.** Not imported. Kernel scope survives today only as best-effort
  restart state, so the first run on the new kernel reports a kernel
  restart. *(If kernel `db` tables are considered user data, the default row
  copy applies.)*

Importers are deleted once the minimum supported version passes the flip.
That is the release policy in `durable-object-schema-migrations.md`.

---

## 10. Phases, gates and sizes

Sizes are in agent-days for one focused agent. *Estimates.* P1 (the fork side)
is **done**: F1 to F7 ship in `fcc7268`, and `9440c29` (pinned) fixes the hard reset and adds `ondoltpush` (§3). What remains is Vibestudio's.

| Phase | Content | Depends on | Gate (executable) | Size |
|---|---|---|---|---|
| **P0 Foundations** (`feat/dolt-p0`) | `@vibestudio/durable/dolt` typed surface of the whole `ctx.storage.dolt` API (merge with resolver, `doltLocal`, remotes); `committedTransaction` on F2 (no roll-forward); schema install commits on Dolt (checkpoint before an upgrade, `schema:` commits); schema-guard filter (`_cf_`, `_litestream`, `dolt_`, `doltlite_`); framework tables local on Dolt; a `FakeDoltStorage` test double with its divergences documented | none (the fork is delivered) | `vitest packages/durable`: commit points, `committedTransaction` atomicity (a throw leaves no rows and no commit), checkpoint before upgrade, failed upgrade commits nothing, filter, merge with resolver, local tables, remotes between fakes. Then a real-celld probe (`doltDurableCelld.test.ts`): a Dolt root class installs its schema, commits through `committedTransaction`, and survives a process kill and restart with `dolt.log()` correct | 3 |
| **P1 Runtime** (fork side) | Dolt facets; F1 merge resolver; F2 commit in a transaction; F3 forks carrying facets; F4 local tables; F5 checkout cost; F6 history reads; F7 remotes | fork | **Done** (`fcc7268`; `9440c29` adds the durable hard reset and `ondoltpush`). Open for P5: a Vibestudio-side test of the facet relay and `ondoltpush`, and the checkout budget below | done |
| **P2 Eval kernels** | **P2a (done):** `ctx.residency.hold()` for the heap until an explicit end (Q3, no idle timer), revocation through `onrevoked`, the host lease and its three methods deleted. **P2b (open, §7.7):** the kernel class in Base as a Dolt facet of the owner's root with the `codegen` and `residency` grants; the owner calls it through its `KernelGateway`; delete `EvalDO`, `evalService` and the `evalEngine` host schemas | cutover, P0 | `pnpm test` for eval packages; system tests `eval-*` (heap retained across turns, cancel, restart report, large return) compared with the cutover numbers; a confinement probe (a userland object's `eval` throws, the kernel's works); a cross-owner probe (owner A cannot address B's kernel); `rg 'EvalDO\|evalService' src packages` is empty (`UNSAFE_EVAL` already is) | 8 (P2a about 1) |
| **P3 Durable services** | `WorkspaceDO` on Dolt; panel undo by reverse patch; backup, restore, reset and clone via Dolt; delete the maintenance journal, `cloneDO`, `durableObjectStorageClone.ts` and `computeWorkerdObjectIdHash`, and the lifecycle tables and driver if the cutover kept them | P2 (facet machinery proven) | `WorkspaceDO.test.ts` against `FakeDoltStorage`; system tests for panel close and reopen, `workers.resetStorage`, and a restore round trip; a fork-idempotency test (the same target id twice gives one object); `rg cloneDO\|do_maintenance` is empty | 6 |
| **P4 Agent system** | Channel and agent cells on Dolt with local tables; Pi local document tables; native conversation fork; delete the hash chain, knowledge export and import, and the clone paths | P0 | Fork-and-subagents acceptance (§E3): edit-and-fork, a multi-agent fork, a subagent `mode: "fork"`, crash-resume of a fork op (kill between phases); hibernation tests (evict between turns, redelivery deduplicated); a fork at sequence N equals the parent's state at N (ledger, participants, agent anchors) | 12 |
| **P5 GAD, decentralized** | Canonical Dolt database and participant work cells (§5.1); the state model, contexts as branches; integration by F1 merge, `pull` and `push` (§5.5); grants and approval as grant issuance (§5.6); work-cell create, retire (§5.7); a derived `commit_index`, `content_roots`; replay migration (Q2); delete the fact-map, radix and frontier machinery | P0, P4 (agent forks), the two *to verify* items | The provenance plan's acceptance matrix (§14), re-expressed over commit hashes and passing in full; the decentralization gates of §5.13; replay equivalence: for each real workspace snapshot available, every legacy event's materialized tree hash equals the replayed commit's, and blame answers match on a sampled set; the **size gate** (a replayed workspace database and the fork latency at that size, recorded); checkout and merge benchmarks: checkout **p95 within 20 ms with `fsync` and 10k local rows** (the fork measured 14 to 16 ms), a context switch batched per participant turn | 20 |
| **P6 Chronolog capability** | Chronolog node deployed per workspace node; the `chronolog` host service; key custody; invite and join; agent writes through approval; Chronolog authority for pushes into a shared GAD `main` (§8.4); the cross-workspace P2P carrier for Dolt remotes | Chronolog fork phase 4, P0, the P2P cross-workspace run | Two workspace instances on two nodes: create a group, invite, write from both sides, see an owner-row rejection, run a replay flip (Chronolog's demo as a system test); a GAD push between workspaces authorised by group membership | 8 |

**Critical path:** P0 → P2 → P4 → P5. Two pieces can run in parallel: P3
after P2, and P6 after P0 plus the cross-workspace carrier.

---

## 11. Risks

- **R1. Commit volume, chunk growth and checkout latency.**
  - Each channel append, GAD mutation and closed turn is a commit. GC rewrites
    the whole file (C5).
  - A context switch is a checkout, **7 to 15 ms with `fsync`**, not 2 ms.
    GAD batches a participant's writes per context.
  - *Mitigation*: measure in P4 and P5. The benchmark covers 10k commits per
    cell: latency, bytes per commit, GC time, and checkout p95.
  - Bytes are kept out of Dolt (§5.10).
- **R2. Facet and remote paths not yet exercised by Vibestudio.** Dolt facets
  and F7 are delivered, but Vibestudio runs neither. *Mitigation*: P0's probe
  covers a Dolt root; P2 is the smallest facet consumer; the facet relay and
  the post-push notification (§3.2) are verified before P5.
- **R3. Semantic change in GAD integration (Q1, accepted).** Agents and
  skills learn that clean changes merge without per-change decisions.
  *Mitigation*: the P5 gate includes the skills documentation cutover
  (provenance plan §12).
- **R4. A held kernel pins its owner.** Memory per open notebook rises with
  the number of owners holding heaps, and with Q3 (no idle release) it
  rises until an explicit end. *Mitigation*: the node budget refuses
  explicitly (§7.4), and every end condition (dispose, reset, archive,
  revocation) releases.
- **R5. GAD replay cost.** Large workspaces may take minutes to replay.
  *Mitigation*: replay runs as a resumable import (commits are its
  checkpoints). Q2 chose replay.
- **R6. History is retention (L7).** A user who wants content gone must
  rewrite history. CAS bytes can be swept only after no retained commit
  references them. F7 has no force push, so a purge cannot be pushed:
  every cell holding the history must rewrite it. *Mitigation*: secrets
  never enter Dolt. A purge operation is designed in P5 and is not built
  before it is needed. `dolt_rebase` is not exposed (§3.2).
- **R7. A write outside `committedTransaction`.** F2 removed the crash window,
  but a class that writes versioned state with plain SQL leaves a dirty
  working set that the next commit sweeps in. *Mitigation*:
  `assertCleanWorkingSet()` in tests and in the dev host (§4.2).
- **R8. Engine maturity.** DoltLite 0.51 has no published test suite
  (fork design §7). *Mitigation*: the fork's harness, plus Vibestudio's
  probes. Determinism is not relied on outside Chronolog.
- **R9. Decentralized-merge hazards.**
  - *Fork cost.* A work cell is a whole-file copy. Mitigation: the size gate
    (§5.1); the sharding fallback.
  - *Publication contention.* Many participants pushing to `main`. Mitigation:
    only a hash comparison contends, a bounded `pull`+`push` retry, and
    per-participant `pub/` namespaces for everything else (§5.5.3).
  - *Divergent decisions.* The rule in §5.5.3.
  - *No push hook.* The canonical may learn late that `main` moved.
    Mitigation: a follow-up RPC and reconciliation from `hashOf("main")`
    (§3.2).
  - *Trust.* The canonical enforces only the fast-forward rule; the other
    invariants hold because every cell runs the same code. This is enough in
    one trust domain and not across workspaces (§8.4).
- **R10. A fork forgets its authority.** A forked work cell has no remotes
  and no grants (F7). That is the right default, and it makes cell creation a
  protocol (§5.7) that must be idempotent and crash-resumable.

---

## 12. Decisions recorded (formerly open questions)

The user answered Q1 to Q5 on 2026-11-13. The record:

- **Q1. GAD integration semantics: adopt by merge.** Non-conflicting source
  changes are adopted by the Dolt merge itself. Their provenance is the
  merge's second parent, and decisions are recorded only for conflicts (§5.5.1).
- **Q2. GAD history at migration: replay.** The full history is replayed into
  Dolt commits on the canonical database (lossless, slower first activation),
  not "import heads, keep the legacy store as an archive" (§9.2).
- **Q3. Eval heap retention: hold until an explicit end.** `ctx.residency.hold()`
  until dispose, reset, the owner's release, a drain or a revocation, bounded
  by the node budget's explicit refusal. There is no idle timer, and the
  30-minute TTL of today's kernel is deleted (§7.4).
- **Q4. Chronolog agent identity: the user's key.** Agents sign with their
  user's key after approval (§8.4). Delegated per-agent keys remain a later
  option.
- **Q5. SQLite for secret-bearing stores: confirmed.** `BrowserVaultDO` and
  `WebhookStoreDO` stay SQLite, because history retains deleted secrets (L7).
- **GAD is decentralized (2026-11-13, restated 2026-11-14).** §5. One Dolt
  database if its size allows; participants work on their own forks and
  branches and merge back with F7 and F1.

Still open for the user:
- the retention horizon of `retired/*` branches in the canonical GAD database
  (§5.7), which trades provenance for size;
- whether a user's own devices are separate participants (the proposal) or one
  cell.
