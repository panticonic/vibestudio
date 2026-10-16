# Terminal apps: handover (2026-10-13)

This is the state of the terminal refurbishment at handover, and how to finish
and extend it. Read it together with:

- [terminal-refurbish-plan.md](terminal-refurbish-plan.md): the original plan.
  Its "Revision (2026-10-12)" section and the status notes at the end replace
  the earlier design sections.
- [terminal-app-units-design.md](terminal-app-units-design.md): how terminal
  apps reuse the panel unit model (option B, host-held leases).
- [terminal-apps.md](terminal-apps.md): the user and developer guide.

## 1. Goal and the decisions the user made

The user asked for four things:

1. A single command that starts a server, or attaches to one, and opens the
   terminal app browser.
2. A reworked, full-featured terminal browser. User experience is a primary
   deliverable throughout, not polish.
3. A full terminal chat app in the Base template, compatible with the agentic
   chat protocol.
4. Legacy terminal infrastructure eradicated, not kept alongside.

These decisions are settled. Don't reopen them without new evidence.

- **Unit model.** Terminal apps are workspace-bound units modelled on panels:
  `terminal-apps/<name>`, the same unit kind `panel`. There is no new manifest
  block; the location alone makes a unit terminal-hosted.
- **AppHost.** Only the terminal browser is an AppHost app
  (`system/clients/terminal-browser`, runtime `terminal`).
- **Where apps run.** A terminal app is an ordinary Node program in a PTY owned
  by the Base `shell` extension, inside the workspace native runtime sandbox.
  The browser proxies those sessions to the real terminal.
- **Rejected: workerd.** Running terminal apps in workerd needed a shim and a
  host protocol, and running another workerd on the client was too much.
- **Leases (option B).** The PTY host holds the lease for a slotless panel
  entity: `PanelRuntimeCoordinator.hostHeldEntityLeases`. These leases emit no
  slot events, never appear in snapshots, have no supervision and no timers,
  and end only when the entity is retired.
- **With no paired server**, `vibestudio terminal` starts a local server and
  owns it.
- **The chat panel** was migrated to the extracted headless core
  (`@workspace/agentic-core` chat-store), shared by the desktop panel and the
  terminal chat.
- **App builds that fail or are rejected reject the push** to protected main,
  like other units. A working build is never demoted: a failed update is
  recorded as "Update not adopted" and the previous version keeps running.
  This also applies to extensions.
- **One session registry.** There is one per-person session list, held by the
  `terminalApps` launch service and shared by the desktop terminal panel and
  the browser. Plain shells are sessions too, with no entity and no grant.
- **Closing a session** works like closing a desktop chat panel. Only the
  program and its panel entity end. The conversation, its agents, its context
  and folder, and any forks persist and can be resumed. Deleting them is a
  separate, explicit action.
- **Delegation.** The user asked for subagents to be Sonnet.

## 2. Where the work is

Nothing is merged into main or pushed. The integration branch is
`terminal/apps-lifecycle`, and the same branch name exists in every repo:

| Repo           | Worktree                                          | Tip                                  | Ahead of main |
| -------------- | ------------------------------------------------- | ------------------------------------ | ------------- |
| host           | `/home/werg/vibestudio-worktrees/apps/vibestudio` | local-main integration (this commit) | 76            |
| base           | `…/apps/templates/base`                           | `942c70f`                            | 52            |
| system         | `…/apps/templates/system`                         | `94d36c5`                            | 38            |
| system-testing | `…/apps/templates/system-testing`                 | `7df786e`                            | 18            |
| personal       | `…/apps/templates/personal`                       | `40693ce`                            | 4             |

On 2026-10-14, merged local host main `3c68a098a`, Base main `a64dca1`,
System main `ca3ab80`, and Personal main `87cd767` into these branches.
System-testing main `8dd93f3` was already included. This is integration **from**
main, not publication or integration **into** main. Earlier verification receipts
below describe the pre-merge implementation, unless explicitly labelled otherwise.

