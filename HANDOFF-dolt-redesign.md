# Handoff: Vibestudio Dolt redesign, P0, P2a, P3, the cuts of P2b and P4

Branch `feat/dolt-p0` (worktree `/home/werg/vibestudio-worktrees/dolt-p0`), cut from
`feat/celld-runtime` `db8e365fd`. Not pushed. Base template branch `feat/dolt-p2`
(worktree `/home/werg/vibestudio-templates-worktrees/base-dolt-p2`, **rebased onto Base `main` `d79b61f`
on 2026-11-15**, not pushed). system-testing template branch `feat/dolt-p2` (worktree
`/home/werg/vibestudio-templates-worktrees/system-testing-dolt-p2`, cut from its `main` `f611e7b`, in the
symlink root `root-dolt-p2`, not pushed). Fork binary: `unified-fork` `2d1749d`
(`native/celld/linux-x64/celld`, gitignored, copied from
`/home/werg/celld-harness-bin/celld-uf-2d1749d`, sha256 `3588aa0e...2776` in
`native/celld/targets.json`). The design is `docs/dolt-redesign.md`.

## State

| Step                                                                                                                   | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Design doc revised to the fork as shipped, GAD decentralized                                                        | done                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 2. P0 Foundations                                                                                                      | done and verified                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3. P2a: heap residency by a hold; the host kernel lease deleted                                                        | **done and gated** (below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4. P2b: general dynamic code (§7 rewritten 2026-11-14 to the user's decisions)                                         | **steps 0 to 6 done** (third pass, 2026-11-15, "third pass" below): the agent settles by pull (a background `eval-await` task and `SessionDO.acknowledge`), the website spec pulls, and the push model is deleted (`evalService` is `dynamicCodeService`, the `eval` service, `resultReceiver`, `onEvalComplete`, `onEvalProgress`, `evalEngine`, `evalEventIngress`, `settle`). **Not done:** the agent hosting its own kernel (optional step 4 of the task; documented in §7.12 item 7) |
| 5. P3 Durable services: `WorkspaceStateDO` (Dolt), the replaying import, the maintenance journal and `cloneDO` deleted | **done and gated**; the `panel-tree-navigation` "regression" was a pre-P3 gap in browser-panel agent calls ("P3 follow-up" below), and every call to a Dolt object costs about three flushes (measured, a decision for the user)                                                                                                                                                                                                                                                          |
| 6. P4 Agent system (2026-11-15)                                                                                        | **slices S1 to S5 done and gated, S6 partly done** (second pass, "P4 second pass" below): the hash chain is deleted (S1); the agent cell is a Dolt cell on Pi's composite storage (S3); the conversation fork forks the agents' cells at a commit (S4); a subagent fork is a fork of its parent's cell (S5); the executor fact is renamed (S6a). **Not done:** agent self-hosting (S6b). P5 onward not started                                                                            |

## P4 continuation (2026-11-17)

Resumed from `celld/docs/fork/HANDOVER.md`, single-track. Host starts at
`c8e2511a3`, Base at `adc9993`, system-testing at `1c16e49`, fork `75f1700`,
Pi `.dolt.5`. Main checkouts and the owner's processes remain untouched.

The first fresh instance, `p4-resume`, reproduced the stopped-sweep checks:

| Test | Run | Result |
| --- | --- | --- |
| `eval-exact-authority` | `st_84b1f7c8b339436da834e81c2893bfbb` | Pass, no tool failures, 102 s |
| `channel-envelope-inspection-bounded` | `st_f26e916dcac34837bb84ea9715ab98cf` | Pass, no tool failures, 51 s |
| `workspace-test-runner-extension` | `st_5b462797e7a44a89bf38fe2ec527ce84` | Fails: `fs.ensureMaterialized` rejects its own bootstrap with `ENOTREADY` |

**Authority validator defect.** The archived final-sweep failure
`st_bcaf1b4e2c9448d38c9dfaa01b2c07b2` is a false negative, not a model error:
the agent used the exact read-only request ceiling, read the permissions, and
returned `{count, rows}`. The result was bounded, with an object-shaped preview;
the validator accepted only arrays or bounded array previews. Its native
`permissions.inventory` receipt proves the completed read (383 rows). Other
archived failures really include `ERUNMANIFEST`; this finding does not reclassify
them.

The exact-authority and preauthorization validators now use schema-validated
native inventory receipts from each invocation's operation journal, independent
of guest syntax or returned shape. No prompt or authority policy changed. The
regression fails against the original validator; the focused semantic-validator
suite passes all 91 tests. Template typecheck passes all three configurations
with `GOMEMLIMIT=3GiB GOMAXPROCS=3`, under the required 6 GiB scope. Without the
native compiler limits it hit the scope's OOM limit twice; Node heap limits do
not control TypeScript 7's native compiler. Failed-run scratch was removed.

Committed locally as system-testing `f86aef1`, fast-forwarded onto both
`feat/dolt-p2` and `feat/dolt-p2-s4`. A fresh instance using the changed template
passed `eval-exact-authority` (`st_6388a0db940c408aa6743274b9b3fd96`, 116 s) and
`eval-preauthorization` (`st_3550bda20edc4696aff8d05fd1a9a729`, 106 s), both with
zero tool failures. `p4-authority-live` was stopped and joined.

**Context-materialization defect.** The test runner correctly calls
`ctx.fs.ensureMaterialized(request.target)`. `FsService.resolveContextRoot`
rejects a chained native extension when its context projection is absent,
before dispatching that explicit materialization request. This is an
infrastructure failure, not a model error. The repair resolves the scoped source
address without demanding a projection before the explicit operation can run;
scratch creation and the authenticated context binding stay in force. Three
regressions fail before the fix; all 77 filesystem-service tests pass after it.
Host typecheck (host, host tests, validation tooling, workerd programs) passes.
The exact real-stack repro now passes on a fresh instance:
`workspace-test-runner-extension`, `st_8b32df60809f47db8974c5fd3c72ca72`, 42 s,
zero tool failures. Full host lint also passes.

Further stopped-sweep checks on `p4-materialize-live`:

| Test | Run | Result |
| --- | --- | --- |
| `file-search-read-tools` | `st_8b1231d427d04d66b850f0f967e9112a` | Pass, no tool failures, 67 s |
| `worker-env` | `st_5fa7705623ee45079de8af85dd7eae19` | Fails, 116 s: first eval guessed the descriptor export and threw a guest `TypeError`; the agent then read the contract, observed the right value and destroyed the worker |
| `dynamic-workspace-service` | `st_c68edbcd7a1c41cfbb518a469412753a` | Pass, no tool failures, 178 s |

The `worker-env` failure was inspected immediately; bounded evidence is retained
in that run's `inspect-resume.json`. This is its required rerun of the prior
sweep failure. The test still rejects the unexpected guest error even though the
task eventually succeeded. No validator or prompt was weakened.
All five failures from the stopped sweep have now had their required rerun:
four pass (including the repaired workspace test); `worker-env` retains the
known model-error failure. The three instances used so far logged zero input-gate
refusals and zero saturated-cell warnings.

`pnpm check:commit` passes every check through host typecheck and lint. Its sole
failure is the pre-existing `format:check` in eight untouched files
(`celldMigration*`, `celldNode.test.ts`, `durableObjectCloneReceipts.ts`,
`dynamicWorkerHost.test.ts`, `hubServer.test.ts`, `nativeSqlitePayloadCelld.test.ts`).
Both changed filesystem files pass focused Prettier/oxlint. The commit uses the
handover's allowed `--no-verify` exception only for that formatting baseline.
`p4-materialize-live` was stopped and joined before these checks.

**Worker validator defect found while resuming the untouched lanes.**
`call-do-method` on `p4-workers-resilience`
(`st_a8783784b6794fae97bb06a153457f67`, 112 s) failed with no tool failures.
The model created the correct object with `stateArgs.probe`, called the actual
`inspectProbe`, observed its value, and retired it. Its creation cell and cleanup
cell each declared `const h`. The validator concatenated all cells before Babel
parsing, so the valid local declarations became an invalid duplicate binding and
it falsely reported missing state arguments. The check now parses each completed
eval independently. The cross-cell regression fails before the fix; all 25
worker-validator tests pass after it, including rejection of a duplicate binding
within one cell. Full inspected trajectory and bounded inspection are retained
as `trajectory-resume.json` and `inspect-resume.json` in the run artifacts.
The instance was stopped and joined before conventional verification; the other
three tests queued for that group did not start.
The fix is local system-testing commit `d21afc8`, fast-forwarded onto both
feature branches. Template typecheck passes all three configurations.
`call-do-method` then passed on a fresh instance, `p4-workers-resilience2`
(`st_e7a2b06975284012a58147baf19bff38`, 122 s), with no tool failures.

**Installed consumer validator defect.** The next case,
`installed-workspace-service-consumer`
(`st_cb7f1235a59844e0aaba8a8e36213a00`, 238 s), also completed with zero tool
failures but was rejected by a syntax-only predicate. Creation used `const h =
await workers.create(...)`; the agent retained it in `scope.workerHandle` and
called `scope.workerHandle.targetId` in a later eval. The validator required the
RPC receiver to use the creation cell's local variable. That redundant predicate
is removed: the existing native receipt join proves successful creation,
ordered invocation on the exact target under the same owner, result fingerprint,
and matching retirement. The regression fails before the change; all 25
worker-validator tests pass after it, including rejection of unrelated targets
and missing receipts.

The actual retained executions for all three validator defects were revalidated
against the fixed validators in the host-owned userland projection: **3 of 3
pass** (`eval-exact-authority`, `call-do-method`, and the installed consumer).
This is revalidation of captured real-stack evidence, not another model run.
The temporary local replay test was deleted; private trajectories stay with the
run artifacts. `p4-workers-resilience2` was stopped and joined. Neither of the
two resilience cases queued behind the consumer started.
This fix is local system-testing `ea84ad3`, fast-forwarded onto both feature
branches; template typecheck passes all three configurations.

**Harness resilience: 5 of 5 pass**, on fresh instance `p4-resilience`, one
test per invocation, concurrency 1, 420 s test bounds, fork `75f1700`:

| Test | Run | Duration |
| --- | --- | --- |
| `eval-thrown-error-then-continues` | `st_bf34a73da4cf4cd697010da5755312d8` | 39 s |
| `eval-huge-return-bounded-terminal` | `st_c1314a0dd5d94975bdeced137317d63d` | 59 s |
| `eval-timeout-error-visible` | `st_cd42295bc0be41f591ddcffa95c79589` | 57 s |
| `invalid-tool-args-visible-retry` | `st_7c150d5cf631433c87a069e501327953` | 42 s |
| `post-tool-followup-turn` | `st_95474f85c5fc40c0891f5e3b188c8023` | 37 s |

No unexpected tool failures in this lane. The instance was stopped and joined.

`p4-resume` was stopped and joined. Its shutdown reported
`active-eval-cancellation` errors for three already-retired session objects;
the supervisor still retired. Keep this evidence separate from successful
scenario results. Log:
`~/.config/vibestudio/instance-state/122394aeedcbfe99/system-test-logs/p4-resume.log`.

## P4 Agent system (2026-11-15): slice plan, what was done, what remains

**Plan, and why this order.** The design's §6 is one change in the doc and five in the code. Before
touching code, the channel, the hash chain and the agent cell were each surveyed (results are in
`docs/dolt-redesign.md` §6.8 and §6.9). The surveys changed the order: the agent cell sits on Pi, an
external package whose id counter is a singleton row, so it cannot be moved by a Base-only change.

| Slice | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Status                                                       |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| S2    | The Dolt engine for userland classes (manifest, admission, UniversalDO, the one-time import of a legacy SQLite facet, fork at a commit through `runtime.cloneContext`), and the **channel cell** on it (commit per append, member and fact; every projection local; the channel's side of the fork; the facts moved out of `state`; schema 126). Done first because every later slice needs the engine and the channel is the fork's parent.                                            | **done, gated** (below)                                      |
| S1    | Delete the channel hash chain: `prevHash`/`hash` out of the envelope, the observation protocol on `(sequence, envelopeId)`, `agentic-protocol`'s `log-envelope` hash code and legacy `hash.ts`, the barrier and fork checks in `channel-do.ts`. GAD keeps a private chain for its other logs (`builds`) until P5 deletes its log machinery; the host `workspaceSource` schemas loosen first. The survey's dependency order is §6.10. Independent of S2 and mechanical; **not started**. | **done** (second pass)                                       |
| S3    | The agent cell on Dolt: Pi composite storage (versioned conversation, local `vsl_` operational set, ids from a local counter), a turn-commit with anchors, first-activation logic for a fork. **Blocked on a decision and a change in `@panticonic/pi-durable`** (§6.9).                                                                                                                                                                                                                | **done** (Pi composite storage, then the agent)              |
| S4    | Native conversation fork across channel and agents; delete `exportChannelKnowledge`/`importChannelKnowledge`, `native-import` bootstrap, the `storage: "fresh"` special case, `postClone`'s remaining identity bits where the host can do them                                                                                                                                                                                                                                          | **done**                                                     |
| S5    | Subagent `mode: "fork"` as a fork of the parent agent cell                                                                                                                                                                                                                                                                                                                                                                                                                              | **done**                                                     |
| S6    | Agent self-hosting (`hosts`, `hostCode`, `onHostedRevoked`, the executor fact renamed from `kind: "eval"`)                                                                                                                                                                                                                                                                                                                                                                              | **partly**: the executor fact renamed; self-hosting not done |

Deviations from the design, with the evidence (full list in §6.8): `participants` is local; the
receipts and the delivery projection are local and rebuilt by folding the ledger; the ledger append
transaction does not contain the projections (the fold needs a hydrated event and is a separate
transaction); `state` is local by the framework's rule so the conversation's facts moved to a
versioned `channel_facts`; the legacy import goes through a staging facet because celld has no
facet rename and a facet fork empties local tables; one facet name `do` for both engines.

**Not done and why it matters for the gate.** The P4 gate (§10) needs edit-and-fork across agents, a
multi-agent fork, a subagent fork, crash-resume with agents, and hibernation tests of agents. None of
those can pass before S3 to S5. What is covered now: fork-at-N equality for the channel (ledger,
members, facts, provenance, clean working set: `channel-do.test.ts` "a channel on a Dolt cell"),
the fork operation's journaling of the commit (a retry asks for the same commit), the legacy import
and both resume stages on the real fork, the host's `storageAt`.

### P4 slice S2: gate, lanes, measurements, commits

**Findings the real engine gave that the fake did not** (each fixed, each now a test or a guard):

1. The root cannot read `_cf_FACET_INDEX` (`access to ... is prohibited`), so legacy detection is by trying the Dolt `do` and reading celld's refusal. A refused start stays registered under its name with its Dolt options: the root must `abort` the name before starting it as SQLite.
2. **A Dolt store reports a primary-key column as NOT NULL** where SQLite reports 0 for a non-integer key: `assertExactSqlTableSchema` now ignores a key's nullability (found by the first lane: the channel failed its own exact-schema check).
3. **A `--` comment in a Dolt class's DDL makes its shape drift at the second activation** (the engine drops comments; the shape is taken from whitespace-collapsed text, so the comment swallows the rest of its statement). `installDurableObjectSchema` now refuses such DDL at install on a Dolt store (test in `schema-dolt.test.ts`); the channel's four commented tables lost their comments and the 125 to 126 upgrade recreates them (the pinned 125 shape is checked by a test that rebuilds a 125 object from the old DDL). **Pi's migrations and every other class headed for Dolt must be checked for line comments (S3).**
4. The SQL dialect the channel and Pi use all runs on DoltLite (probe in `universalDoHost.test.ts`); `PRAGMA table_info` returns the SQLite columns.
5. The cell's clock is coarse by design (a frozen timer): in-cell timing reads 0, so commit latency is timed from outside in batches.

**Gate.** `pnpm type-check`, `pnpm lint`, Base `type-check:userland` (`base`), `check:runtime-docs`, `check:builtin-catalog`, `check:execution-root-providers`, `check:agent-docs`, `check:userland-rpc-contracts`, `generate:host-authority --check`, `generate-runtime-foundation-ledgers --check`, `generate-unit-authority-manifests --check`, `check-explicit-authority-manifests`: clean. `vitest run packages/durable packages/shared packages/service-schemas packages/builtin`: 172 files, 1715 pass. Host vitest (`src/server/services`, `doDispatch`, `workerdRpcRelay`, `rpcServer`, `runtimeManager`, `workspaceEntityStore`, `src/cli`): 248 files, 3074 pass, 2 fail, both pre-existing (`runtimeService.test.ts` clone test, `src/cli/agent/index.test.ts`). Real-fork host suites (the P2 list + `workspaceStateCelld`, `celldCpuWatchdogCelld`, one worker, fork `2d1749d`): 14 files, 78 pass, 2 skipped (before 71; new: a Dolt facet's commits and local tables, fork at a commit and its repeat, the legacy import, both resume stages, the dialect probe, R1). Base userland, the whole template: 541 files, 5100 tests: failures only `vcs-skill-release-generator` (pre-existing) and, in one of two runs, a UI test (`about/new`, then `packages/pubsub rpc-client`) that passes alone (load flakes). Base `workers/pubsub-channel`: 7 files, 196 pass, **on a Dolt cell** (`FakeDoltStorage`; 190 existing tests plus 6 new). system-testing template: untouched.

**Lanes** (`openai-codex:gpt-6-luna`, fresh instance per 4 to 5 tests, one test per `run`, 150 s settle, concurrency 1, 420 s, fork `2d1749d`; "first" is the sweep, "after" one re-run of each failure; the first two sweeps ran on code with the two bugs above and are not counted):

| Lane                                                                                                                                                                                                                                                      | First sweep                                                                                                                                                                               | After one re-run                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| eval-lifecycle (12)                                                                                                                                                                                                                                       | 10 pass; `eval-exact-authority` (the model's `ERUNMANIFEST`, known sample), `eval-preauthorization`, `eval-pregranted-only` (errored on a tool failure)                                   | **12 pass**                                                                                                                                         |
| agentic-runtime (9)                                                                                                                                                                                                                                       | 6 pass; `state-args-immediate-snapshot` (`eval:guest_type_error`, the known failure), `gad-status-summary` (`package_load_failed` once), `runtime-vcs-client-helper` (no result in 480 s) | **8 pass, 1 fail**: `state-args-immediate-snapshot` fails again (known, also on the pre-change commits); `gad-status-summary` passed on a third run |
| smoke (4)                                                                                                                                                                                                                                                 | **4 pass**                                                                                                                                                                                | 4 pass                                                                                                                                              |
| workers (9)                                                                                                                                                                                                                                               | 8 pass; `call-do-method` (the model passed `env` to `createEntity`: model error)                                                                                                          | `call-do-method` fails again, the same model error; the other eight pass                                                                            |
| harness-resilience (5)                                                                                                                                                                                                                                    | **5 pass**                                                                                                                                                                                | 5 pass                                                                                                                                              |
| panels (5)                                                                                                                                                                                                                                                | `browser-panel`, `panel-tree-navigation` pass; `create-panel` (known), `panel-list-sources` fail; `browser-import-panel-lifecycle` ran 0 of 0 (not installed)                             | `panel-list-sources` passes; `create-panel` fails again (known); 0 of 0                                                                             |
| subagents / channels (5: `subagent-followup-after-report`, `subagent-diff-inspection`, `gad-channel-health` pass; `steer-a-running-child` ran past the 480 s outer timeout, then errored, then **passed** with a 700 s outer timeout and a kept instance) |                                                                                                                                                                                           | **5 pass**                                                                                                                                          |

No test showed a schema error, a legacy-import error, a fork error or a hang after the two fixes. What the lanes do **not** exercise: an object that needs the legacy import (a fresh instance has none; covered by the real-fork test and the Base copy test), a conversation fork (no scenario forks a conversation), an agent restart. The conversation-fork path was run only against `FakeDoltStorage` and the real-fork facet fork, not through the product's `fork` RPC.

**R1, commit volume (§11), measured for the channel's write shape on a real Dolt facet** (`universalDoHost.test.ts` "measures the commit volume ...", `VIBESTUDIO_R1_EVENTS`, `VIBESTUDIO_R1_BYTES`; one committed ledger transaction plus one plain local-projection transaction per event, 1 KiB body, this NVMe, fork `2d1749d`):

| events | per event, mean / p95 of 50-event batches | file before gc               | file after gc                | gc    | commit lookup + `dolt_at` read at the middle |
| ------ | ----------------------------------------- | ---------------------------- | ---------------------------- | ----- | -------------------------------------------- |
| 300    | 17.1 / 20.2 ms                            | 4.6 MB                       | 2.5 MB                       | 0.1 s | 8 ms (whole call)                            |
| 10 000 | 15.5 / 16.5 ms                            | 236.6 MB (23.7 KB per event) | 118.9 MB (11.9 KB per event) | 3.7 s | 102 ms (whole call)                          |

So an event costs about two device flushes (15 ms against a 6.4 ms `fsync`), flat across 10 000 commits, and a 1 KiB event is about 24 KB on disk before gc and 12 KB after: the cost is write amplification of a prolly tree plus the local rows in the same file, and gc halves it. Checkout is not a channel cost (the channel never switches branches). **Not measured:** the agent cell's commits and bytes per turn and its checkout cost (no agent is on Dolt), GC under concurrent writes, a long history's fork latency (a fork copies the whole file: 120 to 240 MB at 10 000 events).

**Commits of this pass.** vibestudio `feat/dolt-p0`: `3bf924f4c` the engine for userland classes, legacy import, fork at a commit, `storageAt`, §6.8 and §6.9; `21c95cc32` the dialect probe; `934a45289` the line-comment guard; the handoff commit that follows. Base `feat/dolt-p2`: `4adb8da` the channel on Dolt; `d56886f` primary-key nullability; `409395f` no DDL comments, the 125 upgrade recreates four tables. `--no-verify` for the pre-existing `format:check` failure only. Nothing pushed. **Process slip:** I ran `pkill -f 'tail -n +1 -f'` once to remove my own log followers; it matched only those two processes, but the rule is not to use `pkill -f`.

## P4 third pass (2026-11-15): E14 pinned, S6b and compaction done

Design as built: `docs/dolt-redesign.md` §6.11.6 (S6b), §6.11.8 (compaction). Fork `75f1700` (E14) is pinned
(`native/celld/targets.json`, sha256 `7c3fae1e...f3b7`, binary staged from `/home/werg/celld-harness-bin/celld-uf-75f1700`).

### Commits of this pass (none pushed; `--no-verify` only for the pre-existing `format:check` failure)

- host `feat/dolt-p0` (dev worktree `dolt-p0-dev` = `feat/dolt-p0-s4`, one handoff commit ahead): `6ab7464f5` pin fork 75f1700; `4946452f0` pin Pi dolt.5; `7b8a6ddd3` S6b host side;
  `a0663ac02` compaction (durable base, `doltGcCelld.test.ts`, agent-cell test); `a1b4d3aeb` docs; `db0e8c7dd` and `e3ca7401b` owner-only and finite scopes stay session entities; `2f2ad9e44` docs (S6b held).
- Base `feat/dolt-p2` (= `feat/dolt-p2-s3`): `b755dc5` pin Pi dolt.5; `3553a91` S6b agent side; `46b86c1` compaction in Base's durable base; `adc9993` **reverts `3553a91`** (keeps the agent's gc hook).
  Held: `feat/dolt-p2-s6b-agent-hosting` (`0ee3eed`, one commit on `46b86c1`).
- host held: `feat/dolt-p0-s6b-agent-hosting` (one commit on `e3ca7401b`: `loopback: false` in `packages/rpc` and `packages/durable`, and a stray prettier reformat of `bridgeStream.test.ts`).
- templates (`examples`, `personal`, `google-workspace`, `news`, `system`, `feat/dolt-p4-pi`): one commit each, Pi dolt.5. system-testing: no change this pass (`1c16e49`).
- Pi `feat/dolt-p4`: `c6d518177` removes the retry.
- Gate (host `dolt-p0` + Base `base-dolt-p2`, `gate-static`): type-check, lint, userland type-check (Base, system-testing), the six check scripts: clean. packages vitest 172 files, 1719 pass; host vitest 248 files, 3080 pass, 1 fail (`src/cli/agent/index.test.ts`, known); real-fork host suites 15 files, 81 pass, 2 skipped (14 + `doltGcCelld.test.ts`); Base vitest 544 files, 5095 pass, 1 fail (`vcs-skill-release-generator`, known); system-testing vitest 82 files, 1035 pass, 4 fail (`cli.test.ts`, known).

### Processes

The registry server (PID 2594463), every lane instance and every lanes script of this session were stopped by PID; `ps` shows none left.

### 1. E14 in the product (input-gate refusals)

Pi's 8-attempt retry is **removed** (Pi `c6d518177`, a revert of `611e057aa`); Pi repacked as `1.2.0-vibestudio.4-dolt.5` (artifacts
`~/vibestudio-pi-worktrees/artifacts/1.2.0-vibestudio.4-dolt.5`; Pi `packages/durable` 1578 pass, the same 51 failures in the same 6 files as before) and pinned
in the host (`4946452f0`), Base and the five templates (one commit each).
**Result: zero `input gate` lines** in the instance logs of three fresh instances that ran `steer-a-running-child`,
`state-args-immediate-snapshot`, `subagent-fork-inherits-context` and `conversation-fork-adopts-agent-cell`, and of
every later instance of the sweep (the `input_gate_lines` and `acquire_lines` counters at the end of each group in
the lane table). Before E14: three of about ten agent instances showed it, persistently. The agent's lifecycle retire
with queued commits is exercised by the cleanup of every scenario that spawns or forks an agent (`__lifecycle/prepare`
with `mode: retire`); no scenario drives it alone, and none logged a refusal.

| Test (3 fresh instances)              | Result                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subagent-fork-inherits-context`      | 3 of 3 pass                                                                                                                                                    |
| `conversation-fork-adopts-agent-cell` | 3 of 3 pass                                                                                                                                                    |
| `state-args-immediate-snapshot`       | 2 of 3 pass (the failure is the known guest `TypeError`, `stateArgs.set is not a function`)                                                                    |
| `steer-a-running-child`               | 0 of 3: two timeouts at 450 s (`model.generation` and `suspend_turn` pending) and one run whose model finished but whose headless cleanup timed out after 30 s |

`steer-a-running-child` hits a **saturated cell** (`celld::runtime: refused work for a saturated cell ... in_flight=64 limit=64`,
then `cell request limit reached` 503s to `PubSubChannel`) in these runs and in the subagents lane of the previous pass
(7 lines in `p4s35fsubagents.log`, 1 in `p4dbgsteer.log`): 64 events in flight on one UniversalDO cell. It predates E14 and
S6b; a headless agent's `__alarm` runs for minutes while the test steers, and the 64-event cap then refuses the channel's calls.
Not investigated further; **a candidate for the fork or the host (why 64 events are in flight)**.

### 2. S6b: host side done, agent side held (it hangs)

See §6.11.6. **Kept:** the host recognises an eval host by the `hosts` declaration in a class's manifest, and `dynamicCode.admit`
hosts a run on the owner itself when the owner asks for a persistent scope (no class declares `hosts` for the kernel yet, so the
product behaves as before). The executor fact `kind: "dynamic-code"` was S6a.
**Held, on branches** (Base `feat/dolt-p2-s6b-agent-hosting`, host `feat/dolt-p0-s6b-agent-hosting`, one commit each on top of
this pass's heads): `hosts` in `AiChatWorker`/`SilentAgentWorker`, `HostedEvalKernel` and the vessel's relay methods, the tool, the await
task and the acknowledgement addressing the owner, the lifecycle relay, and `loopback: false` on a hosted class's rpc client. What the real
stack found, in the order it found it: (1) the agent's call to its own id is delivered in-process with no verified caller (every eval
failed `EACCES`); (2) a finite scope and an `owner-session` target must stay session entities (`eval-events`: the harness runs its
probes as the headless `AiChatWorker`): fixed and kept; (3) the kernel acts as the agent, so **its calls to the agent are self-addressed
and answered by its own client** (`describeEvalOwner is not exposed`: `agent.*`, `chat.*`, the outside-content report); (4) with
`loopback: false` they leave the process and **hang at the host** between the caller resolution and the dispatch into the DO (a log line at
the method's entry never prints); `agent-debug-state-method` never finishes and the harness's retire after it hangs. A session entity
carries `evalOrigin` (the owner), which an agent-hosted run loses; that is the first suspect.
**Next (S6b):** merge the two held branches onto the heads and read where the relay's attestation or readiness treats a call whose caller is its own target and whose run has an execution
session (`principalIdentity.ts` `evalOwner`, `credentialGrantIdentity.ts`, `doDispatch.ts` readiness, `rpcServer.ts`
`authorityParentFor`); an `[SELFCALL]`-style log between `resolveCaller` and `relayCall` tells which of the two waits.
Deviations the branch makes (one kernel and one notebook scope per agent; approvals titled as the agent; no resident-session relay; the
census activates every self-hosting agent) are in §6.11.6.
**Watch:** `eval-exact-authority` failed 6 of 10 runs on the self-hosting tree (the baseline passed 2 of 2); every failure was a model
error in the transcript and it passed in isolation; its result on the tree as left is in the lanes table.

### Lanes of this pass (fork `75f1700`, Pi `.dolt.5`, `openai-codex:gpt-6-luna`, fresh instance per group, one test per run, 150 s settle)

Final sweep on the tree as left (host `2f2ad9e44`, Base `adc9993`: no agent hosts its kernel), stopped by the coordinator in `workersb`
(`installed-workspace-service-consumer`, then `resilience`, `panels`, `subagents` were **not run in this sweep**). `input gate` lines in every
instance log of the sweep: **0** (eval-a, eval-b, eval-c, agentic-a, agentic-b, smoke, workers-a, workers-b).

| Group                         | Result                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| eval-a                        | 3 of 4: `eval-exact-authority` fails (model: `ERUNMANIFEST`/approval wording)                                                                                                                                                                                                                                |
| eval-b                        | 4 of 4 (`eval-preauthorization`, `eval-events`, `eval-agent-replay`, `eval-live-kernel-continuity`)                                                                                                                                                                                                          |
| eval-c                        | `eval-db-persistence` pass; the rest of the group passed in the earlier sweep, results in the scratchpad were not re-tallied                                                                                                                                                                                 |
| agentic-a                     | `state-args-immediate-snapshot` pass (it failed in 2 of the E14 runs, known), `runtime-vcs-client-helper`, `gad-status-summary`, `conversation-fork-adopts-agent-cell` pass; `channel-envelope-inspection-bounded` fails (model: empty channel); `subagent-fork-inherits-context` was passed in the E14 runs |
| agentic-b                     | `large-eval-result-terminal`, `agent-debug-state-method`, `turn-no-silent-stall-after-tool`, `atomic-multifile-patch-build` pass; `workspace-test-runner-extension` fails (known)                                                                                                                            |
| smoke                         | `eval-return-value`, `fs-write-read`, `build-service` pass (`file-search-read-tools` not re-checked)                                                                                                                                                                                                         |
| workers-a                     | `list-sources`, `create-worker`, `list-workers`, `create-destroy` pass (`call-do-method`, known model failure, not seen)                                                                                                                                                                                     |
| workers-b                     | `worker-do-sql-persistence` pass; `worker-env` (model: invalid RPC descriptor) and `dynamic-workspace-service` (typed guest errors) fail; **neither was re-run**                                                                                                                                             |
| resilience, panels, subagents | not run in the final sweep                                                                                                                                                                                                                                                                                   |

Failures were not re-run once as the gate asks (the sweep was stopped); each failure's transcript is a model/typed-guest error and none involves
the storage, fork, kernel or input gate. Earlier sweeps on the self-hosting tree (since held) are not counted.

### 3. Compaction of agent and channel cells (done)

See §6.11.8. A geometric schedule (64 commits, then half the commits the cell held at its last collection), checked after
a commit (every eighth for a cell that commits per event, every closed turn for the agent), run 250 ms later under
`waitUntil` in a `blockConcurrencyWhile`, and only over a clean working set. Real fork (`doltGcCelld.test.ts`, 2 tests;
`universalDoHost.test.ts` agent-cell test): 2.8 MB at 10 commits and 0.66 MB after the collection at 19 commits against
5.4 MB for 18 commits never collected; a collection changes no state; the parent closes another turn and a fork cut after
it holds exactly what the parent held and continues (the agent-cell stand-in: 24.7 MB after 40 turns, 2.0 MB after
`gc`, 138 ms, fork 438 ms). **Not exercised by the product lanes** (a scenario has a handful of turns, far from 64 commits);
the agent's hook (`agentCommitPolicy`) is a unit-level wrapper. Not done: `WorkspaceStateDO`, a byte threshold,
gc under concurrent writes of other objects.

## P4 second pass (2026-11-15): S1, S3, S4, S5 done, S6a done, S6b not done

Design as built, with every place the design was wrong: `docs/dolt-redesign.md` §6.11 (§6.11.7 is new: what the product lanes found).

### What was done

| Slice                | Result                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 hash chain        | Deleted end to end (§6.11.1): envelope, ledger, observation protocol, barrier, fork checks, `agentic-protocol` chain code and `hash.ts`; schema 127. GAD keeps a private chain for its other logs until P5.                                             |
| S3 agent cell        | Pi composite storage (`CompositeSqliteStorage`, `{commit}` on the native transaction, local counters), then the agent: versioned conversation, local `vsl_` operational set, one Dolt commit per closed turn, the one-time split of a single-set store. |
| S4 conversation fork | `forkFrontier`/`adoptChannelKnowledge`; the host forks native owners as `snapshot` clones at `storageAt`; the export/import knowledge path is deleted.                                                                                                  |
| S5 subagent fork     | `runtime.createEntity { forkStorage: { at } }` forks the parent's own cell; the child adopts for its task channel.                                                                                                                                      |
| S6a                  | Executor fact renamed to `kind: "dynamic-code"` with a `runId`. **S6b (agent self-hosting) not done**: nothing in S1 to S5 needs it; §6.11.6 says what it takes.                                                                                        |

### Commits (none pushed; `--no-verify` only for the pre-existing `format:check` failure)

- vibestudio `feat/dolt-p0` (the dev worktree `dolt-p0-dev` is `feat/dolt-p0-s4`, merged fast-forward): `e65491051` S1 (wire schema, dialect probe); `c0e63876e` native owners fork at a commit, `createEntity forkStorage`, real-fork test of the composite, dev registry knob, Pi `.2`; `787bb1c1c` executor fact (S6a); `1acca2d9c` forkStorage activation as a clone, §6 as built; `b95fd9960`, `f35b9b665` agent-cell real-fork test; `4a2bdb84c` fork docs; `30cf07867` `vsl_` outside the schema gate; `9a4fcd434` Pi `.3`; then this handoff and design commit. (`7339e113b` and `526f2f40c` pin Pi `.4` and back to `.3`: net zero, see "Pi retry".)
- Base `feat/dolt-p2` (dev worktree `base-dolt-p4`, `feat/dolt-p2-s3`, merged fast-forward): `52a589c` S1, `300efe6`; `051e06e` S3 to S5; `d57da91`, `0b27975`, `1221976`, `760e288`, `8b7ac56`, `64a19e8` (tests, the local table set at open, zod); `e144f54` commit only when a versioned table changed (found by the first lane); `d9d6abf` Pi `.3`; **`f86483b` two product bugs the fork scenarios found** (below); the Pi `.4`/`.3` pin pair.
- system-testing `feat/dolt-p2` (dev `feat/dolt-p2-s4`): `bc9857a`, `a99648c` (conversation fork scenario: forks through the channel's own `fork` RPC, plus edit-and-fork), `3d5fc86`, `1c16e49` (subagent fork scenario).
- Templates (`examples`, `personal`, `google-workspace`, `news`, `system`; worktrees `*-dolt-p4`, branch `feat/dolt-p4-pi`): one commit each, the Pi version. They compose with Base, so every Pi-using template must carry the same Pi version.
- Pi (`~/vibestudio-pi-worktrees/dolt-p4`, branch `feat/dolt-p4`, from the fork's `main` `c7c02b890`; the main checkout was never touched): `c06df0165` `CompositeSqliteStorage` + commit option + version override for the package script; `e74945265` jiti for the model-data check; `f6bfc14c0` local migrations rerun over existing tables, `entryHigh`, a registry for an unpublished release; `6c9b70b85` spec §11.2.1; `611e057aa` `NativeDatabase` asks again when the host refused a transaction at its input gate.

### How Base consumes the local Pi (nothing is published)

`node scripts/package-vibestudio.mjs <dir>` with `VIBESTUDIO_PI_VERSION=1.2.0-vibestudio.4-dolt.3` packs five tarballs (`pi-ai`, `pi-chord`, `pi-codemode`, `pi-durable`, `pi-telemetry`) into `~/vibestudio-pi-worktrees/artifacts/<version>`. The host pins them with `file:` overrides in `package.json` (and `node_modules` was refreshed from the tarballs). Base and every template depend on the version string, but a userland build installs externals from an npm registry in a sandbox and rejects `file:`; so `node scripts/serve-vibestudio-registry.mjs <dir> 4873` serves the tarballs on loopback and `VIBESTUDIO_DEV_NPM_REGISTRY=http://127.0.0.1:4873/` (new knob in `packages/shared/src/npmInstaller.ts`, only that origin is admitted) points the installer at it. Every command that builds userland (system tests, `run-userland-tests.mjs`, `type-check-userland.ts`) needs that variable while the release is unpublished. **To ship:** publish the five packages as `@panticonic/pi-*@<version>`, drop the `file:` overrides and the knob. The registry server of this session (PID in the scratchpad) must be stopped by PID before leaving.

### Gate (the final tree: host `feat/dolt-p0`, Base and system-testing as above, fork `2d1749d`)

| Check                                                                                                                                                                                                                  | Result                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm type-check`, `pnpm lint`                                                                                                                                                                                         | clean                                                                                                                                                                                                                                                                    |
| userland type-check, Base and system-testing                                                                                                                                                                           | clean                                                                                                                                                                                                                                                                    |
| `check:runtime-docs`, `generate-builtin-catalog --check`, `check:execution-root-providers`, `check:agent-docs`, `check:userland-rpc-contracts`, host-authority, foundation-ledgers, unit-authority, explicit-authority | clean                                                                                                                                                                                                                                                                    |
| vitest `packages/durable shared service-schemas builtin`                                                                                                                                                               | 172 files, 1716 pass                                                                                                                                                                                                                                                     |
| host vitest (`src/server/services` ... `src/cli`)                                                                                                                                                                      | 248 files, 3076 pass, **1 fail**: `src/cli/agent/index.test.ts` (pre-existing; the `runtimeService.test.ts` clone test that failed before now passes)                                                                                                                    |
| real-fork host suites (14 files, one worker)                                                                                                                                                                           | 79 pass, 2 skipped                                                                                                                                                                                                                                                       |
| Base vitest (whole template)                                                                                                                                                                                           | 544 files, 5093 pass, **1 fail**: `vcs-skill-release-generator` (pre-existing)                                                                                                                                                                                           |
| system-testing vitest                                                                                                                                                                                                  | 82 files, 1035 pass, **4 fail**: `cli.test.ts` (pre-existing)                                                                                                                                                                                                            |
| Pi `packages/durable`                                                                                                                                                                                                  | 1579 pass, **51 fail in 6 files** (`codemode`, `codemode-models`, `env-truncate`, `harness-telemetry`, `indexeddb-storage`, `tools-images`): the same 51 fail on the fork's `main` `c7c02b890` (checked), none touches the composite; `sqlite-composite.test.ts` 38 pass |

The P4 gate tests of §10: edit-and-fork (scenario `conversation-fork-adopts-agent-cell` forks at the head and before the first message with a replacement seed, through the channel's `fork` RPC on the real stack; `channel-do.test.ts`), multi-agent fork and crash-resume of the fork operation (`channel-do.test.ts` "forks every kept agent's cell at its own commit, and a crash between phases resumes from the journaled frontiers"), subagent fork (scenario `subagent-fork-inherits-context`, `native-subagent-spawn.test.ts`, `runtimeService.test.ts` self fork), hibernation and redelivery dedupe (`native-agent-owner.test.ts`: a redelivery after eviction between turns is deduplicated on the composite store), fork at N equals parent at N (real fork: the forked cell holds exactly the entries its source held at the commit; `channel-do.test.ts` for the channel).

### Lanes (`openai-codex:gpt-6-luna`, fresh instance per 4 to 6 tests, one test per `run`, 150 s settle, concurrency 1; fork `2d1749d`)

Only the last sweep (`s35f`, Pi `.3`, Base `f86483b`) counts. Earlier attempts found bugs (below) or were invalid (a stray lane script from the previous attempt ran concurrently; it was stopped by PID).

| Lane                                                         | First sweep                                                                                                                                                   | After one re-run                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| eval-lifecycle (12)                                          | **12 pass**                                                                                                                                                   | 12                                                                       |
| agentic-runtime (11: the 9 old and the 2 new fork scenarios) | 10 pass; `state-args-immediate-snapshot` fails (`eval:guest_execution_failed`; the same test is the known failure, `eval:guest_type_error`, before this pass) | same, fails again (known)                                                |
| smoke (4)                                                    | 3 pass; `file-search-read-tools`                                                                                                                              | **4 pass**                                                               |
| workers (9)                                                  | 7 pass; `call-do-method` (model passes `env` to `createEntity`: known model error), `worker-do-sql-persistence` (errored)                                     | `worker-do-sql-persistence` passes; `call-do-method` fails again (known) |
| harness-resilience (5)                                       | 4 pass; `invalid-tool-args-visible-retry`                                                                                                                     | **5 pass**                                                               |
| panels (5)                                                   | 3 pass; `create-panel` (known); `browser-import-panel-lifecycle` ran 0 of 0 (not installed)                                                                   | `create-panel` fails again (known)                                       |
| subagents / channels (4)                                     | 3 pass; `steer-a-running-child` errored                                                                                                                       | **flaky**, see below: later runs on three instances passed 2 of 9        |

So after one re-run **four tests fail, all with a cause that predates this pass or is outside it**: `state-args-immediate-snapshot`, `call-do-method`, `create-panel` (known), and `steer-a-running-child` (flaky: the model often reports "no numbers", which the validation rejects; it also failed this way before S3 in the S2 sweep and passed only with a long outer timeout; two of nine runs after the sweep passed). The product `fork` RPC is exercised by `conversation-fork-adopts-agent-cell`, and the child's adoption by `subagent-fork-inherits-context`; both pass in the sweep.

**What the real stack found that no test had (each fixed, each now a test):** (1) the channel asked every entity participant for `forkFrontier`, the headless client's `SessionDO` included, and that class has no such method (default-deny): **a conversation fork from a headless or CLI session never worked, before this pass either** (it asked `exportChannelKnowledge`); the fork now selects `kind: "agent"` participants (`channel-do.ts`, test in the multi-agent case). (2) A forked subagent's adoption bound its projection without `reportTo`; the open that follows binds one with the parent as `reportTo`, and the immutable binding refused the second (`native operation failure: Native channel projection conflicts with its immutable binding`); both paths now call `nativeReportTo`. (3) Earlier lanes: a commit with nothing to commit throws on the real engine (`versionedChangesPending`); the unpublished Pi build (dev registry).

### R1, the agent cell (`universalDoHost.test.ts` "an agent's cell", `VIBESTUDIO_R1_TURNS=60`, a faux-model turn on a real Dolt facet, this NVMe, fork `2d1749d`)

| Measure                                                | Value                                                                                                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| storage transactions per turn                          | 23 (about 1.1 KB of JSON each)                                                                                                            |
| Dolt commits per turn                                  | **1**                                                                                                                                     |
| turn time (23 transactions and the commit), mean / p95 | 558 / 799 ms                                                                                                                              |
| file after 60 turns, before gc                         | 38.8 MB (**635 KB per turn**; an empty cell is 0.7 MB)                                                                                    |
| file after gc                                          | 3.06 MB (about 41 KB per turn), gc 169 ms                                                                                                 |
| fork                                                   | copies the whole file: 3.06 MB after gc, 38.8 MB before; **247 ms** after gc                                                              |
| checkout                                               | none: the agent never switches branches; a fork is the only time the history is read, and `lastTurnCommitThrough` is one `dolt_log` query |

**The cost that matters: 635 KB per turn before gc.** An agent cell that is never collected grows by a megabyte every two turns, and a fork of it copies that. **Periodic `dolt gc` of agent cells is needed and is not scheduled** (the engine's gc is not run by anything in the product; the channel's R1 has the same shape at 24 KB per event).

### Where it stopped, and what remains

1. **S6b, agent self-hosting** (§6.11.6). Not started.
2. **Periodic gc** of agent and channel cells (above).
3. **Input-gate refusals in agent cells: an open finding, probably the fork's.** The first lane runs on the real stack failed agent sessions with `native operation failure {"message":"the cell event ended before it could acquire an input gate"}` followed by `SessionFailed: Session failed after a storage error`, from Pi's `#runCommit` through `NativeDatabase.transaction` into `DurableObjectStorage.transaction`. Pi now asks again up to 8 times (`611e057aa`). What was measured with a diagnostic (a wrapper on `ctx.storage.transaction` and `ctx.blockConcurrencyWhile` of the agent that lists the open blocks at each refusal; removed again): the refusal was **persistent** (the same logical transaction refused on all 41 attempts when the limit was raised to 40, about six seconds) and **no other block of the object was open** (`OPEN` held only the refused call itself). So it is not another transaction or a long block of the agent holding the gate, and asking again cannot cure it; it matches `op_gate_acquire` in celld's `crates/celld/js.rs` (the `RETIRED_INPUT_GATE` path: the calling continuation has no live driver, `operation_continuation_id(scope)` finds no live io context, and the acquisition is refused whatever the gate holds), not `blockConcurrencyWhile`'s `_blockDepth > 0` branch. Where it was seen: (a) right after a fresh agent activation (`activation` 1.7 s) in the first alarm dispatch of the turn (`steer-a-running-child`, instance log), (b) in the agent's `__lifecycle/prepare` retire, in the `retire-subagent` cleanup phase, at the end of a test (82 refusals, two transactions), (c) the first attempt of this pass at `state-args-immediate-snapshot`, before the retry existed. It is rare: it appeared in three of about ten agent instances, and most of the 40 agent scenarios passed with no refusal. It was **not reproduced** by two real-fork probes that model the suspect shapes (a loop under `waitUntil` that keeps asking, with and without a live event's block open; an operation chained behind another one whose event has ended, `NativeDatabase`'s tail; a transaction asked for after a stub call to another object, in the event, under `waitUntil`, after the answer): zero refusals in all of them. **To reproduce in `/home/werg/celld`:** it needs the real shape, an `AiChatWorker`-like cell (Pi `Harness` over `CompositeSqliteStorage` on a Dolt facet) taking a turn started by an alarm right after the activation that a `subscribeChannel` call caused, or a `__lifecycle/prepare` that retires the agent while the session still has queued Pi commits; the instance logs that show it are the `ZZBLK REFUSED` and `input gate` lines of the runs named above. The question for the fork: why does the continuation of a Pi commit chain lose its driver there, and should `transaction()` queue instead of refusing when the object is alive and no block is open (the harness comment says exactly this: "the object is alive and the call starts a block of its own, queued behind a running one")? It is not specific to Dolt in `transaction()`'s code; what the Dolt agent cell changes is how long and how often its transactions run (23 per turn, with a commit), so more windows.
4. **The Pi retry.** The 8-attempt retry is the only mitigation in the tree and **there is no evidence that it ever cured a refusal** (the refusals that were measured were persistent). It is kept because it is harmless and cheap, and because the first lanes needed something; a longer retry (40 attempts) was tried, shown to cure nothing, and reverted (`7339e113b` then `526f2f40c` pin `.4` and back to `.3`: the tree is byte-identical to `9a4fcd434`). Remove it when the fork fix lands.
5. **Pre-existing failures** (unchanged): `src/cli/agent/index.test.ts`, `vcs-skill-release-generator`, four `cli.test.ts` tests in system-testing, Pi's 51 tests in 6 files, and the lanes `state-args-immediate-snapshot`, `call-do-method`, `create-panel`.
6. **Not measured / not done:** a product restart probe of an agent cell (the real-fork tests cover reopen after a kill); the 10 000-turn agent history (fork latency grows with the file: 247 ms at 3 MB); GC under concurrent writes.

**Process slips:** a stray `lanes2.sh` of the previous attempt kept running (it started its next group after its first instance was stopped) and interfered with the first sweep of this pass; found by `ps`, stopped by PID, the sweep rerun. One `git commit --amend` mistake in the Pi worktree (after a failed `git revert`) rewrote my own unpublished commit; reset to `611e057aa` and the package rebuilt, the dolt.3 artifact and the host's `node_modules` verified (`attempt >= 8`, no `REFUSED_TRANSACTION_ATTEMPTS`). No `pkill`.

## Commits

vibestudio `feat/dolt-p0` (this pass, newest last):

1. `1afb6c862` celld: pin fork 9440c29; schema text rule matches the documented rendering
2. `7611524ef` eval: the notebook heap is held by a residency hold; the host kernel lease is gone
3. `c065446c3` tests: the owner reaches its kernel through a gateway its root binds; a userland object cannot compile code
4. `d1bfdec3f` docs: P2a results, P2b findings and decisions
5. `a31856181` workspace state: `WorkspaceStateDO`, a Dolt cell, replaces the SQLite `WorkspaceDO`; the import replays the retired store's history (P3)
6. `80a744f9c` workspace state: format
7. `a1d39adf9` storage: backup, restore, reset and retirement without a maintenance journal; `cloneDO` is `forkObjectStorage` (P3)
8. P3 results, §4.6 as built, the fresh-workspace legacy cell, the real-fork reverse-patch check (`7e106506a`, `5697de08c`, `fb63135ac`)
9. `132c51b48` panel execution: log an activation only when one happens; `VIBESTUDIO_DO_CALL_TRACE` (P3 follow-up)
10. `27b24c549` the follow-up's measurements and results
11. `083f47ec4` durable: a Dolt object admits a call from memory and records a mutating call's nonce in its own transaction (P2b step 0)
12. `9a8a8cc44` docs: §7 is a general dynamic-code system; the CPU-limit probe `celldCpuWatchdogCelld.test.ts` (D4)
13. `1f61b1447` dynamic code: one admission function (`dynamicCodeAdmission.ts`), called by `evalService`
14. `253763068` handoff: state only what was checked (earlier pass)
15. `9065f0ae8` dynamic code: any entity hosts a class in its own cell (`CodeHost` on `UniversalDO`, `hostCode` on the durable base; §7.2 "As built")
16. `6b932b884` durable: a product class has no per-object props; the hosting props are read defensively (a bug of 15 found by `internalStorageWorkerd.test.ts`)
17. docs: §7.2 as built, §7.12 step 3; the handoff of step 3
18. `f1fa35157` docs: §7.5.1, the kernel call contract
19. `112b5bb65` shared: `kernelRealm`; `d8fbba38c` eval: the kernel is hosted code in a session entity, the product `EvalDO` deleted (steps 3c, 4);
    `ea00b4684` docs and the terminal-hint test; `309bafd3b` the session entity carries the verified agent binding; census, `internalStorageWorkerd`;
    docs and this handoff

Earlier: `72b682e86`, `1ca22c6f8`, `4a81ab2c7`, `7d5bc1775`, `01ef6ffe9`, `0019b6d35`.

Base `feat/dolt-p2` (this pass: `5c6639a` kernel and session, `4c517d7`, `956af80` agentic-do owner, `c59a650` channel relay, authority manifests,
`c456f1f` agent chatOp caller, `81db5ba` reset): `dbc66e5` durable base: Dolt support (`committedTransaction`, `transactionSync`, the call-nonce gate of `083f47ec4`) and `hostCode`; `340a236` reads the hosting props defensively; `a14ef7c` skills: the eval notebook heap is held until an explicit end, not for a
30-minute idle lease (EVAL.md, TOOLS.md, WORKFLOW.md); `473acbb` panels: agent calls on a browser panel are answered by the host
(`panelRuntime.ts`, test, `PANEL_API.md`).

Fork (`/home/werg/celld-worktrees/commit-cost`, branch `fix/dolt-commit-cost` from `unified-fork` `9440c29`, **not pushed**):
`ed1010b` measures what a commit adds to a write and pins the root-record counts (tests and `docs/fork/design.md` only; the binary behaves as
`9440c29`, so nothing is re-pinned here). The wip binary `/home/werg/celld-harness-bin/celld-uf-ed1010b-wip` was built for the e2e run; the worktree's `target/` is deleted. The user's main Base checkout has uncommitted
edits to `skills/sandbox/EVAL.md`; expect a textual conflict there when this branch is merged.

All commits use `--no-verify`: the pre-commit hook (`pnpm check:commit`) passes type-check and lint
and then fails at `format:check` on 16 files of the base branch that were never formatted
(pre-existing). Files touched here are prettier-clean (`universalDoHost.test.ts` was reformatted
after my edit).

## How the test runs find the Base worktree (nothing global changed)

Vibestudio reads template checkouts from `VIBESTUDIO_TEMPLATE_CHECKOUTS` (else the git config key
`vibestudio.templateCheckouts`, which is `/home/werg/vibestudio-templates` and is shared by every
worktree of the repo, so it was not touched). `/home/werg/vibestudio-templates-worktrees/root-dolt-p2/` holds symlinks:
`base` points to the Base worktree (`base-dolt-p2`), `system-testing` points to the system-testing worktree
(`system-testing-dolt-p2`, since 2026-11-15), every other registered template (`personal`, `system`, `examples`, ...)
points to its checkout under `~/vibestudio-templates`. Every system-test command runs with
`VIBESTUDIO_TEMPLATE_CHECKOUTS=/home/werg/vibestudio-templates-worktrees/root-dolt-p2`. (Both worktrees are cut from
committed `main` of their template; Base `main` now contains `skills/sandbox/claims/`, so nothing is copied in by hand any more.)

## What P2a did (`7611524ef`)

- `EvalDO` takes `ctx.residency.hold()` when a run is admitted (`enqueueRun`, and `runEval` if none
  is held) and ends it only on `reset`, a lifecycle release (retire, suspend), or the node's
  revocation. No timer. A refused hold (`ERR_RESIDENCY_BUDGET`, a drain under way) warns and the run
  proceeds unheld (the restart report states the loss). A class without `ctx.residency` runs unheld.
- `onrevoked` (registered on the hold by `EvalDO`, which is itself the root cell, so the handler runs):
  on `drain` or `swap` active runs take the typed `runtime_generation_lost` terminal through
  `cancelRunsForLifecycle` (the cancellation path persists the scope); on `operator` only the hold ends.
- Deleted: `evalKernelLease.ts` and its test, the lease touch in `evalService`, the
  `eval-kernel-lease-close` shutdown stage and the `onKernelLeaseCoordinator` seam, the
  `acquireKernelLease`, `attachKernelLeaseHolder`, `holdKernelLease` methods and their schemas, the
  `registerLifecycleRelease({ kind: "eval-kernel" })` declaration and `resumeAfterRestart`'s clear,
  `idleExpiresAt` (schema and status), the three generated catalog rows, 126 lines of authority ledger.
  `scripts/runtime-authority-review.json`: the three review rows removed and `censusDigest` updated to
  the observed value (a pure reduction: the ledger diff is deletions only).
- New: `packages/durable/src/residency.ts` (`ResidencyContext`, `ResidencyHandle`),
  `DurableObjectContext.residency`, `runtime.residency` in the builtin catalog and `residency` in
  `buildRuntimeDeployment` (EvalDO declares it; `codegen` as before).
- Tests: `EvalDO.cancel.test.ts` (no idle timer over two hours, refused hold, new hold after revoke,
  release at lifecycle and at reset, drain gives `runtime_generation_lost`, operator leaves the run),
  `runtimeManager.test.ts` (the deployment declares residency for EvalDO only).

## Fork findings (celld 9440c29 against this pass)

1. **Fixed, verified:** an acknowledged `reset({ hard: true })` survives SIGKILL. The canary is a plain
   test and passes.
2. **Schema text:** the documented rule (`docs/services/dolt-cells.md`, "Schema text") is wider than P0's
   workaround, which only ignored whitespace around `( ) ,`. `looseSql` now also ignores comments and the
   quotes of plain names and keeps literals and names that need quotes (`1afb6c862`, unit tests on the
   doc's own examples). Not exercised against the real engine's rendering of comments and quoted names
   beyond the fork's own pinned rule.
3. **A Worker Loader's `env` supports only service bindings** (`DataCloneError: Worker Loader env
supports only Service Binding capabilities` for a namespace or the loader). Repro:
   `src/server/ownerKernelPathCelld.test.ts` (first version passed `env: { ROOT: this.env.ROOT }`). Not a
   bug; it shapes the design (the root binds a `KernelGateway` service binding per owner, §7.1) and means
   a facet loaded through a loader must pass a custom remote `transport` (the built-in carrier needs a
   namespace binding).
4. `CELLD_IDLE_EVICT_S` is unset in the product, so idle cells leave memory only under pressure or the
   cap; a hold matters under pressure. No census of holds is in `/state` (only `revoking_holds` during a
   revocation), so product-level proof is behavioural (see "hold check").
5. Memory: a system-test instance (server, node, builds) reaches the 6 GiB scope limit during its first
   minute (`MemoryPeak` 6442450944 after one test) and survived only by reclaim. With `MemoryHigh` set,
   `systemd-oomd` killed it; with the plain 6 GiB limit a kernel OOM killed the first `doctor` once.
   Lanes were therefore run in fresh instances of 3 to 4 tests. Not a fork bug.

## Results

Unit and integration (all inside `systemd-run -p MemoryMax=6G`, system tests at concurrency 1):

| Run                                                                                                                                                                                                                                                                                                                                                                                                                      | Result                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `pnpm type-check`, `pnpm lint`                                                                                                                                                                                                                                                                                                                                                                                           | clean (Base has no root type-check or lint; only Markdown changed there)                        |
| `vitest run packages/durable packages/shared packages/service-schemas packages/builtin`                                                                                                                                                                                                                                                                                                                                  | 182 files, 1927 tests pass (durable alone: 11 files, 129 tests, 2 new for the schema text rule) |
| host vitest: `runtimeManager`, `evalService`, `serviceAuthorityMatrix`, `authorityRuntime`                                                                                                                                                                                                                                                                                                                               | 4 files, 168 pass                                                                               |
| host vitest on the real fork 9440c29, one worker: `dynamicWorkerHost`, `universalDoHost` (+ the confinement test), `internalStorageWorkerd`, `celldNative.integration`, `nativeSqlitePayloadCelld`, `celldMigration.integration`, `nativeAlarmRetirementCelld`, `nativeModelTransportCelld`, `internalStorageDo`, `doltDurableCelld` (hard-reset canary now a plain test), `doltEvalKernelCelld`, `ownerKernelPathCelld` | 12 files, 60 pass, 2 skipped, 0 fail (before: 10 files, 57 pass, 2 skipped)                     |
| `CELLD=native/celld/linux-x64/celld npx tsx scripts/celld-runtime-smoke.ts <scratch dir>`                                                                                                                                                                                                                                                                                                                                | passes (P3 build)                                                                               |

System-test lanes, real models (`openai-codex:gpt-6-luna`), one test per `run`, 420 s per-test timeout, fork 9440c29,
Base worktree as above. "Before" is `HANDOFF-celld-runtime.md` (8a4ab46 unless stated).

| Lane                | Before                                                                 | After (this branch)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eval-lifecycle (11) | 6 pass, 1 fail, 4 error (F7); on fcc7268 `eval-pregranted-only` 4 of 6 | **10 pass, 1 fail**, twice (one instance, then fresh instances of 4 tests). The failure is `eval-preauthorization` both times (model/validator: 377 permission rows returned as a preview, once with a tool failure); across 5 valid runs it passed 3 times. F7 did not occur.                                                                                                                                                                                                                                                                                       |
| eval hold check     | n/a                                                                    | `eval-live-kernel-continuity` (a 15 s idle gap between cells) passes with `CELLD_IDLE_EVICT_S=5` exported to the instance's server, which hands its environment to the node (`celldNode.baseEnv`); the variable was seen on the server process, not on the node process                                                                                                                                                                                                                                                                                              |
| agentic-runtime (9) | 4 pass, 2 fail, 1 error, 2 timeout                                     | **6 pass, 3 fail**: `agent-debug-state-method` (unexpected `channel.admin` prompt, the open item of the cutover handoff), `workspace-test-runner-extension` (fails on base too), `runtime-vcs-client-helper` (failed once with a tool failure, passed on a re-run: 1 of 2). The first sample of this lane ran with 3 pass and 6 fail/error because the Base worktree lacked the untracked `skills/sandbox/claims/` of the user's main checkout (`ENOENT .../claims/claimCheck.nl`); I copied that directory into the worktree (untracked, not committed) and re-ran. |
| smoke (4)           | 3 pass, 1 error (F7)                                                   | **4 pass**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

No test in these lanes showed a hang, an input-gate error, or an eval residency problem. The lanes
do not prove the hold in the product beyond `eval-live-kernel-continuity`; a product-level census of
holds does not exist (fork finding 4).

## P2b so far (`docs/dolt-redesign.md` §4.2 and §7)

### Step 0: the per-call nonce (commit `083f47ec4`)

Every call to a Dolt object wrote a replay nonce (a root record and about three flushes). Now
(`DirectCallNonceGate`, `packages/shared/src/directRpcEnforcement.ts`; used by `packages/durable/src/index.ts`):

- every call on a Dolt object is admitted from a bounded in-memory set and a **floor** (the object's activation, raised when
  the set is full); an attestation issued at or before the floor is refused `ERR_ATTESTATION_STALE` _before anything runs_;
- the **host re-stamps and resends** such a refusal (same nonce, fresh `issuedAt`, same lifetime), in
  `workerdRpcRelay.postToDurableObject` / `streamFromDurableObject` and `DODispatch.dispatchImpl`
  (`retryOnStaleAttestation`). Retries did not re-sign before: the relay is deliberately not a retry unit, which is sound here
  only because the refusal is a pre-execution admission failure. It happens once per object activation;
- a mutating call (declared sensitivity other than `read`) also checks the durable ledger and records its nonce in **its own first
  transaction** (`committedTransaction`, or the new base `transactionSync` for local state, which `WorkspaceStateDO` now uses
  instead of `ctx.storage.transactionSync`); a call that changed no storage (`total_changes()`) records nothing; a call that changed
  storage outside a base transaction records it when it ends. Events, alarms and SQLite objects are unchanged.
- Soundness check: the attestation is host-minted with `issuedAt`, `expiresAt` (60 s) and a UUID nonce (`attestDirectRpc`); the
  receiver cannot be given an old `issuedAt` by a replayer. Two caveats recorded in §4.2: a clock stepping backwards across a
  restart (the durable record for mutating calls covers it, reads are 60 s replays of a read), and a write outside a base
  transaction. I found no unsound case, so nothing was weakened. **Base's `durable-base.ts` has no Dolt awareness at all**
  (no `committedTransaction`, no `dolt` getter, the nonce table is the versioned name), so the same change is not applied there
  and must come with the Base durable base's Dolt support (§7.12 step 3).
- Tests: `directRpcEnforcement.test.ts` (the gate), `dolt-base.test.ts` (piggyback, no-change call), `workerdRpcRelay.test.ts` (the re-stamp).

**Measured** (`VIBESTUDIO_DO_CALL_TRACE=all`; the model-free navigation of "P3 follow-up" on a fresh instance each, one warm-up run
and five measured runs; mean ms per call, before the change then after): `panelTreeDetail` 44 to 8, `entityResolve` 47 to 6,
`contextEdgeListByChild` 42 to 6, `alarmNextWakeAt` 47 to 8, `alarmClear` 48 to 14; per run `openPanel` 2.1 s to 0.9 s, `navigate`
2.0 s to 0.85 s, state and tree 1.1 s to 0.6 s. (A first intermediate build, with the plain nonce piggyback but no "nothing
changed" test, left `alarmClear` at 50 ms; the change counter fixed it.) Script and traces: the session scratchpad `p2b/` (`nav.ts`,
`runnav.sh`, `trace.py`).

### The design, and D4 (commit `9a8a8cc44`)

§7 now describes one hosting helper for any entity (`hostCode`, a `CodeHost` service binding the UniversalDO root gives each entity,
the manifest decides `codegen`/`residency` through the executable admission), session entities, one admission function, pull
delivery, eval as an ordinary Base class, and what is deleted. **D4, measured** (`celldCpuWatchdogCelld.test.ts`, real fork):
`WorkerCode.limits.cpuMs` ends a spinning call in about `cpuMs` (1004 ms for 1000), per invocation, leaves the root, siblings and the
same kernel (heap kept) answerable; with no limit the call never ends. So the per-run liveness supervisor can go **once kernels are
loaded workers with `limits.cpuMs`**, not before (today's `EvalDO` is a product DO, not shown to be covered). **Fork gap:**
`getDurableObjectClass` accepts only `props`, so the limit is per loaded unit, not per run; a starving run is ended at the unit's
`cpuMs`, not at its `timeoutMs`. A `limits` option on `getDurableObjectClass` (or a per-call limit on a facet fetch) is the request.

### The admission function (commit `1f61b1447`)

`src/server/services/dynamicCodeAdmission.ts`: `createDynamicCodeAdmission(deps).admit(ctx, input)` returns the session, its nonce, the
normalized manifest and a `discard`; `assertAgentCausalParent`, `normalizeAuthorityManifest` moved here. `evalService.prepareRun`
calls it (44 `evalService` tests pass unchanged; 7 new tests). Known naming debt: the executor fact is still `kind: "eval"`, with
`evalRunId` and `eventSinkNonce` (wire types in `packages/rpc/src/authority.ts` and four consumers); renaming it and deleting the
event-sink nonce go with pull delivery.

### Gate, this pass (steps 0 to 2)

`pnpm type-check`, `pnpm lint` clean. `vitest run packages/durable packages/shared packages/service-schemas packages/builtin`: 184 files,
1956 tests pass (before: 1946). Host vitest `src/server/services`, `doDispatch`, `workerdRpcRelay`, `rpcServer`, `runtimeManager`,
`workspaceEntityStore`: 189 files pass, 1 fails (`runtimeService.test.ts` "starts an unbound native execution clone fresh": pre-existing,
documented in the cutover handoff). Real-fork host suites (the P2 list, `workspaceStateCelld`, `celldCpuWatchdogCelld`, one worker):
14 files, 66 pass, 2 skipped (before: 13 files, 63 pass, 2 skipped).

System-test lanes on the final code of this pass, fork 9440c29, real models (`openai-codex:gpt-6-luna`), a fresh instance per 3 to 5 tests,
one test per `run`, concurrency 1, 420 s, Base worktree as above. "Before" is the P3 section of this file.

| Lane                   | Before (P3)                                                                                                                                          | After (this pass)                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eval-lifecycle (11)    | 10 pass, 1 fail (`eval-preauthorization`)                                                                                                            | **11 pass** (`eval-preauthorization` failed once, passed on the re-run)                                                                                                                                                                                                                                                                                                          |
| agentic-runtime (9)    | 6 pass, 3 fail                                                                                                                                       | **6 pass, 3 fail**: `agent-debug-state-method` (no result inside the 560 s, the known `channel.admin` prompt), `workspace-test-runner-extension` (fails on base), `state-args-immediate-snapshot` (3 fail or error of 3 here; **2 of 2 fail on the pre-change commit `27b24c549`**, so not this pass; its earlier history was not looked up); `runtime-vcs-client-helper` passed |
| smoke (4)              | 4 pass                                                                                                                                               | **4 pass** (`file-search-read-tools` failed once, passed on the re-run: the known "no `grep` run" sample)                                                                                                                                                                                                                                                                        |
| workers (9)            | all nine have passed on P3                                                                                                                           | **8 pass**, `create-destroy` failed once with an error and once with a failure (pre-change: failed once, passed once, so a model sample)                                                                                                                                                                                                                                         |
| harness-resilience (5) | 5 pass                                                                                                                                               | **5 pass**                                                                                                                                                                                                                                                                                                                                                                       |
| panels                 | 2 pass (`browser-panel`, `panel-list-sources`), `create-panel` fails, `panel-tree-navigation` 3 of 3, `browser-import-panel-lifecycle` not installed | **the same**: `browser-panel`, `panel-list-sources`, `panel-tree-navigation` pass; `create-panel` fails (model errors, unchanged); `browser-import-panel-lifecycle` ran 0 of 0                                                                                                                                                                                                   |

No test showed a hang, a residency problem or an input-gate error. No lane test failed with an attestation error (the failures above are model errors or the known ones); the re-stamp path is proved by its unit tests and the live latency numbers, and was not counted in a server log. The run left no process behind:
instances `p2bbase`, `p2bafter*`, `p2blane` are stopped.

### Step 3: the hosting helper (commits `9065f0ae8`, `6b932b884`; Base `dbc66e5`, `340a236`)

What exists, and how it differs from the design as first written, is `docs/dolt-redesign.md` §7.2 "As built". In short: any
entity calls `this.hostCode({ name, executable: { source, className } })` and gets `{ call(method, ...args), release() }`;
`UniversalDO` (now deployed with `codegen` and `residency`) loads the class as a unit carrying the grants, takes the hold,
relays a drain to the class and ends it with the entity; the host admits it only if the host class declares
`durable.classes[].hosts` and the hosted class declares `durable.classes[].hosted` (`RuntimeManager.admitHostedCode`, gateway
route `/_dohost/`). The `CODE_HOST` binding is unnamed (a proof in the facet's props selects the root: a shared unit cannot carry a
per-entity binding). A hosted class acts as its entity (`props.host`). One helper, `packages/durable/src/codeHost.ts`, serves both
bases; Base's `durable-base.ts` got `dolt`, `committedTransaction`, `transactionSync`, the local nonce table and the
`DirectCallNonceGate` (and `createTestDO` takes a `storage`, so Base tests can run on `FakeDoltStorage`).

Tests: real fork, `universalDoHost.test.ts` "hosting code in an entity" (4 tests: compile + Dolt commit + identity + isolation
between entities; refusals incl. a forged proof; a CPU limit ends a spin and the same instance answers; a drain reaches the class
through its root's handler), `packages/durable/src/codeHost.test.ts` (7), Base `durable-base.dolt.test.ts` (6).

Gate (this step): `pnpm type-check`, `pnpm lint`, `type-check:userland:base` clean. `vitest run packages/durable packages/shared
packages/service-schemas packages/builtin`: 185 files, 1963 pass (before: 184, 1956). Host vitest `src/server/services`, `doDispatch`,
`workerdRpcRelay`, `runtimeManager`, `rpcServer`: 188 files pass, 1 fails (`runtimeService.test.ts` "starts an unbound native
execution clone fresh", pre-existing). Base userland `packages/runtime/src/worker` + `packages/agentic-do`: 62 files, 675 pass. Real-fork
host suites (the P2 list + `workspaceStateCelld`, `celldCpuWatchdogCelld`, one worker): 14 files, 71 pass, 2 skipped; the one
failure of the first run (`internalStorageWorkerd`, 11 tests: product classes have no `ctx.props`, my bug) was fixed and the file
passes (14 pass, 2 skipped).

System-test lanes, `openai-codex:gpt-6-luna`, a fresh instance per 3 to 5 tests, one test per `run`, concurrency 1, 420 s, fork
9440c29, Base worktree + the symlink root. "Before" is "Gate, this pass (steps 0 to 2)" above.

| Lane                   | Before                                                                                                                             | After (step 3)                                                                                                                                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| eval-lifecycle (11)    | 11 pass                                                                                                                            | **11 pass** (`eval-db-persistence` failed once, passed on the re-run)                                                                                                                                                          |
| agentic-runtime (9)    | 6 pass, 3 fail                                                                                                                     | **7 pass, 2 fail**: `state-args-immediate-snapshot` and `workspace-test-runner-extension` (both fail on the pre-change commits); `agent-debug-state-method` passed this time                                                   |
| smoke (4)              | 4 pass                                                                                                                             | **3 pass**, `file-search-read-tools` fails (2 of 2 here, and **2 of 2 on the pre-change commits `253763068` + Base `473acbb`**: the "no `grep` run" sample, so not this step)                                                  |
| workers (9)            | 8 pass                                                                                                                             | **9 pass** (`create-destroy` and `dynamic-workspace-service` failed or errored once each, then passed: `create-destroy` 1 of 1, `dynamic-workspace-service` 3 of 3 here; the pre-change build 2 of 2; `call-do-method` passed) |
| harness-resilience (5) | 5 pass                                                                                                                             | **5 pass**                                                                                                                                                                                                                     |
| panels                 | `browser-panel`, `panel-list-sources`, `panel-tree-navigation` pass; `create-panel` fails; `browser-import-panel-lifecycle` 0 of 0 | **the same** (`panel-list-sources` failed once, passed on the re-run; `create-panel` fails with model errors as before)                                                                                                        |

No test showed a hang, an attestation error or an input-gate error. The pre-change checks checked out the two commits in the same
worktrees (detached), rebuilt, ran, and went back to the branches (rebuilt); nothing was left detached. All instances are stopped.

### Steps 3c and 4: session entities and the kernel as a Base class (2026-11-14)

Design first, committed alone: `docs/dolt-redesign.md` §7.5.1 (the kernel call contract: `start`, `await`, `events`, `cancel`, `get`,
`receipt`, scope controls; the kernel's own caller check: the hosting entity, or a session entity whose admission nonce matches).

What exists (vibestudio `f1fa35157` .. HEAD, Base `5c6639a` .. HEAD):

- **Base `workers/eval-kernel`** (`EvalKernel`): `EvalDO` moved into the template (engine, journal, surface help, owner bindings, tests: 239
  tests: the product's 7.6k lines of tests minus the push, redelivery and hold ones, plus the contract tests). A `hosted` Dolt class (`storage: "dolt"`,
  `codegen`, `residency`, `limits.cpuMs 600000`). The engine is imported directly; the runtime, natlang and cdp providers are the template's own
  packages (env can override, an empty binding turns one off). It commits `eval: <runId> accepted` before `start` returns and `eval: <runId>
<status>` when the run settles (a commit sweeps whatever the run left dirty: events, checkpoints; every write is its own Dolt transaction, so a
  run with many outbound calls pays one flush per checkpoint, not measured). The root holds residency and relays a drain to `onHostedRevoked`
  (the generation-lost terminal as before). Gone: result redelivery and its alarm (a facet has none), the residency hold, host-only schemas.
  The realm is locked down by importing `@vibestudio/shared/kernelRealm` first in the entry (SES; `ses` is now a dependency of
  `packages/shared`, `pnpm-lock.yaml` edited by hand to match the root's resolution).
- **Base `workers/session`** (`SessionDO`, plain SQLite): hosts the kernel (`hosts` in its manifest), authenticates its principal (or the host
  service), relays the contract with the nonce of the run named (local table `session_runs`), relays lifecycle to the kernel, relays channel
  deliveries/invocations to the kernel's resident sessions (found by the system-test runner: the channel addresses the session entity), and has
  `settle` for the push model's host settlement paths.
- **Host:** `evalService` creates the session entity with `runtime.internal.createEntity` (new optional third argument: a host-verified agent
  binding, because the execution admission is checked against the entity's `agentBinding` on every call); owner is the parent. The identity
  checks that named the product class use `isEvalHostRecord` (`packages/shared/src/evalRuntimeIdentity.ts`). The liveness supervisor and the
  gateway token are gone. The host pulls a terminal row (`await`) and delivers `onEvalComplete` to an agent with backoff until acknowledged
  (in memory: **a restart of the host loses it**). The product `EvalDO`, its catalog entry, `internalDoExecutionCatalog` row, generated ledgers
  (`generate:builtin-catalog`, `generate:host-authority`, `generate:runtime-foundations`, review digest) and `packages/builtin/src/eval-engine`
  are deleted. Base `agentic-do` accepts `onEvalComplete` from the host.
- **D5:** legacy `EvalDO` scopes and unacknowledged receipts are dropped; the kernel starts empty (§7.12 step 4). The restart report is not
  wired to a message: it is this paragraph and §7.10.
- Tests: Base `workers/eval-kernel` (239, including `EvalKernel.contract.test.ts`: caller check, `await` timeout, commits on a
  Dolt fake), `workers/session` (8); host `evalService.test.ts` 37; identity, ingress, roots, journal, rpcServer, runtimeManager adapted.

Found by running it (each fixed): a hosted entry may export only classes (`SESSION_KERNEL_CLASS` in the entry failed the schema probe); the
kernel needs the entity's token as its gateway token; channel deliveries reach the session entity; the session record needs the agent binding;
the owner takes the terminal hint from the host.

**Restart delay, answered** (the "60 s after `restartWorkerd`" of the earlier pass): not a hard kill and not a lease. `restartWorkerd` is an
in-place adoption (`celld node adopted generation 2 in place`; the node process lives on). A cell that holds a residency hold is not at a swap
safe point, so celld quiesces it (new requests queue) until `CELLD_DEPLOY_MAX_AGE_S` (default **60**) forces the swap, which revokes the hold
(`residency_revoked ... reason="swap"` at +60.36 s in the node log). With `CELLD_DEPLOY_MAX_AGE_S=2` the same test takes 4.4 s instead of 63.9 s.
`NodeFenced` was not seen in this run's log (it is what a request path reports when it is submitted while the actor is gone). **Consequence for
the product:** a planned restart (developer restart, generation swap) waits up to 60 s for every cell that holds a hold, which is every
entity with a hosted kernel; either set the variable for the node or have the root release its holds on a planned restart. Not a celld bug.

**Gate (this pass).** `pnpm type-check`, `pnpm lint`, `type-check:userland:base` clean. `vitest run packages/durable packages/shared
packages/service-schemas packages/builtin`: 171 files, 1712 pass. Host vitest `src/server/services`, `doDispatch`, `workerdRpcRelay`, `rpcServer`,
`runtimeManager`, `workspaceEntityStore`: 199 files, 2611 pass, 1 fail (`runtimeService.test.ts` "starts an unbound native execution clone
fresh", pre-existing). `src/cli/agent/index.test.ts` "exports the selected workspace RPC client" fails on an `auth.getConnectionInfo` return
schema: not examined, not touched by this work (it was not in earlier gates). Real-fork host suites (the P2 list + `workspaceStateCelld`,
`celldCpuWatchdogCelld`, one worker): 14 files, 68 pass, 2 skipped; `internalStorageWorkerd` had three tests on the product `EvalDO` (two deleted,
one moved to `WebhookStoreDO`). Base: `workers/eval-kernel` 14 files and `workers/session` pass, `packages/agentic-do` 53 files 588 pass,
`packages/runtime/src/worker` pass. `check:execution-root-providers`, `check:builtin-catalog`, `generate:host-authority --check`,
`generate-runtime-foundation-ledgers --check` and `generate-unit-authority-manifests --check` pass (the Base manifests declare what the
kernel's and session's code implies). Not run: `format:check`, `check:runtime-docs` (known failures).

System-test lanes, `openai-codex:gpt-6-luna`, a fresh instance per 3 to 5 tests, one test per `run`, concurrency 1, 420 s, fork 9440c29,
Base worktree + symlink root. "Before" is "Gate (step 3)" above.

| Lane                   | Before (step 3)                                                                           | After (steps 3c and 4)                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eval-lifecycle (11)    | 11 pass                                                                                   | **11 pass** over two runs: `eval-preauthorization` failed once (the known 380-row preview) and passed on the re-run; `eval-scope-reset` failed twice on `reset:true` (`SQL error: prepare SQL cursor: not authorized`: reset dropped Dolt-reserved tables) and **passes after the fix** (Base `81db5ba`)                                                                                                                                                        |
| agentic-runtime (9)    | 7 pass, 2 fail (`state-args-immediate-snapshot`, `workspace-test-runner-extension`)       | **9 pass**: `state-args-immediate-snapshot` failed once and passed on the re-run; `agent-debug-state-method` errored once and passed on the re-run; `workspace-test-runner-extension` passed                                                                                                                                                                                                                                                                    |
| smoke (4)              | 3 pass, `file-search-read-tools` fails                                                    | **4 pass**                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| workers (9)            | 9 pass                                                                                    | **8 pass**: `create-destroy` failed twice (the model called a method that does not exist, `runtime.listEntities`; it also failed once on the pre-change build in earlier passes); `worker-do-sql-persistence` and `worker-env` failed once and passed on the re-run                                                                                                                                                                                             |
| harness-resilience (5) | 5 pass                                                                                    | **5 pass**                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| panels                 | `browser-panel`, `panel-list-sources`, `panel-tree-navigation` pass; `create-panel` fails | `browser-panel` failed once (model error, `panelCdp.consoleHistory` without `page`) and passed on the re-run; **before that, `browser-panel` and `panel-tree-navigation` errored on `chatOp: refusing caller do:workers/session:SessionDO:...`, a hard-coded product id in Base `agent-vessel.ts` (fixed, Base `c456f1f`)**; `panel-list-sources` and `panel-tree-navigation` pass; `create-panel` fails as before; `browser-import-panel-lifecycle` ran 0 of 0 |

No pre-change check of the failures was needed beyond the above: each re-run passed, or the failure is the one the earlier passes recorded
(`create-destroy`, `create-panel`). The batches were run on the final code except that `eval-scope-reset` (before its fix) and the two panel tests
(before the `chatOp` fix) ran on the previous Base commit and were re-run on the fix. Per-test durations of the hosted kernel: `eval-events` 2 s,
`eval-cancel-run` 4 s, the others 20 to 210 s (model time). All instances are stopped (`p2b2lane`).

**Commits of this pass.** vibestudio `feat/dolt-p0`: `a4d330a3b` pin `ec0d6f5`; `1578208d4` per-run CPU limit, swap no longer stalls; `ee19d3160` D5 message;
`ddadd91b4` `cpuLimitForTimeout`; `97eb441a2` CLI session identity fix; `84f67dbe6`, `004b63ed8` `restart` and `callOrRestart`; `a542e82e0`, `54da92af3` docs (§7.7
cost, §7.8 CPU findings). Base `feat/dolt-p2`: `8634b7e` session CPU limit; `192a024` D5 message; `b0b8cbe` overdue-run reaper; `b286b2a` kernel call budget; `b97b3ff` type
fixes. All with `--no-verify` for the known `format:check` / `check:runtime-docs` failures (Base has no hook). Nothing pushed.

### P2b steps 5 and 6, this pass (2026-11-14): what was done, and where it stopped

Fork `ec0d6f5` is pinned (`native/celld/targets.json`, sha256 `6fa5937a...1b9d`; the binary is gitignored, copied from
`/home/werg/celld-harness-bin/celld-uf-ec0d6f5`).

**Done and gated**

1. **Per-run CPU limit.** `hostCode(...).limited({ cpuMs })` (`packages/durable/src/codeHost.ts`, `CodeHostInput.limits`,
   `UniversalDO.hostedFacet` passes it as the third argument of `ctx.facets.get`), `cpuLimitForTimeout(timeoutMs)`;
   `SessionDO.start` carries the run's `timeoutMs`. `celldCpuWatchdogCelld.test.ts`: the second probe now ends a spin at the
   call's limit (1658 ms for 1500) and also work left under `waitUntil` (1472 ms). **Found by driving the product kernel
   (not by the probe):** after the limit ends the run, the next calls to that kernel's entity never return (`eval run`,
   `eval repl-reset`; another session is fine). The minimal probe does not reproduce it (fork gap without a minimal repro, §7.8
   has the CLI repro). Built because of it: `EvalKernel.reapOverdueRuns` (an overdue run is settled by the next
   `await`/`start`/`get`), `hostCode(...).restart()` and `callOrRestart` (a call that overruns its budget asks for a restart
   and answers `EUNRESPONSIVE`); `SessionDO` uses them. If the whole cell is what stopped, none of it helps and the node-level
   `recoverUnresponsiveSandbox` (kept, no caller) is the only recovery.
2. **Restart wait.** The `universalDoHost` drain test takes 2 s (63 s before) and asserts it. No `CELLD_DEPLOY_MAX_AGE_S`
   workaround existed in code (only in the two handoffs).
3. **D5 restart report is a message.** `legacyNotebookDropped`: the admission reports an active
   `do:vibestudio/internal:EvalDO:<key>`; the kernel says it once in `kernel.event`; the eval tool prints
   `[kernel] This notebook was upgraded: ...` under `[kernel] Restarted` (§7.10).
4. **Measured** (§7.7): 11.0 flushes of the kernel's cell file per trivial run (2 named commits, 9 uncommitted writes),
   `start` 78.7 ms, pull to terminal 121.5 ms.

- **A regression of step 3c, found and fixed:** a CLI session (an owner with no code) failed every `eval run` with "no
  matching sealed execution artifact" (`entityOfCodeIdentity`). The lanes cannot see it (their owners all have code).
- `src/cli/agent/index.test.ts` "exports the selected workspace RPC client" fails on `db8e365fd`, the base of this branch
  (`feat/celld-runtime`), and on `7bb9a617d`: it predates all of this work.

**Not done: Step 5 (pull per caller kind) and Step 6 (deletion).** No caller kind was moved, so `evalService`, the ingress,
roots and journal services, `settle`, `evalEngineMethods` and `resultReceiver` are all still there
(`rg 'evalService|EvalDO|UNSAFE_EVAL|resultReceiver|eval_result_redeliveries'` has about 190 hits; most are tests, the generated
catalog and the authority ledger). The reasons, and what the next pass needs to decide first:

- Each caller needs the host admission as a **host service** (today it is a function inside `evalService.prepareRun`, with
  owner resolution, the session entity's creation, source resolution, the parent panel, the harness identity and the run
  digest around it). Proposal: `dynamicCode.admit` (and `release`), taking the run's intent and the hosting entity, returning
  the nonce, the digests and the exact start input; `evalService` shrinks to it.
- **The push channels have no pull replacement yet, and need a design decision**: (a) live events: the kernel pushes to
  `evalEventIngress` (UI, CLI console) and to the agent's `onEvalProgress`; the pull is `events(runId, after)` tailed by the
  caller; (b) authority events (`appendAuthorityEvent`, written by the host's authority observer through `SessionDO.settle`):
  a puller needs "waiting for approval" too, so the host keeps them and the puller asks a host method, or the hosting entity
  relays; (c) execution roots (`retainExecutionRoot`, `listRetainedExecutionRoots` through `settle`): the `eval-run` root
  provider needs an ordinary host-callable method on each hosting entity instead of `settle`.
- The agent hosts its own kernel: `hosts` in the agent classes' manifests, `onHostedRevoked`, and the acknowledgement task of
  `native-eval-receipts.ts` becomes a pull task (`kernel.await` until terminal, then `acceptReceipt`); the executor fact stays
  `kind: "eval"` until then; the host places that name the session entity (`isEvalHostRecord`: approvals, webhooks, authority
  runtime, live caller) must also recognise an agent-hosted kernel; `chatOp`'s `assertOwnEvalCaller` becomes the entity itself.
- Callers to move, in the order of size: the CLI (`evalCommand.ts`, `evalAutoApproval.ts`, `mobile-smoke.mjs`), panels
  (`panels/natlang/src/runtimePorts.ts`, the panel runtime), the system-test runner (template `system-testing`,
  `workers/system-test-runner/index.ts`: `eval.deleteScopeValue`, `eval.dispose`, `eval.readScopeTextPage`, `createEvalRunObserver`;
  that template's main checkout has uncommitted user edits, so it needs its own worktree), the agent (`native-eval-tool.ts`,
  `native-agent-owner.ts`, `agent-vessel.ts` `cancelEval`, `rpc-contract.ts`, `harness/src/tools/eval.ts`), and the website e2e
  spec (`tests/e2e/flows/websiteWorkspaceConnection.spec.ts`).

**Gate, this pass.** `pnpm type-check`, `pnpm lint`, `type-check:userland:base` (two type errors of mine fixed on the way), `check:execution-root-providers`,
`check:builtin-catalog`, `generate:host-authority --check`, `generate-runtime-foundation-ledgers --check`, `check:unit-authority`,
`check-explicit-authority-manifests`, `generate-unit-authority-manifests --check`: clean. `vitest run packages/durable packages/shared
packages/service-schemas packages/builtin`: 171 files, 1715 pass (before 1712). Host vitest `src/server/services`, `doDispatch`, `workerdRpcRelay`,
`rpcServer`, `runtimeManager`, `workspaceEntityStore`: 190 files, 2514 pass, 1 fail (`runtimeService.test.ts` "starts an unbound native execution clone
fresh", pre-existing). Real-fork host suites (the P2 list + `workspaceStateCelld`, `celldCpuWatchdogCelld`, one worker, fork `ec0d6f5`): 14 files, 70
pass, 2 skipped (before 68). Base userland: `workers/eval-kernel`, `workers/session`, `packages/agentic-do`, `packages/runtime/src/worker`,
`packages/harness`: 111 files, 1299 pass. Not run: `format:check`, `check:runtime-docs` (known failures).

System-test lanes on the final code, `openai-codex:gpt-6-luna`, fresh instances of 3 to 5 tests, one test per `run`, concurrency 1, 420 s, fork `ec0d6f5`.
"First" is the sweep, "after" is after one re-run of each failure.

| Lane                   | Before (steps 3c and 4)                                                                   | First sweep                                     | After one re-run                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eval-lifecycle (11)    | 11 pass                                                                                   | 9 pass                                          | **11 pass** (`eval-exact-authority` and `eval-preauthorization` each failed once and passed on the re-run)                                                                                                                                                                                                                                                                                                                         |
| agentic-runtime (9)    | 9 pass                                                                                    | 5 pass                                          | **8 pass, 1 fail**: `workspace-test-runner-extension` fails 3 of 3 (it fails on the base too, handoff of the cutover); `state-args-immediate-snapshot` failed twice and passed on the third try, `runtime-vcs-client-helper` (timeout) and `agent-debug-state-method` (error) passed on re-run                                                                                                                                     |
| smoke (4)              | 4 pass                                                                                    | 3 pass                                          | **3 pass, 1 fail**: `file-search-read-tools` fails 2 of 2 (the known "no `grep` run" sample; 2 of 2 on the earlier pre-change commits too)                                                                                                                                                                                                                                                                                         |
| workers (9)            | 8 pass (`create-destroy` failed twice)                                                    | 7 pass                                          | **8 pass, 1 fail**: `installed-workspace-service-consumer` fails 3 of 3 (`eval:module_not_available`, a user-code failure of the model's script; earlier passes saw it fail on model errors and pass on re-run). The pre-change comparison could not be made: the pre-change checkout does not boot in this environment (a storage error for `AiChatWorker`, with the new binary), so **this one is not shown to be pre-existing** |
| harness-resilience (5) | 5 pass                                                                                    | **5 pass**                                      | 5 pass                                                                                                                                                                                                                                                                                                                                                                                                                             |
| panels                 | `panel-tree-navigation`, `panel-list-sources`, `browser-panel` pass; `create-panel` fails | `panel-tree-navigation` pass; the others failed | `browser-panel` and `panel-list-sources` pass on re-run, `create-panel` fails (model errors, as before), `browser-import-panel-lifecycle` ran 0 of 0                                                                                                                                                                                                                                                                               |

No test showed a hang or an attestation error. The two instances used for the CPU-limit and measurement checks (`dolt-p2b`, `dolt-p2c`) are stopped; the strace wrapper
and call-trace environment were set only for `dolt-p2b`.

### P2b steps 5 and 6, second pass (2026-11-15): the kernel fix, `dynamicCode`, three caller kinds pulled

**Setup done.** Fork `2d1749d` pinned (`03b096335`; the two upstream wedges E12/E13 of the fork docs are fixed in it). Base
`feat/dolt-p2` rebased onto Base `main` `d79b61f` with **no conflict**: the user's `EVAL.md` edit (the natlang call budget
sentences) and this branch's lease removal touch different paragraphs, so both are kept; the untracked copy of
`skills/sandbox/claims/` was dropped from the worktree (it is committed in `main` now). `check:runtime-docs` **now passes**
(rc 0), so it is no longer a reason for `--no-verify`; the only remaining one is the pre-existing `pnpm format:check`
failure (11 files of the base branch, none of them touched here except `celldCpuWatchdogCelld.test.ts`, now formatted).
The system-testing template has its worktree and is in the symlink root (`system-testing` points to
`/home/werg/vibestudio-templates-worktrees/system-testing-dolt-p2`).

**1. The kernel fix** (Base `bd89d94`, host `a929dddb5`, docs §7.8). `EvalKernel.awaitRunOrAbandon`: after a deadline abort
(and the cancel handlers) a run whose promise does not settle within 1.5 s is abandoned: the row takes the typed
`eval_deadline_exceeded` result and the run chain is released (the chain element races the run against a per-run
`abandoned` promise), so queued and later runs are admitted. **Product repro, passing:** `eval run` of `while(true){}` with
`--timeout 4000`, then `eval run` of `return 40+2` on the same session answers in 5.9 s on the same kernel incarnation; the
server log has the one `abandoning it` warning. Tests: Base `EvalKernel.cancel.test.ts` "a run whose guest never unwinds after
its deadline abort ..." (fake timers; it first failed because the queued run was stuck behind the abandoned promise, which is why
the chain race exists), the real-fork probe `celldCpuWatchdogCelld.test.ts` ("a run ended by its call's CPU limit is settled
by its own deadline timer", settles after 1505 ms with a 1500 ms limit), and the system scenario `eval-deadline-recovery`
(system-testing template; passes on the product). **Correction of the earlier note:** `eval repl-reset` "never returning" on a
healthy session was the critical `code-runner.reset` approval that a bare CLI has nobody to answer, not a wedge.

**2. `dynamicCode.admit` / `release` / `reset` / `dispose`** (host `b03d1c1c4`, `728afc698`; schema
`packages/service-schemas/src/dynamicCode.ts`; docs §7.5.2). `admit` returns `{ runId, runDigest, authorityManifestDigest, host,
hostId, nonce, start }` and starts nothing; the caller starts the run on the hosting entity (`start(input, nonce)`), pulls
(`await`, `events`), cancels, and calls `release`. `reset` and `dispose` are host methods because they need host authority
(`code-runner.reset` approval; retirement), and the session's own `reset` is host-only. **A pull caller has no event sink**
(`eventSinkNonce` is optional); a caller that dies between `admit` and `release` is reconciled by the next admission, which asks
the hosting entity (`get`) every 2 s whether the holder ended, or never started (30 s grace). The session (Base `cf05314`)
serves its principal, the host and the user's own shell, and its run methods are website-eligible. `evalService.ts` now holds
both services (`createEvalServices`); `createEvalService` is kept for the tests and returns the `eval` service. One client:
`createDynamicCodeExecutor`, `startDynamicCodeRun`, `createDynamicCodeRunObserver`, `createDynamicCodeScope` (5 tests).
Authority census, golden, catalog and ledger regenerated (additions only; `censusDigest` updated).

**3. Callers moved, each gated:**

| Caller              | Commits                                               | Gate                                                                                                                                                                                          |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CLI                 | host `3794a5fa5` (`evalCommand.ts` and its 14 tests)  | pull verified on the product: `eval run` ok, console streamed in text mode, spin then run, `smoke` lane and `eval-cancel-run`, `eval-events` on that instance                                 |
| natlang panel       | Base `cf05314` (`panels/natlang/src/runtimePorts.ts`) | Base type-check; the panel's tests use fake ports; the `panels` lane does not run the natlang panel, so **the panel path is covered by the executor's unit tests only, not by a product run** |
| system-test runner  | host `728afc698`, system-testing `b341577`            | `workers/system-test-runner` 14 tests and `skills/system-testing/runner.test.ts` (21), system-testing type-check; every system-test lane runs through it                                      |
| agent, website spec | **not moved**                                         | see "What the agent needs"                                                                                                                                                                    |

`mobile-smoke.mjs` only runs the CLI (`vibestudio eval run`), `evalAutoApproval.ts` needed no change (its caller id is the session
entity's id, unchanged).

**What the agent needs (step 5's last real caller, and therefore step 6). Done in the third pass, below; kept as the plan it followed.** Not started, because it is one coherent cut of about
a day and touches the Pi durable machinery; a half-done agent would leave both models in force. The design, from reading the code:

- **Pull instead of the host tail and `onEvalComplete`.** `native-eval-tool.ts` `execute`: `admit` through `createMainRpcCaller(execution.rpc)`
  (the invocation rpc carries the causal parent), `start` on the session entity (`hostId = evalRuntimeId(participantId, scope)`,
  already computed in `native-agent-owner.ts` and `agent-vessel.ts`), then `retainContinuation` and a **background Pi task**
  (`vibestudio.eval-await`, created like the acknowledgement task in `native-eval-receipts.ts`, `background: true`) whose phase loops
  `session.await(runId, { waitMs })` and `events`, hands each page of events to the vessel's progress handler (the body of
  `onEvalProgress`, which stays an internal method), and on a terminal row calls `retainObservedEvalReceipt` (this accepts the
  receipt that resolves the parked tool and creates the acknowledgement task). `onEvalComplete` and `resultReceiver` go.
  `consumeEvalReceipt` becomes the task's tail. `cancel` is `session.cancel` + `receipt` + `release`.
- **Acknowledgement.** Add `acknowledge(runId, identity)` to `SessionDO` (a relay to the kernel's `acknowledgeRunResult`, principal
  only) and `hostedCodeMethods.acknowledge`; `createNativeEvalAcknowledgements` calls it instead of `eval.acknowledge`.
- **Self-hosting (optional, and the user's stated end state).** `hosts` in the agent classes' manifests (`AiChatWorker`, the native
  owner), `hostCode` in the agent, `onHostedRevoked`, `isEvalHostRecord` recognising an entity whose manifest hosts the kernel
  (`principalIdentity.ts`, `approvalCallerTitle.ts`, `evalKernelAuthority.ts` go with the ingress, the `liveExecutionCaller`,
  authority runtime and webhook places), `assertOwnEvalCaller` becoming "the caller is this entity" (the kernel's callbacks to its
  agent are calls to itself), and the executor fact renamed from `kind: "eval"` (`packages/rpc/src/authority.ts` plus four
  consumers: `authorityRuntime.ts`, `agentExecutionSessionRegistry.ts`, `acquisitionCoordinator.ts`, `attachedHostApprovalPresenter.ts`).
  It is not needed to delete the push machinery (the session entity can keep hosting for the agent), so it can follow.
- **Channels (b) and (c) before step 6.** (b) authority events: `EvalAuthorityEventJournal` pushes them into the kernel
  (`SessionDO.settle("appendAuthorityEvent")`); the kernel stores them in `run_events` and `get().activity`, which a puller already
  sees. Replace by the host keeping them per run (in memory, bounded, ordered) behind a host method `dynamicCode.authorityEvents(runId, after)`
  that the hosting entity's `await`/`events` relay merges (or the puller calls). (c) execution roots: the `eval-run` root provider
  (`src/server/index.ts` `evalRunRootProvider`) lists `listRetainedExecutionRoots` through `settle`; make it a host-callable method on every
  hosting entity provided once by the durable bases (`hostedExecutionRoots()`), and move `evalExecutionRoots.retain` (the publication
  interlock the kernel calls when it imports a workspace bundle) into `dynamicCode` as an admitted-executor method, then delete the
  roots service.
- **Then step 6** is deletions: `evalService` down to `dynamicCode`, `evalEventIngressService`, `evalExecutionRootsService`,
  `evalAuthorityEventJournal`, `evalKernelAuthority`, `settle`, `deliverTerminalToReceiver`, `evalEngineMethods` and its schema,
  `resultReceiver` (schema, executor, tests), the `eval` service schema, `eval_result_redeliveries` (already gone with the product
  `EvalDO`; the string survives in docs), the generated catalog and ledger rows, and the census digest. The website spec
  (`tests/e2e/flows/websiteWorkspaceConnection.spec.ts`: `eval.start` + polling `eval.get`) becomes `dynamicCode.admit` plus
  `rpc.call(hostId, "start" ...)`; the session's run methods are already website-eligible. It needs the desktop app and was not run.

`rg 'evalService|EvalDO|UNSAFE_EVAL|resultReceiver|eval_result_redeliveries'` therefore still has its hits (evalService and its tests,
the agent, the service schemas and generated rows, docs); none was deleted this pass.

**Gate, this pass.** `pnpm type-check`, `pnpm lint`, `type-check:userland:base` and `:system-testing` (run as `npx tsx
scripts/type-check-userland.ts --template X`: `pnpm type-check:userland:base` in a `nohup` shell was terminated after about a minute for a
reason not found; run in the foreground it passes), `check:runtime-docs`, `check:builtin-catalog`, `check:execution-root-providers`,
`generate:host-authority --check`, `generate-runtime-foundation-ledgers --check`, `generate-unit-authority-manifests --check` (a comment in
`SessionDO.ts` that named `dynamicCode.reset` made the scanner imply the `code-runner.reset` request: avoid service names in comments),
`check-explicit-authority-manifests`: clean. `vitest run packages/durable packages/shared packages/service-schemas packages/builtin`: 172 files, 1720
pass (before 1715). Host vitest `src/server/services`, `doDispatch`, `workerdRpcRelay`, `rpcServer`, `runtimeManager`, `workspaceEntityStore`, `src/cli`:
249 files, 3087 pass, 2 fail, both pre-existing (`runtimeService.test.ts` "starts an unbound native execution clone fresh", `src/cli/agent/index.test.ts`
"exports the selected workspace RPC client"). Real-fork host suites (the P2 list + `workspaceStateCelld`, `celldCpuWatchdogCelld`, one worker, fork `2d1749d`):
14 files, 71 pass, 2 skipped (before 70). Base userland (`workers/eval-kernel`, `workers/session`, `packages/agentic-do`, `packages/runtime/src/worker`,
`packages/harness`, `panels/natlang`): 118 files, 1364 pass (before 111, 1299). system-testing: `workers/system-test-runner`, `skills/system-testing/runner.test.ts`,
`tests/scenario-semantic-validators.test.ts`: pass.

**System-test lanes** (`openai-codex:gpt-6-luna`, a fresh instance per 3 to 4 tests, one test per `run`, concurrency 1, 420 s, fork `2d1749d`, Base worktree
rebased on `main` + the symlink root with the system-testing worktree; the new code in the loop is the kernel fix, `dynamicCode`, and the runner). "Before" is
the table of the 2026-11-14 pass (after one re-run). "First" is the sweep, "after" is after one re-run of each failure (a failure that persisted was inspected).

| Lane                   | Before                       | First sweep                                                                                | After one re-run                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eval-lifecycle (12)    | 11 pass (11 tests)           | 11 pass, `eval-preauthorization` fails                                                     | **12 pass**: the new `eval-deadline-recovery` passes first time; `eval-preauthorization` failed twice more and **passed on the third try** (inspected: the agent preflighted, ran with the exact preauthorization and reported the 2 profiles, `likelyIssue: validation-mismatch`; the known validator/model flake of earlier passes)   |
| agentic-runtime (9)    | 8 pass, 1 fail               | 7 pass, `state-args-immediate-snapshot` and `workspace-test-runner-extension` fail         | **8 pass, 1 fail**: `workspace-test-runner-extension` passes on re-run (it failed 3 of 3 before); `state-args-immediate-snapshot` fails 2 of 2 on `p.stateArgs.set is not a function` in the model's own script (`eval:guest_type_error`; it failed 2 of 2 on the pre-change commits too, 2026-11-14)                                   |
| smoke (4)              | 3 pass, 1 fail               | **4 pass**                                                                                 | 4 pass (`file-search-read-tools` also failed once and passed on a re-run on the CLI instance)                                                                                                                                                                                                                                           |
| workers (9)            | 8 pass, 1 fail               | 7 pass, `call-do-method` and `dynamic-workspace-service` fail                              | **9 pass**: both pass on re-run; `installed-workspace-service-consumer` **passes 2 of 2** (it failed 3 of 3 with `eval:module_not_available`, a failure of the model's script, in the earlier pass: it does not reproduce, and no state of this work makes a module unavailable, so it is a model-sample failure, not shown to predate) |
| harness-resilience (5) | 5 pass                       | **5 pass**                                                                                 | 5 pass                                                                                                                                                                                                                                                                                                                                  |
| panels                 | 3 pass, `create-panel` fails | `panel-tree-navigation` passes; `create-panel`, `browser-panel`, `panel-list-sources` fail | `browser-panel` passes on re-run; `panel-list-sources` failed twice and **passed on a third try**; `create-panel` fails (2 of 2; the model errors of every earlier pass); `browser-import-panel-lifecycle` ran 0 of 0                                                                                                                   |

No test showed a hang, an attestation error or an input-gate error; no failure was in a path this pass changed except as noted. The CLI cut was also run on its own
instance (smoke 4 of 4 after one `file-search-read-tools` re-run, `eval-cancel-run`, `eval-events`). All instances are stopped (`p2dcpu`, `p2dcli`, `p2dr1`, `p2g1*`,
`p2g2*`, `p2dbg1`); nothing is running.

**Commits of this pass.** vibestudio `feat/dolt-p0`: `03b096335` pin fork `2d1749d`; `a929dddb5` the CPU-limit deadline probe; `b03d1c1c4` `dynamicCode`
service; `3794a5fa5` CLI pulls; `728afc698` run observer and `startDynamicCodeRun`; `1b6adb699` docs (§7.5.2, §7.8, §7.12). Base `feat/dolt-p2` (rebased onto `main`
`d79b61f`, so **the Base hashes in the sections above predate the rebase**; the tip before this pass is `88e8c60`): `bd89d94` kernel deadline abandonment, `cf05314`
session (shell, host-only reset, website-eligible runs) and the natlang panel. system-testing `feat/dolt-p2` (from `main` `f611e7b`): `b341577` runner and probes pull,
`eval-deadline-recovery`. All host commits used `--no-verify` for the pre-existing `format:check` failure only (`check:runtime-docs` passes). Nothing pushed.

**Fork gaps found this pass:** none open. E12 and E13 (fork `design.md` §3b.17, `upstream-findings.md`) are fixed by `2d1749d` and verified by the product repro and the real-fork
probe above. One behaviour worth knowing: after the CPU limit ends a `start` call the kernel keeps its heap (same incarnation id on the next run) and the timer fires about one
limit after the call began, so a run with `timeoutMs` T is settled at about T plus the 1.5 s grace.

### P2b steps 5 and 6, third pass (2026-11-15): the agent pulls, the push model is deleted

**What moved.** The agent (Base `packages/agentic-do`), the website acceptance spec and a host integration test
(`tests/headless-panel.integration.test.ts`, found by `rg` and not in the earlier list) settle by pull; then step 6
deleted the push model. The design is the "What the agent needs" plan above, with the deviations below; the
as-built account is `docs/dolt-redesign.md` §7.5.2 ("The agent pulls too") and §7.11 ("As done").

- **Agent.** `native-eval-tool.ts` `execute` admits with `dynamicCode` and starts on the session entity
  (`startDynamicCodeRun`, new option `keepAdmissionOnFailure`, so a lost start response is retried under the same
  admission instead of releasing it), records the start's digest, reads `receipt`; if the run is not terminal it
  creates the `vibestudio.eval-await` background task (once: its id is kept in the retained admission document)
  and parks as before. `createNativeEvalAwait` (`native-eval-receipts.ts`) pulls `await` and `events` for at most
  15 s per invocation, hands the pages to `publishEvalEvents` (console to `invocation.output`, authority events
  to `invocation.progress`; the old `onEvalProgress` body), checkpoints the cursor, sleeps 0.5 s and repeats; a
  terminal row releases the admission and commits the receipt acceptance, the acknowledgement task and its own
  completion in **one transaction** (`retainEvalReceiptTx`). `SessionDO.acknowledge` relays the acknowledgement
  to the kernel under the run's nonce (the kernel's `acknowledgeRunResult` now checks its caller).
  `cancel` and the chat pill's `cancelEval` are `cancel` on the entity. Gone: `onEvalComplete`, `onEvalProgress`,
  `consumeEvalReceipt`, `retainedEvalRunRoute`, `evalOwnerCallbackRpcMethods` and its contract check.
- **Deviation from the plan: the pull is not one long phase.** The first version looped for the whole run inside
  one invocation. `alarm()` runs `harness.runPass`, which waits for every live invocation, so it would have held
  the owner's wake-up pass for as long as the user's code runs. Each invocation now pulls for at most 15 s and
  sleeps (`sleepUntil`); a failed pull sleeps with backoff instead of looping.
- **Deviation from the plan: `settle` is not "replaced by the host keeping events".** The two host-to-entity
  interlocks that carry facts only the host holds stay, as named host-only methods of `SessionDO`
  (`recordAuthorityEvent`, `retainExecutionRoot`, `executionRoots`); they are not delivery to a caller. A pull of
  authority events by the kernel was not built (a host round trip per poll and a second cursor). The string
  `settle`, `failPendingRun` and the event-sink nonce are gone.
- **Step 6.** `evalService.ts` is `dynamicCodeService.ts` (`createDynamicCodeService`, the `dynamicCode` service
  alone; the managed service is named `dynamicCode`); deleted: the `eval` service and its methods, the host tail,
  `deliverTerminalToReceiver` and its backoff, `resultReceiver`, `evalEngine.ts` (and
  `EVAL_ENGINE_HOST_CONTRACT_VERSION`: nothing compared it), `evalEventIngress` (service, schema, sink registry, the
  kernel's live push), `createEvalExecutor` and the other push-era helpers of `eval.ts`, `eventSinkNonce`. The
  kernel lost the console streamer and every push. Authority golden, host catalog, foundation ledgers and
  `scripts/runtime-authority-review.json` (11 rows removed, `censusDigest` updated) are regenerated (deletions
  only). `execution.eval-do` is `execution.eval-kernel` in the update ledger. Repo-wide prose and fixtures: see the
  `rg` result below.
- **Website spec.** `tests/e2e/flows/websiteWorkspaceConnection.spec.ts` admits with `callMain('dynamicCode.admit')`,
  starts and pulls with an ad-hoc `hostedCall` descriptor over the SDK's `rpc`, releases in `finally`. It needs the
  desktop app: it type-checks (host `pnpm type-check`) and **was not run**.
- **Self-development scenario.** The attached-host protocol carries service calls only, so the system-testing
  scenario `self-development-child-eval` (which called the child host's `eval.start`/`eval.get`) now admits and
  releases through the attached route (`dynamicCode.admit`, `dynamicCode.release`) and no longer proves that the cell
  runs. Its validator and unit test are updated; **the scenario was not run** (it needs an isolated development host).
- **Not done:** the optional agent self-hosting (`hosts` manifests, `onHostedRevoked`, the executor fact renamed from
  `kind: "eval"`): documented in §7.12 item 7; nothing needs it.

**Not tested as the user asked.** A real-fork probe of "the agent restarts mid-run and gets its result exactly once" was
not built: the owner's Pi harness runs in the agent's cell with its own storage, and a probe would need the whole
Base agent bundle and the host's authority stack in a fork test. The restart semantics are tested on a real
file-backed Pi session instead (`native-eval-tool.test.ts` "an owner restart while the run is pending still gets its
result exactly once": the owner closes with the run pending, the run finishes while it is down, the reopened owner's
await task pulls the row, accepts the receipt once, the parked tool call finishes, the cell was started once, the
acknowledgement is called once, a second restart changes nothing; also a restart between the terminal row and the
acknowledgement, a failed and a refused pull, an event cursor that survives a restart, cancellation), and on the
product by the agent lanes below (the pull itself, not a restart).

**`rg 'evalService|EvalDO|UNSAFE_EVAL|resultReceiver|eval_result_redeliveries'`** over host, Base and system-testing
(`node_modules` excluded) now has these hits and no others; each is explained:

- **Base and system-testing: none.**
- **Host, the D5 migration that drops legacy `EvalDO` state (the user's decision):** `packages/shared/src/evalRuntimeIdentity.ts`
  (`legacyEvalDoRuntimeId`, the entity id of the retired class), `src/server/services/dynamicCodeAdmission.ts` (comments on
  `legacyHostRuntimeId` and `legacyNotebookDropped`), their tests (`evalRuntimeIdentity.test.ts`, `dynamicCodeAdmission.test.ts`, the
  D5 cases of `dynamicCodeService.test.ts`), `src/server/celldMigration.test.ts` (the legacy storage class names the migration maps)
  and `src/server/workspaceStateMigration.test.ts` ("owes nothing to the retired class"), and `STATE_DIRECTORY.md` (the legacy
  `vibestudio_internal:EvalDO/` directory, now documented as dropped by the upgrade).
- **Host, regression guards that name the retired thing on purpose:** `packages/shared/src/productBuiltinCatalog.generated.test.ts`
  ("eval is hosted code, not a product class": `EvalDO` is not a product builtin) and
  `packages/service-schemas/src/eval.test.ts` (`resultReceiver` is refused by the start input).
- **Host `docs/`: 48 files.** `docs/dolt-redesign.md` is this design and names what it deletes. The other 47 are dated plans, specs,
  reviews and audits (`*-plan.md`, `*-spec.md`, `security-review-*`, `reviews/`, `durable-pi-*`, ...) that describe the system as it
  was when written; they were not rewritten. The live reference docs were (`docs/architecture/*`, `docs/cli.md`, `docs/pi-architecture.md`,
  `docs/agentic-architecture.md`, `skills/vibestudio-agent/*`, the generated `API.md`).
- Generated rows (`authority-ledger.json`, the golden, the host catalog, `runtime-authority-review.json`) have no hit left.

**Gate, this pass.** `pnpm type-check`, `pnpm lint`, Base `type-check:userland` for `base` and `system-testing`
(`npx tsx scripts/type-check-userland.ts --template X`), `check:execution-root-providers`, `check:builtin-catalog`,
`generate:host-authority --check`, `generate-runtime-foundation-ledgers --check`, `generate-unit-authority-manifests --check`,
`check-explicit-authority-manifests`, `check:runtime-docs`, `check:agent-docs`, `check:userland-rpc-contracts`: clean.
Host vitest, the whole `vitest.host.config.ts` suite including the real-fork files (fork `2d1749d`): 1,054 files, 10,287 tests: 2 failures, both pre-existing (`runtimeService.test.ts` "starts an unbound native execution clone fresh", `src/cli/agent/index.test.ts` "exports the selected workspace RPC client"); the earlier run of this pass failed 22 tests of my own fixture renames (`workspaceEntityStore.test.ts`, one `rpcServer.test.ts` case), fixed. The run included the 13 real-fork files (the P2 list, `workspaceStateCelld`, `celldCpuWatchdogCelld`, `doltEvalKernelCelld`, `ownerKernelPathCelld`, `doltDurableCelld`), all green; `internalDoLoader.test.ts`, which the earlier gates did not include, had two failures from step 4 (it named the deleted `EvalDO` bundle entry) and is fixed.
Base userland, the whole template: 540 files, 5,094 tests, 2 failures: `workers/session` "records the host's observations..." (my
new test, a wrong message pattern, fixed and re-run green) and `tests/vcs-skill-release-generator.test.ts` ("stale VCS skill artifacts:
skills/vibestudio-vcs/content-manifest.json": **pre-existing**, it fails identically on the tree without my uncommitted Base changes and
this work touches nothing under `skills/vibestudio-vcs`). system-testing template (`workers/system-test-runner`, `skills/system-testing`):
72 files, 892 tests, 4 failures, all in `cli.test.ts` doctor tests: **pre-existing** (the same 4 fail with this pass's changes stashed).
New and changed tests: `native-eval-tool.test.ts` (15, on a file-backed Pi session: the restart cases above), `native-eval-receipts.test.ts`
(10), `native-agent-owner.test.ts` (57), `chat-op.test.ts` (61), `SessionDO.test.ts` (12), `EvalKernel.contract.test.ts` (9), host
`dynamicCodeService.test.ts` (34), `dynamicCode.test.ts` (8).

**System-test lanes** (`openai-codex:gpt-6-luna`, a fresh instance per 4 to 5 tests, one test per `run`, concurrency 1, 420 s, fork
`2d1749d`, Base and system-testing worktrees through the symlink root, each instance given 150 s to finish its background builds before its
first run: a run started during them lost the instance to the 6 GiB scope limit twice, which is why the sweep above has a settle delay). "Before" is the last table of the second pass.

| Lane                   | Before               | First sweep                                                                                                                                                                                                                        | After one re-run                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| eval-lifecycle (12)    | 12 pass              | 10 pass; `eval-exact-authority` (the model passed `resource.key: "*"`: its own `ERUNMANIFEST`; it failed 3 of 3 here, 3 times earlier, passed on re-run), `eval-scope-reset` fail                                                  | **12 pass** (`eval-exact-authority` and `eval-scope-reset` pass on re-run)                                                                                                                                                                                                                                                                                |
| agentic-runtime (9)    | 8 pass, 1 fail       | 6 pass; `state-args-immediate-snapshot`, `gad-status-summary`, `workspace-test-runner-extension` fail                                                                                                                              | **7 pass, 2 fail**: `workspace-test-runner-extension` (`[fs.ensureMaterialized] Context folder ... is missing` in `verify`; fails on base, passed on re-run in the earlier pass), `state-args-immediate-snapshot` (`eval:guest_type_error`, the model's own script; **2 of 2 fail on the pre-change commits too**). `gad-status-summary` passes on re-run |
| smoke (4)              | 3 pass, 1 fail       | **4 pass**                                                                                                                                                                                                                         | 4 pass                                                                                                                                                                                                                                                                                                                                                    |
| workers (9)            | 9 pass               | **9 pass**                                                                                                                                                                                                                         | 9 pass                                                                                                                                                                                                                                                                                                                                                    |
| harness-resilience (5) | 5 pass               | 4 pass; `eval-huge-return-bounded-terminal` fails (the model's own `JSON.parse` of the truncated value, as in earlier passes)                                                                                                      | **5 pass**                                                                                                                                                                                                                                                                                                                                                |
| panels                 | 3 pass, create-panel | `browser-panel`, `panel-tree-navigation`, `panel-list-sources` pass; `create-panel` fails (model errors, `eval:guest_execution_failed`); `browser-import-panel-lifecycle` 0 of 0 (about/browser-import-inspector is not installed) | the same: 3 pass, `create-panel` fails again, 0 of 0                                                                                                                                                                                                                                                                                                      |

The agent's pull itself is exercised by every agent-driven test above (the eval tool is the agent's pull). **Not exercised on the
product:** an agent restart in the middle of a run (unit-tested on a real file-backed session only, see above), the website spec, the
self-development child scenario. No lane test showed a hang or an attestation error. All instances are stopped; the
fork binary is unchanged.

**Commits of this pass.** vibestudio `feat/dolt-p0`: `12042a31f` the shared client (the entity's acknowledgement of `start`,
`acknowledge` on the observer, `cancel` with call options, `keepAdmissionOnFailure`); `5ec7dbbee` the website spec and the
headless-panel integration test pull; `1069cc0d9` step 6 (the push model deleted); the handoff commit that follows this text. Base
`feat/dolt-p2`: `74e5261` the agent pulls (eval-await task, acknowledge relay, kernel pushes removed); `9b757c8` step 6 in Base
(named host-only session methods, `failPendingRun` and the engine constant deleted, prose and fixtures, the sandbox skill documents the pull
client). system-testing `feat/dolt-p2`: `915ea48` the self-development scenario. All host commits used `--no-verify` for the pre-existing
`pnpm format:check` failure only (type-check and lint were run by hand). Nothing pushed.

## What remains after P2b

- **The agent hosting its own kernel** (§7.12 item 7). Optional; nothing in the pull or the deletions needs it.
- **Moving the host's authority events to a pull** (the kernel asking the host on each `events` call) if the two named host-to-entity
  interlocks of §7.5.2 are to go too.
- **A product-level restart probe for the agent** (kill or swap the agent's cell in the middle of a run in a lane). The system tests have no
  scenario that restarts an agent; the unit tests cover the durable semantics.
- **The pre-existing failures**, unchanged: `runtimeService.test.ts` clone test, `src/cli/agent/index.test.ts`, system-testing
  `cli.test.ts` doctor tests, `vcs-skill-release-generator` (stale manifest in Base).

## P3 Durable services: what was built (`docs/dolt-redesign.md` §4.6 has the design and the deviations)

**`WorkspaceStateDO`** (`packages/builtin/src/workspace-state/WorkspaceStateDO.ts`) is the workspace state on a
Dolt cell. It is a new class because a cell's engine is fixed at creation; the SQLite `WorkspaceDO` stays
for one release as a read-only exporter (`WorkspaceDO.ts`: `legacyManifest`, `legacyReadRows`).
Versioned: entities, bindings, slots, slot history, context edges, the seeding marker. Every mutation is one
`committedTransaction` (no commit for a retry, a failure or a local-only change, found through `dolt_status` inside
the transaction). Local (`doltLocal`, declared in the deployment from `runtime.doltLocal`): the close-cleanup outbox,
the panel-tree revision, the lifecycle registry, the alarm schedule, the durable-work owners, the import's staging.

**Deviations from the doc's plan, with reasons (also §4.6):**

- _Panel undo is not "closing deletes rows, reopening reverts them"._ Closing stays `slots.closed_at` because the closed
  list, its paging and the purge are row queries (L2) and `dolt_history_*` is not modelled by the double and cannot
  purge. Each close, reopen and purge is one commit; a close commit's reverse patch touches only `slots` (checked on the
  real fork); a hard reset to the commit before a close is the undo, and the schedule and outbox are untouched.
- _The lifecycle tables and driver, `alarmDriver` and `durableWorkDriver` are not deleted._ They are live: every DO's
  `setAlarmAt` calls `workspace-state.alarmSet`, Pi owners publish a lease, `MissionsDO` and Base's `durable-base.ts`
  register lifecycle releases. Deleting them is the agent system's hibernation-first work (P4), not a local change.
  They became local tables of the new class.

**The migration** (Q2, replay where history exists; `legacyImport.ts`, `legacyImportDriver.ts`,
`src/server/workspaceStateMigration.ts`, the barrier in `DODispatch`): the first call to `WorkspaceStateDO` runs it and
every call waits. Status settled (`verified`, `skipped`, `adopted`) means the retired store is not read. Otherwise the host
pages the 14 tables into a local staging table, `planReplay` orders the rows by their own timestamps (dependencies pulled
forward: the real engine enforces foreign keys), and the class applies one commit per event dated as the row's time
(entity, slot on its first entry, each later history entry as a navigation, one close per shared `closed_at` stamp,
retire at `retired_at`), the applied counter in the same transaction. It then copies the operational tables, proves every
table equal to the retired store's digest, and only then writes the marker commit and `verified`. Idempotent (a settled
cell never reads the store; resume continues at the next event; a changed source restarts from the base commit);
the retired cell is never written or deleted (a later release deletes the class); a failure fails the start and the next
start resumes. A cell that already holds rows is `adopted`, never imported into.

**Storage operations** (`src/server/durableObjectStorage.ts`): `do_maintenance` and its step machine are gone; the node's
fork and restore do the copying. Kept as rows: the storage identity (rotated before any replacement), the backup registry
(listed once the fork finished; unfinished ones swept), the retired-object outbox (an earlier build's open retirements are
adopted). `cloneDO` is `forkObjectStorage`, idempotent by target id. `rg 'cloneDO|do_maintenance'` has only the one
explained hit: the adoption of the earlier journal (`durableObjectStorage.ts` and its test), plus two historical docs
(`capability-approval-design.md`, `ws1-agent-loop-spec.md`). `durableObjectStorageClone.ts` and
`computeWorkerdObjectIdHash` had no remnants.

### P3 results

| Run                                                                                                                                                                                                                           | Result                                                                                                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm type-check`, `pnpm lint`                                                                                                                                                                                                | clean                                                                                                                                                                                                                                           |
| `vitest run packages/durable packages/shared packages/service-schemas packages/builtin`                                                                                                                                       | 184 files, 1946 tests pass (after the catalog and contract test updates; builtin alone: `WorkspaceStateDO.test.ts` 103 tests on `FakeDoltStorage`, `WorkspaceStateDO.dolt.test.ts` 7, `legacyImport.test.ts` 12)                                |
| host vitest `src/server/services`, `doDispatch`, `workerdRpcRelay`, `panelExecutionReconciler`, `workspaceServices`, `rpcServer`, `workspaceEntityStore`, `runtimeManager`, `durableObjectStorage`, `workspaceStateMigration` | all pass except `runtimeService.test.ts` "starts an unbound native execution clone fresh" (pre-existing on the cutover baseline `73e5ba525`, documented in the cutover handoff)                                                                 |
| real-fork host suites, one worker (P2 list + `workspaceStateCelld.test.ts`, `universalDoHost` with the new fork-idempotency test, `internalStorageWorkerd` on `WorkspaceStateDO`)                                             | 13 files, 63 pass, 2 skipped, 0 fail (before: 12 files, 60 pass, 2 skipped)                                                                                                                                                                     |
| `workspaceStateCelld.test.ts` on the real fork                                                                                                                                                                                | 3 tests: the store installs, one commit per mutation, close undone by a durable reset, local state across a kill, the reverse patch of a close; the import end to end with the node killed at four points mid-import and an empty retired store |

System-test lanes, real models (`openai-codex:gpt-6-luna`), fork 9440c29, Base worktree as in "How the test runs find the
Base worktree", a fresh instance per batch of 4 to 5 tests, one test per `run`, 420 s per test, concurrency 1. "Before" is the
P2a section above or `HANDOFF-celld-runtime.md`.

| Lane                           | Before                                                                                              | After (P3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| smoke (4)                      | 4 pass                                                                                              | **4 pass** (first sample 2 pass: `build-service` hit an authority prompt after the model chose `build.getBuildNpm`, `file-search-read-tools` ran no `grep`; both passed on rerun)                                                                                                                                                                                                                                                                                                                   |
| workers (9)                    | 5 pass, 4 timeout (cutover; base: `call-do-method` and `installed-workspace-service-consumer` fail) | **7 pass** (`list-sources`, `create-worker`, `list-workers`, `create-destroy`, `worker-env`, `worker-do-sql-persistence`, `installed-workspace-service-consumer`), 2 fail twice each: `call-do-method` (`FixtureWorkerDO missing from launchable class list`, fails on the cutover base too; not re-run on base here) and `dynamic-workspace-service` (model errors: a `package.json` that is not valid JSON, an `rpc.call` descriptor misuse; passed on the cutover base, not re-run on base here) |
| harness-resilience (5)         | 4 pass, 1 timeout                                                                                   | **5 pass** (`invalid-tool-args-visible-retry` first showed "eval interrupted by restart": celld's `SELF-FENCE: node lease not renewed within TTL` after the host stalled for about 65 minutes, then passed twice)                                                                                                                                                                                                                                                                                   |
| panels (5, no earlier numbers) | n/a                                                                                                 | 2 pass (`browser-panel`, `panel-list-sources`), `browser-import-panel-lifecycle` ran no test (0 of 0), `create-panel` fails (model errors: `panelCdp.consoleHistory` without `page`; **fails the same way on d1bfdec3f**), **`panel-tree-navigation` fails 4 of 4 on P3 and passes 2 of 2 on `d1bfdec3f` (P2a, before P3)**                                                                                                                                                                         |
| the doctor boot                |                                                                                                     | the product boots on a fresh workspace with the new classes: "no retired SQLite store, nothing to import"                                                                                                                                                                                                                                                                                                                                                                                           |

### P3 follow-up: the "regression", measured

**`panel-tree-navigation` was not a P3 regression** (`docs/dolt-redesign.md` §4.6 has the account). On `d1bfdec3f` rebuilt
with only a call-latency trace it failed 3 of 3 (twice with the same `TARGET_NOT_REACHABLE` as P3, once with a model error), and a
script with no model (`openPanel(data:...)`, `navigate`, `state()`, `tree()`, via `vibestudio eval run`) fails the same way on both
builds, before and after the navigation. The call is `PanelHandle.state()` or `.tree()` on a **browser panel**: `_agent.*` is
answered by the panel runtime of a code panel, an external page has none, so it addresses a `panel:` target that never connects.
The test passes only when the model does not make that call. The earlier evidence, re-read:

- "re-materialized three times" was the log line of `PanelExecutionReconciler.resume`, written for every `ensureExecutable`
  (each acquire and `ensureSlot`); nearly all find the entity active and activate nothing. The pre-P3 server log has the same repeats.
  It is now logged by the activation itself (`132c51b48`). No race, timeout or revision check in the coordinator or the panel runtime
  is involved; there is no latency-exposed correctness bug there.
- "disabling the commit passed 1 of 2" was a model sample, not a signal.

**Fixed (Base, `473acbb`, for the user to review):** on a browser panel the host answers the agent calls: `state()` is `{}`, `routes()`
the URL parts, `tree()` and `snapshot()` the CDP document capture `snapshot()` already takes, `setMode()` `undefined`. It was a failure
reported as a recoverable `host_unavailable` that invites retries. Test: `panelRuntime.test.ts`.

**What is slower, measured.** `VIBESTUDIO_DO_CALL_TRACE=all` (or a label substring) on the server logs each `DODispatch` call's latency.
Same eval (open a data panel, navigate, state, tree, cdp) four times on each build; mean ms per call, `d1bfdec3f` against P3:
`panelTreeDetail` 35 to 64 (58 calls per run), `entityResolve` 36 to 72, `contextEdgeListByChild` 35 to 58, `alarmClear` 41 to 67,
`alarmNextWakeAt` 41 to 68, `slotCreate` 36 to 94, `slotCommitPreparedNavigation` 35 to 127, `entityActivate` 30 to 116,
`entityRetire` 29 to 159; about 190 calls per run on both. `navigate` went from 1.7 s to 2.2 to 3.5 s, `openPanel` from 2.0 to 3.0 to 3.7 s.
**Cause: every transaction on a Dolt cell is a root record and a flush, and every call writes one.** The node under `strace -f`
(wrapper via `VIBESTUDIO_CELLD_BIN`) showed 228 calls to `WorkspaceStateDO` in a 15 s window as 233 flushes of the cell file, 208 of the
replication segments and 342 of the node index's WAL: a read costs as much as a write. The writer is the replay nonce
(`DurableDirectRpcNonceLedger.consume`, a `DELETE` and an `INSERT` into `vsl_direct_rpc_nonces`, local, per direct RPC). It is an
inference from the flush count and the code, not a bypass experiment. The commit itself is cheap (fork, release, same NVMe, 200 writes
per shape): write 6.5 ms, 1 root record, 1 flush; the same in a transaction with `{ commit }` 7.8 ms, 1 root record, 1 flush; the same
plus a local-table write 7.8 ms, 1, 1; write then a separate commit 13.5 ms, 2, 2; a write to a local table only 6.3 ms, 1, 1.
**So item (a) does not apply** (a commit in the transaction costs no flush) and **(b) buys nothing**: `doltLocal` does not avoid the root
record, and folding bookkeeping into the next commit saves the 1.3 ms of CPU. `docs/dolt-redesign.md` §4.2 records this and that "every
mutation of versioned state is one commit" is **not narrowed**. The lever is transactions per call; the options, all for the user:
the nonce written in the call's own transaction; the nonce held in memory and persisted lazily (a replay window after a crash or
eviction within the attestation lifetime: a security decision); a fork mode in which a transaction that writes only `doltLocal` tables
shares the next durable step's flush (changes what "local state survives a kill" promises).

**Gate, P3 build + the Base fix, one test per invocation, concurrency 1, 420 s, `openai-codex:gpt-6-luna`:**

| Lane                                                | Result                                                                                                                                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `panel-tree-navigation`                             | **3 of 3** pass with the fix (before it: P3 failed 5 of 5 as first measured, 4 in the P3 report and 1 here, and `d1bfdec3f` 3 of 3; an intermediate sample on P3, while the first draft of the fix was in place, went 2 of 3) |
| panels                                              | `browser-panel`, `panel-list-sources` pass; `create-panel` fails (model errors; fails the same way on `d1bfdec3f`, unchanged); `browser-import-panel-lifecycle` not installed in this workspace                               |
| smoke                                               | **4 of 4** (`file-search-read-tools` ran no `grep` once, passed twice on re-run, as in the P3 report)                                                                                                                         |
| workers                                             | first pass 7 of 9 (`dynamic-workspace-service`, `installed-workspace-service-consumer` failed on model errors); re-run: both pass (`dynamic-workspace-service` twice), so all nine have passed on this build                  |
| harness-resilience                                  | first pass 4 of 5 (`eval-huge-return-bounded-terminal`: the model's own `JSON.parse` of a truncated value), re-run passes: **5 of 5**                                                                                         |
| `call-do-method` on detached `d1bfdec3f`            | **fails 2 of 2** (it passed once of three on P3)                                                                                                                                                                              |
| `dynamic-workspace-service` on detached `d1bfdec3f` | passes 2 of 2 (P3: 2 of 3 in this pass, 0 of 2 in the P3 report): the failures are model errors, not a state difference I can show                                                                                            |

`pnpm type-check`, `pnpm lint` clean; host vitest `doDispatch`, `panelExecutionReconciler`, `panelRuntimeCoordinator`, `panelRuntimeService`
109 pass; Base `panelRuntime.test.ts` 57 pass (userland runner, `--template base`). Fork: `cargo test -p celld` 123 pass, 2 ignored (the
benchmarks), `celld-ltx` dolt tests 7 pass, `tests/e2e/run --no-slow` exit 0 (34 pass, 1 known-failing, 2 skipped), `examples/dolt`
`demo.sh` and `sqlite-regression.sh`, `dolt-facets`, `dolt-remotes` `demo.sh` and `cluster.sh` pass (`CELLD_ESBUILD` set).
`check:runtime-docs` fails on Base's generated `RUNTIME_API.md`/`WORKERS.md` (the user's uncommitted Base edit adds
`panelTree.listPresentationTargets`); it fails without these changes. The detached `d1bfdec3f` worktree is removed.

**Fork gaps found by P3:** none that block. Observations that shaped the work: the real engine enforces foreign keys
in SQLite and Dolt cells (the fake does not); `dolt_status` is readable inside a `{ commit }` transaction;
`ctx.storage.dolt.hashOf` is not (the fake refuses it too, as the doc says); a string with an embedded NUL is cut when
bound (sql.js too), so composite keys use `\u001f`. `dolt_revert` is still not exposed: undo is a hard reset, or the
patch of `dolt.diff` applied as SQL.

## What remains

- **P2b** (unchanged, waiting for D1 to D5, `docs/dolt-redesign.md` §7.7).
- **Delete the retired store** in the release after this one: the `WorkspaceDO` class, its catalog entry, its
  schemas, the import driver, the barrier, the adoption of the earlier maintenance journal, and the retired cells
  themselves (the only deletion of user data this migration implies; nothing deletes it now).
- **Lifecycle, alarm and durable-work machinery** (P4: native alarms for every DO, replace the planned-restart prepare
  protocol); their tables then leave `WorkspaceStateDO`.
- A **system test for panel close and reopen, `workers.resetStorage` and a restore round trip** does not exist in
  the catalog (275 tests; none exercises them). The coverage is the real-fork tests (`universalDoHost`, `workspaceStateCelld`);
  an acceptance test that drives the panel tree through the agent is worth adding to the Base `system-testing` skill.
- **Commit volume** (R1): the per-commit cost is measured (§4.2). The nonce and the per-call flushes are the open cost; GC time over many commits is not measured.
- Decide the per-call nonce options above.
- The import's **cost on a large workspace** is not measured (one commit per event, about one to two ms each on the
  real engine in the tests); `replay` calls are bounded by `budgetMs` so the start reports progress.

## How to run

```sh
cd /home/werg/vibestudio-worktrees/dolt-p0
export VIBESTUDIO_TEMPLATE_CHECKOUTS=/home/werg/vibestudio-templates-worktrees/root-dolt-p2
NODE_ENV=development systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 node scripts/ensure-host-build.mjs
systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 pnpm type-check
systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 pnpm lint
systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 npx vitest run packages/durable packages/shared packages/service-schemas packages/builtin
# real fork (the staged binary is picked up; or set VIBESTUDIO_CELLD_BIN)
systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 npx vitest run --config vitest.host.config.ts --maxWorkers=1 --no-file-parallelism \
  src/server/dynamicWorkerHost.test.ts src/server/universalDoHost.test.ts src/server/internalStorageWorkerd.test.ts \
  src/server/celldNative.integration.test.ts src/server/nativeSqlitePayloadCelld.test.ts src/server/celldMigration.integration.test.ts \
  src/server/nativeAlarmRetirementCelld.test.ts src/server/nativeModelTransportCelld.test.ts src/server/internalStorageDo.test.ts \
  src/server/doltDurableCelld.test.ts src/server/doltEvalKernelCelld.test.ts src/server/ownerKernelPathCelld.test.ts
# per-call latency of every DO call in a server log: VIBESTUDIO_DO_CALL_TRACE=all (or a label substring such as WorkspaceStateDO) in the
# environment of `doctor`; a model-free repro of the navigation: `node --import tsx src/dev/runCli.ts --instance ID agent attach default`, then
# `... eval run FILE --approval-level 2 --timeout 150000` (FILE: openPanel(data:...), navigate, state(), tree())
# system tests: a fresh instance per 3 to 4 tests, one test per `run`, concurrency 1
systemd-run --user --scope --unit=p2-inst -p MemoryMax=6G -p MemorySwapMax=0 --quiet pnpm system-test --instance dolt-p2 doctor
pnpm system-test --instance dolt-p2 run eval-cancel-run --concurrency 1 --test-timeout-ms 420000
pnpm system-test --instance dolt-p2 stop   # then stop the p2-inst scope
```

Instance ids must be lowercase. Machine rules kept: every heavy command inside `systemd-run -p
MemoryMax=6G` (8G for the host build), instances stopped, nothing started that is still running, the
user's Vibestudio, llama-server, postgres and `~/namlu` untouched, `~/vibestudio`, `~/vibestudio-templates/base`
and `/home/werg/celld` untouched, nothing pushed.

## Next steps (end of the third pass)

1. **Re-run what the stopped sweep did not**: `file-search-read-tools`, `call-do-method`, `installed-workspace-service-consumer`, harness-resilience (5), panels (5), subagents (4, incl. the flaky `steer-a-running-child`), and re-run once each failure above (`eval-exact-authority`, `channel-envelope-inspection-bounded`, `workspace-test-runner-extension`, `worker-env`, `dynamic-workspace-service`); start from `lg5.sh`-style one-test-per-run groups with a registry server (`scripts/serve-vibestudio-registry.mjs` on 4873, `VIBESTUDIO_DEV_NPM_REGISTRY`).
2. **S6b agent side**: see "2. S6b" above: find why a hosted kernel's self-addressed call to the agent never reaches the DO (add a log between `resolveCaller` and `relayCall`; look at `evalOrigin` loss and readiness), then merge the two `*-s6b-agent-hosting` branches. Nothing half-migrated is live: no class declares `hosts` for the kernel and the agent uses session entities.
3. **`steer-a-running-child`**: the cell is saturated (`in_flight=64 limit=64`); why 64 events are in flight is a host or fork question.
4. **Compaction in the product**: no lane reaches 64 commits, so the agent's hook is unit-level only; a model-free soak of an agent cell past 64 turns on the real stack would close it. `WorkspaceStateDO` is not on the schedule.
5. Publish Pi (`@panticonic/pi-*@1.2.0-vibestudio.4-dolt.5` or a later release), drop the `file:` overrides and the dev-registry knob (see "How Base consumes the local Pi").
