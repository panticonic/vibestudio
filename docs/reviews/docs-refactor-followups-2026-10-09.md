# Docs refactor follow-up integration

The user authorized all seventeen follow-ups in cleanup-handoff-2026-10-09.md,
and committing the already-ready work without exact authorship separation.
All seventeen source follow-ups are now implemented or resolved against the existing design.
Template release promotion remains at the publication boundary described below.

## Ready work committed

- Host: `279564b80` — runtime contracts, lifecycle ownership, documentation cleanup.
  Full `pnpm check:commit` passed, including host typechecks, lint and formatting.
- Base: `54aa169` — runtime ownership, automation actions, workspace guidance.
  The Base semantic composition typecheck passed.
- Other template repositories' earlier work was already committed and clean.
- Base: `df3625c` — owned mission recovery, exact preparation retries, and
  semantic-event branch publication. Base composition typecheck passed.
- System Testing: `c96d9ae` — self-development handoffs use semantic commit
  events and the canonical branch publication contract.

## Follow-ups implemented since those commits

9. Mobile device revocation clears only the matching secure-store pairing,
   clears the returning token provider, retires foreground reconnection, and
   joins retirement on close. Secure-store mutations are serialized. Tests
   cover joined deletion, newer-pairing preservation, and other terminal codes.
10. Supervision reports source release identities for panels, workers and DOs.
    DOs belong to the worker source release; release selection spans runtime
    kinds so the worker and its objects are all discoverable.
11. Typecheck requests are scoped to the authenticated calling context. Checking
    another context requires invoking from that context. This keeps source
    materialization and compiler admission under one authority. Every endpoint
    rejects cross-context requests before source discovery.
12. Full report replacement requires unchanged narrative. Narrative mutations
    use the existing append/patch APIs, which own IDs and authorship. Regressions
    cover forgery, deletion, edits, and preserving the draft after refusal.
13. Removed the public getDebugState RPC and participant method advertisement,
    closed its self-call shortcut, and removed adminInspectAgent. Debug reads
    use gad.inspectAgent and the bounded channel-admin inspection receiver.
    Dependent advertisement expectations and the Gmail test fixture are migrated.
14. Desktop panel actions retain contributed commands until the authoritative
    runtime-lease or slot-retirement event. Contributions retain their exact
    originating runtime; an old retirement cannot erase a replacement's set.
15. Cloudflare Pages upload credentials use the JWT exp claim inside the broker,
    replacing the assumed fifteen-minute retention. Cloudflare's official API
    documents a short-lived token, not a fixed fifteen-minute lifetime:
    https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get_upload_token/
    The credential never leaves the broker. Tests cover protocol expiry,
    malformed/expired tokens, and publication/audience admission.
    17 (partial). Collection refreshes from panel-tree invalidations, subscribing
    before its initial query and coalescing invalidations during a query into a
    subsequent read. Its interval is removed. Remote title and watch release
    regressions pass. MigrateTab now observes published browser-import updates;
    closing the panel cancels only that observation. Automation overview now
    observes the mission owner's versioned changes. It subscribes before
    loading, retains changes during loading, and offers an explicit retry after
    a provider failure. Unmount cancels only the observation.

Verification so far: 19 report/supervision tests, 10 credential/publication tests,
15 shared-command/mobile tests, 185 Base chat/channel/website tests, 14 System
extension tests, and 7 Personal collection tests passed. Host typecheck passed.
System Testing, Google Workspace, and Personal composition typechecks passed.
Another 21 Base automation/advertisement tests, 19 browser-import owner and
client tests, 30 Personal tests, and 5 shell client tests passed. The shell
regression proves a failed reload retains commands until runtime retirement.
The host integration gate passed. Subsequent composition checks are recorded in the final source integration section.

Agent lifecycle recovery now drains parked automation Finish receipt debt.
A storage-reopen regression proves that it redelivers the original terminal
receipt without repeating execution. MissionsDO now acquires durable lifecycle
ownership before admission, joins cancellation and retirement, and reopens each
persisted phase with stable receiver identity. Forty-three mission regressions
passed, and the sixty-second run polling guard is removed.
The subsequent mission observation changes pass forty-seven mission tests,
twelve host client tests, and three System Automation UI tests. System's
composition typecheck passed.

Preparation retains its exact canonical VCS command and full mutation receipt.
Generation no longer preempts VCS's atomic destination admission. Callers can
provide the original command identity and basis for an identical retry; changed
payloads still fail VCS command reuse checks. Thirty preparation tests passed.

