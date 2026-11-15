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

Facts come from source reads unless they are marked _estimate_, _spike_ or
_to verify_. A claim read only from the fork's documentation and not yet run
against the binary is marked _to verify_.

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
- dynamic code as a general system: one hosting helper any entity uses (code
  loaded as a Dolt facet with codegen and residency grants), one per-run
  admission step, pull delivery, and eval as an ordinary kernel class, which
  deletes `EvalDO`, `evalService`, the lease and `UNSAFE_EVAL` (§7);
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

- Deletion line counts marked _estimate_ still need span-level checks.
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
  (`ownerKernelPathCelld.test.ts`, `universalDoHost.test.ts`): §7.2.

- **P3 Durable services** (§4.6): the workspace state is a Dolt cell
  (`WorkspaceStateDO`) with the retired SQLite `WorkspaceDO` kept one release
  as the read-only source of a replaying, verified, resumable import; the
  maintenance journal and `cloneDO` are deleted (`DurableObjectStorage`,
  `forkObjectStorage`). What P3 did not do, and why, is §4.6 too.

**P2b, the general dynamic-code system (§7), is designed (2026-11-14
decisions) and partly built:** the per-call nonce cost is fixed (§4.2), the
admission function exists (§7.3, §7.12 step 2), the D4 question is answered
on the real fork (§7.8), and **the hosting helper is built (§7.2 "As built",
§7.12 step 3)** on both durable bases, with Dolt support and the nonce gate in
Base's `durable-base.ts`. **Not done:** session entities, the kernel class in
Base, pull delivery and the deletion of `evalService` and the `evalEngine` host
schemas (§7.12 steps 4 to 6). `UNSAFE_EVAL` is already gone
(the cutover replaced it with `new Function` under the class's `codegen`
declaration), so only its documentation remains.

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
   - _versioned_: history and knowledge, which fork, merge and reset carry;
   - _local_: identity-bound operational state (outboxes, mailboxes,
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

| ID     | Constraint                                                                                                                              | State on `9440c29`                                                                                                                                                                                                                                                                                                                                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** | Dolt operations throw inside `transaction()` and `transactionSync()`.                                                                   | Still true for every operation _except_ the commit of F2: `{ commit }` is an option of the outermost transaction. It throws on a nested transaction (a savepoint) and on a SQLite cell.                                                                                                                                                                                          |
| **C2** | A plain `merge(name)` that conflicts rolls back.                                                                                        | Resolved by F1: pass `resolve`. A merge Dolt finishes by itself still calls it once, with empty lists, so the application can add its own rows. A fast-forward or an up-to-date merge makes no commit and does not call it (`fastForward: false` forces a merge commit). Schema conflicts cannot be resolved by a row resolver. At most 100 000 conflicting rows and violations. |
| **C3** | Writes go to the checked-out branch, and checkout moves the runtime tables.                                                             | Cost is flat in local-state size (F5). It is still a device write: **7 to 15 ms with `fsync`**, about 0.7 ms with the flush off. A transaction made with `{ commit }` leaves nothing for checkout to record, which is the faster path.                                                                                                                                           |
| **C4** | `_cf_*` tables are unversioned and classes cannot declare their own.                                                                    | Resolved by F4: `doltLocal` patterns. Limits in §3.                                                                                                                                                                                                                                                                                                                              |
| **C5** | A chunk file was capped at 1 GiB.                                                                                                       | Lifted. A capture after `gc()` and a restore read the whole file into memory, and DoltLite's GC buffer limits live data to about 2 GiB. `gc()` rewrites the whole file.                                                                                                                                                                                                          |
| **C6** | A fork copies the whole file and shares no storage.                                                                                     | Still true (copy-on-write is planned). A fork drops identity: the alarm, the id name, **and the remotes, grants and remote-tracking branches** (§3.2).                                                                                                                                                                                                                           |
| **C7** | Facets nest four deep, cannot set an alarm, keep the root resident when they hold sockets, and never commit atomically with their root. | Unchanged. A facet runs in its root's isolate, so facets of one root share one thread. Parallelism means separate objects (§5.1).                                                                                                                                                                                                                                                |
| **C8** | Dolt facets did not exist.                                                                                                              | Resolved: `ctx.facets.get(name, () => ({ class, celld: { storage: "dolt", doltLocal } }))`. The engine is fixed at creation, and a start that omits `celld.storage` on a Dolt facet is refused, so every start passes it.                                                                                                                                                        |

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

| Class                                                                                           | Engine          | Why                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GAD (`GadWorkspaceDO`, userland facet): the canonical database and each participant's work cell | Dolt            | Its whole job is versioned state with branches and merges, and its work is decentralized over forks (§5)                                                       |
| Channel (`PubSubChannel`, facet)                                                                | Dolt            | A versioned ledger with native fork at a sequence                                                                                                              |
| Agent (`AiChatWorker` family, facet)                                                            | Dolt            | Fork at a turn, rewind, inspection as of a turn                                                                                                                |
| Eval kernel (new kernel facet, replacing `EvalDO`)                                              | Dolt            | Per-run commits, reset as `reset`, forks with its owner                                                                                                        |
| `WorkspaceDO` (internal root)                                                                   | Dolt            | The panel and entity tree gains undo natively (`slot_history`, `panel_close_cleanup` go). Its scheduler and lifecycle tables disappear with the cutover (§4.5) |
| `MissionsDO` (facet)                                                                            | Dolt            | Ordinary product state. Versioning comes free, and keeping one engine for all userland state is simpler than two                                               |
| Other userland facets (panels, apps)                                                            | Dolt by default | One facet engine for userland. A manifest can opt out to `sqlite` for secret-bearing state                                                                     |
| `BrowserVaultDO`, `WebhookStoreDO`                                                              | SQLite          | They hold secrets (L7)                                                                                                                                         |
| celld-internal broker cells (D1, KV, queues)                                                    | unchanged       | Runtime-owned                                                                                                                                                  |

---

## 3. Fork features F1 to F7: delivered, with what they do not do

Each one wrapped an engine feature DoltLite already had, and each removed a
wall that would otherwise have forced a workaround in Vibestudio. All are in
`unified-fork` (fork design §3b.12 for F1 to F6, §3b.13 for F7); the build
Vibestudio pins is `9440c29`, which also fixes the hard-reset durability gap
(below) and adds `ondoltpush`.

### 3.1 What was delivered

| ID     | Feature as shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | How Vibestudio uses it                                                                                                                                                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** | `dolt.merge(name, { message, author?, date?, resolve, fastForward? })`. `resolve(merge)` runs once, synchronously, inside the merge's transaction. `merge.conflicts` holds each conflicting row (`table`, `key`, `base`, `ours`, `theirs`, `ourChange`, `theirChange`) and `merge.violations` each constraint violation. Each must be answered with `resolve()`, `keepOurs()` or `takeTheirs()`. celld then makes one 2-parent commit. A throw, a promise, or an unanswered row rolls everything back. Result: `{ hash, conflicts: [], fastForward, upToDate, resolved }`.                                                                                                                                                                                                                                                                                     | GAD's semantic resolution (§5.5) and every `pull` that needs it. The resolver writes rows with `ctx.storage.sql`, reads the other side with `dolt_at_<t>(ref)`, and adds its own rows (the `events` row, `decisions`). |
| **F2** | `transactionSync(fn, { commit })` and `transaction(fn, { commit })`. One root record carries the writes and the commit. A function `commit` receives the callback's result and may return `null` to leave the writes uncommitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `committedTransaction` (§4.2), schema install commits (§4.3), every commit point of §0. **It removes the crash window (C1), so the first draft's roll-forward is deleted from the design.**                            |
| **F3** | `env.NS.fork(sourceId, { at?, facets: { [name]: { at?, facets? } } })` copies the object with every facet, each Dolt component at its own commit. `ctx.facets.fork` copies one facet. Dolt facets exist.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Forked conversations (§6.4), eval kernel forks (§7.3), and **GAD work cells** (§5.7). Idempotent by target id (`to`, `name`), with `replaceUnfinished` and `deleteUnfinished` for an interrupted fork.                 |
| **F4** | `doltLocal` patterns: for a class in `celld.durable_objects.<C>.doltLocal`, for a facet in its startup options `celld: { storage, doltLocal }`. Local tables are never staged, shown or hashed, survive `reset` and `merge`, move with `checkout` without copying rows, and start empty in a fork.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | L3 (§2.1). Outboxes, receipts, mailboxes, caches.                                                                                                                                                                      |
| **F5** | Checkout does not copy rows (`dolt_checkout --carry-ignored`), so its cost does not depend on local-state size: 0.7 ms (flush off), **7.5 ms with nothing written and 13.8 ms after a local write** (`synchronous=NORMAL`, this NVMe), at 0, 1 000 and 10 000 local rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | GAD's write to context B after one to context A (§5.3).                                                                                                                                                                |
| **F6** | `dolt_at_<t>`, `dolt_history_<t>`, `dolt_diff_<t>`, `dolt_blame_<t>`, `dolt_diff_summary`, `dolt_log`, `dolt_commit_ancestors`, `dolt_branches`, `dolt_status`, `dolt_merge_base`, `dolt_hashof*`, and in a resolver `dolt_conflicts_<t>` and `dolt_constraint_violations_<t>` are readable from application SQL. `dolt.query` reads them under the local-read profile.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Cross-branch reads without a checkout (compare, blame, eval scope history).                                                                                                                                            |
| **F7** | Remotes between cells. The source issues a **grant** (`remote.grant({ label, fetch, branches, push, expiresAt?, peer? })`, a bearer token shown once, only its SHA-256 kept). The holder does `remote.add(name, { id, token })`, then `await fetch`, `pull` (fetch plus merge, with `resolve`) and `push`. A push is "ask the target to fetch": the target installs the pack as `pushed-<grant id>/<branch>` and moves the branch itself, in its own turn, **only as a fast-forward** (`ERR_DOLT_NON_FAST_FORWARD` otherwise, `ERR_DOLT_TARGET_DIRTY` if the checked-out branch has uncommitted changes). The wire is three requests (`refs`, `fetch`, `push`) over any `async (bytes) => bytes` carrier. The built-in carrier is an internal request to the source's object, so a source on another node of the fleet is reached over the inter-node channel. | Decentralized GAD (§5): participants fetch, merge and push.                                                                                                                                                            |

### 3.2 What they do not do (gaps found by reading, with where it bites)

- **A push that moved a branch is announced to the target** (`9440c29`,
  `ondoltpush({ remote, grant, branch, from, to, created })`, in the target's
  turn and before the pusher is answered; a handler that throws changes
  nothing). The class needs the method; a holder gets no event. This replaces
  the earlier "no hook" gap: the canonical GAD database reacts to `main`
  moving without a follow-up RPC from the pusher. Pinned by the fork's
  `examples/dolt-remotes`; _a Vibestudio-side test is P5's_.
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
- **What a commit costs, measured (P3 follow-up; fork `9440c29`, this NVMe,
  `crates/celld/dolt_cell.rs` `commit_cost_by_shape` and the plain test beside
  it on the branch `fix/dolt-commit-cost` of the fork, flushes counted with
  `strace -f`).** A commit made in the transaction is **not** a second durable
  step: a write is one root record and one `fsync` with or without it. It adds
  about 1.3 ms of CPU and 340 bytes.

  | one operation                                             | p50 ms | root records | `fsync`s |
  | --------------------------------------------------------- | -----: | -----------: | -------: |
  | autocommit write, no commit                               |    6.5 |            1 |        1 |
  | `BEGIN; write; txCommit; COMMIT` (`committedTransaction`) |    7.8 |            1 |        1 |
  | the same plus a local-table write                         |    7.8 |            1 |        1 |
  | write, then a separate commit                             |   13.5 |            2 |        2 |
  | a write to a local table only                             |    6.3 |            1 |        1 |

  What is expensive is that **every transaction on a Dolt cell is a root
  record and so a device flush** (a SQLite cell at `NORMAL` has none), and in the
  product one durable step is about three flushes (the cell file, the replication
  segment and the node index's WAL). That includes a transaction that writes only
  a `doltLocal` table. Every direct RPC to a Dolt object consumes a replay nonce
  (`vsl_direct_rpc_nonces`, a local table, `DurableDirectRpcNonceLedger.consume`),
  so **every call to `WorkspaceStateDO`, a read as much as a write, is at least one
  root record**: 228 calls in a 15 s window of a navigation were 233 flushes of
  the cell file, 208 of the segments and 342 of the index. Per call latency from
  the dispatcher (`VIBESTUDIO_DO_CALL_TRACE`), the same eval on `d1bfdec3f`
  (SQLite `WorkspaceDO`) and on P3, mean ms over four runs:

  | call                                                        | before P3 |       P3 |
  | ----------------------------------------------------------- | --------: | -------: |
  | `panelTreeDetail` (read, 58 per navigation)                 |        35 |       64 |
  | `entityResolve`, `contextEdgeListByChild` (reads)           |        35 |   72, 58 |
  | `alarmClear`, `alarmNextWakeAt` (about 35 each, background) |        41 |       67 |
  | `slotCreate`, `slotCommitPreparedNavigation` (commits)      |        35 |  94, 127 |
  | `entityActivate`, `entityRetire` (commits)                  |    30, 29 | 116, 159 |

  Two consequences for this section's rule. (1) Making bookkeeping mutations
  `doltLocal`, or folding them into the next meaningful commit, **does not buy
  flushes**: a local-only write costs the same root record as a versioned one,
  and the commit it would drop is the 1.3 ms. So "every mutation of versioned
  state is one `committedTransaction`" is **not narrowed**: nothing was measured
  that it would save. The bookkeeping that would be the candidates, were the CPU
  worth it, are `entityReserve`, `entityPrepareExecution`,
  `entityAdvanceExecution` and the resource bindings (no user-meaningful history).
  (2) The lever is the
  number of transactions per call, and the biggest single contributor is the
  nonce row.

  **The nonce, fixed (P2b step 0; `DirectCallNonceGate`,
  `packages/shared/src/directRpcEnforcement.ts`).** On a Dolt object:
  - _Every_ call is admitted from a bounded in-memory set plus a **floor**: an
    attestation issued at or before the object's activation (or before the
    `issuedAt` of an entry the full set evicted) is refused as
    `ERR_ATTESTATION_STALE`. So nothing an earlier activation could have
    accepted is accepted again, and a full set never forgets an unexpired nonce:
    it raises the floor. The attestation is host-minted and carries `issuedAt`,
    `expiresAt` (60 s) and a UUID nonce (`attestDirectRpc`), so this is sound.
  - A stale refusal runs nothing, so the **host re-stamps it** (same nonce,
    fresh `issuedAt`, same lifetime; only the host can) and sends it once more,
    in the two transports every host-mediated call uses
    (`workerdRpcRelay.postToDurableObject` and `streamFromDurableObject`,
    `DODispatch.dispatchImpl`). It happens once per activation, on the first
    call.
  - A **mutating** call (a declared sensitivity other than `read`) also checks
    the durable ledger (a read) and records its nonce in **its own first
    transaction** (`committedTransaction`, or the base's `transactionSync` for
    local state), so the durable nonce shares the call's root record. A call
    whose storage did not change (`total_changes()` unchanged) records nothing;
    a call that changed storage outside a base transaction records it when it
    ends (one extra record, as before). The durable record is defence in depth
    against a clock that steps backwards across a restart, where the floor alone
    would admit an old request. Events and alarms keep the immediate durable
    consume; a SQLite object is unchanged.
  - Residual: a clock step back across a restart, a write outside a base
    transaction, a crash before the call ends, and a captured request replayed
    within its 60 s all at once.

  Measured on the model-free navigation (`VIBESTUDIO_DO_CALL_TRACE=all`, five
  runs after a warm-up, same build otherwise): mean ms per call
  `panelTreeDetail` 44 to 8, `entityResolve` 48 to 6, `contextEdgeListByChild` 42
  to 6, `alarmNextWakeAt` 47 to 8, `alarmClear` 48 to 14; per run `openPanel`
  2.1 s to 0.9 s, `navigate` 2.0 s to 0.85 s, the two reads 1.1 s to 0.6 s. The
  P3 numbers above were 35 to 64 for the same read, so the call is now cheaper
  than on the SQLite `WorkspaceDO`.

### 4.3 Schema migrations as commits

`installDurableObjectSchema` keeps its contract (one transaction, trusted
fingerprints, a contiguous upgrade path, fail closed). On a Dolt store it
adds three things:

1. **Before an upgrade path runs**, a dirty working set (state a `keep` class
   had not yet committed) is committed as `schema: checkpoint before
C vN→vM`. This is a plain `dolt.commit`, taken _before_ the transaction,
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
fact. The commits record _when_ each migration happened, not a second copy
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

_Built in P3 as §4.6 records: the userland objects these operations act on are
SQLite facets of a UniversalDO cell, so the backup stays a fork and not a
branch; the journal is gone. The Dolt column below is what a Dolt object can
additionally do for itself._

| Operation                | Today (`workerdManager.ts`, `durableObjectStorageClone.ts`)                                                                                                                 | On Dolt                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backup                   | Quiesce (facet abort, or a whole-process stop for internal DOs), integrity-check, then copy raw files into `do-backups/<op>` with a manifest and verify. Retain 5 and sweep | `branch.create("backup/<op>")`, in the object's own turn. O(1)                                                                                                                          |
| Restore                  | Journaled replace of files, then reactivate                                                                                                                                 | `reset({ hard: true, to: "backup/<op>" })`, in the object's own turn. Local tables survive, so in-flight obligations are not lost (L3)                                                  |
| Reset (disposable state) | Back up, then delete files                                                                                                                                                  | Back up as a branch, then `reset --hard` to the latest `schema:` commit, giving the fresh schema with no rows                                                                           |
| Clone (`cloneDO`)        | Reservation, seal and drain relays, quiesce or cooperatively pause, `node:sqlite` backup per file, staged and digest-verified publish, receipt table                        | `env.NS.fork(source, { at, facets })` (F3). The new id is claimed with a conditional create, so the operation is idempotent by target id. The entity reservation in `WorkspaceDO` stays |
| Retention                | `sweepDurableObjectBackups`                                                                                                                                                 | `branch.delete`, then `gc()`                                                                                                                                                            |

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

### 4.6 P3 as built

**`WorkspaceStateDO`.** A cell's engine is fixed when its class creates it, so
the Dolt store is a new class and the SQLite `WorkspaceDO` stays one release,
read-only, as the import's source (`packages/builtin/src/workspace-state/`).
The deployment lists `WorkspaceDO` in `new_sqlite_classes` and
`WorkspaceStateDO` in `new_dolt_classes` with its `doltLocal` patterns
(`runtime.storage`, `runtime.doltLocal` of the builtin catalog).

- **Versioned:** `entities`, `runtime_resource_bindings`, `slots`,
  `slot_history`, `context_edges`, `workspace_meta` (the template-seeding
  marker). Every mutation is one `committedTransaction` through the class's
  `commit` helper; `dolt_status` is read inside the transaction, so an
  idempotent retry, a failed call and a call that changed only local tables make
  no commit. A nested mutation (`initializePanels`) joins its outer commit.
  Verified on the real engine: `dolt_status` is readable inside a transaction.
- **Local** (`panel_close_cleanup`, `local_%`, `lifecycle_*`, `do_alarms`,
  `do_alarm_test_policies`, `durable_work_owners`, plus the framework's `vsl_%`
  and `state`): never in a commit, not rewound by a reset. The panel-tree
  revision is local (`local_workspace_meta`) and replaces the change triggers: a
  reader sees the stored counter, plus one while a mutation has uncommitted
  versioned changes, and `commit` bumps the counter inside the same transaction,
  so a result built inside a mutation carries the revision the tree has once it
  lands, and a reset never moves it back.
- **Deviation from §4.5, panel undo.** Closing stays a row state
  (`slots.closed_at`), and `slot_history` and `panel_close_cleanup` stay. The
  closed-panel list, its keyset paging, its closed counts and the permanent
  purge are queries over rows (L2); a list derived from commits would need
  history-table reads (`dolt_history_*`, which the double does not model) and
  could not purge. Navigation history is application data with a cursor, not
  version history. What Dolt adds: the close, the reopen and the purge are each
  one commit, the reverse patch of a close commit is exactly the SQL that reopens
  it (`dolt.diff({ from: close, to: parent })` touches only `slots`), and a hard
  reset to the commit before a close is the undo of everything since, with the
  schedule and outbox untouched (tests: `WorkspaceStateDO.dolt.test.ts`, and on
  the real fork `workspaceStateCelld.test.ts`). `panel_close_cleanup` is an
  outbox, so it became local.
- **Deviation from §4.5, lifecycle, alarms, durable work.** They stay, as local
  tables of the new class, and their drivers stay. The cutover did not delete
  them and they are not dead: `DurableObjectBase.setAlarmAt` still calls
  `workspace-state.alarmSet`, Pi owners hold a lease published by
  `publishDurableWorkOwner`, and `MissionsDO` and the Base `durable-base.ts`
  register lifecycle releases. Deleting `lifecycleDriver`, `alarmDriver` and
  `durableWorkDriver` means moving every class's alarms to native alarms and
  replacing the planned-restart prepare protocol, which is the agent system's
  hibernation-first semantics (§6.6, P4). Their tables are local so a reset
  never rewinds a scheduler's claims (the invariant the wake-publication header
  states).

