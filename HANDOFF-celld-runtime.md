# Handoff: Vibestudio runtime cutover to the celld fork

Branch `feat/celld-runtime` (worktree `/home/werg/vibestudio-worktrees/celld-cutover`),
rebased onto `origin/main` `73e5ba525`. Not pushed.

Fork binary: `unified-fork` `8a4ab46` (release, `/home/werg/celld-harness-bin/celld-uf-8a4ab46`,
sha256 `a047b11af51171ea8adecd4551f9469ffd78b8876b22c350ad5b92ffbfeb1358`,
named by `native/celld/targets.json`). Stage it with
`node scripts/stage-native-celld.mjs --from <binary>` or set
`VIBESTUDIO_CELLD_BIN=<absolute path>`.

## State: the cutover is done

| Step | What |
| --- | --- |
| 1 | `_runGenerationTransition`: a planned generation on a live node is `deploy` + `POST /reload` (compaction included); the node is replaced only if it cannot adopt it (or a prepare failed, or it crashed). The `stop` request kind is gone. |
| 2 | `stopWorkerd` graceful = the node's own `/shutdown?handoff=preserve`, then SIGTERM/SIGKILL containment. Shutdown uses it too. |
| 3 | Every product class is always deployed; registering one only needs the node running. |
| 4 | Storage on the node (G1): `cloneDO` = `NS.fork`, backup = fork to a hidden cell (`__vibestudio_backup:<op>`), restore = `NS.restore(stop)`, reset = backup + cell delete, retirement = `__vibestudio_destroy` (or journaled, collected at the next node start). Router `/_object` carries fork/restore. Clone receipts: `durableObjectCloneReceipts.ts`. `durableObjectStorageClone.ts`, the SQLite integrity worker, file copies, capnp config are deleted. Maintenance is userland-only (product classes refuse it). |
| 5 | shutdown cleanup trimmed. |
| 6 | deps: `workerdPrograms`, `getProxyPort` removed; `appRoot` passed. |
| 7 | `egressProxy.ts` verifies celld's HMAC identity (`services/celldEgressIdentity.ts`); host programs (router, worker host, UniversalDO) are admitted to the gateway origin only; `startForCaller` removed. |
| 8 | EvalDO uses `new Function`; catalog field `runtime.codegen` (regenerated). Host kernel lease kept. |
| 9 | Tests ported (see below). |
| 10 | `native/celld/targets.json`, `scripts/native-celld-artifacts.mjs`, `stage-native-celld.mjs`; the app verifies the staged digest; electron hooks stage and re-verify; `workerd` dependency, Windows manifest removed. |
| 11 | `WorkerdManager` -> `RuntimeManager` (`runtimeManager.ts`), `WORKERD_*` host variables -> `RUNTIME_*`. `WORKERD_SESSION_ID` / `WORKERD_BOOT_GENERATION` keep their names: the template repositories read them. |
| G2 | `celldMigration.ts` (V6): see below. |
| G3 | Class secrets: each product class's `RPC_AUTH_TOKEN` (as `RPC_AUTH_TOKEN__<Class>`) and UniversalDO's loader/lifecycle secret (`DO_LOADER_SECRET__UniversalDO`; gateway `/_docode`, `/_doadmission` check `getDoLoaderSecret()`). The router and worker host are not Durable Object classes, so the gateway token, dispatch secret and the worker-host loader secret stay variables. The key is `<state>/celld/secrets.key` (0600). |

`ExecutablePreparation` (an entrypoint) cannot read UniversalDO's class secret, so it forwards to a UniversalDO cell named `__prepare:<source>:<class>` (marked `x-internal-*`, which the router strips from external calls).