Semantic-source branch publication now exports an exact event through the same
Git projection engine into an owned private checkout, then requires an absent
remote ref in the actual receive-pack advertisement. Git's ref update checks
that same prior identity atomically. It preserves protected main, the managed
checkout, and upstream tracking. SELF_IMPROVEMENT.md now uses semantic VCS and
this publication contract rather than running Git on a workspace projection.
Seventy-nine bridge regressions and twenty-five Git client tests passed,
including a real Git tree containing changed and unchanged semantic files.
The Base composition typecheck passed after these changes.

## Decisions verified against existing implementation

3. Keep host attestation of the selected service principal ceiling. The host
   resolves the exact provider and service, seals targetRequirement separately
   from method authority, and the receiver checks both. This already exists in
   authorityRuntime, RPC admission, and directRpcEnforcement. Authority tests
   (including authority folding) passed: 61 tests in three files.
4. Singleton object identity stays in workspace selection (singletonObjects),
   shared by service resolution and DO routes. Provider exports declare service
   contracts, not workspace object identity. authorityFold already consumes
   serviceRequests and folds concrete service resolution/invocation effects.
   Its focused regressions pass; no duplicate folding path is needed.
5. Keep the single-source decision-only commit contract. Ordinary commit already
   includes every local application and its recorded integration decisions;
   concludes adds one net-zero/convergent source. Separate conclusions remain
   separate semantic decisions and commits; no decisions-table migration is needed.

## Final source integration

1. News cadence now belongs to Missions. The two defaults invoke the selected
   native `refreshNow` tool in the existing News agent, retaining exact execution
   image, lifecycle ownership and cancellation. Daily briefings use an explicit
   IANA timezone and cron trigger. Invalid unzoned requests fail before admission.
   Initial pause is admitted atomically by Missions, and pause/resume are
   idempotent. The reader observes both channel and mission changes; no refresh
   interval or private cadence mirror remains. Commits: News `d17852b`, `7723766`;
   Base `678dfa4`, `f9346da`; host `794c37d07`, `0218ba12c`.
2. Git imports clone into an owned staged checkout and semantic context. One
   atomic provider-state replacement selects configuration and candidate together.
   Failed unselected candidates are retired; cleanup debt survives reopening.
   A lost selection acknowledgment reads the committed receipt before cleanup.
   Ordinary clone uses this same pipeline, and all review readers use the selected
   context. Base commit `e8e135f`; 84 focused bridge/upstream tests passed.
3. SetupHub now admits all observations before its first snapshot and coalesces
   invalidations during a read. Credential and provider configuration changes use
   native file notifications, including other-process replacement and deletion.
   Model defaults, credentials, Missions and paired devices expose owned versioned
   observations. Local models, browser import, installed catalog/workspace config,
   workspace catalog and connection/topology changes use their existing events.
   Failure remains visible until an explicit retry; unmount cancels and joins only
   the observations. Base commit `f439c15`, Personal commit `d97fba8`.

Final focused checks: 49 model-settings tests, 13 SetupHub/observation tests,
44 News worker tests, five News browser tests, and the SetupHub phone-width
browser regression passed. Base and Personal composition typechecks passed.
The browser regression also verifies that the external-checkout mock is applied.
A pinned two-line Vitest patch repairs its false root-prefix match for sibling
checkout paths. pnpm applies it reproducibly; no browser resolver fallback remains.

## Integration verification and release boundary

The current follow-up checks passed: 68 host tests, 206 Base tests, 22 System
tests, 43 Personal tests, 55 Google Workspace tests, and 3 System Testing tests.
Three additional Personal browser-import UI tests verify versioned progress,
terminal completion, visible provider errors, and observation cancellation on
unmount without cancelling the import itself. All eight template compositions
passed the host-owned semantic typecheck. The current pair-authority gate passed.
These focused results supplement the earlier full-suite runs; they are not a
claim that every agentic scenario or live-device smoke test passed.

Packaged defaults still reference older published Base, Personal, and System
tags in `build-resources/workspace-template-release.json`. Those releases do not
implement the new source contracts. Pushing the source repositories to main
does not promote the packaged defaults. Promotion must use each template's
ordinary authoring inspection, review, and publish workflow, followed by
`generate:workspace-template-release` with the actual publication receipts.
The profile currently has no active GitHub publication credential accepted by
that workflow. A GitHub connection with repository-publish access is required
before promotion can proceed; Git's working push credentials do not supply
that application authority. No receipt or pin was fabricated, and no legacy
reader was added to accommodate the old releases.