**The import** (`legacyImport.ts`, `legacyImportDriver.ts`,
`src/server/workspaceStateMigration.ts`), Q2 (replay where history exists):

1. The first call to `WorkspaceStateDO` (every dispatch awaits it; the
   migration's own calls bypass the barrier) asks the new store for its status.
   `verified`, `skipped` or `adopted` (a cell that already holds workspace rows,
   say a restored object) is settled and the retired store is never read.
2. Otherwise `WorkspaceDO.legacyManifest` states, per table, the row count and
   an order-independent SHA-256. No tables means a fresh workspace: `skipped`.
3. `legacyImportBegin` records the manifest and the base commit, and the host
   pages the 14 tables (`legacyReadRows`, rowid keyset) into the local staging
   table `local_legacy_rows`, idempotent by legacy rowid.
4. `planReplay` orders the rows by their own timestamps (`created_at`,
   `recorded_at`, `closed_at`, `retired_at`): an entity arrives, a slot arrives
   on its first history entry, each later entry is a navigation commit that moves
   the pointer (the last one to its final pointer), every slot one close took
   down closes together at the shared stamp, a retired entity retires at
   `retired_at`. A row never arrives before what it references (the real engine
   enforces foreign keys), and the plan is a pure function of the rows. It is
   stored (`local_legacy_events`) and applied one commit per event with the
   event's time as the commit date; the applied counter is written in the same
   transaction, so a crash resumes at the next event, never repeating one.
5. `legacyImportFinish` copies the operational tables (alarms, leases, outbox,
   `state`, the revision) as they are, then proves every legacy table equal to
   what the cell holds by digest (`state` as a subset), and only then writes the
   marker commit and `verified`. If the retired store changed since staging began
   the driver refuses to finish and the next start begins again from the base
   commit (`reset --hard`).

The retired cell is never written (apart from creating the framework's `state`
table in a fresh empty cell) and never deleted: it stays the fallback until a
later release deletes the class. A failed import fails the start (no call to the
store gets through) and resumes on the next one.

**Storage operations** (`src/server/durableObjectStorage.ts`). The journal and
its step machine (`do_maintenance`) are deleted; the node's object fork and
restore do the copying and a restore the node accepted completes by itself. The
host keeps three tables: the storage identity a host authority is bound to
(rotated before any replacement, so a crash leaves an identity newer than the
data, never authority outliving it); the backup registry (a backup is listed
only once its fork finished, an unfinished one is swept at the next operation or
start); and an outbox of retired objects whose storage is not yet deleted (an
earlier build's open retirements move into it). `cloneDO` is
`forkObjectStorage`, idempotent by target id: `ERR_OBJECT_EXISTS` is done, an
interrupted fork is taken over (`replaceUnfinished`), and a retry after a lost
receipt leaves the one object it holds. The clone receipt table stays: it is the
reservation's proof that the copy is its own, not a journal.

**`panel-tree-navigation` was not a P3 regression.** The P3 gate saw it fail 4 of 4 on
P3 and pass 2 of 2 on `d1bfdec3f`. On `d1bfdec3f` rebuilt with only a call-latency
trace it failed 3 of 3 (two with the same error as P3, one with a model error), and a
deterministic script (`openPanel(data:...)`, `navigate`, then `state()` and `tree()`,
run with `vibestudio eval run`) fails the same way on both builds, before and after the
navigation. The failing call is `PanelHandle.state()` or `.tree()` on a **browser
panel**: `_agent.*` is answered by the panel runtime inside a code panel, an external
page has none, so the call addresses a `panel:` target that never connects and fails as
`TARGET_NOT_REACHABLE`, reported as a recoverable `host_unavailable`. The test passes only
when the model does not make that call. Two readings of the first evidence were wrong:
"the coordinator re-materializes the entity three times" was the log line of
`PanelExecutionReconciler.resume`, written for every `ensureExecutable` check (each
acquire and each `ensureSlot`), almost all of which find the entity active and
activate nothing (the pre-P3 server log has the same repeats); the line is now written
only for a real activation. And the per-call slowdown is real but is not what fails the
test: see the cost paragraph of §4.2 (every call to a Dolt object writes a replay nonce).
Fixed on the Base side (`panelRuntime.ts`, `callPanelAgent`, test in
`panelRuntime.test.ts`): on a browser panel the host answers the agent calls itself,
`state()` with `{}` (an external page registers no state providers), `routes()` with the
panel's URL parts, `tree()` and `snapshot()` with the document capture `snapshot()`
already takes over CDP, and `setMode()` with `undefined`. That changes what these four
return for a browser panel from a failure to a value, which is for the user to review.

**Findings on the fork, from building this:**

- The real engine enforces foreign keys, in SQLite cells and in Dolt cells; the
  fake does not. Anything that inserts rows (the importer, a test seeding a
  store) must put parents first.
- A string with an embedded NUL is cut at the NUL when bound (sql.js, and so
  any key built with `\0`); the importer's composite keys use `\u001f`.
- `dolt_status` and a pinned commit `date` work inside a `{ commit }`
  transaction; `ctx.storage.dolt.hashOf` does not (read it first).

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

  A _context_ is a branch inside a cell, so a participant that works on many
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

| Today                                                                 | On Dolt                                                                                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkspaceFactRoot`, persistent radix nodes and edges, file manifests | The Dolt root of the commit. A point read is `SELECT … FROM files WHERE repository_id = ? AND path = ?` (at a ref, `dolt_at_files(?)`)                             |
| Repository and file _state_ rows with `prior_*_state_id`              | The current row, plus Dolt history. "Prior state" is the row at the commit's parent. Restore reads the row before the tombstone change (`dolt_at_files(<parent>)`) |
| `contentKind`, `byteLength`, `coordinateExtent`                       | Unchanged columns. They are intrinsic file facts                                                                                                                   |
| Host tree hash                                                        | Still derived for materialization. It is keyed by commit hash                                                                                                      |

### 5.3 States, applications, events and contexts

| GAD concept                                   | On Dolt                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `StateNodeRef`                                | A commit hash. The public `{kind: "event" \| "application"}` shape stays as a projection: a commit is an event if it introduced an `events` row                                                                                                         |
| `WorkApplication` (one mutation)              | One commit on the context branch, holding its rows: `commands`, `work_units`, `changes` (+ coordinates and counteractions), `applied_changes` (+ predicates), `content_edges` (+ mappings), and any `decisions`. The basis is the commit's first parent |
| `WorkspaceEvent` (commit)                     | One commit that adds a single `events(event_id, command_id, kind, message)` row. Its parents are the Dolt parents. "Applications committed by this event" is the first-parent range since the previous event                                            |
| Integration commit                            | The Dolt merge commit (2 parents) produced by §5.5, which adds its `events` row inside the resolver                                                                                                                                                     |
| Genesis                                       | The schema commit plus the template-installation commit, in the canonical database. Every work cell forks from a descendant of it                                                                                                                       |
| Context `committed_event_id` / `working_head` | Branch `ctx/<id>`. The working head is the branch head. The committed event is the nearest first-parent commit with an `events` row (derived, no pointer)                                                                                               |
| CAS on the working head                       | `hashOf("ctx/<id>") === expected`, checked inside the write turn **of the cell that owns the context**. The check stays local; no other cell can write that branch (§5.8)                                                                               |
| `forkContext` (with uncommitted applications) | `branch.create("ctx/<child>", { from: "ctx/<parent>" })`. O(1), carrying every application commit, which is exactly GAD's "share the immutable head" rule. Within one cell                                                                              |
| `discard`                                     | `reset({ hard: true, to: <committed event> })` on the context branch                                                                                                                                                                                    |
| `destroyContext`                              | `branch.delete`. Reachable commits remain through other branches and merges                                                                                                                                                                             |
| `vcs_workspace_heads`, `refs`, `ref_log`      | Branches. A protected-main move is a fast-forward push, and its history is `dolt_log` of `main` in the canonical database                                                                                                                               |
| Push to protected main                        | Approval at the host (unchanged), which mints a short-lived push grant, then a fast-forward-only push of the committed event (§5.5, §5.6)                                                                                                               |

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
  message,
  author,
  date,
  resolve(merge) {
    /* §5.5.2 */
  },
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
of a _prefix_ of the source, with `upTo` set to one of the source's
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

| Holder                                              | Grant                                                                                                                                                                | Lifetime                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A work cell (agent, user, subagent)                 | `fetch: true`, `branches: ["main", "ctx/*", "pub/*"]`, `push: ["pub/<participant>/*"]`. May fetch the canonical and publish its own branches under its own namespace | The participant's life. `expiresAt` set to a renewal horizon, `peer` set when the carrier is P2P |
| Publish to protected `main`                         | An **additional** short-lived grant with `push: ["main"]`, minted **after approval** and bound to one participant                                                    | Minutes, or one use (revoked after the push)                                                     |
| A reader (a panel, a CLI, another workspace's read) | `fetch: true`, `branches: ["main"]`                                                                                                                                  | As needed                                                                                        |

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
  is _after_ the fact: when it learns `main` moved (the follow-up RPC or the
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

| Single-writer law (provenance plan)                               | Under decentralized GAD                                                                                                                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One DO owns contexts, events, applications, decisions, lineage    | **Each cell owns the branches it writes.** A branch has exactly one writer, so the invariant "one writer per branch" holds everywhere. The _database_ has many cells, and the canonical owns only `main` |
| CAS on the working head, in one turn                              | **Kept, local.** `hashOf("ctx/<id>") === expected` inside the owning cell's turn. Cross-cell publication is a fast-forward-only push, which is a CAS on `main` performed by Dolt                         |
| Protected push is an approval-gated CAS of the protected ref set  | **Kept.** Approval mints a short-lived `push: ["main"]` grant; the push is the CAS (fast-forward only). `PublicationGate` still decides; it no longer writes the ref                                     |
| Push validates every traversed integration event and reachability | **Kept, at the pusher**, with an after-the-fact check on the canonical (§5.6). Reachability is a fast-forward by construction: the pushed tip contains `main`                                            |
| Command journal and idempotency                                   | **Kept.** A `commands` row is versioned with its application commit. Ids come from the causal coordinate, so two cells never mint one. A retry goes to the cell that owns the context                    |
| No persistent plan token, staging set or merge session            | **Kept.** F1 resolves inside the merge's own transaction. A merge never spans turns. A failed push leaves a normal pull to run again                                                                     |
| Effect outbox, no DO transaction across external I/O              | **Kept, local per cell.** The outbox is a local table. Materialization of `main` is the canonical's effect; materialization of a context is its cell's                                                   |
| Neither side holds a global concurrency gate across external I/O  | **Kept and strengthened.** No object holds anything for another                                                                                                                                          |
| `UNIQUE(repository_id, path)` and stable file identity            | **Kept as constraints, enforced at merge** (L10): a violation reaches the resolver                                                                                                                       |
| Execution and integration are independent axes (invariant 10)     | **Kept.** A subagent's execution is its own cell; its code returns through §5.5                                                                                                                          |
| Agentic log owns events, GAD indexes them                         | Unchanged (§6.1)                                                                                                                                                                                         |

What is _new_ as a risk: the canonical's invariants hold because every cell
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
  _in any cell that can still publish_. A local `content_roots` table holds
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
_estimates_.

| Removed                                                                                                                                                                                               | Lines                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `persistentRadix.ts`                                                                                                                                                                                  | 817                                                                              |
| `workspaceFactMap.ts`                                                                                                                                                                                 | 489                                                                              |
| `workspaceFactChangeSet.ts` (manifest member algebra)                                                                                                                                                 | 354                                                                              |
| `netEffectMerge.ts` aspect algebra (the three-way text merge stays)                                                                                                                                   | ~200 of 311                                                                      |
| `semanticWorkspaceFacts.ts` (fact-root composition)                                                                                                                                                   | ~1,100 of 1,284                                                                  |
| `semanticWorkspace.ts`: event ancestor graph, maximal merge bases, merge comparison and structural constraints, decision attribution, commit and discard chain handling, working-mutation persistence | ~4,500 of 14,477 (_estimate_: spans 3021–3776, 9717–11860, 8513–9201, 4167–4433) |
| `semanticVcsStore.ts` (state and frontier persistence)                                                                                                                                                | ~1,000 of 2,062                                                                  |
| `semanticVcsSchema.ts` (15 of 33 tables)                                                                                                                                                              | ~350 of 720                                                                      |
| `GadWorkspaceDO.ts`: log chain, `forkLog`, refs and `ref_log`, projection copy by head                                                                                                                | ~1,500 of 7,203                                                                  |
| Tests that exercise removed mechanics                                                                                                                                                                 | not counted                                                                      |
| **Total, production code**                                                                                                                                                                            | **~10,000** (_estimate_)                                                         |

Added (_estimate_, ~1,500 lines): the work-cell lifecycle (create, grant,
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

_Built in P4 slice S2; §6.8 has what was built and where the code showed this
list to be wrong (`participants`, the receipts, the relationship projection and
the `state` table are not as listed below)._

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

| Removed                                                                                                        | Lines                   |
| -------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Channel hash chain and fork boundary (`channel-ledger.ts`, mostly)                                             | ~180 of 229             |
| Log hash preimage (`hash.ts`, `prepare-log-event.ts`)                                                          | ~300                    |
| Fork saga clone, postClone and rollback (`channel-do.ts` 6504–7660, partly)                                    | ~500                    |
| `delivery-projection.ts` fork reset paths                                                                      | ~150 (_estimate_)       |
| Knowledge export and import (`native-channel-knowledge.ts` ×2, `native-channel-bootstrap.ts` import path)      | ~1,100                  |
| Channel-to-GAD hash-for-hash mirror verification (`channel-observation.ts`, `channel-do.ts` 2041–2350, partly) | ~250                    |
| Host clone path for channels and agents (`cloneDO` 5109–5183, `durableObjectStorageClone.ts`)                  | ~310                    |
| **Total**                                                                                                      | **~2,800** (_estimate_) |

### 6.8 P4 as built, slice S2: the Dolt engine for userland classes, and the channel cell

**The engine declaration.** A userland class says `"storage": "dolt"` and `"doltLocal": [...]`
in its `durable.classes[]` entry (`HostedClassManifest` already had both for hosted
classes). `RuntimeManager.classEngine` reads it into the object's admission
(`DoExecutableAdmission.engine`, with the framework patterns `vsl_%` and `state` added by
`doltLocalPatterns`; it is part of the incarnation version only when present). UniversalDO
starts the object's one facet, still named `do`, with `celld: { storage: "dolt", doltLocal }`.
The name is uniform on purpose: a fork at a commit names it (`facets: { do: { at } }`,
`RuntimeManager.forkObjectStorage({ at })`, the router's `fork` operation), and the host
never needs to know which engine an object has.

**A class that was SQLite (§9.2 as built).** An object created before its class declared Dolt
has a SQLite facet `do`, and celld refuses to start the other engine under a name. UniversalDO
finds out by trying: a first request asks the Dolt `do` for `__legacy/engine`; the refusal
"storage engine is fixed" means a legacy facet exists. (The root cannot read celld's
`_cf_FACET_INDEX`: `access to _cf_FACET_INDEX.name is prohibited`.) The move is a state machine
whose stage is a key of the root's own storage (`vibestudio:do-engine`), written before the stage
begins, so a kill resumes where it stopped (two real-fork tests inject a failure in each stage):

1. `copying`: the legacy SQLite facet is intact. Stage it into a Dolt facet `do-staging`
   (every table, parents first, through the class's own proof-gated `__legacy/tables|rows|load|commit`
   calls, `packages/durable/src/legacyImport.ts`, served by both durable bases).
2. `copied`: delete the legacy facet (the staging facet holds everything now).
3. `swapping`: delete any partial `do`, copy the staging facet into a new Dolt `do`, commit
   `import: <key> from sqlite`, delete the staging facet. The marker becomes `dolt`.

The detour through a staging facet exists because celld has no rename and a facet fork empties the
local tables, whose rows (the object's identity in `state`, its mailbox) must survive the move.
The class code runs on the legacy facet too, so the schema guard has already upgraded the legacy
tables to the current shape before the copy. The importer is deleted when the minimum supported
version passes the flip (§9.2).

**The channel.** `PubSubChannel` declares `storage: "dolt"` (schema 126).

|                     | Tables                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioned           | `channel_ledger_events`, `channel_ledger_chunks`, `channel_members`, **`channel_facts`** (new)                                                                                                                                                                                                                                                                                               |
| Local (`doltLocal`) | everything else: `channel_ledger_state` (head, GAD observation cursor, fork provenance), `participants`, `presence_last_seen`, `invite_index_ops`, `channel_relationship*`, `channel_event_identities`, `channel_delivery_*`, `channel_receipts`, `channel_observation_claim`, `channel_maintenance_queue`, `pending_calls`, `provider_call_claims`, `fork_*`, `lineage_*`, `state`, `vsl_*` |

Where this differs from §6.2, and why (all found by the survey of `channel-do.ts`):

- **`participants` is local, not versioned.** `restoreActivationState` deletes every row at each
  activation (they are live external sessions), presence is not in the ledger, and typing and
  status sweeps write it at high frequency. Durable membership of an agent is
  `channel_relationships`.
- **`channel_relationships`, the receipts and the whole delivery projection are local, rebuilt by
  folding the ledger.** They are a deterministic fold (L2: a fact is stored once). A fork's child
  has _different_ subscriptions on purpose (its agents are new entities), and today's rule, kept,
  is that the inherited prefix is replayed context-only through the fork boundary. Versioning the
  table would give the child the parent's subscriptions. `read` and `declined` receipts are not in
  the ledger, but a fork has always started without them and a projection-version change has
  always discarded them, so keeping them local changes no behaviour.
- **The ledger append transaction does not contain the projections.** The fold needs the hydrated
  event (an async blob read) and runs in its own transaction after the append; a crash between
  them is repaired by the cursor (`alarm` replays from it). So the commit of an append holds the
  event, and the projections are local and recomputable. Commit message: `channel: append <seq>
<kind> <envelopeId>`; a membership change is `channel: member add|remove|handle <id>`; a fact
  `channel: <key>`; a fork's first commit `fork: initialized <key> from <source>`.
- **`state` is local by the framework's own rule, and the conversation's facts lived in it.**
  `channel_facts` holds `config`, `initialConfig`, `conversationSeed(Installed)`, `createdAt` and
  the opening-request keys, written only inside a commit (`writeFact`/`setFact`). What stays in
  `state` is identity (`contextId`, `forkedFrom*`, `forkPointId`, `rootChannelId`) and caches. The
  125 to 126 upgrade (`schemaUpgrades`, pinned to the version-125 shape in
  `channel-schema-history.ts`) moves the facts, and `initial_config_json`, into `channel_facts`.
- **The head is a local column, not derived.** `channel_ledger_state` keeps `head_sequence` and
  `head_hash` (the hash chain is still there until §6.7's deletion); a fork's local table starts
  empty, so `initializeClone` rebuilds the row from the events it holds.
- **`lineage_heads`, `lineage_head_outbox` and `invite_index_ops`** were not in the list: they are
  an outbox and a cache of other cells' state, so local.

**The fork, channel side (§6.4 steps 1, 2 and 5; the agents are S3 and S4).** The fork saga journals
`channelCommit`, the commit that appended the fork point (`commitAtSequence`: `dolt_log` by the
append message, checked against `dolt_at_channel_ledger_events`), and passes it to
`runtime.cloneContext` as `storageAt: { <entity id>: <commit> }` (captured in the clone definition,
so a retry with another commit is refused). The host forks that object's `do` facet `at` it. What
is gone from the channel: truncating the child's ledger (`forkFrom`, now `adoptParent`, which only
names the parent), `resetForFork` (now `seedForFork`, which re-seeds the local rows a fork lacks),
pruning the fork view, the table-by-table clone deletes in `initializeClonedStorage` and the
`state` key deletes. `postClone` remains: it carries the identity and the seed marker, which the
child needs and the fork cannot give. Agents are still forked by knowledge export and import.

**Dolt facts established on the real engine** (`universalDoHost.test.ts`): the dialect probe shows
partial unique indexes, CHECK, JSON1, `RETURNING`, `ON CONFLICT ... DO UPDATE ... WHERE`,
multi-statement `exec`, `STRICT` tables, `INSERT OR REPLACE`, `PRAGMA table_info` and
`PRAGMA foreign_keys` all work on a Dolt facet, so the channel's and Pi's SQL runs unchanged. A
class's own `ctx.facets.get` registers the name with the first start options: after a refused
start the root must `abort` the name before starting it with other options.

**Two more engine facts, found by the first lanes.** A Dolt store reports a primary-key column as
NOT NULL (the exact-schema helper ignores a key's nullability), and it drops `--` comments from the
DDL it keeps while the shape is taken from whitespace-collapsed text, so a line comment would make
the shape drift at the second activation: the install now refuses it, and any class moved to Dolt
(Pi's migrations in S3) must be free of them.

### 6.9 What the survey of the agent cell found, and what it changes (S3 onward)

The agent family (`AiChatWorker` to `NativeAgentOwner`) was surveyed before any change. Findings
that make §6.3 and §6.4 steps 3 and 4 larger than written:

1. **Pi is an external package** (`@panticonic/pi-durable`), not in the Base template. Its shared
   id counter is a singleton row (`durable_metadata.next_id`) updated on every commit, and every
   record type (conversation, entry, task, submission, document) draws from it. That breaks L10 in
   a versioned table: two forks would hand out the same ids, and a merge or a hard reset would
   rewind the counter. A split store needs a composite `Storage` that mints ids from a local one.
   Pi already supports a table prefix (`SqliteStorage.open(db, { prefix })`, `vsl_` matches the
   framework pattern), so the second table set costs no schema work, but `Harness.open` takes one
   `Storage`, and `NativeDatabase.transaction` has no commit option.
2. **`fork` is declared only on conversation-scoped documents.** 28 of 53 kinds (session and task
   scope) declare none. Almost all of them are admission, outbox or receipt documents, so the table
   choice is "local unless a kind is conversation knowledge", with `pi.agent`, `pi.codemode.store`
   and `vibestudio.product-model-configuration` the versioned ones. Pi's `initial` kinds must be local
   (a fork must see them empty); `current` cannot be honoured exactly (the fork sees the value as of
   the commit).
3. **Tasks and submissions are versioned unless split too**, and the commit that closes a turn also
   creates a non-terminal `turn.closed` publication task aimed at the parent channel (and eval,
   input-settlement, automation-run tasks). A fork at that commit would copy a pending publication.
4. **`ExecutionOwner` must be local** (it holds the runtime id, context, incarnation and authority
   session), and `openBoundAgentSession` refuses an unbound namespace that has conversations: a fork
   needs first-activation logic (bind a new owner, rebind the conversation to the fork channel,
   restore `agent:settings` from `state`, ignore inherited operational tasks, drop other channels
   of a multi-channel agent).
5. **The turn-close transaction mixes both kinds** (entries and the run state, with publication
   tails, admission documents and model evidence). One composite transaction across the versioned and
   local table sets is required.
6. **There is no per-turn anchor row.** Anchors are derived from several documents by
   `exportNativeChannelKnowledge`, and the agent's own published events get channel sequences
   asynchronously after the Pi commit, so a commit written at turn close knows only the input side.
   The "last commit whose anchor is at most N" rule needs a second commit after publication
   acknowledgement, or the anchor is defined on the input side only.
7. Agents can be multi-channel (`nativeReasoningChannelIds` derives from `subscriptions`), so a
   whole-cell fork carries other channels' conversations.

So S3 is a Pi change first (composite storage, local document kinds, a turn-commit with anchors) and
an agent change second. §6.11 is what was built, and where this survey was wrong.

### 6.10 The hash chain: what deleting it touches (S1, done: §6.11.1)

Corrections to §6.7 found by the survey. `prepare-log-event.ts` has **no hash code** (it normalizes
actors, audiences and causality, and GAD calls it too): it stays. `hash.ts` is a different, legacy
trajectory hash with no production consumer. The real chain is `log-envelope.ts` (`logEnvelopeHashPreimage`,
`computeLogEnvelopeHash`, `verifyLogEnvelopeHash`, `checkLogIntegrity`, `LOG_GENESIS_HASH`, and the
`prevHash`/`hash` fields of the strict wire schema). `logEnvelopeSemantic` stays (it is the canonical
content comparison of "exact" idempotency). GAD's chain is **independent**: it computes its own hash
over the same preimage, and the channel only checks that the two agree
(`channel-observation.ts`); GAD keeps `log_events.hash UNIQUE NOT NULL` and a `builds` log that uses
the chain for `checkLogIntegrity`. `eventDigest` of the agent's knowledge anchors does not depend on
the chain.

Dependency order: (1) host `workspaceSource.ts` schemas make the hash fields optional (the schemas are
strict and shared with Base workers); (2) the channel observation protocol and the barriers and
fork checks of `channel-do.ts` move from `hash` to `(sequence, envelopeId)` (`parent_hash` becomes the
parent envelope id); (3) `channel-ledger.ts` stops computing and storing the chain; (4) GAD computes
its own chain with a private function (its removal is P5's) and stops exposing it; (5) delete the
protocol's chain code and legacy `hash.ts`, regenerate the GAD catalog. The channel's
`channel_ledger_state` already is a local table (S2), so (2) and (3) need no engine work.

### 6.11 P4 as built, slices S1 and S3 to S6

The slice order held: S1, then S3 (Pi first, then the agent), S4, S5, S6. Each slice was committed
separately; the lanes were run once for S3 to S5 together, because the three are one model (the agent's
cell on Dolt and the fork that follows from it) and a lane run of S3 alone would have gated a state that
cannot fork.

#### 6.11.1 S1: the hash chain is deleted

The channel's event ledger carries no `prevHash`/`hash`. What changed, in the survey's order:

1. The host's strict wire schema `logEnvelopeSchema` (`workspaceSource.ts`) lost the two fields.
2. The observation protocol, the delivery-release barrier and the fork prefix name a boundary by
   `(sequence, envelopeId)`: `waitObservedThrough` answers `{ observedSequence, envelopeId }` (null at
   sequence 0), a fork's parent prefix is the envelope id at its sequence, and the claim receipts carry the
   envelope id alone. GAD's `initializeLogHead` and `forkLog` still answer their head-level hash; the channel
   no longer compares it.
3. `channel-ledger.ts` stores and computes no chain. Schema 127 **recreates** `channel_ledger_events` (no
   `hash`) and `channel_ledger_state` (no `head_hash`, `parent_hash`) instead of `ALTER TABLE ... DROP
COLUMN`: the real engine drops a column correctly (probed, `universalDoHost.test.ts`), but a SQLite store
   keeps the old table text with a hole in it and the shape fingerprint reads that as drift, and a legacy
   SQLite object is upgraded on SQLite before the one-time import. An event stored before the change
   still carries its two fields in its chunked body; `ChannelLedger.at` strips them on read, so the strict
   schema and every comparison see one shape.
4. GAD keeps a private chain for the logs it owns (`workers/workspace-source/logChain.ts`: the
   preimage, `ChainedLogEnvelope`, `wireLogEnvelope`); a stored envelope is a `ChainedLogEnvelope`
   inside the worker and is stripped before it is answered. **Not exposed any more:** the wire envelope.
   **Still exposed, and P5's to remove with the log machinery:** the head-level pointers
   (`headHash`, `forkHash`, `expectedHeadHash`) and the trajectory event view (`prevEventHash`,
   `eventHash`), which GAD derives from its own chain.
5. Deleted from `agentic-protocol`: `computeLogEnvelopeHash`, `verifyLogEnvelopeHash`, `checkLogIntegrity`,
   `LOG_GENESIS_HASH`, the preimage and the legacy `hash.ts` (`computeEventHash`, `checkTrajectoryIntegrity`).
   `GENESIS_EVENT_HASH` stays: it is GAD's chain start.

#### 6.11.2 S3, Pi: a composite storage (`@panticonic/pi-durable`)

`CompositeSqliteStorage` (Pi `packages/durable/src/storage/sqlite/composite.ts`, tests
`test/sqlite-composite.test.ts`, 37 tests including Pi's own storage conformance suite) is one store over two
table sets in one database, written in one transaction:

| Set                       | Tables                                                                                      | Holds                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| versioned (default names) | conversations, entries, documents, document revisions, payload chunks, record ids, metadata | conversations, entries, and the documents that are conversation knowledge |
| local (`vsl_` prefix)     | the same eleven tables                                                                      | tasks, submissions, every other document, **and the two counters**        |

The routing rule is `defaultDocumentRoute`: a document is versioned when its scope is a conversation and
its `fork` is `current` or `asOf`, local otherwise. It reproduces §6.9's list exactly with no per-kind table:
of the 53 document kinds, `pi.agent`, `pi.codemode.store` and `vibestudio.product-model-configuration` are
the versioned ones. **§6.9 was wrong on tasks:** it left open whether they are versioned; they are all
local (a task is an operation in flight, and a fork must not inherit a pending publication), and so are
submissions.

- **Counters.** The ID and the sequence counters live in the local set and are the composite's alone. A
  rewind of the versioned set cannot lower them, two forks never share one, and a fork (whose local rows
  start empty) restarts them above the highest ID and sequence its versioned set stores, once, at open.
- **A fork empties the local rows and keeps the local tables.** Found by the first real-fork run: Pi's
  migrations run again from version zero over tables that exist and fail (`table vsl_durable_metadata already
exists`). The local set's migrations are therefore written `IF NOT EXISTS` / `INSERT OR IGNORE`
  (`applyCompositeSqliteMigrationsInTransaction`).
- **The commit option.** `NativeDatabase.transaction(fn, afterCommit, { commit })` passes the engine's
  `{ commit }` to `ctx.storage.transaction`, and the composite's `commit(writes, seq, { entryHigh })` policy
  names the commit a storage transaction ends with (or none). Two engine facts the real run gave: a
  `{ commit }` that has nothing to commit **throws** (`nothing to commit`), so a commit function must return
  null for no change; and a Dolt operation (`dolt.status()`) cannot run inside the transaction, while the SQL
  table `dolt_status` can.
- **No `--` comment in any Pi migration** (a test asserts it), as §6.8 required.

#### 6.11.3 S3, Base: the agent cell

`NativeAgentOwner` opens `CompositeSqliteStorage` over `ctx.storage`; the agent classes declare
`storage: "dolt"` with the product tables local (`do_identity`, `subscription_intents`, `subscriptions`,
`subagent_runs`, `custom_cards`, `agent_hot_path_trace`; `vsl_%` and `state` are the framework's). The trace
table lost its `AUTOINCREMENT` (a local table of a Dolt cell may not have one).

- **When a turn commits.** The storage transaction that creates the pending `turn.closed` publication task
  ends in a commit, `agent: turn closed <turn> entries<=<N>` (`nativeAgentCommitPolicy`): it sweeps in
  everything the turn wrote and names how much of the conversation it holds. Nothing else commits. A
  faux-model turn is **23 storage transactions** (about 25 KB of JSON) and one Dolt commit.
- **Where §6.3 and §6.4 were wrong: no anchor rows.** The design put
  `{channelId, throughSequence, eventDigest}` in the commit's rows, which needs a second commit after
  publication acknowledgement (the agent's own events get their channel sequences after the turn). Instead
  the frontier is derived **at fork time** by the function the knowledge export already used
  (`nativeChannelKnowledgeFrontier`, extracted from `exportNativeChannelKnowledge`): the greatest entry the
  channel prefix accounts for, `at`. The commit is then the newest turn commit whose `entries<=N` is at most
  `at` (`lastTurnCommitThrough`), or the cell before its first turn closed. The granularity is a closed
  turn, as §6.4 required; the anchors a fork adopts are those of entries the commit holds.
- **An object that predates the split opens under its sealed schema.** The schema gate fingerprints every
  table of an object, and the local `vsl_` set is created by the session, after the gate. Found by reading the
  gate against the change, not by a test that failed: the first draft listed the `vsl_` tables as required (an
  existing object has none until it opens) and the shape of a store that had opened once would have drifted at
  its next activation. The `vsl_` prefix, the framework's local-table naming, is now outside every class's
  sealed shape (`packages/durable/src/schema.ts`), and `ensureLocalPiTables` creates the set (or its
  schema-version row, which a fork loses) at each open, as a read when there is nothing to do.
- **The one-time move of a single-set store** (`pi-store-split.ts`): a legacy object (copied by the
  engine's import, or an upgraded SQLite object) has Pi's one set. `migratePiStoreLayout`, one committed
  transaction after the layout migration, moves tasks, submissions and the operational documents (with
  revisions, chunks and ID rows) to `vsl_` under the same IDs and carries the counters, then records
  `vibestudio.pi-store.layout = 3`. A new object only records the layout. Tested on a store made by Pi's
  own single-set `SqliteStorage`, and in `native-agent-owner.test.ts` (the legacy-provenance tests un-split a
  store first, then reopen).

#### 6.11.4 S4: a native conversation fork across the channel and its agents

The channel's fork saga journals, per kept agent, the agent's **frontier** (`forkFrontier`: the conversation
id, the commit, the entry high-water mark, the anchors, the configuration) and passes
`storageAt: { <channel>: commit, <agent>: commit, ... }` to `runtime.cloneContext`. The host forks a native
owner like any other DO (`cloneProvenance.storage` is `snapshot` for every DO; the `!agentBinding` exception
is gone), the fork's versioned conversation arrives with it under the same entry IDs, and its local set is
empty. The first activation is `adoptChannelKnowledge`: the owner sets a `state` marker
(`vibestudio.fork-adoption`) so `openBoundAgentSession` accepts a conversation with no owner (the only time it
does), binds a new owner, then adopts the existing conversation (`adoptNativeChannelKnowledge`: the channel
binding, the anchors, the configuration, the bootstrap `native-import` provenance) once, and clears the
marker. Deleted: `exportNativeChannelKnowledge`, `importNativeChannelKnowledge` and the `KnowledgeExport`
document family, the history copy with re-allocated entry IDs, and `exportChannelKnowledge`/
`importChannelKnowledge` on the wire (the contract is `forkFrontier` and `adoptChannelKnowledge`).
**Not deleted:** `native-channel-bootstrap`'s `native-import` phase (the adoption still uses it, with the
fork's provenance) and `postClone` of the channel (it carries identity, as §6.8 said).
A multi-channel agent's other conversations stay in the fork's cell as unbound conversations (the fork
holds the whole cell); they are never subscribed and cost space only.

#### 6.11.5 S5: a subagent `mode: "fork"` is a fork of the parent's cell

The parent asks itself for the frontier at the channel's present head, then creates the child with
`runtime.createEntity { forkStorage: { at: <commit> } }`: the host reserves the child with `snapshot`
provenance and forks the **caller's own** storage into it before activation (`reserveForkedStorage`; only the
entity itself can fork itself, into its own class, at one of its own commits), and the child adopts the
conversation for its task channel with the same `adoptChannelKnowledge`.

#### 6.11.6 S6: executor fact (S6a) and agent self-hosting (S6b)

**S6a.** The executor fact is `kind: "dynamic-code"` with a `runId` (it was `kind: "eval"` with an `evalRunId`),
in the wire type, the registry, the admission, the roots and live-caller consumers and their tests.

**S6b, as built (2026-11-15).** An agent hosts its own eval kernel; no session entity stands between an agent
and its runs.

- **Manifests.** `AiChatWorker` and `SilentAgentWorker` declare `hosts: [{ source: "workers/eval-kernel",
className: "EvalKernel" }]`. The host recognises an eval host by that declaration, not by a class name:
  `declaresEvalKernel` (shared) over the build graph's `durable.classes[].hosts`, behind one predicate
  (`hostsEvalKernel`, `index.ts`) that `dynamicCode`, `evalExecutionRoots`, the root provider and the authority
  observer take. `isEvalHost(record, hostsEvalKernel)` is the session entity or such a class
  (`evalKernelAuthority.ts`); `isEvalHostRecord` stays the session entity's own test.
- **Admission.** `dynamicCode.admit` resolves the owner; when the owner's class hosts the kernel, the host entity
  is the owner (`selfHostOf`): the executor's runtime id is the agent's own, the harness identity is the agent's
  own sealed code (as it already was for an agent), and no session entity is created. A finite scope is
  refused (it is a session entity's: the agent keeps its kernel for its own life). Host controls reach the
  agent's methods by their names (`get`, `cancel`, `reset`, `recordAuthorityEvent`, `retainExecutionRoot`,
  `executionRoots`).
- **The agent.** `HostedEvalKernel` (`packages/agentic-do/src/hosted-eval-kernel.ts`) holds the relay once; the
  vessel exposes `start`, `await`, `events`, `cancel`, `get`, `receipt`, `acknowledge`, `readScopeTextPage`,
  `deleteScopeValue`, `end` (the agent itself or the host) and `reset`, `recordAuthorityEvent`,
  `retainExecutionRoot`, `executionRoots` (the host only). Every call to the kernel is `{ kind: "host" }`: no
  admission nonce, the agent is the kernel's only principal (§7.5.1). The agent's tool, await task and
  acknowledgement address `evalHostId(ownerId)`, which is the owner. A call an agent makes to its own id is
  delivered in-process by its rpc client with **no verified caller**; the vessel accepts exactly that and the
  host (a call from outside always carries the caller the host verified). The chat/describe relays
  (`chatOp`, `describeEvalOwner`, ...) now check that the caller is the agent itself, because the kernel acts as
  the agent.
- **Lifecycle.** `releaseForLifecycle` relays each phase to the kernel first (runs cancelled, panels it opened
  retired, the residency hold released on `release`), then to the agent's own release. `onHostedRevoked` needs
  nothing in the agent: the root relays a drain or swap to each hosted facet, and the kernel class owns the
  callback.
- **Deviations from §7.2 and §7.5.1, each forced.** (1) **One kernel per agent, one notebook scope for the whole
  agent.** The execution-session registry admits one live run per executing runtime id, and a kernel's outbound
  calls are attributed to its entity; several kernels in one entity (one per conversation scope, as session
  entities give) would need the registry keyed by (entity, scope). The agent's former per-conversation
  notebooks are therefore one; runs of different conversations queue behind each other at admission, as the
  runs of one conversation always did. (2) **Approvals of an agent's own eval are titled as the agent's** (the
  requester is the agent entity; `approvalCallerTitle`'s "eval sandbox" title is for session entities).
  (3) **The kernel's channel-delivery relay** (resident sessions) is not on the agent: an agent's eval reaches
  channels through `chatOp`, never through resident sessions. (4) The kernel's infrastructure calls run under
  the agent's sealed authority, as the design says; the agent's manifest was not widened for it (see the lanes).
  (5) **The census activates every self-hosting agent**: `executionRoots` is a call on each active agent entity
  (the session entity answered `[]` without starting a kernel and so does the agent, but the agent's own
  activation is the cost).

#### 6.11.7 What the product lanes found (the last of the pass)

The unit and real-fork tests passed before the lanes ran; the lanes found what they could not.

- **Fork selection was wrong in the design and in the code before it.** §6.4 and the channel's fork saga asked
  every `entity` participant for its knowledge. A headless client (the CLI and the system-test session) is an
  entity too (`kind: "external"`) with no agent cell: the call was refused by default-deny, so **a conversation
  fork from a headless session never worked**, before this pass as well. The saga now selects participants whose
  `ref.kind` is `agent` (the multi-agent test has a headless entity in the channel). The lane scenario
  `conversation-fork-adopts-agent-cell` is the first test that forks through the channel's own `fork` RPC on the
  real stack.
- **An adoption must bind exactly what the open that follows binds.** The projection binding is immutable
  (`native-channel-publication.ts`, `bind`). A subagent's open binds `reportTo` (its parent) on the task
  channel; the fork's adoption bound the same projection without it, and the first open after the adoption was
  refused. Both paths now take `reportTo` from one function (`nativeReportTo`). §6.8's note that the adoption "is
  one binding" holds only if the candidate is the same value on both paths.
- **A commit with nothing to commit throws on the real engine** (found by the first lane, fixed with
  `versionedChangesPending`): §6.3's "a commit at each turn" is a commit when a versioned table changed.
- **Cost of the cell that the design did not give a number for (R1).** A turn of 23 storage transactions and one
  Dolt commit is 558 ms and **635 KB of file before gc** (41 KB after); a fork copies the file (247 ms at 3 MB). The
  design's "gc is cheap, run it sometimes" (§11) is now a requirement: nothing schedules it.
- **The input gate refuses a transaction from a continuation without a live driver, whatever the gate holds.**
  Agent cells hit it rarely and persistently (§6.11.3's agent runs many transactions from chained promises); a
  retry does not cure it. The evidence and the pointer into celld are in `HANDOFF-dolt-redesign.md`
  ("Input-gate refusals in agent cells"); it is the fork's to fix, and Pi's 8-attempt retry should go when it does.

#### 6.11.8 Compaction of Dolt cells

A commit appends to the cell's file and frees nothing; `gc` rewrites the whole file. R1 for the agent cell:
635 KB a turn before `gc`, 41 KB after, and a fork copies the file. Nothing in the product ran it. Now every Dolt
class does, from its base (`@vibestudio/durable` and Base's `durable-base.ts`; helpers `doltGcDue`,
`collectDoltGarbage`, `DoltGcPolicy` in `packages/durable/src/dolt.ts`):

- **Schedule, geometric.** A cell is due after `minCommits` (64) commits, and after that when the commits since
  its last collection reach half the commits it held then (`growth` 0.5), capped at the engine's log window of
  10 000. A fixed N would make the total cost quadratic (the rewrite is the size of the file); this keeps it
  linear in the history and collects a young cell early, when it is cheap. The memory is the cell's own local
  `state` (`__dolt_gc_head`, `__dolt_gc_commits`): never versioned, never forked, and kept across a restart. Due
  is one bounded read of the log (`log({ limit: threshold })`); a class overrides `doltGcPolicy()` (or returns
  `null` for never).
- **When.** After a commit, never in it: `committedTransaction` asks for a check after every eighth commit of an
  activation (a channel commits per event); the agent asks after the commit of a closed turn
  (`agentCommitPolicy` in `native-agent-owner.ts`, every one). The check waits 250 ms under `waitUntil`, so the
  committing event finishes first, then runs in a `blockConcurrencyWhile` (no other event, no open
  transaction), and **only when the working set holds nothing uncommitted** (`dirtyApplicationTables`): a turn
  that is mid-way leaves the cell alone and the next closed turn tries again.
- **Measured on the real fork** (`doltGcCelld.test.ts`, class on the real `DurableObjectBase`, a turn of eight
  plain transactions and a commit): the same 19-commit history is 5.4 MB never collected and 0.66 MB after the
  schedule ran (2.8 MB at 10 commits before it); the cell reads and writes, keeps every commit and its local
  rows, and the schedule survives a kill and restart. The agent-cell stand-in (`universalDoHost.test.ts`)
  asserts that a collection changes no state (entries and commits identical, nothing dirty), that the parent
  closes another turn afterwards, and that a fork cut after the collection holds exactly what the parent held at
  its commit and continues on its own.
- **Not done:** `WorkspaceStateDO` (a product class, not this base) is not on the schedule; a byte threshold
  (the engine reports no file size to the cell; `sql.databaseSize` was not probed); gc under concurrent writes
  to other objects of the same node.

---

## 7. Dynamic code: one hosting helper, one admission step

The first draft of this section moved `EvalDO` into the owner's root as an
"eval kernel" and kept a special path for it. The user's decision of
2026-11-14 replaces that with a **general system for dynamic code** that any
entity can host, built from the two real consumers: the eval kernels, and the
dynamic workers that the Worker Loader serves through `loadExecutable`. Eval is
ordinary code on that system. Nothing below is eval-shaped except the kernel
class itself.

### 7.1 Decisions (user, 2026-11-14, binding)

1. **Any entity hosts code**, through one helper on the durable base. It loads
   code as a facet of the entity, with Dolt storage, a codegen grant and a
   residency hold. The entity's root handles drains in `onrevoked` (a facet's
   own `onrevoked` does not run, §7.4). Agents, workers, panels and sessions
   all use it. Panels, the CLI and the system-test runner become **session
   entities**, registered through the existing `runtime.createEntity` path, and
   host their kernels through the same helper.
2. **One admission step for all dynamic code.** `evalService` shrinks to one
   per-run admission function named for dynamic code (§7.3). Owner resolution,
   `ensureEvalDO`, token minting, dispatch, the liveness supervisor and the
   lease go.
3. **Eval is ordinary code.** The REPL engine is one kernel class hosted through
   (1). It has no special identity, no host-only schemas and no product-builtin
   catalog entry. A manifest declares it with the `codegen` and `residency`
   grants.
4. **Pull, not push.** A caller awaits the call or re-queries by run id; the
   result is a committed row in the kernel's Dolt storage. Progress goes
   through an events stream. `resultReceiver`, `onEvalComplete`,
   `onEvalProgress`, the event-sink push routes, `acknowledge` and
   `eval_result_redeliveries` are deleted.
5. **Legacy `EvalDO` state is dropped** at migration (D5). The restart report
   says what is lost (§7.9).
6. **D4.** `recoverUnresponsiveSandbox` stays as a node-level watchdog call. The
   per-run liveness supervisor is dropped only after celld's per-isolate limit
   is shown to cover a CPU-starved loaded worker (§7.8, shown, with one gap).

### 7.2 Hosting code in any entity

**What the runtime forces (each measured on the real fork).**

- A facet is created by its **root** (`ctx.facets.get(name, () => ({ class,
celld }))`) and cannot be reached from outside it. Ownership of a hosted
  instance is therefore structural.
- A Worker Loader's `env` supports **only service bindings** (`DataCloneError:
Worker Loader env supports only Service Binding capabilities`). An entity's own
  code (a loaded worker, the root's `do` facet) cannot load code or grant
  itself `codegen`: `ownerKernelPathCelld.test.ts`.
- The `codegen` and `residency` grants are per isolate, and a loader cannot grant
  more than it holds. The UniversalDO root holds both and never runs guest code
  itself. A userland object in the product root cannot compile code
  (`universalDoHost.test.ts`, "confines code generation").
- A facet's `onrevoked` does not run; the root's does
  (`doltEvalKernelCelld.test.ts`).

**The helper.** `UniversalDO` (`src/server/workerdPrograms/universalDo.ts`)
exports a `CodeHost` entrypoint and binds one per entity into that entity's
`env` with `ctx.exports.CodeHost({ props: { name } })`, a service binding whose
props the entity cannot change (the `KernelGateway` of the first draft,
generalised). The durable bases (`DurableObjectBase` in `packages/durable` and
Base's `durable-base.ts`) wrap it:

```ts
// in any entity class
const kernel = await this.hostCode({
  name: `repl:${scopeKey}`, // names the facet inside this entity
  executable: { source, className }, // resolved by the host, like loadExecutable
});
const run = await kernel.call("start", input); // a call to the hosted class
```

- **The entity does not choose grants.** `hostCode` asks the root, and the root
  asks the host's executable admission (`/_doadmission`, the step that already
  returns `props` for the `do` facet) what the entity's manifest permits for
  that class. A manifest declares `codegen` and `residency` the way it declares
  any capability, with an approval. The root passes what admission returned to
  `ctx.facets.get`.
- **Dolt storage and the local tables** are part of the same declaration
  (`storage: "dolt"`, `doltLocal`), so a hosted class is a transactional class
  (§4.2) with its own commit history.
- **The residency hold** is taken by the root on `hostCode` and released on
  `release`, `reset`, the entity's retirement or a revocation. A hold pins the
  root, and facets are part of the root (C7), so a held kernel keeps its entity
  resident; a notebook heap is entity state, so that is honest.
- **The root's `onrevoked`** relays a drain or swap to each hosted facet's
  `persist` method (the scope snapshot). The hosted class sees one
  `onRevoked({ reason })` callback, the same shape on every entity.
- **Calls** are `entity -> its CodeHost binding -> the root -> the facet`, one
  extra hop (measured). Another entity's root is unaddressable from the first.
- **Callers without a root** (a panel, the CLI, the system-test runner) were
  served by `ensureEvalDO`, which registered an entity by hand
  (`store.activate`/`advanceExecution`: lineage `parentId`, `ownerUserId`,
  `agentBinding`, `stateArgs`, a finite or persistent lifecycle). They become
  **session entities**: a UniversalDO keyed `session:<principal>:<scope>`
  created through the existing `runtime.createEntity` path, with a lifecycle
  (finite or persistent), a context binding and the `parentId` link that
  `resolveParentPanel` walks. The caller hosts its kernels in it with
  `hostCode`, like any other entity. No new identity mechanism exists.

**As built (step 3, 2026-11-14).** The design above held except in two
places, both forced by measurement:

- **The binding names no entity.** A loaded unit is shared by every object of
  a class and its `env` is fixed when the unit loads, so a per-entity
  `ctx.exports.CodeHost({ props: { name } })` in the unit's `env` would give every
  later entity the first one's root (the `owner-v1` unit of
  `ownerKernelPathCelld.test.ts` has that flaw, which the probe did not
  exercise). `CODE_HOST` is one unnamed service binding in every regular unit's
  `env`. What selects the root is a **proof** the root puts in the facet's
  `props` (`codeHost: { name, proof }`, an HMAC of the root's name under the
  runtime's loader secret): `CodeHost` verifies it and hands the request to that
  root only. A hosted class's unit gets no `CODE_HOST`, so code does not host
  code. Props are per facet, so one isolate still serves every entity.
- **Two manifests decide the grants, not a capability request.** The hosting
  class declares `vibestudio.durable.classes[].hosts: [{ source, className }]`; the hosted
  class declares `.hosted: { storage: "dolt", doltLocal, codegen, residency, limits: { cpuMs } }`
  (`HostedClassManifest`, `packages/shared/src/types.ts`). Nothing else grants:
  the host (`RuntimeManager.admitHostedCode`, route `/_dohost/<source>/<class>?host=<root key>`,
  reached only with the UniversalDO class's own secret) refuses a class the
  host does not declare (`EACCES`) or one not marked `hosted` (`EINVAL`).
  A capability request in `authority.requests` would have gone through the build's
  static authority analysis, which has no call to analyse here.

Mechanics, each checked on the real fork (`universalDoHost.test.ts`, "hosting
code in an entity"):

- The UniversalDO class is deployed with `codegen` and `residency`; its loader
  puts `celld: { codegen, residency }` and `limits: { cpuMs }` on a hosted unit
  only. The unit key carries the grants, so the same code with another grant is
  another isolate. The entity's own `do` facet still cannot compile.
- `UniversalDO` keeps a map of hosted instances by the entity's name for them
  (`code:<name>` facets, remembered in a root table so retirement deletes every
  facet's storage), takes the residency hold when the class declares it, and
  registers the `onrevoked` handler that calls the class's `__hosted/__revoked`
  (the facet's own does not run). A refused hold warns and the class runs
  unheld.
- **The call route.** `hostCode` returns `{ call(method, ...args), release() }`.
  A call is a POST of `{ args }` to `/<name>/__hosted/<method>` on the facet, which
  only the root can name, so the class serves any `@rpc` method of its own
  without a caller check (`serveHostedCall`, refused unless `ctx.props.host` is
  set, so an ordinary object cannot be driven through it). Arguments and results
  use the RPC JSON codec.
- **Identity.** The host puts `host: { entityId, token }` in the hosted class's
  props (an entity-pinned token, minted as `evalService.mintGatewayToken` did);
  the base presents `entityId` and the token on outbound RPC. The hosted class
  therefore acts as its entity: its context, lineage and sealed authority are the
  entity's. Its network effects are attributed to its own class's egress identity.
- **Both bases**: one helper (`packages/durable/src/codeHost.ts`, export
  `@vibestudio/durable/codeHost`); Base's `durable-base.ts` now has `dolt`,
  `committedTransaction`, `transactionSync`, the local nonce table and the
  `DirectCallNonceGate` of §4.2, so a Base class can be a Dolt class.
  A product class has no `ctx.props`; both bases read it defensively (the first
  version did not, and the product DOs failed on `undefined.host`).
- **A planned restart does not wait for a held cell** (celld `ec0d6f5`). Before it,
  a cell with a residency hold was not at a swap safe point, was quiesced, and waited
  for `CELLD_DEPLOY_MAX_AGE_S` (60 s) before the age rule revoked the hold, so the
  drain test took 63 s. A swap now revokes the holds of a cell that is otherwise at
  a safe point at once (`onrevoked` runs with reason `"swap"`), so the test takes
  about 2 s. A cell with a request in flight or an open WebSocket still waits, as it
  must. No `CELLD_DEPLOY_MAX_AGE_S` setting is needed (none was ever committed).
- **A call can carry a CPU limit** (celld `ec0d6f5`, third argument of
  `ctx.facets.get`). `hostCode(...).limited({ cpuMs })` returns the same hosted
  class whose calls carry the limit through the root (`CodeHostInput.limits`,
  validated as positive integers). §7.8 has what it bounds.
- **Session entities (step 3c, as built).** `SessionDO` (Base `workers/session`)
  is a plain SQLite entity that hosts one kernel with `hostCode` (its manifest
  declares `hosts: [workers/eval-kernel:EvalKernel]`). It is created by
  `evalService` through `runtime.internal.createEntity` as a `do` with the owner as
  parent (`stateArgs`: `principalId`, `ownerPrincipalId`, `subKey`,
  `agentExecutionAdmission`, `lifecycle`), keyed by `evalHostObjectKey(owner,
scope)` (`packages/shared/src/evalRuntimeIdentity.ts`; the runtime id is
  `do:workers/session:SessionDO:<key>`). A verified caller that is not the owner
  (an agent relay, a shell selecting a live session owner) acts for the owner
  record, so the parent is always the owner and the lineage
  `resolveParentPanel` walks is kept. The class authenticates its caller (its
  principal, or the host service acting for it), relays the §7.5.1 contract with
  the nonce of the run named (it keeps `(runId, nonce)` in a local table), relays
  the entity's lifecycle to the kernel (`lifecycle`), and has one host-only path,
  `settle`, for the push model's settlement calls (below). The identity checks of
  the host that named the product `EvalDO` (principal identity, kernel
  authority, event ingress, execution roots, approvals, webhooks, the authority
  observer) recognise this entity (`isEvalHostRecord`). The owner with no code of its own
  (a user or CLI session) is mediated by the session class's sealed image.

### 7.3 One admission step for all dynamic code

A kernel cannot mint its own execution session, so "no host check" holds for
**reachability** (§7.2), not for **authority**. The per-run admission is one
host function, `admitDynamicCode`
(`src/server/services/dynamicCodeAdmission.ts`), called once for every run of
dynamic code, eval or not:

| Part of the admission                                                                                                                                                                                             | Source today                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| the run's authority **intent** and `normalizeAuthorityManifest` (`effects`, requested capabilities, the allowlist)                                                                                                | `evalService.prepareRun`, `normalizeAuthorityManifest` |
| `preauthorize` of exact prospective operations through the dispatcher's authorization-only path                                                                                                                   | `prepareRun`, `deps.preauthorize`                      |
| **execution-session** admission and **task-authority** registration (`executionSessions.admitWhenAvailable`, `taskAuthorities.bind*`), including the mission, test policy, attached-host and parent-session facts | `prepareRun`                                           |
| the **causal parent** an agent-bound run must carry, and the check that it belongs to the relay's host-bound trajectory                                                                                           | `prepareRun`                                           |

It takes the verified caller, the hosting entity (the session's `runtimeId`) and
the run's intent, and returns the **session nonce** that the kernel call
carries, with a `release` that closes the session. Every dynamic-code run goes
through it, so `eval-exact-authority`, `eval-pregranted-only` and
`eval-preauthorization` keep one path. The caller (the entity, or the CLI's
service handler for a session entity) calls it, then calls the kernel with the
nonce.

What leaves `evalService` and is **not** part of the admission: owner
resolution for four caller kinds (the entity now names itself), `ensureEvalDO`,
the per-owner gateway token (the kernel authenticates as its root), dispatch,
`activity` leases and `resolveContextSource`'s consumer wiring (the entity
resolves exact source by the host service it already calls).

### 7.4 Heap residency

- **The heap is held explicitly.** A hosted class takes a hold when `hostCode`
  starts it and releases it at `release`, at `reset`, at retirement of the
  entity, or when its owner releases it. celld never ends a hold by timer.
- **Revocation.** On drain, swap or operator revocation the **root's**
  `onrevoked` persists each hosted class's scope snapshot (the existing
  `scopeManager` persistence) through its `persist` method. The next run reports
  `[kernel] Restarted` with the exact restored and lost keys, which is today's
  restart contract.
  - The handler is registered by the root, not by the hosted class. The
    hosted class is in its own isolate, and the fork does not run an `onrevoked`
    registered there (`residency.md`, "Facets"). Probed on the fork
    (`doltEvalKernelCelld.test.ts`): a drain ran the root's handler, which
    called the facet to persist and commit, and did not run the facet's own.
- **When the node's budget refuses a hold** (`ERR_RESIDENCY_BUDGET`), the run
  proceeds without one. The heap may be lost at eviction, and the restart
  report states it. The refusal is explicit, never silent.
- **There is no idle policy (Q3, decided).** A heap is held until an explicit
  end. The node's residency budget bounds the total. The 30-minute idle TTL of
  `EvalDO` is deleted, not ported (P2a did this).

### 7.5 Calls: pull, with an events stream

- **A caller awaits the call or re-queries by run id.** The kernel's `start`
  returns once the run is durably accepted; `await(runId)` blocks until the
  terminal row and returns it; `get(runId)` and `receipt(runId)` re-read it.
  The result is a committed row in the kernel's Dolt storage (`eval: <runId>
<status>`), so a restart of the caller, the entity or the node loses nothing
  that was committed, and a caller that comes back reads the row.
- **Progress** (console, tool-call and state events) goes through the kernel's
  `events(runId, afterSeq)` stream, paged by sequence number. A live consumer
  tails it; a late one reads from the row.
- **The kernel and its entity share a cell** (a facet is part of its root, C7)
  and fail together, so there is no redelivery protocol to keep.
- **Deleted with the push model:** `resultReceiver` and its contract check,
  `onEvalComplete`, `onEvalProgress`, the event-sink push routes
  (`evalEventIngress`, `eventSinks`), `acknowledge`, `eval_result_redeliveries`
  with its 5 s to 5 min backoff and its alarm.
- **Consumers of the push model** were Base's `agentic-do`
  (`native-eval-tool.ts`, `native-agent-owner.ts`, `agent-vessel.ts`,
  `rpc-contract.ts`), `harness/src/tools/eval.ts`, the CLI (`evalCommand.ts`),
  the natlang panel, the system-test runner and the website acceptance spec.
  All of them pull now (§7.5.2); none of the deleted pieces has a caller.

#### 7.5.1 The kernel call contract (decided 2026-11-14, before step 3c and 4)

A kernel is a hosted class (§7.2). Nothing but its hosting entity's root can
name it, so **reachability is structural** and the host does not check it. This
subsection fixes what the kernel itself accepts. The methods are ordinary
`@rpc` methods of the class, reached through `hostCode(...).call(method, ...args)`;
every argument and result uses the RPC JSON codec.

| Method                                                                                            | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start(input, caller)`                                                                            | Durably accepts one run and returns `{ runId, runDigest, status, existing, scopeInputRevision }`. It returns **after** the accepted row is committed (`eval: <runId> accepted`) and **before** the cell runs: the run executes in the kernel's own lifetime (`waitUntil`), never inside this call. Idempotent on `runId`: a replay with the same input returns the existing row; the same `runId` with different input is refused (`EINVAL`). |
| `await(runId, { waitMs? }, caller)`                                                               | Blocks until the run is terminal or `waitMs` (default 30 s, at most 120 s) passes, and returns `{ status, result?, progress? }`. A timeout is not a failure: the status is non-terminal and the caller calls again. The terminal result is the committed row, so a call that arrives after a restart of the caller, the entity or the node reads the same value.                                                                              |
| `events(runId, { after, limit }, caller)`                                                         | Pages the run's event log (console, tool-call, state, checkpoint and diagnostic events) by sequence number: `{ events, next, hasMore }`, 256 per page at most. A retention gap is reported as a `diagnostic` event with the sequence to re-read from. A live consumer re-calls with `next`; a late one reads the log from 0.                                                                                                                  |
| `cancel(runId, caller)`                                                                           | Ends the run through the kernel's abort path and returns `{ ok, forcedReset }`. A terminal run answers its terminal state (it is not an error); an unknown run is `ENOTFOUND`.                                                                                                                                                                                                                                                                |
| `get(runId, caller)`, `receipt(runId, caller)`                                                    | Re-read the row and its result receipt.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `reset(caller)`, `readScopeTextPage(key, offset, limit, caller)`, `deleteScopeValue(key, caller)` | Scope-level controls; they name no run.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `persist({ reason })`                                                                             | Not callable by an entity: the root's `onrevoked` handler calls it on a drain or swap (§7.4).                                                                                                                                                                                                                                                                                                                                                 |

**`caller`, and the kernel's own check.** Every control method takes one
argument that says who the hosting entity is acting for:

```ts
type KernelCaller =
  | { kind: "host" } // the hosting entity acting for itself
  | { kind: "session"; admissionNonce: string }; // a session entity acting for the principal it serves
```

- **The hosting entity itself (`host`).** The kernel can only be reached through
  the root of the entity that hosts it, by that entity's own `CODE_HOST`
  binding. A call that arrives is therefore from the hosting entity, and the
  kernel serves it for every method. An agent, a worker or any other entity that
  hosts its own kernel calls it this way; it needs no nonce, because it is the
  only principal the kernel has.
- **A session entity acting for its principal (`session`).** A session entity
  (§7.2) serves a principal that is not itself: a panel, the CLI, the
  system-test runner. The session class authenticates that principal first (its
  own `stateArgs` name it, and its caller must be it or the host service acting
  for it). It then relays with the **admission nonce** that the one admission
  function (§7.3) returned for the run. The kernel keeps the nonce with the run's
  admission arguments (`executionSessionNonce`, as today) and checks it, as a
  digest in constant time, on every run-scoped method (`await`, `events`,
  `cancel`, `get`, `receipt`). `start` requires the run's own nonce to be the
  one the session presents; a replay of a run that has not begun (`pending` or
  `cancelling`) may carry a fresh admission (the host re-drives a start after
  a restart), and a replay of a run that has begun is refused (`EACCES`)
  unless it carries the run's own nonce. Scope-level methods take the nonce of
  any run of this kernel, or none while the kernel has no run.
  The nonce is a host-minted, per-run secret that the execution-session registry
  already binds to the run's principal, so a session class that holds a nonce
  for one run cannot name another run it did not admit. After the run has ended
  the registry no longer honours the nonce for effects, and the kernel still
  accepts its digest for **reading** the committed row; the session keeps
  `(runId, nonce)` in its own local table so a principal that comes back after a
  restart can pull.
- **What the check does not do.** It is a second, independent check behind the
  session's own, not a defence against a compromised session class: that class
  can claim `host`. The session class is part of the reviewed Base template, and
  the manifests (`hosts`, `hosted`) bound what it can host.
- **Authority is separate.** None of this says what the run may do. Outbound
  calls from the kernel carry the nonce (`bindExecutionSession`); the host
  authorizes each one against the admitted session (§7.3).

Events and progress are rows, not pushes: `run_events` is appended in the same
transaction as the state it describes, and a consumer that wants "as it
happens" polls `events` or issues `await` with a short `waitMs`.

#### 7.5.2 As built: the pull callers (2026-11-15)

**The host service `dynamicCode`** (`src/server/services/dynamicCodeService.ts`, schema
`packages/service-schemas/src/dynamicCode.ts`) has four methods and is the only host surface a pull caller uses:

| Method    | What it does                                                                                                                                                                                                                                                                                                                         |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `admit`   | The one admission (§7.3) plus what only the host knows: owner resolution, the session entity (created through `runtime.createEntity` when absent), exact source, the owning panel, the harness identity, the run digest. Returns `{ runId, runDigest, authorityManifestDigest, host, hostId, nonce, start }`; **it starts nothing**. |
| `release` | Closes the run's execution session and activity lease. Only the admitting caller (or the host) may; unknown or already released answers `released: false`.                                                                                                                                                                           |
| `reset`   | The scope reset, behind the `code-runner.reset` approval (critical). The session's own `reset` is host-only, so no principal can reach it without the gate.                                                                                                                                                                          |
| `dispose` | Retires a scope declared `finite` at creation, through the host lifecycle owner.                                                                                                                                                                                                                                                     |

The caller then talks to the hosting entity, never through the host: `start(input, nonce)`, `await(runId,
{ waitMs })`, `events(runId, { after, limit })`, `cancel(runId)`, `get`, `receipt`, `readScopeTextPage`,
`deleteScopeValue` (the session relays them with the run's nonce; §7.5.1 is the contract). The session accepts its
principal, the host, and the user's own shell (the host's rule for a shell selecting a live session owner at
admission); its run-scoped methods are website-eligible because the principal it serves may be a website. One
client composes it: `createDynamicCodeExecutor(rpc, { signal, onEvents })` (admit, start, tail `events`, `await`,
release; abort cancels on the entity), and `startDynamicCodeRun` + `createDynamicCodeRunObserver` +
`createDynamicCodeScope` for a caller that outlives one call (the system-test runner keeps the entity's id and
pulls from a later activation).

**A pull caller has no event sink** (the `eventSinkNonce` of the admission and the executor fact is gone), so
nothing tells the host that its run ended. The execution session is released by `release`; if the caller died
between `admit` and `release`, **the admission of the next run reconciles**: a run that waits for the entity's one
live admission asks the hosting entity (`get`, a pull of the host's own) every 2 s whether the holder ended and
closes it when it has, or when the entity never heard of it for 30 s (the caller died before `start`). A held,
running run is never taken.

**Callers moved** (each with its gate in `HANDOFF-dolt-redesign.md`): the CLI (`vibestudio eval run`,
`repl-reset`: `evalCommand.ts`; the approval observer reads `authority-requested` and `authority-decided` from
the pulled events; `mobile-smoke.mjs` only runs the CLI), the natlang panel (`runtimePorts.ts`), the system-test
runner worker and the harness probes (`probeEvalCancellation`, `probeEvalEventPages`, the new
`probeEvalDeadlineRecovery`), the agent, and the website acceptance spec (below).

**The agent pulls too** (Base `packages/agentic-do`, 2026-11-15). The owner is durable and may restart in the
middle of a run, so its pull is a durable background task and the receipt is accepted in one transaction:

- `native-eval-tool.ts` `execute`: `dynamicCode.admit`, then `start` on the session entity (the same
  `startDynamicCodeRun`, with `keepAdmissionOnFailure` so a lost start response is retried under the same
  admission), records the run's digest in its retained admission document, reads `receipt`; a run that is
  already terminal is accepted at once, otherwise it creates the **`vibestudio.eval-await` task** (once; the
  admission document remembers its id) and parks the tool call on the receipt wait it always had.
- **The await task** (`native-eval-receipts.ts` `createNativeEvalAwait`, `background: true`) pulls `await` and
  `events` from the session entity for at most 15 s, hands each page of events to the vessel
  (`publishEvalEvents`: console becomes `invocation.output`, authority events become `invocation.progress`),
  checkpoints the last handed-over sequence, and then sleeps 0.5 s (`sleepUntil`) so that the owner's wake-up
  pass, which waits for every live invocation, is never held for the length of a run. A failed pull sleeps and
  retries with backoff (2 s to 60 s); a refusal that retrying cannot change (`ENOTFOUND`, `EACCES`, `EINVAL`,
  or a run its kernel does not know) is parked as an exact repair incident. On a terminal row it releases the
  admission and commits, in **one transaction**, the receipt acceptance that resolves the parked call, the
  acknowledgement task, and its own completion. A restart of the owner finds the task still live and pulls
  again: the committed row is read once, the receipt is accepted once, the cell is not started again.
- **Acknowledgement** is `SessionDO.acknowledge(runId, identity)`, a relay to the kernel's
  `acknowledgeRunResult` under the run's nonce, called by the existing acknowledgement task. It is the
  durable record that the owner consumed exactly this result; the kernel refuses a changed result afterwards.
- **Cancellation** (`cancel` of the tool, and the chat pill's `cancelEval`) is `cancel` on the entity, a
  `receipt` read, the receipt accepted, and `release`.
- Gone from the agent: `resultReceiver`, `onEvalComplete`, `onEvalProgress`, `consumeEvalReceipt`, the
  completion hint's caller checks. Gone from the kernel: the console streamer, the progress push, the live
  event push to the ingress, `failPendingRun`.

**What the host keeps, and why it is not delivery.** Two interlocks involve facts only the host holds, and
they are calls from the host to the hosting entity, never a result or event delivery to a caller:
(b) the authority events its observer sees (`EvalAuthorityEventJournal` calls the session's host-only
`recordAuthorityEvent`; the kernel stores them in `run_events` so every puller already sees them in `events`),
and (c) the publication interlock for workspace bundles a notebook imports (`evalExecutionRoots.retain`
calls the session's host-only `retainExecutionRoot`; the root provider lists `executionRoots`). The earlier
string-dispatched `settle` is gone. Moving (b) to a pull (the kernel asking the host for the events of its
runs on each `events` call) costs a host round trip per poll and a second cursor, and was not done.

### 7.6 Eval is ordinary code

- **The kernel class** (`EvalKernel`) lives next to the engine in Base
  (`packages/eval`; `EvalDO`'s engine is already workspace-owned through
  `providers.evalEngine`). It is a class like any other: no
  `internalDOExecutionIdentity`, no `hostOnly` method authority, no entry in the
  product-builtin catalog, no host-only schema in
  `packages/service-schemas/src/evalEngine.ts`. Its methods are ordinary
  `@rpc`/schema methods callable by the hosting entity.
- **A manifest declares it.** The hosting entity's manifest names the kernel
  executable and the `codegen` and `residency` grants (D5 mechanics: the
  `celld` options flow through `loadExecutable`'s admission). The product
  builtin flag `runtime.code-execution.manage` and the 18 `direct:...EvalDO...`
  ledger rows go; an ordinary capability with an approval replaces them.
- **The engine and runtime providers** (`INTERNAL_DO_ENV` today) become the
  manifest's provider bindings, as any dynamic worker's are.
- **SES `lockdown()` stays in the kernel isolate.** Kernels of every entity that
  uses the same executable share one loaded-worker isolate per version, so
  frozen intrinsics still prevent cross-entity prototype pollution. The guest
  facade (`evalConfinement.ts`, 387 lines) stays, so guest code cannot reach the
  kernel's journal. `new Function` runs inside the confined realm.

### 7.7 What a kernel's state is (Dolt)

- **Versioned:** `runs`, `run_events`, `run_checkpoints`, `run_progress`,
  `run_result_artifacts`, `repl_scopes`, the user's `db` tables and
  `eval_execution_roots`. The kernel is a transactional class (§4.2): one commit
  per finished run (`eval: <runId> <status>`). That gives "scope and db as of run
  R", and `reset` is `reset({ hard: true, to: <schema commit> })`.
- **Local:** in-flight cancellation bookkeeping, and the replay-nonce ledger.
- **Forks.** A forked entity forks its hosted classes' durable state with it
  (F3). Heap state is never forked.

**Measured: the Dolt write cost of one kernel run** (2026-11-14, celld `ec0d6f5`,
`VIBESTUDIO_DO_CALL_TRACE=all`, a `vibestudio eval run` of `return 1 + 1` twenty times in
one session of a fresh instance, the node under `strace -f -e fsync,fdatasync,sync_file_range`;
an idle 20 s window as the baseline: 0.95 flushes per second for the whole node):

| What                                                                        | Per run                                                                                                                                                                          |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| flushes (`fsync`) of the kernel's own cell file (`db.sqlite`)               | **11.0** (220 over 20 runs)                                                                                                                                                      |
| of which named commits                                                      | 2 by construction (`eval: <runId> accepted`, `eval: <runId> done`); the other 9 are writes outside a commit (run events, checkpoints, state), each its own transaction and flush |
| flushes of the node index WAL (shared by every cell, so an upper bound)     | 5.0 (99 over 20 runs)                                                                                                                                                            |
| replication segments written (`ltx`)                                        | about 0.25 (the node batches them)                                                                                                                                               |
| the session entity's own SQLite cell                                        | 0.15 (3 WAL flushes in the window)                                                                                                                                               |
| `SessionDO.start` (route, hold check, `accepted` commit, schedule)          | 78.7 ms mean                                                                                                                                                                     |
| the pull until the terminal row (`get`: execution plus the terminal commit) | 121.5 ms mean                                                                                                                                                                    |

At 6.5 ms per commit-sized flush (§4.2: write 6.5 ms, one root record, one flush) the 11 flushes are
about 70 ms of the 200 ms from accepting a trivial run to its terminal row, a third. **The lever is
not the two commits but the nine uncommitted writes**: wrapping the run's lifecycle writes in the
transaction of the commit they precede (the `accepted` row with its two state events; the terminal
row with its events) would take the run to about 4 flushes. It is a kernel change, not measured
beyond this count, and not made here. A run with many outbound calls pays one more flush per
checkpoint (not measured).

### 7.8 Host-process safety (D4): measured

The host's per-run liveness supervisor exists because a synchronous guest loop
starves a whole isolate, and the only recourse was to have the host replace the
node (`recoverUnresponsiveSandbox`), which kills every object. Probed on the
real fork (`src/server/celldCpuWatchdogCelld.test.ts`, a Dolt facet in a loaded
worker, one object):

| Setup                                                             | Result                                                                                                                                                                                                          |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `limits: { cpuMs: 1000 }` on the loaded worker, a call that spins | the call fails after **1004 ms** with `Worker exceeded CPU limit of 1000 ms`; the owner's root answers in 2 ms; a sibling object's kernel answers; **the same kernel serves the next calls and keeps its heap** |
| the same limit, three calls of 200 ms CPU each                    | all succeed: the limit is **per invocation**, not cumulative                                                                                                                                                    |
| no limit, a call that spins                                       | **never ends** (the probe's 8 s window); a sibling object is unaffected, only that isolate is starved                                                                                                           |

So celld's per-isolate limit **covers a CPU-starved loaded worker** and ends only
the starving call, which is strictly better than replacing the node. The one gap
of the first measurement, that the limit was the loaded unit's `limits.cpuMs`,
fixed at load, and not a run's `timeoutMs`, is closed by celld `ec0d6f5`: a
limit on **one call**, the third argument of `ctx.facets.get(name, startup, { limits })`.
The root takes the stub for each call, so the facet is not restarted and the
kernel keeps its heap. Measured (same probe, no unit limit):

| Setup                                                                                                  | Result                                                                                                                              |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| no limit at all, a call that spins                                                                     | never ends (the 6 s window)                                                                                                         |
| the same call through a stub with `limits: { cpuMs: 1500 }`                                            | fails after **1658 ms** with `Worker exceeded CPU limit of 1500 ms`; the same kernel answers the next call with its heap            |
| a call that answers at once and spins under `ctx.waitUntil` (what a kernel's `start` does), same limit | `start` answers in 130 ms; the next call to the kernel is answered after **1472 ms**: the limit of the call bounds the work it left |

So `start` carries the run's `timeoutMs` as its CPU limit
(`kernelStartLimits`, Base `workers/eval-kernel/contract.ts`, applied by
`hostCode(...).limited`), and a run's own timeout timer, already due when the
spin is ended, settles it. The decision:

**What the product kernel did after the limit ended its run, and the fix (celld `2d1749d`, Base `bd89d94`).**
`vibestudio eval run` of `while (true) {}` with `--timeout 4000` on a fresh instance, kernel as first built:

- the spin ended at about 4 s (`celld::ops: an op was handed to an event that no longer takes ops`): the
  limit worked, but the deadline timer's continuation was dropped with the ended event, and **the next
  `eval run` of the session never returned**. The cause had two parts. celld discarded the pending ops
  (timers, subrequests, reads) of a CPU-limited event (fork finding E12), and, once they survive, the kernel
  still awaited the run's promise, which a unwound JavaScript stack never settles, so the run chain (one
  scope runs one cell at a time) never advanced (fork finding E13 is the sibling case, a termination
  inside a transaction).
- celld `2d1749d` keeps a limited event's pending ops, so the deadline timer fires after the limit and its
  abort is delivered. `probe: a run ended by its call's CPU limit is settled by its own deadline timer`
  (`celldCpuWatchdogCelld.test.ts`, real fork) pins it: the run is settled at the deadline's turn, about
  1.5 s after a 1.5 s limit, and the kernel answers the next call.
- the kernel (`EvalKernel.awaitRunOrAbandon`) no longer awaits a run past its **deadline abort**: after the
  abort and the cleanup handlers, the guest has `OVERDUE_RUN_GRACE_MS` (1.5 s) to unwind; if its promise has
  not settled it is abandoned, the run's row takes the typed `eval_deadline_exceeded` result, and the run
  chain is released (a per-run `abandoned` promise races the run in `runChain`), so the runs queued behind it
  and every later one are admitted. A user cancellation keeps its own bounded recovery (`cancel`'s
  force reset); only the deadline abort abandons.
- verified on the product: spin with a 4 s timeout, then `eval run` of `return 40+2` on the same session
  answers in 5.9 s with the same kernel incarnation (the heap is kept); the server log has the one
  warning `did not unwind within 1500ms of its deadline abort; abandoning it`. The system scenario
  `eval-deadline-recovery` (system-testing template, `probeEvalDeadlineRecovery`) does the same through
  the pull model. (The earlier note that `eval repl-reset` never returned was a critical approval,
  `code-runner.reset`, that a bare CLI has nobody to answer; it was not a wedge.)

What was built before the fix and stays, each tested: the kernel settles an overdue run on the next pull
(`reapOverdueRuns`, for runs with a `timeoutMs`; a run with none is ended by `cancel`); a hosted instance can
be restarted without losing its storage (`hostCode(...).restart()`, root op `restart`), and `callOrRestart`
asks for that when a call overruns a generous budget and answers the caller with `EUNRESPONSIVE`.
`recoverUnresponsiveSandbox` (node-level) is the only recovery if it is the whole cell that stops, and no
caller has it.

- the executable admission sets `limits.cpuMs` for every unit that holds
  `codegen` (a bounded CPU budget per invocation, a manifest value; the kernel's
  is 600000 ms): it is the ceiling, and a run's `timeoutMs` is the lower limit;
- the per-run liveness supervisor (the 5 s probe, `superviseIsolateLiveness`) is
  **deleted**, with its `activity` lease;
- `recoverUnresponsiveSandbox` stays as a node-level watchdog call for what the
  limit cannot see (a hung runtime that burns no CPU). The root's or the node's
  watchdog calls it, not a per-run loop.

### 7.9 Trust model

- **Codegen confinement is enforced by the runtime, per isolate** (§7.2). Only
  the hosted class's loaded-worker isolate can compile. The entity, the root's
  other facets and every other isolate refuse `eval`, `new Function` and
  WebAssembly compile.
- **Authority.**
  - The kernel calls host services as its hosting entity (its root's entity
    identity), carrying the run's execution session nonce from §7.3.
  - Egress from guest code goes through the egress hook. The loaded worker's
    identity names the class and the root, and the proxy attributes it to the
    entity (A1, fixed).
  - The owner-scoped gateway token minted by `evalService` goes.
  - The host never authorizes "may this caller reach that kernel": only the
    entity can. It still authorizes **what the run may do** (§7.3).

### 7.10 Migration (D5)

Legacy `EvalDO` objects are **not** migrated into a Dolt kernel (a cell's engine
is fixed at creation, and `celldMigration` imports product objects into SQLite
cells). Scope state is soft, and a run receipt of the previous generation is not
needed once pull delivery exists. What is dropped: the notebook scopes (values
and `db` tables) of every legacy `EvalDO`, and the receipts of runs that had not
been acknowledged when the workspace migrated. The retired cells are deleted by a
later release, as `WorkspaceDO`'s are.

**The restart report is a message the user sees, not prose.** The next run of a
scope that had a legacy notebook carries it in its result:

- **Detected by the admission.** The retired entity is `do:vibestudio/internal:EvalDO:<key>`
  with the same `<key>` as the new host (`evalHostObjectKey(owner, scope)`;
  `legacyEvalDoRuntimeId`). The one admission function (§7.3) reports
  `legacyNotebookDropped` when that entity is still recorded `active` in the workspace
  entity store, and the call into the kernel carries it (`RunArgs.legacyNotebookDropped`,
  host to kernel only).
- **Said once by the kernel.** `kernelStatusForRun` puts `legacyNotebookDropped: true`
  on the first result's `kernel.event` (kind `restarted`, so the existing restart
  notice also appears) and records in its own state that it did, so a later restart
  of the heap does not repeat it (`evalKernelStatusSchema`).
- **Shown by every surface of the result.** The agent's eval tool text (Base
  `harness/src/tools/eval.ts`) adds: `[kernel] This notebook was upgraded: scope values
and db tables from the previous version (its EvalDO) were not carried over and are gone.
Rebuild what you need from stable IDs, files, or durable records ...`, directly under
  `[kernel] Restarted`, which is the surface the user and the agent read. Tests: the
  admission (`dynamicCodeAdmission.test.ts`), the service (`evalService.test.ts`), the
  kernel (`EvalKernel.cancel.test.ts`) and the tool (`eval.test.ts`).

### 7.11 What this deletes

| Removed                                                                                                                                                                                                          | Lines                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `src/server/services/evalService.ts` (owner resolution, `ensureEvalDO`, token minting, liveness supervision, kernel lease touch); about a quarter remains as `admitDynamicCode`                                  | 1,247, ~300 kept         |
| `evalKernelLease.ts` (done in P2a), `evalKernelAuthority.ts`, `evalAuthorityEventJournal.ts`, `evalExecutionRootsService.ts`, `evalEventIngressService.ts`                                                       | 163 + 38 + 82 + 95 + 182 |
| `EvalDO.ts`: host-only RPC wiring, redelivery, host-settlement paths (`appendAuthorityEvent`, `failPendingRun`), identity pinning, internal-DO packaging; the rest (~3,300 lines) moves to the Base kernel class | ~1,300 of 4,632          |
| `packages/service-schemas/src/evalEngine.ts` (18 host-only methods), the `evalEventIngress` and `evalExecutionRoots` schemas                                                                                     | ~420                     |
| authority ledger rows: 18 `direct:...EvalDO...`, 10 `host:eval.*`, 2 kernel callback rows, the `runtime.code-execution.manage` review entries                                                                    | generated                |
| `UNSAFE_EVAL` (already gone, P2a/cutover)                                                                                                                                                                        | 0                        |
| tests of removed paths (`evalService.test.ts`, ingress and roots tests, part of `EvalDO.redelivery.test.ts`)                                                                                                     | ~3,100                   |
| the per-run liveness supervisor and its `activity` lease (D4, §7.8)                                                                                                                                              | ~110                     |

**As done (2026-11-15).** Deleted: the `eval` host service and its file (`evalService.ts` is now
`dynamicCodeService.ts`, the `dynamicCode` service alone: admission, release, reset, dispose), the host tail and
its backoff redelivery, `resultReceiver`, `onEvalComplete` and `onEvalProgress`, `eval.acknowledge`, the
`evalEngine` schema (`EVAL_ENGINE_HOST_CONTRACT_VERSION` too: nothing compared it), `evalEventIngress` (the
service, its schema, the event-sink registry, the kernel's live push), `evalMethods`, `createEvalExecutor` and
the other push-era client helpers, `failPendingRun`, the string-dispatched `settle`, the `eventSinkNonce` of the
executor fact, ten `host:eval.*` and the `host:evalEventIngress.publish` review rows, and the three lease methods
(P2a). **Kept, with a different shape:** `acknowledgeRunResult` (the principal's durable acknowledgement,
through `SessionDO.acknowledge`), and `appendAuthorityEvent`, `retainExecutionRoot`,
`listRetainedExecutionRoots` (host-to-entity calls for facts only the host holds, now the session's host-only
`recordAuthorityEvent`, `retainExecutionRoot` and `executionRoots`; §7.5.2). Kept as the kernel's ordinary
methods: `start`, `await`, `get`, `receipt`, `events`, `cancel`, `reset`, `readScopeTextPage`,
`deleteScopeValue`. `eval_result_redeliveries` and the product `EvalDO` went with step 4; the legacy
`EvalDO` entity id survives only in the D5 migration (`legacyEvalDoRuntimeId`, the admission's
`legacyNotebookDropped`).

### 7.12 Order, and where P2b stands

Each step is a complete cut that keeps the system working.

1. **This section** (the design), its own commit. **Done.**
2. **The admission function** (§7.3): `admitDynamicCode` extracted from
   `evalService.prepareRun` with a general signature and its own tests;
   `evalService` calls it. **Done** (this pass).
3. **The hosting helper** (§7.2): the `CodeHost` entrypoint on `UniversalDO`,
   `hostCode` on both durable bases (Base's `durable-base.ts` also got the Dolt
   awareness it lacked: `committedTransaction`, the local nonce table, the
   call-nonce gate of §4.2), the manifest grants through the host's admission,
   and the root's `onrevoked`. **Done** (this pass, "As built" in §7.2).
   **Not done:** the session entities for panels, the CLI and the runner (they
   come with the kernel's call contract in step 4/5).
   3c. **Session entities** (§7.2 "As built"): `SessionDO`. **Done** (2026-11-14).
4. **The kernel class in Base** hosted through (3), replacing the product
   `EvalDO`. **Done** (2026-11-14): `workers/eval-kernel` (`EvalKernel`), the
   engine imported directly, a Dolt class that commits when a run is accepted
   and when it ends (`eval: <runId> <status>`), the §7.5.1 contract with its
   caller check, the realm locked down at load (`@vibestudio/shared/kernelRealm`,
   SES), the root holding residency and relaying a drain. The product class,
   its catalog entry, generated authority rows and `packages/builtin/src/eval-engine`
   are deleted. **Kept for step 5/6** (they are push, and the callers still use it):
   the kernel pushes live events to `evalEventIngress` and its progress to an
   agent's `onEvalProgress`; the host pulls a terminal row with `await` and
   delivers `onEvalComplete` to a receiver, with backoff until the receiver's
   acknowledgement (in memory: a restart of the host loses it; the kernel has no
   redelivery index and no alarm, since a facet has none); the host reaches the
   kernel's settlement paths (`appendAuthorityEvent`, `retainExecutionRoot`,
   `listRetainedExecutionRoots`, `acknowledgeRunResult`) through `SessionDO.settle`;
   `service-schemas/evalEngine.ts` still declares the old host-only table.
   **D5:** legacy `EvalDO` scopes and unacknowledged receipts are dropped: the
   new kernel starts empty. **Provider sources** are the template's own
   packages (`@workspace/eval`, `@workspace/runtime`, `@workspace/natlang`,
   `@workspace/cdp-client`), overridable by the class's env.
5. **Pull** (§7.5) for each consumer in turn, with the push machinery deleted when the last has moved.
   **Done** (2026-11-15): the admission as a host service (`dynamicCode`, §7.5.2), the CLI, the natlang panel,
   the system-test runner and its harness probes, **the agent** (an `eval-await` background task and
   `SessionDO.acknowledge`, §7.5.2) and the website acceptance spec (type-checked; it needs the desktop app
   and was not run).
6. **The liveness supervisor** went with step 4 (the kernel's unit carries `limits.cpuMs`; a run's `timeoutMs`
   bounds its call, §7.8); **`evalService` and the push machinery are deleted** (§7.11 "As done"). **Done.**
   Done since step 4: a run's `timeoutMs` bounds its CPU (§7.8, celld `ec0d6f5`), a run ended by its CPU limit
   is settled by its deadline (§7.8, celld `2d1749d`, Base `bd89d94`), the D5 restart report is a message
   (§7.10), the cost of a kernel run is measured (§7.7).
7. **Done** (2026-11-15, §6.11.6 "S6b, as built"): the agent hosts its own kernel (`hosts` in the agent classes'
   manifests, the host's manifest-based eval-host recognition, the executor fact `kind: "dynamic-code"`).

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

Approvals and provenance _inside_ a workspace stay where they are. An
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
  class. That RPC ships for exactly one release. **Built in P3 (§4.6):** the
  old class is read-only (`legacyManifest`, `legacyReadRows`), the host drives
  the import because the new class cannot address the old, the history is
  replayed as commits (Q2) and the move is verified by digest before it is
  settled.
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
  restart. _(If kernel `db` tables are considered user data, the default row
  copy applies.)_

Importers are deleted once the minimum supported version passes the flip.
That is the release policy in `durable-object-schema-migrations.md`.

---

## 10. Phases, gates and sizes

Sizes are in agent-days for one focused agent. _Estimates._ P1 (the fork side)
is **done**: F1 to F7 ship in `fcc7268`, and `9440c29` (pinned) fixes the hard reset and adds `ondoltpush` (§3). What remains is Vibestudio's.

| Phase                                | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Depends on                                              | Gate (executable)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Size            |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| **P0 Foundations** (`feat/dolt-p0`)  | `@vibestudio/durable/dolt` typed surface of the whole `ctx.storage.dolt` API (merge with resolver, `doltLocal`, remotes); `committedTransaction` on F2 (no roll-forward); schema install commits on Dolt (checkpoint before an upgrade, `schema:` commits); schema-guard filter (`_cf_`, `_litestream`, `dolt_`, `doltlite_`); framework tables local on Dolt; a `FakeDoltStorage` test double with its divergences documented                                                                                                                                                                      | none (the fork is delivered)                            | `vitest packages/durable`: commit points, `committedTransaction` atomicity (a throw leaves no rows and no commit), checkpoint before upgrade, failed upgrade commits nothing, filter, merge with resolver, local tables, remotes between fakes. Then a real-celld probe (`doltDurableCelld.test.ts`): a Dolt root class installs its schema, commits through `committedTransaction`, and survives a process kill and restart with `dolt.log()` correct                                                                                                                                                  | 3               |
| **P1 Runtime** (fork side)           | Dolt facets; F1 merge resolver; F2 commit in a transaction; F3 forks carrying facets; F4 local tables; F5 checkout cost; F6 history reads; F7 remotes                                                                                                                                                                                                                                                                                                                                                                                                                                               | fork                                                    | **Done** (`fcc7268`; `9440c29` adds the durable hard reset and `ondoltpush`). Open for P5: a Vibestudio-side test of the facet relay and `ondoltpush`, and the checkout budget below                                                                                                                                                                                                                                                                                                                                                                                                                    | done            |
| **P2 Eval kernels**                  | **P2a (done):** `ctx.residency.hold()` for the heap until an explicit end (Q3, no idle timer), revocation through `onrevoked`, the host lease and its three methods deleted. **P2b (open, §7.12):** general dynamic code. The hosting helper (`hostCode`, any entity, Dolt facet with `codegen` and `residency` from the manifest), session entities for panels, the CLI and the runner, one admission function (`admitDynamicCode`, built), pull delivery, the kernel class in Base with no special identity; delete `EvalDO`, `evalService`, the push machinery and the `evalEngine` host schemas | cutover, P0                                             | `pnpm test` for eval packages; system tests `eval-*` (heap retained across turns, cancel, restart report, large return) compared with the cutover numbers; a confinement probe (a userland object's `eval` throws, the kernel's works); a cross-owner probe (owner A cannot address B's kernel); `rg 'EvalDO\|evalService' src packages` is empty (`UNSAFE_EVAL` already is)                                                                                                                                                                                                                            | 8 (P2a about 1) |
| **P3 Durable services (done, §4.6)** | `WorkspaceDO` on Dolt; panel undo by reverse patch; backup, restore, reset and clone via Dolt; delete the maintenance journal, `cloneDO`, `durableObjectStorageClone.ts` and `computeWorkerdObjectIdHash`, and the lifecycle tables and driver if the cutover kept them                                                                                                                                                                                                                                                                                                                             | P2 (facet machinery proven)                             | `WorkspaceDO.test.ts` against `FakeDoltStorage`; system tests for panel close and reopen, `workers.resetStorage`, and a restore round trip; a fork-idempotency test (the same target id twice gives one object); `rg cloneDO\|do_maintenance` is empty                                                                                                                                                                                                                                                                                                                                                  | 6               |
| **P4 Agent system**                  | Channel and agent cells on Dolt with local tables; Pi local document tables; native conversation fork; delete the hash chain, knowledge export and import, and the clone paths                                                                                                                                                                                                                                                                                                                                                                                                                      | P0                                                      | Fork-and-subagents acceptance (§E3): edit-and-fork, a multi-agent fork, a subagent `mode: "fork"`, crash-resume of a fork op (kill between phases); hibernation tests (evict between turns, redelivery deduplicated); a fork at sequence N equals the parent's state at N (ledger, participants, agent anchors)                                                                                                                                                                                                                                                                                         | 12              |
| **P5 GAD, decentralized**            | Canonical Dolt database and participant work cells (§5.1); the state model, contexts as branches; integration by F1 merge, `pull` and `push` (§5.5); grants and approval as grant issuance (§5.6); work-cell create, retire (§5.7); a derived `commit_index`, `content_roots`; replay migration (Q2); delete the fact-map, radix and frontier machinery                                                                                                                                                                                                                                             | P0, P4 (agent forks), the two _to verify_ items         | The provenance plan's acceptance matrix (§14), re-expressed over commit hashes and passing in full; the decentralization gates of §5.13; replay equivalence: for each real workspace snapshot available, every legacy event's materialized tree hash equals the replayed commit's, and blame answers match on a sampled set; the **size gate** (a replayed workspace database and the fork latency at that size, recorded); checkout and merge benchmarks: checkout **p95 within 20 ms with `fsync` and 10k local rows** (the fork measured 14 to 16 ms), a context switch batched per participant turn | 20              |
| **P6 Chronolog capability**          | Chronolog node deployed per workspace node; the `chronolog` host service; key custody; invite and join; agent writes through approval; Chronolog authority for pushes into a shared GAD `main` (§8.4); the cross-workspace P2P carrier for Dolt remotes                                                                                                                                                                                                                                                                                                                                             | Chronolog fork phase 4, P0, the P2P cross-workspace run | Two workspace instances on two nodes: create a group, invite, write from both sides, see an owner-row rejection, run a replay flip (Chronolog's demo as a system test); a GAD push between workspaces authorised by group membership                                                                                                                                                                                                                                                                                                                                                                    | 8               |

**Critical path:** P0 → P2 → P4 → P5. Two pieces can run in parallel: P3
after P2, and P6 after P0 plus the cross-workspace carrier.

---

## 11. Risks

- **R1. Commit volume, chunk growth and checkout latency.**
  - Each channel append, GAD mutation and closed turn is a commit. GC rewrites
    the whole file (C5).
  - A context switch is a checkout, **7 to 15 ms with `fsync`**, not 2 ms.
    GAD batches a participant's writes per context.
  - _Mitigation_: measure in P4 and P5. The benchmark covers 10k commits per
    cell: latency, bytes per commit, GC time, and checkout p95.
  - Bytes are kept out of Dolt (§5.10).
  - _Measured at P3 (§4.2)_: the commit is about 1.3 ms and no extra flush; the
    cost is one root record, about three flushes, per transaction, and every direct
    call writes a replay nonce. Count transactions per call, not commits.
  - _Measured at P4 S2 (§6.8, handoff)_: the channel's write shape on a real Dolt facet costs about
    15 ms per event (two flushes), flat over 10 000 commits; about 24 KB on disk per 1 KiB event
    before gc, 12 KB after; gc of a 237 MB file takes 3.7 s. The agent cell is not measured (it is not
    on Dolt).
- **R2. Facet and remote paths not yet exercised by Vibestudio.** Dolt facets
  and F7 are delivered, but Vibestudio runs neither. _Mitigation_: P0's probe
  covers a Dolt root; P2 is the smallest facet consumer; the facet relay and
  the post-push notification (§3.2) are verified before P5.
- **R3. Semantic change in GAD integration (Q1, accepted).** Agents and
  skills learn that clean changes merge without per-change decisions.
  _Mitigation_: the P5 gate includes the skills documentation cutover
  (provenance plan §12).
- **R4. A held kernel pins its owner.** Memory per open notebook rises with
  the number of owners holding heaps, and with Q3 (no idle release) it
  rises until an explicit end. _Mitigation_: the node budget refuses
  explicitly (§7.4), and every end condition (dispose, reset, archive,
  revocation) releases.
- **R5. GAD replay cost.** Large workspaces may take minutes to replay.
  _Mitigation_: replay runs as a resumable import (commits are its
  checkpoints). Q2 chose replay.
- **R6. History is retention (L7).** A user who wants content gone must
  rewrite history. CAS bytes can be swept only after no retained commit
  references them. F7 has no force push, so a purge cannot be pushed:
  every cell holding the history must rewrite it. _Mitigation_: secrets
  never enter Dolt. A purge operation is designed in P5 and is not built
  before it is needed. `dolt_rebase` is not exposed (§3.2).
- **R7. A write outside `committedTransaction`.** F2 removed the crash window,
  but a class that writes versioned state with plain SQL leaves a dirty
  working set that the next commit sweeps in. _Mitigation_:
  `assertCleanWorkingSet()` in tests and in the dev host (§4.2).
- **R8. Engine maturity.** DoltLite 0.51 has no published test suite
  (fork design §7). _Mitigation_: the fork's harness, plus Vibestudio's
  probes. Determinism is not relied on outside Chronolog.
- **R9. Decentralized-merge hazards.**
  - _Fork cost._ A work cell is a whole-file copy. Mitigation: the size gate
    (§5.1); the sharding fallback.
  - _Publication contention._ Many participants pushing to `main`. Mitigation:
    only a hash comparison contends, a bounded `pull`+`push` retry, and
    per-participant `pub/` namespaces for everything else (§5.5.3).
  - _Divergent decisions._ The rule in §5.5.3.
  - _No push hook._ The canonical may learn late that `main` moved.
    Mitigation: a follow-up RPC and reconciliation from `hashOf("main")`
    (§3.2).
  - _Trust._ The canonical enforces only the fast-forward rule; the other
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
