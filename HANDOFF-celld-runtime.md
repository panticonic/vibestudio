# Handoff: Vibestudio runtime cutover to the celld fork

Branch `feat/celld-runtime` (worktree `/home/werg/vibestudio-worktrees/celld-cutover`),
rebased onto `origin/main` `73e5ba525`. Not pushed.

Fork binary: `unified-fork` `4b74341` (release, `/home/werg/celld-harness-bin/celld-uf-4b74341`,
sha256 `56ace9963f096a0c4c6378d8476e890a51b055ced0110f3d6ff11fc165b9a3c7`,
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
- celld's per-isolate V8 heap limit defaults to 128 MB; the supervisor sets `CELLD_V8_HEAP_LIMIT_MB=512` (`VIBESTUDIO_RUNTIME_HEAP_LIMIT_MB` overrides). Without it EvalDO runs failed with "the isolate is over its V8 heap limit".
- Product classes answer the host's storage-destroy lifecycle call (class secret `LIFECYCLE_SECRET__<Class>`, `__vibestudio_destroy`); entity retirement of an internal object needs it.

## Migration (V6)

`migrateLegacyWorkerdStorage` runs at the first node start, after the deployment is published and before the node runs. It reads the workspace's retained legacy WorkspaceDO database for DO entities, derives workerd's file hash (HMAC of the name under the namespace key), and runs `celld cell import`: userland object = UniversalDO cell `encodeUniversalKey(ref)` with facet `do` (`<hash>.1.sqlite`); product object = class cell `objectKey`. Marker `<state>/celld/legacy-migration.json`; per-object idempotent ("exists"); a failure fails the start; legacy files are never deleted. Databases no record names are reported as `unmapped`. Limits: product objects whose keys are not in the entity table (and are not the workspace singleton) are unmapped; legacy file backups (`do-backups`) are not restored (backups are now cells).
Verified on the real fork: `celldMigration.integration.test.ts` (workerd-schema files, facet, KV conversion, node serves them).

## Tests

- Mocked-process manager tests: `runtimeManager.test.ts` (recording node supervisor).
- Real fork (skip without a binary; set `VIBESTUDIO_CELLD_BIN`): `dynamicWorkerHost`, `universalDoHost` (includes clone, cooperative clone, backup/reset/restore), `internalStorageWorkerd`, `celldNative.integration`, `nativeSqlitePayloadCelld` (>10 MB records across a node replacement), `celldMigration.integration`.
- Harness: `tests/helpers/celldNodeHarness.ts` (node proxy verifying the identity MAC; one-module probe node).
- Smoke: `scripts/celld-runtime-smoke.ts` (deploy with secrets, readiness, internal class, fork/restore through `/_object`, inspector, reload, shutdown).
- Deleted, not ported: `workerdNative.integration` (workerd binary), `nativeAlarmRetirementWorkerd`, `nativeModelTransportWorkerd` (see fork issues 2 and 3; the fixtures are in git history before `7a801d3c8`).

## Fork issues found (precise repros)

1. **A root request whose facet call is in flight when `ctx.facets.abort()` runs never gets its response**, even if the root catches and returns. Repro: root DO whose `fetch` forwards to `ctx.facets.get("do", ...)`; facet `fetch` for `/hold` does `await new Promise(() => {})`; call `/hold`, then call a root path that runs `ctx.facets.abort("do", new Error("x"))`. The `/hold` HTTP request never completes (root logged that it returned a 500). Also true if the root rejects the pending call itself first (Promise.race) and returns before the abort. workerd rejects the pending call. Vibestudio consequence: retiring an object with a request in flight leaves that HTTP request open; callers (the host relay) must drop their own request. Tests do.
2. `Response.clone()` of a streaming response throws `Cannot clone a streaming response before consumption` (`new Response(new ReadableStream(...)).clone()`); workerd tees. Request clone and string-body Response clone work.
3. Not understood: the native model WebSocket upgrade fixture (`nativeModelTransportWorkerd`/alarm test) fails under celld with `WebSocket upgrade failed: isolate stopped reading WebSocket` from `fetch()` with `Upgrade: websocket` inside a DO alarm-driven pass, while a plain DO `fetch` upgrade to the same kind of server works. Needs the fixture rerun against the fork with a focused repro. Risk: agent model calls (they normally go through the egress proxy, not direct).
4. Inspector targets for loaded workers are titled `__loader:<n> (celld dynamic worker isolate)`; the loader id (`do-code:...`) is not in the title, so tooling cannot find a worker's isolate by name.
5. A fork whose publication was interrupted leaves a target no one can retry or delete (`unfinished publication`); only import has `--replace-unfinished`. Vibestudio backs up under a fresh name; a clone to a fixed id cannot recover.
6. `celld cell import` and fork errors are plain text; the host matches `already exists` / `unfinished publication` substrings.

## System-test results (`--instance celld-cutover`, fork 4b74341)

- `doctor`: ok, 7/7 checks (275 tests discovered).
- `run eval-return-value`: passed (37 s, agent computes a value through EvalDO on celld).
- A 39-test run (smoke, workers, agentic-runtime, eval-lifecycle, edge-cases, delivery-hardening, harness-resilience, rpc-communication, agent-capabilities; concurrency 3) did not finish within 40 min and produced no result. The instance log shows userland agent DOs (`workers/agent-worker:AiChatWorker`) stuck in `__lifecycle/prepare` for 1000+ s and `__alarm` for 1000+ s, `Pi activation is sealed for lifecycle release` alarm re-arms, and `the cell event ended before it could acquire an input gate` from `DurableObjectState._blockConcurrencyWhile` (the agent runtime's storage layer calls `blockConcurrencyWhile` from background continuations after the originating event ended; workerd allows it). `pnpm system-test stop` then hangs behind that prepare. This is the main open blocker for agents on celld: it needs either residency holds / event-bound continuations in the agent runtime (template repository code, not in this repo) or a fork semantic for continuations. Not investigated further.

## What remains

- CI/release wiring for the celld artifact: `.github` workflows must build the fork per target, place it in `native/celld/artifacts/<platform>-<arch>/`, and `targets.json` needs digests for linux-arm64, darwin-arm64, win32-x64 (null today; staging those targets is refused).
- Nothing in the user's own Vibestudio instance was migrated or touched.
- Dolt redesign (V9) untouched; EvalDO host kernel lease kept (`CELLD_DEPLOY_MAX_AGE_S` 60 s cancels a held request when a reload forces a move; compaction skips live executions).
- V11 (Node surface) is only exercised as far as the test suites and system-test lanes below.
- The two native tests of fork issue 3 are not ported.
- Host vitest run (1054 files): 3 failures at the time of the full run; `tests/packagedUserlandBoundary.test.ts` was mine (fixed). `src/cli/agent/index.test.ts` (auth.getConnectionInfo schema) and `runtimeService.test.ts` "starts an unbound native execution clone fresh" fail in files this branch does not touch (not verified against a clean `origin/main`).

## How to run

```sh
# staged or local fork binary
export VIBESTUDIO_CELLD_BIN=/home/werg/celld-harness-bin/celld-uf-4b74341
cd /home/werg/vibestudio-worktrees/celld-cutover
NODE_ENV=development systemd-run --user --scope --quiet -p MemoryMax=8G -p MemorySwapMax=0 node scripts/ensure-host-build.mjs
systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 pnpm type-check
systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 npx vitest run --config vitest.host.config.ts
CELLD=$VIBESTUDIO_CELLD_BIN systemd-run --user --scope --quiet -p MemoryMax=6G -p MemorySwapMax=0 npx tsx scripts/celld-runtime-smoke.ts "$PWD/.smoke-run"; rm -rf .smoke-run
```
