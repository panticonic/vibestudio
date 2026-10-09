# Handoff: skill-docs pass + design-smell refactors (2026-10-09)

The seventeen source follow-ups have now been implemented or resolved. See
[the final integration record](./docs-refactor-followups-2026-10-09.md) for commits
and verification. Template release promotion still requires the application's
GitHub publication credential; the historical working-tree status below is superseded.

This is the historical handoff supplied before final integration. The working-tree
and validation status below describe that moment; they are not the final commit or
verification record. Open design proposals remain follow-up work unless a later
implementation explicitly closes them.

Nothing is committed. The working trees in the host repo and in every template repo
(`/home/werg/vibestudio-templates/*`) mix several authors' uncommitted work:

- this effort (Claude subagents, then Codex, then Claude reviewers);
- a separate review/cleanup session (rpc streamCodec/httpClient, hostConfig GATEWAY\_\*,
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
  comments are gone. Direct agent-to-agent calls were _replaced_, not lost:
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

1. **News scheduling.** The panel's 60s reader timer is now replaced by channel-driven
   refreshes, with an initial read after channel readiness. The remaining scheduling
   question is still open: method-charter missions cannot target the live News agent, and
   missions do not yet own the News cadence or pass a timezone through `setSchedule`.
2. **MissionsDO `driveRun`:** the elapsed-time redispatch check has been removed. Run
   advancement is owned by persisted lifecycle work and explicit recovery/retirement events,
   rather than inferred from `progress_at` age.
3. **Principal ceiling.** How a receiver learns the service-level principal ceiling: the
   host attests the target's principals, or the receiver enforces the sealed catalog.
   Codex's false doc comment and dead flag are removed.
4. **Singleton fold.** Current authority folding derives consumer requests from
   `serviceRequests` in `authorityFold.ts`; singleton selection remains a workspace
   selection concern. The earlier ownership question is resolved by that split.
5. **`prepareApplication` retry safety.** Preparation now retains the exact VCS edit and
   receipt in its result, and accepts a caller-owned command id plus original working basis
   before mutation. Replaying the identical request at that identity returns the original
   receipt; changed bytes or intent fail with `CommandIdReuse`. The atomic repository-create
   edit rejects occupied destinations, so a new command cannot overwrite an existing
   candidate. A lost response is recoverable only when the caller retained identity and
   basis before the first call; omitting them lets the helper mint an unreturned random id,
   and a fresh helper invocation is a new command, not replay. Automatic runtime-owned
   recovery remains future work. See Base `skills/workspace-dev/PROJECTS.md` for the
   recovery contract.
6. **`commit({concludes})`.** Accept the single source per commit, or migrate the decisions
   table (it has a `UNIQUE(work_unit_id)` constraint).
7. **Transactional git import.** Imports now own isolated checkout/context candidates.
   Configuration and candidate selection are published together in the Git owner's
   state; failures before selection retire the candidate, and a lost publication
   response is resolved from the persisted selection. Activation retires interrupted
   candidates while preserving selected checkouts. The focused bridge/upstream/activation
   projection passes 86 tests.
8. **`git.createBranch` semantics.** Implemented as an event-bound remote branch creation
   in Base, gated by the same publication authority as `pushUpstream`. The projection-based
   `GitClient` example was removed from the guidance.
9. **Mobile self-revoke.** The mobile client now clears its credential on close code 4001
   and joins session, transport, and credential retirement while preserving the primary
   failure. Focused failure-path coverage is present; no new validation claim is made here.
10. **Worker supervision release id.** Panel and worker supervision now derive their
    release identity from the source repository; DO supervision reports its worker release.
11. **typecheck-service.** The service checks the invocation's own context and rejects a
    request that names another context.
12. **Problem reports.** Full replacement no longer changes another author's narrative;
    narrative edits go through the author-checked patch operation.
13. **Agent inspection.** Inspection goes through `gad.inspectAgent`; `chat.callMethod`
    rejects debug-state access and points callers to that operation.
14. **Desktop `workspaceClient.ts`.** Contributed commands remain registered when a
    requested reload fails before runtime replacement, and retire with the replaced
    runtime.
15. **Cloudflare upload credential.** Base requests the provider's JWT expiry and derives
    credential expiry from that claim rather than imposing a local 15-minute lifetime.
16. **SetupHub owner-state change events.** SetupHub subscribes before reading its
    snapshot and follows credential, model-setting, automation and device revisions,
    plus the existing setup lifecycle event streams. Changes during a refresh remain
    pending for a subsequent read. Observation cancellation joins owned work and
    preserves independent cleanup failures; device activity does not invalidate readiness.
    The focused SetupHub projection passes 12 tests and its responsive Chromium test passes.
17. **Observation updates.** Migration progress now follows the provider's event-observation
    lifecycle; unmount cancels observation, not the import operation. Collection
    follows panel-tree invalidations. System Automations follows MissionsDO's
    user-scoped version observation, and News refreshes from channel events.
    System Automations' three focused UI tests and News's five Chromium reader tests pass.