Post-merge verification: the host build, focused RPC/pairing/terminal-host and
build-preparation tests pass. Base replay/recovery, shared chat host and terminal
runtime tests pass, as does the Base semantic-projection composition typecheck.
Both chat connection contracts forward the real RPC recovery-generation event;
recovery does not require a visible disconnect/reconnect status transition.

The catalog worktrees have no terminal-specific changes. Examples (`c351a87`),
Google Workspace (`ca8c0b4`), and News (`4f8885e`) were fast-forwarded to local
main in the same integration; Spectrolite (`32c4475`) was already current.

`terminal/native` (`…/worktrees/native/`) and `terminal/perf`
(`…/worktrees/perf/`) are fully merged into `terminal/apps-lifecycle`. They can
be removed with `git worktree remove` and their branches deleted.

**Leave this one alone:** `/home/werg/vibestudio-templates/system-stream-integrity-worktree`
belongs to someone else.

### Working rules that bit us

- **Set the template variable.** Always run
  `export VIBESTUDIO_TEMPLATE_CHECKOUTS=/home/werg/vibestudio-worktrees/apps/templates`
  before pnpm, build or test commands. Git config is shared between worktrees,
  so without it the main checkouts are used.
- **Never run tools inside a template checkout.** Run template tests and type
  checks from the host worktree:
  - `pnpm test:userland -- --template base --filter <path>`
  - `pnpm type-check:userland -- --template <t>`

  Bound concurrent type checks by available memory. Base/System passed together,
  but each compiler reached roughly 5.8 GB RSS (see §5); four-way failures have
  not been established as a cache collision.

- **Instances.** Give every instance a unique name. Stop and join it in a
  finally-equivalent path, and check that its ephemeral root and its
  dev-instance registry record are gone.
- **Verify subagent claims yourself.** Two agents in this effort reported
  "tests pass" when a specific file was failing.
- **Commits** end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Don't use
  `--no-verify`. The full hook now includes the authority audit and takes
  roughly 3–5 minutes.

## 3. Architecture map

### CLI and the one command

- **Entry points.** `pnpm dev:terminal` is `src/dev/runInstance.ts terminal
  --ephemeral`; `pnpm start:terminal` is `src/dev/runProduct.ts terminal`,
  which runs the product command `vibestudio terminal`
  (`hosts/terminal/terminalCommand.ts`) with product semantics.
- **Starting the server.** `hosts/terminal/localServer.ts` attaches to a
  server or starts an owned one. `ttyRestore.ts` restores the terminal.
  `terminalHost.ts` hosts the downloaded browser module.
- **Startup progress.** `hosts/terminal/launchProgress.ts` prints numbered,
  timed steps.
- **Template scope.** Template preparation has a scope, `sources` or
  `release` (`runInstance.ts`). Only the terminal path uses `sources`, which
  skips the exhaustive runtime prebuild. Server, desktop and the packagers use
  `release`. Main's `sourcesReady` receipt hands prepared sources to the server
  before the owned release producer finishes; packaging still requires its
  completion. Producer failures propagate to the foreground owner.
- **Browser contract.** `packages/shell-core/src/terminal/terminalClientHost.ts`
  is the contract between the CLI and the browser (host ABI `terminal-host-1`, formerly `terminalBrowserHost.ts` v2/v3). It carries
  `system` and `workspaceRpc`; `readLocalFile` has been removed. Personal is
  the default workspace.

### Terminal app units and their build

- **Build.** `src/server/buildV2/builder.ts`: `bundleNodeProgram` (~4832) is
  shared by `buildExtension` and `buildTerminalProgram` (~5077). Native
  dependencies are projected next to the bundle.
- **Units.** The tree scanner marks `terminal-apps/*` launchable. Placing a
  terminal app in a panel slot is refused. Install review groups them as
  "Terminal apps".

### Launch service and leases

- **Launch service.** `src/server/services/terminalAppsService.ts` has
  `launch`, `restart`, `close`, the session list, and browser settings. The
  sessions-changed event is `terminal-apps:sessions-changed`.