Also found by running the real product (`pnpm system-test`):
- SES `lockdown()` replaces `Function` with an evaluator that rejects any source mentioning an import expression (the eval engine's own source does), and `createPrivateGuestGlobal` refuses a realm that can still compile. Fix: `workerdRealm.ts` sets the realm's compiler aside (`captureRealmCompiler`) before lockdown with `evalTaming: "no-eval"`; EvalDO compiles through `getRealmCompiler()`. (The audit's V7 "verified" probe did not include an import-expression source.)
- celld's per-isolate V8 heap limit defaults to 128 MB; the supervisor sets `CELLD_V8_HEAP_LIMIT_MB=1024` (512 until 8a4ab46 testing: see below) (`VIBESTUDIO_RUNTIME_HEAP_LIMIT_MB` overrides). Without it EvalDO runs failed with "the isolate is over its V8 heap limit".
- Product classes answer the host's storage-destroy lifecycle call (class secret `LIFECYCLE_SECRET__<Class>`, `__vibestudio_destroy`); entity retirement of an internal object needs it.

## Migration (V6)

`migrateLegacyWorkerdStorage` runs at the first node start, after the deployment is published and before the node runs. It reads the workspace's retained legacy WorkspaceDO database for DO entities, derives workerd's file hash (HMAC of the name under the namespace key), and runs `celld cell import`: userland object = UniversalDO cell `encodeUniversalKey(ref)` with facet `do` (`<hash>.1.sqlite`); product object = class cell `objectKey`. Marker `<state>/celld/legacy-migration.json`; per-object idempotent ("exists"); a failure fails the start; legacy files are never deleted. Databases no record names are reported as `unmapped`. Limits: product objects whose keys are not in the entity table (and are not the workspace singleton) are unmapped; legacy file backups (`do-backups`) are not restored (backups are now cells).
Verified on the real fork: `celldMigration.integration.test.ts` (workerd-schema files, facet, KV conversion, node serves them).

## Tests

- Mocked-process manager tests: `runtimeManager.test.ts` (recording node supervisor).
- Real fork (skip without a binary; set `VIBESTUDIO_CELLD_BIN`): `dynamicWorkerHost`, `universalDoHost` (includes clone, cooperative clone, backup/reset/restore, retirement with a request in flight), `internalStorageWorkerd`, `celldNative.integration`, `nativeSqlitePayloadCelld` (>10 MB records across a node replacement), `celldMigration.integration`, `nativeAlarmRetirementCelld` and `nativeModelTransportCelld` (ported from the deleted `...Workerd` tests; they pass on 8a4ab46).
- Harness: `tests/helpers/celldNodeHarness.ts` (node proxy verifying the identity MAC; one-module probe node).
- Smoke: `scripts/celld-runtime-smoke.ts` (deploy with secrets, readiness, internal class, fork/restore through `/_object` with the error-code header, `replaceUnfinished`, `deleteUnfinished`, inspector, reload, shutdown).
- Deleted, not ported: `workerdNative.integration` (needs the workerd binary).

## Fork issues

Issues 1-6 of the earlier handoff are fixed in `8a4ab46` and verified here:
1. Facet abort with a request in flight: the retirement tests in `universalDoHost.test.ts` no longer drop the caller's request; the held request now fails by itself.
2. Streaming `Response.clone()`: the ported alarm fixture clones a streamed alarm response (`response.clone().text()`) and passes.
3. WebSocket upgrade from an alarm: both ported native tests pass (upgrade, send, cancel, close joined; `fetch()` with `Upgrade: websocket` inside an alarm pass).
4. Inspector title with the loader id: not exercised by a Vibestudio test.
5. Unfinished fork target: `cloneDO` and the backup fork pass `replaceUnfinished: true` through the router (`/_object`), so a fixed-id clone or a backup recovers from an interrupted fork; the renaming workaround is gone. Not exercised against a really interrupted fork (a test cannot interrupt one).
6. Error codes: the router returns the node's `error.code` in `X-Vibestudio-Object-Error`; `RuntimeManager` reads `ERR_OBJECT_EXISTS`; `CelldNode.importCell` runs `celld cell import --json` and reads `ERR_OBJECT_UNFINISHED` / `ERR_OBJECT_EXISTS`. No message matching is left. `deleteUnfinished` is routed too (`op: "deleteUnfinished"`).

Open (found on 8a4ab46, product level). The probe repros below did NOT reproduce, so these are observations for the fork author, not isolated repros.

**F7. An agent session fails on its first pass: `the cell event ended before it could acquire an input gate`.** Thrown by `DurableObjectState._blockConcurrencyWhile` (harness.js, the `this._blockDepth > 0 && !orphan` branch that rejects when `!__io_context_live()`), reached from `DurableObjectStorage.transaction` (pi-durable `NativeDatabase.transaction`, the agent harness's commit). The harness fails (`SessionFailed: Session failed after a storage error`) and every later call on that object fails the same way; the alarm driver re-arms the failed alarm forever, so the test errors in ~10 s or never ends. Always a freshly created `AiChatWorker` object (also seen on `PubSubChannel`), 1-10 s after `Entity ready`, in its first alarm pass. Rate on 8a4ab46: 7 of ~30 agent sessions with a 512 MB heap (smoke/build-service, eval-pregranted-only, eval-preauthorization, eval-db-persistence, eval-scope-reset, invalid-import, concurrent-scope), 1 of 5 with 2048 MB (eval-pregranted-only), so it does not depend on the heap. Product repro: `VIBESTUDIO_CELLD_BIN=.../celld-uf-8a4ab46 pnpm system-test --instance X run eval-pregranted-only` (about one in three). Not reproduced with probe objects: a continuation of an ended event calling `transaction()` while another block is open (resumed by a promise, by a timer); three concurrent orphan transactions; the pi-durable `enqueue` promise chain with a request and an alarm overlapping; several same-class objects with alarm passes started while another object's alarm runs 6 s; a constructor `blockConcurrencyWhile` plus an alarm as the first event; two objects sharing a module-level lock released by the other's event; the real native model harness with a held provider socket and a second object started meanwhile (the `nativeModelTransportCelld` fixture). Suspected shape (read from the source, not shown): `orphan` is decided at entry from the running event, then `__with_input_gate_context` rebinds the continuation to its retained [origin, driver] pair; when the driver chosen there is an event that has just finished (the turn that runs the continuation), the second `__io_context_live()` check fails while `_blockDepth > 0` (a block of the same object is open). A hung node's `/state` showed `requests` > 0 and `turns` 0 in both isolates (everything waiting).

**F8. An agent `__alarm` never completes: the model WebSocket upgrades and then no frame is sent.** Hang for 300 s on 8a4ab46 with either heap size, pass on the workerd baseline: `console-streaming` (3 of 3), `state-args-immediate-snapshot` (2 of 2), `runtime-vcs-client-helper` (2 of 2). `agent-debug-state-method` errored twice (an unexpected `channel.admin` authority prompt: model choice or a caller-identity difference, undecided) and hung once (baseline: 2 of 2 pass). Evidence from a hung `console-streaming`: the host holds one TLS connection to the model provider with 2245 bytes sent and 5031 received, idle for 230 s (the TLS handshake and the upgrade request only; the agent's `response.create` frame, many KB, never left); the node's connection to the egress proxy for that socket shows 1606 bytes sent (the upgrade request) and 135 received (the 101); the host's calls to the agent (`onEvalProgress`, `publish`, `waitForNativeRun`) returned headers and never ended their bodies; node `/state` showed `requests` 5 and `turns` 0. Not reproduced: 120 probe objects each upgrading with `fetch()` + `Upgrade` from an alarm through an egress proxy (the proxy completes the upgrade and echoes; also with a 60 KB frame and a staggered first send).

**Fork follow-up (2026-11-14, celld branch `fix/agent-blockers`, commits `28e5986` and `fcc7268` on top of `8a4ab46`, not pushed; binary `/home/werg/celld-harness-bin/celld-uf-fcc7268-wip`, used through `VIBESTUDIO_CELLD_BIN`, `native/celld` untouched).**
- **F7 fixed (`28e5986`, fork finding E11).** The continuation that starts the block belongs to an event that has *answered but still runs* (it left I/O pending, which a completed cell event keeps). Its cross-event claim lifecycle had already closed at the event's retirement check, so the block was neither an orphan (the event still looked live) nor able to claim its origin, and `op_gate_acquire` refused it (the error comes from `__gate_acquire`, harness column 42, not the `_blockDepth` branch). Pattern: pi-durable's `enqueue` chain, a transaction queued by the alarm pass and released by another event's turn after the pass answered. A refused claim now means an ended origin: the block is the object's own. Deterministic repro: celld e2e `continuations` ("lingering" steps: the arming request leaves a timer pending).
- **F8 fixed (`fcc7268`, fork finding E10).** Not WebSocket-specific. A continuation of event A run by another event's turn while A's driver was leaving (A answered, nothing of its own pending) started an op; it was handed to A (mailbox still open) and A's `abandon` dropped it with its resolver, so the promise never settled. Seen in traces as "an ended event drops the resolvers of its pending ops ... handed=1" on a PubSubChannel RPC, after which the agent `__alarm` waited forever (the model frame, a commit or an RPC reply never resumed; the earlier evidence of a socket upgraded with no frame is one instance). The driver now closes the mailbox inside an isolate turn and polls what was handed in the gap. Deterministic repro: celld e2e `continuations` ("an op handed to a request on its way out still settles").
- **`system-test stop` (C3): Vibestudio's protocol, not celld.** Traced: the EvalDO `cancel` is delivered at once (not queued behind `holdKernelLease`); it then awaits the in-flight run's settlement (`cancelRun` with an owned cleanup awaits `terminal` without bound), and that run was stuck on the F8 hang. With the fix, `stop` took 3-15 s in 6 of 6 tries.
- **agent-debug-state-method:** no `channel.admin` prompt seen in 7 runs on the fix (4 pass, 2 errored with tool failures not captured, 1 hung on a `ModelGatewayDO.__alarm` first pass, 270 s, untraced; not reproduced in 3 traced runs). `inspectAgent` is `adminAccess` and `getDebugState` needs channel administration, so a prompt depends on the caller the host resolves for the eval; not settled.
- System tests on `fcc7268`, one test per invocation, concurrency 1, 420 s timeout (before = 8a4ab46 per the table above, and 5 console-streaming runs on the F7-only build `28e5986`: 4 hung):

| test | after (fcc7268) | notes |
| --- | --- | --- |
| eval-pregranted-only | 4 of 6 pass | the 2 failures are model code (`permissions is not exported by @workspace/runtime`, `eval:guest_execution_failed`), no input-gate error |
| console-streaming | 3 of 3 pass | |
| state-args-immediate-snapshot | 2 of 3 pass | 1 fail with 2 tool failures in 256 s, no hang (base failed once too) |
| runtime-vcs-client-helper | 3 of 3 pass | |
| agent-debug-state-method | 4 of 7 pass | see above |

Remaining: the `ModelGatewayDO` alarm hang (once in about 25 agent runs, cause unknown; trace with `RUST_LOG=celld::cell_event=debug,celld::input_gate=debug,celld::egress_gate=debug,celld::ops=debug` and `VIBESTUDIO_LOG_LEVEL=verbose`, celld debug lines go to stdout, which the runtime logs only at verbose).

Several lane tests simply take 110-230 s on both runtimes (`call-do-method`, `worker-do-sql-persistence`, `dynamic-workspace-service`, `installed-workspace-service-consumer`, `eval-db-persistence`): a 150 s lane timeout reports a hang that a 300 s one does not.

## System-test results (fork 8a4ab46)

`doctor`: ok, 7/7 checks (275 tests discovered). Lanes were run one test per `pnpm system-test run` (concurrency 1, 150-300 s each, instance reset after a timeout) because concurrency 2 made the four-test smoke lane hang twice (600-900 s, no result: a session failed with F7 and its test never ended). The models are real (`openai-codex:gpt-6-luna`), so a failure can be model behaviour; the failing tests were rerun on a clean `origin/main` (`73e5ba525`, workerd, temporary worktree, removed). `base` = that run, `exp` = celld rerun with `VIBESTUDIO_RUNTIME_HEAP_LIMIT_MB=2048`.

| lane (tests) | celld 8a4ab46, 512 MB heap | notes |
| --- | --- | --- |
| smoke (4) | 3 pass, 1 error | build-service: F7 (passes on rerun, exp and base). file-search-read-tools once failed on model behaviour (no `grep` call), passed in another run |
| workers (9) | 5 pass, 4 timeout | the four are slow tests (126-228 s) that finish on exp (`dynamic-workspace-service`, `installed-workspace-service-consumer`, `call-do-method` 110 s, `worker-do-sql-persistence` 136 s); base: call-do-method and installed-workspace-service-consumer fail, the rest pass |
| agentic-runtime (9) | 4 pass, 2 fail, 1 error, 2 timeout | gad-status-summary and workspace-test-runner-extension (`fs.ensureMaterialized`: context folder missing) fail on base too; agent-debug-state-method and the two timeouts (state-args-immediate-snapshot, runtime-vcs-client-helper): F8 |
| eval-lifecycle (11) | 6 pass, 1 fail, 4 error | the errors are F7 (eval-pregranted-only, eval-preauthorization, eval-db-persistence, eval-scope-reset; exp: 3 of 4 pass, pregranted F7 again); eval-exact-authority failed once (permissions read allowlist; model behaviour, base pass) |
| edge-cases (3) | 0 pass, 2 fail, 1 error | eval-extra-argument and fs-not-found fail on base too (the model does not provoke the expected failure); invalid-import F7 (base and exp pass) |
| delivery-hardening (4) | 3 pass, 1 timeout | delivery-first-connect-recovery hangs on base and exp too |
| harness-resilience (5) | 4 pass, 1 timeout | eval-huge-return-bounded-terminal is slow, passes on exp and base |
| rpc-communication (2) | 2 pass | |
| agent-capabilities (6) | 1 pass, 2 fail, 2 timeout, 1 error | large-output (the agent summarised instead of counting; base passed once) and dynamic-import (fails on base too): model/validator mismatches; error-recovery slow (passes on exp and base); console-streaming F8; concurrent-scope F7 (passes on exp and base) |

Totals on celld with 512 MB: 28 pass, 7 fail, 8 error (7 F7, 1 authority prompt), 10 timeout, of 53 tests. Failures the baseline shares: gad-status-summary, workspace-test-runner-extension, eval-extra-argument, fs-not-found, dynamic-import, delivery-first-connect-recovery, and once each call-do-method, installed-workspace-service-consumer, state-args-immediate-snapshot, eval-preauthorization. The celld-only problems are F7, F8, and possibly agent-debug-state-method. `pnpm system-test stop` still hangs (an EvalDO `cancel` queued behind a `holdKernelLease`); instances were killed by PID.

Heap: with 512 MB a node that had run two tests failed `eval.get` with "the isolate is over its V8 heap limit" (the codegen isolate, shared by every EvalDO cell, holds ~22 MB per cell: 262 MB at 12 cells, 356 MB at 9 cells with an active run). The default is now 1024 MB.

## What remains

- CI/release wiring for the celld artifact: `.github` workflows must build the fork per target, place it in `native/celld/artifacts/<platform>-<arch>/`, and `targets.json` needs digests for linux-arm64, darwin-arm64, win32-x64 (null today; staging those targets is refused).
- Nothing in the user's own Vibestudio instance was migrated or touched.
- Dolt redesign (V9) untouched; EvalDO host kernel lease kept (`CELLD_DEPLOY_MAX_AGE_S` 60 s cancels a held request when a reload forces a move; compaction skips live executions).
- V11 (Node surface) is only exercised as far as the test suites and system-test lanes below.
- F7 and F8 above are the open blockers for agents on celld (fork side; handed over with their evidence). Until F7 is fixed about a third of agent sessions fail at their first pass.
- Host vitest: `src/cli/agent/index.test.ts` (auth.getConnectionInfo returns no `deviceId`) and `runtimeService.test.ts` "starts an unbound native execution clone fresh" fail identically on a clean `origin/main` (`73e5ba525`, detached temporary worktree, removed): pre-existing, not from this branch.

## How to run

```sh
# staged or local fork binary
export VIBESTUDIO_CELLD_BIN=/home/werg/celld-harness-bin/celld-uf-8a4ab46
cd /home/werg/vibestudio-worktrees/celld-cutover
NODE_ENV=development systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 node scripts/ensure-host-build.mjs
systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 pnpm type-check
systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 npx vitest run --config vitest.host.config.ts
CELLD=$VIBESTUDIO_CELLD_BIN systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 npx tsx scripts/celld-runtime-smoke.ts "$PWD/.smoke-run"; rm -rf .smoke-run
```
