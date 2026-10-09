# Handoff: skill-docs pass + design-smell refactors (2026-10-09)

This is the historical handoff supplied before final integration. The working-tree
and validation status below describe that moment; they are not the final commit or
verification record. Open design proposals remain follow-up work unless a later
implementation explicitly closes them.

Nothing is committed. The working trees in the host repo and in every template repo
(`/home/werg/vibestudio-templates/*`) mix several authors' uncommitted work:
- this effort (Claude subagents, then Codex, then Claude reviewers);
- a separate review/cleanup session (rpc streamCodec/httpClient, hostConfig GATEWAY_*,
  shell/mobile UI and others; already finished);
- another session still editing `packages/workspace-contracts/src/serviceMutation.ts`,
  the harness `workspace-service` tool and `base/skills/workspace-dev/create-project.ts`.
  The type-check failures there are its in-progress work.

Commit in reviewable slices, per repo and per goal, not as one blob.

## Done (reviewed and tested by focused tests)
- **Skill docs language pass:** all templates. Stale facts fixed throughout.
- **Bug fixes:**
  - ui.feedback starts a repair turn (the dead `FeedbackIngest` class was removed).
  - `ctx.fs` docs, readiness-deadline docs, google-drive "Google agent" section,
    collection-orchestration `{node, handle}` prompt.
  - code-ref default docs, the `.tmp` paths, the action-bar file rule.
- **Runtime:**
  - CDP sessions follow panel generations (`panel_cdp_generation_changed`).
  - Scope-serializable handles; `page.setContent`; `Symbol.asyncDispose` / `await using`.
  - The two CDP references are merged (workspace-dev/BROWSER.md is the full one); the
    EVAL importable list is generated.
  - `useHostCommands` merging; `services.*` is raw-only; the `parent` export is removed.
  - `useAction`/`OpenLinkButtons`; `putPathTree`; build check against module-level
    runtime clients in DOs.
- **VCS:**
  - Runtime-minted `commandId`; `vcs.publish` with typed `IntegrationRequired`.
  - `commit({concludes})`, single source (see open item 6); `SourceIsAncestor` recovery;
    listFiles/readFile invariant moved into a server test.
- **Publication:** host-owned website publication journal (`publishFromJournal`);
  resumable `publishToGitHub`.
- **Binary RPC:** native binary codec (`wireJson.ts`, NUL-escaped tag), wired into the
  DO/worker receivers, rendered in `help()`.
- **Host services:**
  - `@rpc` policies may use module-level consts.
  - Pairing via hub events, with the client clocks removed.
  - Sensitive-import versioned waits (and 3 mobile-provider bugs fixed).
  - Supervision `release` keys; `extensions.status/update`; `ensureMaterialized` returns
    the root.
  - Problem-report append/patch with server section ids; `prepare` returns the frozen
    revision; `problemReports` eval global.
- **System testing and mobile:**
  - `runNextSelectedStage`; trajectory persisted with failure evidence.
  - Shared `createHostCommandRegistry` (desktop and mobile).
  - RN ABI build check (`RN_HOST_ABI` in `packages/shared/src/buildProvider.ts`).
- **gad:** health split into `durableIntegrityOk` / `activity`; paging
  `pageInfo.next/previous`; `gad.inspectAgent`.
- **Automations and Personal:**
  - Automations: `contextId` injection, `missions.launch/edit` helper.
  - `load_action_bar({code})`; SetupHub routes client-side selections itself.
  - Collection title (slot title only); `panelTree.walk`; tour scene registry.
- **Dead code removed:** the agent-outbox idea is dropped. The dead `agent-wake` and
  `agent-effect` durable-work queues are deleted (`packages/shared/src/durableWork.ts`,
  `durableWorkDriver.ts`, tests renamed to the real queues), and the stale `channel_call`
  comments are gone. Direct agent-to-agent calls were *replaced*, not lost:
  - `notify` with `to:` from `list_addressees`/`discover_agents`;
  - `chat.callMethod`/`callMethodByHandle` (durable, `native-channel-method.ts`);
  - the `*_subagent` tools.

## Completed in the continuation (2026-10-09)

1. **Notification automations.** Added `notify` to the canonical mission action
   type and every automation snapshot/payload schema. Validation rejects empty
   text and fresh-mode notifications. MissionsDO tests cover delivery, inbox
   failure failing the run, and push failure leaving the inbox delivery successful.
   The skill contract and AutomationActivity tests pass.
2. **State args migration.** Completed `stateArgs.patch` / `patchForPanel` callers,
   mocks, Svelte exports, docs, journal evidence, and the mobile manager client
   across the template checkouts. Collection notes patch only their addressed
   key (blank deletes it), tour updates patch only changed fields, and sensitive
   import checkpoints use a merge diff to delete stale nested keys. Corrected
   the active-build schema test fixture and the missing schema resolver fixture;
   patch returns now have structural JSON schemas. Merge/diff helpers preserve
   prototype-named JSON keys as data. Owner tests prove concurrent composition,
   schema validation, and entry/build conflict rejection.