- **Launch approval.** Launching asks `terminal-apps.run`, prepared as "Run
  <App> <version> in <workspace>?".
- **Launch steps.**
  1. Create the session context, with a caller that carries the launching
     call's test policy.
  2. Create the slotless panel entity `nav-term-<uuid>`.
  3. Hold its host lease and mint the connection grant.
  4. Open the PTY through the shell extension as the person.
  5. Write a one-shot 0600 launch file, which the program unlinks once it has
     read it.
  6. Watch `awaitExit` and retire the entity when the program exits.
- **Leases.** `src/server/panelRuntimeCoordinator.ts`: `hostHeldEntityLeases`
  and `holdEntityForHost`.
- **Per-session state.** Saved state is `runtime.patchEntityStateArgs`. It
  shares `mergeValidateStateArgs` with `slot.patchCurrentStateArgs`.
- **Shutdown.** The shutdown stage `terminal-apps-release` aborts the exit
  watches before the extension host drains.

### Shell extension and attach protocol (Base)

- **Shell extension.** `base/extensions/shell`. Sessions are owned by
  `user:<id>`, and `launchedBy` records who opened them.
- **Attach protocol.** `base/packages/pty-stream` frames
  hello/data/reset/gap/exit with an epoch and a byte cursor. Flow control is
  per attachment and counted in bytes, and attaching with a size triggers a
  SIGWINCH redraw.
- **Shell integration.** `TERM_PROGRAM=vscode`/`VSCODE_*` is set only for
  interactive login shells, not for app launches.
- **Extension process authentication.** Extension processes are authenticated
  by how they were launched (`attachNativeProcess`). There is no token in the
  environment.

### Browser (System)

- **Location.** `system/clients/terminal-browser`. Tabs are shell sessions.
- **Escape sequences passed through:**
  - OSC 0/2 titles;
  - BEL/OSC 9/OSC 777 attention badges;
  - OSC 8 links, opened after confirmation;
  - OSC 52 copy;
  - bracketed paste;
  - focus reports (`?1004`).
- **Approvals overlay.** Keys follow `allowedDecisions`. `task.rules`
  approvals appear as a checklist resolved through `resolveTaskRules`.
  Approvals raised by an app's agents badge and open the right tab.

### Chat

- **Units.** The app is `base/terminal-apps/chat`, and its UI is
  `base/packages/terminal-chat`.
- **Shared core** (`base/packages/agentic-core`):
  - the chat-store: `ChatSession`, `ChatHostController`, `ForkLineageStore`;
  - `chat-presentation/actor.ts`, so a raw principal id is never shown.
- **Forks.** A fork carries history up to the fork point as context only.
  Inherited messages never appear as pending.
  `ChatHostController.conversationState(channelId)` supplies the target
  conversation's own agent roster on fork switch, in both the desktop panel
  and the terminal chat.
  The parent transcript's durable `channel.forked` marker is distinct from the
  terminal-local confirmation that navigation completed. Neither inserts a
  model message or rewrites the inherited native knowledge prefix. The local
  notice is in-memory, not timer-expiring, and is not sent to agents.

### Apps lifecycle (AppHost and unit-host)

- **Build contract.** `src/server/buildV2/appBuildContract.ts`
  (`validateAppBuildContract`) is enforced inside the build, so the
  protected-main gate rejects bad app artifacts. `buildApp` is a table of
  three target adapters.
- **Admission and review.** Admission is exact and uniform for every app
  target (`packages/unit-host/src/exactUnitAdmission.ts`). An unreviewed app
  opens its review (`unitHost.requestReview`, `whenReviewed`) instead of
  failing. Electron and mobile continue on `shell-approval:resolved`.
- **History.** Version history and rollback live in `@vibestudio/unit-host`,
  so extensions have rollback too.
- **Events.** `supervision:changed` replaced `apps:available`, `apps:status`,
  `apps:lifecycle` and `extensions:status`. Adoption policy is a per-target
  table.
- **Serving.** `src/server/buildArtifactTransport.ts` is the serving core
  shared by panels and apps. `PanelHttpServer.serveAppArtifact` replaced the
  `/_a/` handler in AppHost. There is one protocol for both: `Accept-Encoding`
  negotiation plus `Range`/`If-Range` over the negotiated representation.

### Tests

- **System test.** `skills/system-testing/tests/terminal-chat.ts` in the
  System-testing template, with `_vt-screen.ts`, a small VT screen model
  (`@xterm/headless` cannot load in the eval sandbox).
- **Approvals.** A test's approvals are decided by the runner's test policy
  (`testPolicy`). Tests never answer the person's queue.

## 4. Verification evidence at handover

| Check                                             | Result                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full commit hook                                  | Passed for this infrastructure/polish handoff, including type-check, lint, format, dependency census, template hygiene and the unit authority audit                                                                                                                                            |
| `type-check:userland`                             | Base, System, System-testing and Personal passed, each run on its own; Base and System-testing were rerun after the latest changes                                                                                                                                                             |
| System test `eval-cancel-run`                     | Passed on final readiness/ownership sources in run `st_4c1422d4fdc04f2a81939af8eafbc0af`, 1.515 s, zero tool failures                                                                                                                                                                          |
| System test `terminal-chat-approval-fork-resume`  | Passed on final sources in run `st_79a0805c43fa446597cdb60c3a3c7c24`, 55.440 s: fork-agent reply, switch-back, kill/relaunch, older-question/result restoration and original tool-title preservation; zero tool failures, concurrency 1. The managed instance was stopped and retired. See §5. |
| Host focused suites                               | 45 passed after main integration; release preparation tests 20 passed                                                                                                                                                                                                                          |
| Base terminal/core focused tests                  | 34 passed after removing speculative input/join changes; projected composition typecheck passed                                                                                                                                                                                                |
| System-testing terminal/frame/history tests       | 38 passed; projected composition typecheck passed                                                                                                                                                                                                                                              |
| Infrastructure/polish focused host tests          | Approval/tier/matrix 24, RPC client 85, native build-report/authority 49, installed-smoke 10 passed                                                                                                                                                                                            |
| Replay and invocation projection regressions      | Replay 88 and canonical protocol 73 passed; final Base composition typecheck passed                                                                                                                                                                                                            |
| Ordered replay readiness and connection ownership | 101 focused replay tests, 17 independently rerun connection tests and 3 signal-store tests passed; Base main/integration composition checks passed                                                                                                                                             |
| Terminal browser tests                            | 108 passed                                                                                                                                                                                                                                                                                     |
| Live `pnpm dev:terminal` checks                   | Launcher, Chat streaming, detach/resume, kill/relaunch with transcript, shell cwd, quit with a live PTY (~10 s, clean). Fork plus fork-agent reply checked only before the upstream merge                                                                                                      |
| Cold start to launcher                            | Before: about 26 min to template-preparation done. After: ~70 s on a quiet host; ~27.5 s with a warm derived cache                                                                                                                                                                             |
| `extensions.invoke` p50                           | ~225 ms → 9.1 ms. Shell echo p50 ≈ 58 ms, measured before the last extension fix                                                                                                                                                                                                               |
| Full host test suite on the final branch          | **Not run**                                                                                                                                                                                                                                                                                    |
| Other system tests on the final branch            | **Not run**                                                                                                                                                                                                                                                                                    |

## 5. Open work, in priority order

### Finish before merging to main

1. **Run the full host suite and a small system-test sample on the final
   branch.** The harness changes could affect other tests:
   - the session context created by the launch service;
   - withdrawal of pending approvals at DO quiesce (`DODispatch.dispatchLifecycleImpl`);
   - the merged abort signal in `EvalDO.createExecutionContext`
     (`AbortSignal.any`).

   The final exact agent-driven fork/resume and eval-cancellation samples now
   pass (see §4). The full host suite remains unrun; do not substitute the
   focused sample for that broader pre-merge gate.