3. **Panel lifetime.** EvalDO now claims invocation/session ownership when the
   runtime commits a slot. Ownership is persisted without the old 100-resource
   truncation. Ordinary completion joins invocation panel retirement before
   its terminal result; explicit cancellation owns retirement after guest unwind
   and registered handlers settle. This preserves the existing contract that
   the sandbox result can settle while cancellation remains `cancelling`.
   Session panels survive suspension/cold hydration and retire at the session's
   terminal lifecycle. Interrupted invocation ownership drains before the next
   cell. Cleanup uses the ordinary archive implementation under the creator's
   authority, retains failed owners, and propagates retirement failures. Tests
   cover commit-before-boot-failure claiming, success/failure/cancellation,
   handler ordering, cold recovery, session retirement, and partial cleanup.
   Documented alongside `await using` in `workspace-dev/BROWSER.md`.
4. **Generated contracts and authority review.** Runtime docs/catalogs regenerated;
   runtime-doc, VCS release, authority-ledger, both authority-matrix tests, and
   template-checkout hygiene checks pass. The authority review has no duplicate
   JSON keys, including `host:credentials.recordWebsitePublication`. Reviewed
   the state-patch entries: existing runtime-state capability/context-boundary
   principals remain; serialization/schema guards grant no additional authority.
5. **Documentation contradictions.** Updated PANEL_SYSTEM's removed handle
   methods; supplied `.tmp/ui/package.json` for the lodash component example;
   corrected the prompt audit's mobile test name.

## Verification and integration remaining

- Final focused host run: **273 tests passed** across eight files; see
  `.docs-focused-tests.log` (ignored local evidence).
- Base notification/UI/runtime/chat tests: **107 passed**, plus the later panel
  handle ownership regressions (**27 passed** in that file).
- Personal collection/browser-import: **40 passed**. Spectrolite session/vault:
  **14 passed**, and create-app: **3 passed**. System Testing prompt/CDP
  diagnostics: **35 passed**.
- `pnpm type-check:host`, and Base/System composed typechecks, were attempted.
  Remaining diagnostics belong to the pre-existing workspace-service work
  (`serviceMutation.ts`, harness workspace-service and fixtures, create-project),
  plus incomplete host-side `packages/react` / `packages/runtime` source copies.
  These were preserved rather than edited across another author's work. Logs:
  `.typecheck-host.log`, `.typecheck-base.log`, `.typecheck-system.log`.
- No system-test instance was allocated. No changes were committed because the
  repositories still contain mixed authors' edits and staged changes; integrate
  in reviewable goal-specific slices after coordinating ownership.
- Concurrent changes to EvalDO lifetime cleanup/tests were observed during this
  continuation and preserved. Avoid overlapping edits to this feature.

## Open decisions (yours)
1. **News scheduling.** Needs a `{kind:"method"}` action for continue-mode agent
   automations; method-charter missions cannot target the live News agent. After that:
   missions own the cadence, `setSchedule` gets a `timezone` argument, and the panel's 60s
   timer is replaced by refetching on channel updates.
2. **MissionsDO `driveRun`:** the `progress_at + 60_000 > Date.now()` elapsed-time
   re-dispatch check violates AGENTS.md.
3. **Principal ceiling.** How a receiver learns the service-level principal ceiling: the
   host attests the target's principals, or the receiver enforces the sealed catalog.
   Codex's false doc comment and dead flag are removed.
4. **Singleton fold.** Should the singleton key be owned by the provider package export or
   by the workspace selection? DO routes also look keys up in `singletonObjects`.
   Generating consumer authority requests from `serviceRequests` (`authorityFold.ts`) is
   still not done.
5. **`prepareApplication` retry safety.** Proposal: split file generation from destination
   checks and compare the regenerated files to the recorded command's application. Until
   then the "Never call either preparation API again" rule stays.
6. **`commit({concludes})`.** Accept the single source per commit, or migrate the decisions
   table (it has a `UNIQUE(work_unit_id)` constraint).
7. **Transactional git import.** The git config now lives in git-bridge state, so it can't
   be atomic with the semantic import. Move it back into the snapshot, or use staging plus
   a discardable candidate.
8. **`git.createBranch` semantics.** Proposal: `{repoPath, branch, from: eventId}` exports
   to a new remote branch, gated like `pushUpstream`. The SELF_IMPROVEMENT.md snippet
   using `GitClient` on a projection is wrong today.
9. **Mobile self-revoke.** Should the mobile client clear its credential on close code 4001?
   Desktop already does.
10. **Worker supervision release id.** Panel, worker and DO rows report `release: null`.
11. **typecheck-service.** May it check contexts other than the caller's own?
12. **Problem reports.** `problemReports.update` still accepts any author on a full replace.
13. **Agent inspection.** `getDebugState` is still callable via `chat.callMethod`;
    `adminInspectAgent` is test-only and could be removed.
14. **Desktop `workspaceClient.ts`.** It drops a panel's commands before reload or navigate
    instead of on actual runtime replacement.
15. **Cloudflare upload credential.** It keeps `expiresInMs: 15 min`. Confirm it mirrors
    Cloudflare's JWT lifetime.
16. **SetupHub owner-state change events.** Too large for this pass; it needs its own task
    (8 owner sources).
17. **Remaining polling.**
    - collection panel `setInterval(refresh, 2000)` (`personal/about/collection/index.tsx:~313`)
    - System Automations UI 5s polling
    - `MigrateTab.tsx` `getImportJob` 500ms polling (no wait API)