2. **Fork scenario harness corrected.** The earlier cloned-agent delivery
   diagnosis was wrong. `/Forked/` matched the parent's transcript marker before
   navigation completed, so the harness sent its prompt to the wrong conversation.
   It now waits for the exact child-navigation confirmation and an online screen;
   `/forks` waits for the composer, not a notice mentioning the command.

   Diagnostic run `st_18a824f29d224feb9038cd882b9938ad` proved that the child
   replied and switching back worked. Its parent-history assertion then waited
   for a question outside the initial 50-envelope replay. System-testing
   `4547499` uses PageUp when that question is on the previous history page,
   both after switch-back and after relaunch, retaining the original restoration
   assertions. No delay or retry was added. Base `163e26b` removes the speculative
   `cb68db2` input/join fixes and their artificial regression tests. The complete
   corrected scenario passed in `st_1093b70974ba4c53ae2d1d8045c18ab2`.

   Follow-up diagnostic `st_cf3aa40234b14c2a85a192a7d793de50` again proved the
   child reply and parent switch, but exposed a further viewport assumption:
   prepending older history preserves the scroll anchor, so one PageUp need not
   reveal the question. That owned diagnostic was cancelled, inspected and
   stopped. Base `34c2eeb` exposes a truthful settled start-of-conversation
   boundary; System-testing `ef5016e` follows ordinary message selection through
   finite history, retaining question and result views separately. Its VT model
   observes DEC 2026 committed frames rather than arbitrary transport chunks.
   No page-count cap, delay or retry was added.

   The stricter final run `st_2065c7f48ecc4951b54d37318e18b94a` completed fork
   reply, parent switch and kill/relaunch in 47.199 s, with no cleanup errors,
   but found a genuine older-history restoration defect. The resumed tail
   starts at sequence 7 while the original question/tool start remain durable
   at sequences 4/5. The view falsely reports the beginning without fetching
   those events. Replay readiness incorrectly named the global history start,
   and synthetic receipt snapshots manufactured sequence zero. Readiness now
   derives the actual retained durable boundary; bootstrap receipts retain
   their identity without claiming a durable sequence. Eighty-eight focused
   replay regressions pass. This failed run is not accepted as a restoration
   pass; its owned instance was stopped and retired. Corrected sources passed
   fresh run `st_27c3756523324092a716c2425cafdbce`, 50.957 s, zero tool failures;
   the captured resumed view contains the original question and eval result,
   without the child nonce. The instance was stopped and retired.

   Artifact review found another metadata inconsistency: a completed
   invocation ingested before its older start event keeps the generic title
   "Invocation". The canonical reducer now enriches start metadata without
   reopening an already-progressed lifecycle. Seventy-three protocol tests
   pass, including reverse-order running/completed/failed/cancelled/abandoned
   cases. The scenario compares an actually observed tool title before/after
   restart instead of prescribing an agent tool choice; its 18 tests pass.
   Stricter fresh run `st_c1621d6398354842b1309ebb02f63f0d` then failed in
   41.652 s before the title assertion: transport-ready was exposed as
   projection-ready while the subscriber's retained replay was still draining.
   The resumed app briefly showed a new conversation and an optimistic queued
   question instead of its pending replay. The run was inspected, its full
   trajectory retained privately, and its instance stopped and retired.
   Replay completion now travels on the existing event stream after its
   retained prefix, including recovery generations. Projection readiness
   follows consumption of that control, not transport readiness. Atomic
   subscription admission keeps replay before the completion boundary; native
   knowledge and model-facing observers never receive these non-durable
   controls. Connection retirement signals and joins its reader and active
   callback, preserving causal, cleanup and observer failures. The final Base
   composition check and 101 focused replay tests pass; 17 connection tests
   also pass independently. No delay, retry or weakened restoration assertion
   was added. Fresh strict run `st_79a0805c43fa446597cdb60c3a3c7c24` passed in
   55.440 s with zero tool failures. Captured evidence confirms the original
   "Get Agent Settings" title survived restoration, the scenario reached
   `done`, its session closed and its program exited with code zero.
   `eval-cancel-run` also passed on these final sources in
   `st_4c1422d4fdc04f2a81939af8eafbc0af`, 1.515 s. The final managed instance
   was stopped and its root and registry record retired.

3. **Approval withdrawal cancellation is complete.** Host `a52e2fb42`
   propagates a typed cancellation with the original lifecycle cause through
   approval waiters, DO dispatch and EvalDO. `eval-cancel-run` passed.
4. **Test the first-launch review end to end.** An unreviewed Electron app
   should open its review, start once accepted, and show a plain message when
   declined. Only unit tests and code paths cover this today. The blocker was
   landing a new app on a test instance: a new app directory needs a
   repository first.
5. **Test the desktop panel and browser session sharing in a real Electron
   client.** Unit tests only so far. Use
   `node scripts/development-client-executor.mjs --instance ID`.
6. **Measure echo latency on an idle host**, with the event-driven driver
   (`pdrive.mjs`, see §6), for the shell and for Chat input. The residual
   extension-call cost is a few ms above core calls.

### Infrastructure defects found

7. **Former startup cap already removed by main.** Current managed-instance
   registration waits for readiness or its owning process's failure, without
   `STARTUP_TIMEOUT_MS`. The older timeout diagnosis is not current.
8. **Fresh managed startup review already owned by the launcher.** Current
   `runSystemTest.ts` settles fresh-instance startup before the first test
   command; managed doctor also owns startup approvals on reuse. Continue to run
   doctor first as required by AGENTS.md, but do not reintroduce a second
   bootstrap path to fix the old report.
9. **Concurrent typecheck collision not reproduced (2026-10-14).** Concurrent
   projected Base and System checks both passed, with distinct invocation
   directories and UUID-owned compiler state; scratch was retired. Two compiler
   processes each reached roughly 5.8 GB RSS, with host available memory around
   1.5 GB and full 2 GB swap. The earlier four-way failures may be resource
   pressure, but no compiler failure or OOM was established. Do not introduce
   cache shims or claim an isolation defect from the old report.
10. **Mobile test completion race fixed (2026-10-14).** The two-worker run
    reproduced BrowserPrivacyManager pressing Delete while update refresh was
    still pending. Both suites now wait for visible completion/close, not entry
    into a mocked service. A controlled pending-refresh regression proves that
    distinction. The two-worker rerun passed 11 tests; no production timeout or
    timeout extension was introduced.

    Stream ownership also needed repair: RPC response bodies without a client
    lifetime dropped their explicit/ambient call cancellation signal. The
    canonical response adapter now preserves the owning reason, joins reader
    cancellation, detaches listeners and retains unexpected teardown failures.
    Already-errored bodies are distinguished by their stored error identity,
    not by guessing from `AbortError` names. Eighty-five client tests pass.
    The scenario's approval watch shares the harness lifetime and suppresses
    only its exact owned cancellation reason, never an unrelated transport error.

### Upstream sync

11. **Main integration complete.** Host main `39554dbe0` and all configured
    Base, System, System-testing and Personal mains are ancestors of these
    worktree branches. The formerly held-back model-authority changes are
    integrated. Model authority presentation has one bounded `model:` path,
    without duplicate broad `model.use` entries.

### Design questions for the user

12. **Snug sockets** (`send`/`split`) now reach all of a person's sessions,
    because sessions share the `user:<id>` owner. Within one runtime this is
    documented as not a security boundary, but the reach is now wider.
13. **Launch approvals unified (2026-10-14).** Launch/resume/restart use an open
    transport plus one exact prepared gated `terminal-apps.run` leaf for both
    user and code callers. App, version and workspace are named; underdeclared
    code remains denied. Preparation checks session ownership before revealing
    a stored command. The authority census was explicitly reviewed and regenerated.
14. **Device principals.** Per-device app principals could become a generic
    client-run entity in supervision. This was listed as "consider" and not
    done.

### Improvements worth doing

15. **Startup profiling uncovered validation defects, not a measured scheduler
    regression (2026-10-14).** A fresh owned source-terminal instance reached
    browser chrome; native `readStartupProfile` reported semantic activation
    7.006 s and reconciliation 13.197 s. The inherited shared build cache was
    not reset; this was not an installed-product or compiler-cold benchmark.
    Browser readiness also included an explicit first-run approval, whose wait
    must not be charged to compilation.

    Native `profileBuild("clients/terminal-browser", {ref: "main", verifyCache: true})`
    exposed two false validation failures: build reports omitted declared
    type-only development dependencies, and authority folding applied the mobile
    context-boundary baseline to every app target. Reports now reuse the existing
    compiler graph, without changing runtime composition; authority folding and
    checkout audit apply the mobile baseline consistently, preserving explicit
    crossing checks for every target. Forty-nine focused regressions pass.
    A fresh owned instance repeated the native profile successfully: report
    `ok`, no diagnostics, preexisting browser key
    `a5b7db0823b86c27fe92e576e4a07145e9cfdf48989d2fa5752c3da96f78d93e`,
    30.627 s initial validation and a 1.364 ms verified repeat with identical
    build keys. Its startup report measured activation 3.988 s and reconciliation
    4.682 s with the inherited cache; those are not controlled before/after
    speedup measurements. Both profiling instances were stopped and their roots
    and registry records retired.
    After the stream-lifetime changes, the final managed instance rechecked the
    browser report: `ok`, no diagnostics, key
    `80baf4f782e1a0e0ccef81608325cd7d1da9fc11f1e949f51c60ec18148f7f15`,
    8.425 s validation and a 0.420 ms identical-key repeat. This again validates
    correctness/cache reuse, not an installed-launch speedup.
    No speculative-prefill delay or user-visible speedup has been established,
    so no scheduling change is justified by this run.

16. **Installed acceptance tooling ready; exact artifact unavailable.** The
    existing `scripts/terminal-app-smoke.mjs` accepts `--app-directory` and
    `--expected-release`, validates exact template pins and the canonical full
    release before launching, then checks fresh-profile/warm-profile readiness,
    terminal restoration and owned-server shutdown. Its ten regression tests
    include stale pins, process exit and failed cleanup ownership. Failure
    evidence is bounded/private; scratch is retired only after every owner joins.
    The local installation predates this branch and lacks a complete release;
    current published template pins do not contain the terminal changes. No
    installed launch, timing or session-restoration pass is claimed. Publishing
    these templates and producing the corresponding package is a separate action
    requiring user direction; do not inject checkout overrides into a package.
17. **Canonical approval title fallback polished (2026-10-14).** Missing entity
    records use the declared source name or semantic requester kind instead of
    opaque runtime IDs. Identity fields retain exact IDs. Approval/service
    regressions passed 18 tests. This is not an exhaustive visual audit of every
    approval surface.
18. **More terminal apps.** Candidates: a workspace file browser, a missions
    or automation monitor, an approvals inbox. Use the Base terminal-apps
    skill (`base/skills/terminal-apps`) and the Server Logs port as the
    reference for a small app.
19. **Authority audit.** It matches by exact name, unlike build admission's
    coverage matching, so it can be stricter than admission. Align the two.

## 6. Useful artifacts

The session scratchpad holds the following, and may be RAM-backed and
short-lived. Copy anything you need.

`/tmp/claude-1001/-home-werg-vibestudio/60f4aeb1-0c7a-4b93-83ad-572e8d46767a/scratchpad/`:

- `drive.mjs`: pty driver.
- `perf/pdrive.mjs`: event-driven driver with `echo-shell` / `echo-chat`
  modes.
- `live/`: screen captures.
- `preamble.md`: the rules every subagent was given.
