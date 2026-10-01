# Vibestudio template user experience review and repairs

Reviewed and repaired 1 October 2026. All eight official template sources were reviewed together with their host integration: Base, Personal, System, System Testing, Examples, Google Workspace, News, and Spectrolite.

The review found problems in durable operation ownership, truthful status, first use, recovery, accessibility, and installed source boundaries. The sixteen recorded findings are addressed in the changes described below. Additional repairs cover interrupted downloads, Spectrolite file errors and concurrent agent management, Gmail reply preparation, and a semantic-history integrity defect. The result is supported by conventional tests, composition typechecks, Chromium interactions, and isolated installed-template verification. It is not a claim that live OAuth, physical devices, or every application journey has been exercised.

## Scope and method

The initial inventory contained 162 declared source repositories, 142 executable/package units, 52 skill documents, 158 Markdown documents, 782 test files, and 4,549 tracked files. Counts describe inventory, not a line-by-line manual review of every asset. The extra local `vibestudio-dev` checkout is outside the official registry and outside this review.

Review covered manifests, startup configuration, packages and service declarations, installed documentation, user-facing panels and settings, worker operations, durable state, and existing tests. Failure probes established the delivery, draft, verification, and world-identity defects before repair. Each repair was then checked against the owning lifecycle and its plausible effects on other templates.

External checkouts were treated as source inputs. Tests, typechecks, dependencies, compiler state, browser optimization caches, and screenshots were owned by the host projection. No package manager or build tool was run with an external template checkout as its working directory. Existing unrelated host documentation and experiment changes were preserved.

## Findings and resulting behavior

| Finding                            | Previous problem                                                                                                             | Repair and acceptance evidence                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F01 · Gmail delivery ownership     | Local bookkeeping failure after accepted delivery made the same compose retryable and could send twice.                      | A durable compose record owns the send claim and accepted receipt. Post-send warnings cannot reverse known delivery. Ambiguous outcomes remain fenced and reconcile through the stable RFC Message-ID. Reopen/repeat, malformed acceptance, local failures, and receipt persistence failure are covered.                                                                                            |
| F02 · Saved draft lifecycle        | Saved editor fields could reopen stale; send created another message without consuming the draft; discard did not delete it. | Editor fields and remote draft identity belong to one serialized operation. Sending uses Gmail's atomic draft-send endpoint with the final edited content. Discard waits for remote deletion; failures retain the same owned draft for explicit recovery. Each save revision gets a distinct RFC identity, so an older draft cannot falsely confirm newer edits. Incomplete drafts remain saveable. |
| F03 · News briefing lifecycle      | A ten-minute watchdog declared valid slow work failed while leaving its owner running; late output could resurrect it.       | Briefings are bound to exact owned turn IDs before submission. Authoritative turn closure propagates the original failure. Pending-to-error and pending-to-ready transitions are transactional; unrelated turns and stale writers cannot settle another operation. Slow work remains pending without an expiry.                                                                                     |
| F04 · Feed freshness               | Every feed could fail while the headline claimed “Up to date.”                                                               | Poll status uses actual successes and enabled-source error/backoff observations. Failed or skipped attempts do not advance the last successful observation. Retained articles remain readable. Tests cover all-source failure, partial failure, and skipped work.                                                                                                                                   |
| F05 · Saved-story recovery         | A rejected unsave removed the still-saved story until the user changed tabs.                                                 | Serialized reader mutations wait for acceptance before removing a Saved row. Rejection retains the row and action, with visible error. Chromium exercises rejection and recovery on the actual reader.                                                                                                                                                                                              |
| F06 · Reader continuity            | Refresh replaced loaded pages with page one and moved selection by numeric position.                                         | One reader owner refreshes the loaded extent through its previous boundary, serializes refresh/load/mutations, validates cursor progress, and preserves selection by article ID. Chromium loads several pages and triggers a real refresh event while an older story is selected.                                                                                                                   |
| F07 · Game action ownership        | A response from an old world could replace the newly selected world and its action state.                                    | Client/world identity owns pending actions, results, locks, errors, and art updates in both Grimoire and Regency. Switching identity resets the projection and rejects stale completions. Separate regression cases cover both games.                                                                                                                                                               |
| F08 · Spectrolite collaboration    | Connection failures were hidden and default-agent startup silently retried indefinitely.                                     | The session exposes connecting, ready, error, and closed states from actual readiness and stream lifecycle. Sending requires ready state. Installed agent identity is durable before launch; original startup failures have explicit retry. Agent operations serialize owned mutations, removal retires the exact owned entity, and an explicitly empty selection stays empty.                      |
| F09 · Help ownership               | Local links targeted settings absent from catalog workspaces.                                                                | Help routes permissions to System and credentials to Personal through the existing workspace-role selector. No duplicate settings implementation was added.                                                                                                                                                                                                                                         |
| F10 · Installed documentation      | Guidance linked to optional owner files or host-only documentation outside the composition.                                  | Foundational guidance is self-contained; optional workflows name their actual owner and availability. System Testing declares Personal onboarding requirements. A composed Markdown closure check resolves 284 links/references with zero broken targets.                                                                                                                                           |
| F11 · Catalog first launch         | Examples and Google Workspace lacked a purpose-specific opening surface.                                                     | Examples opens a curated world chooser with developer references secondary. Google opens setup and Gmail entry with permission-aware status. Both use the normal panel routing and template startup declaration. Welcome layouts pass at 320, 390, and 1280 pixels.                                                                                                                                 |
| F12 · Google setup burden          | The default asked for all Workspace APIs and broad grants before a mail task; prerequisite expectations were unclear.        | Catalog and setup explicitly describe the supported bring-your-own OAuth application requirement. Gmail is the default scope/service choice; all Workspace access is explicit. The normal browser is the default. Additional consent unions requested permissions with existing grants because installed-app OAuth does not support incremental authorization. Secrets remain in trusted flows.     |
| F13 · Google verification          | The badge could report unverified while the success message claimed verified.                                                | Badge, warning, success text, and next action derive from the same verified status and requested permission set. Gmail and Drive require their respective grants; a verified Drive-only identity cannot unlock Gmail. Browser tests cover revoked verification and insufficient Gmail permissions.                                                                                                  |
| F14 · Story identity and readiness | New panels shared implicit world keys; illustration failure hid accepted game state; fabricated initial state looked loaded. | A deliberate Begin action persists a new panel-owned identity before loading. Persistence failure keeps the same candidate identity for retry. Existing keys resume. Accepted game state renders independently of optional art; loading and original errors are visible. Chromium exercises first use and failed persistence in both games.                                                         |
| F15 · Desktop column policy        | Preferred width was below minimum and fixtures assumed smaller columns than the declared policy.                             | Preferred width equals the declared 575-pixel minimum. Tests derive two-column boundaries from that minimum and divider, preserving the existing policy that narrower windows cannot fit two minimum columns. Focused layout and full System tests pass.                                                                                                                                            |
| F16 · Ad-block accessibility       | Repeated icon actions lacked accessible names; removal could lose keyboard focus.                                            | Persistent field labels and row-specific action names identify add/remove controls. Accepted removal restores focus after React commits. Chromium tests at three widths exercise role/name queries, long values, removal, and focus.                                                                                                                                                                |

The remote draft behavior follows [Google's draft lifecycle](https://developers.google.com/workspace/gmail/api/guides/drafts): sending consumes the draft and can include updated raw content. Consent expansion follows the [installed-app OAuth contract](https://developers.google.com/identity/protocols/oauth2/native-app); identity permissions use the canonical returned scope names documented for [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect).

Gmail's reply flow also prepares the recipient and subject visibly before review. Sending uses the owned edited fields; clearing the recipient cannot silently restore a hidden default. The welcome panel seeds the same canonical Gmail agent object key that its facade and tools resolve, through ordinary chat installed-agent state.

Personal download recovery now distinguishes a live resumable native transfer from retained history. Live native capability is observed transiently rather than persisted. Historical interrupted HTTP downloads offer a fresh download link; non-web/blob sources explain the source limitation. Attaching history cannot overwrite a live transfer owned by the download manager. Host ownership and UI tests cover these boundaries.

Spectrolite distinguishes file absence from permission/transport failure before note creation. Agent management lists owned installed records even when the live roster has not appeared or has disappeared, so failed launch/removal remains actionable. Removing the last assistant does not silently recreate a default assistant.

## Shared contract and verification repairs

Installed first-launch checks exposed a verification gap: the new welcome panels initially used package names that differed from their canonical source paths. Both names and explicit entry declarations were corrected. Template repository validation now shares the build graph's manifest contract; regression tests reject the identity mismatch and accept the installed identity. This prevents source inventory/typecheck success from silently admitting a unit that installed discovery omits.

Existing failures were investigated against their current contracts rather than waived:

- Reachable semantic merge decisions must have the matching coordinate entry. An orphaned reachable decision now raises an integrity failure; the existing corruption test passes. Source copy attribution is tested through the recorded incorporates/copy chain, preserving the real copies edge.
- The runtime panel export manifest and generated API/VCS artifacts now match the canonical public surface, including `launchAgentIntoChannel` as a module helper rather than an invented portable instance method.
- CLI approval events use the typed EventsClient watch admission path, including validated arguments, existing stream/ACK behavior, and original error propagation.
- Startup-boundary builds receive the canonical composed source alias graph. Panel/CDP fixtures assert stable entity and functional proxy behavior rather than raw object identity or an extra replacement RPC.
- System fixtures provide the actual asynchronous event boundary, bound-conversation addressee context, and strict host-read projection. Browser template-update fixtures provide the current update-assistant method.
- Chat hierarchy browser tests follow the declared theme tokens, distinguish surfaces, and assert actual text contrast of at least 4.5 instead of stale literal palette values.

The initial verification exhausted host storage after dependency projections accumulated unowned leases. Each test configuration now acquires one dependency projection, lends it to alias generation, and releases it once. Browser tests use the same Base-plus-selected composition, with an owned optimization cache and no source watcher for the immutable one-shot projection. This also avoids concurrent optimizer races and inotify exhaustion. No production timeout or watchdog was introduced.

## Verification

| Composition      | Latest complete conventional run   | Follow-up evidence                                                                                                        | Final composition typecheck |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Base             | 3,473 passed; 1 skipped; 369 files | Shared browser and host contract checks                                                                                   | Pass                        |
| Personal         | 253 passed                         | Download UI: 3 passed; host download ownership included below                                                             | Pass                        |
| System           | 830 passed; 2 skipped; 94 files    | Ad-block Chromium interactions: 3 passed                                                                                  | Pass                        |
| System Testing   | 748 passed                         | Required-unit declarations and installed documentation closure                                                            | Pass                        |
| Examples         | 193 passed; 27 files               | Welcome Chromium: 3 passed; story first-use Chromium: 2 passed                                                            | Pass                        |
| Google Workspace | 234 passed; 25 files               | Latest compose/worker revision checks: 62 passed, including three additional regression cases; welcome Chromium: 5 passed | Pass                        |
| News             | 169 passed; 16 files               | Reader Chromium: 2 passed after the final valid-HTML correction                                                           | Pass                        |
| Spectrolite      | 209 passed; 29 files               | Agent-ownership focused run: 9 passed; final roster projection typechecked                                                | Pass                        |

Complete-run totals include shared host integration checks repeated across compositions; they are not additive unique product-case counts. Later follow-ups target changed boundaries instead of automatically rerunning unrelated passing suites.

Additional checks:

- Shared Base Chromium: 31 passed across 11 files, including composer, hierarchy/contrast, update review, and command palette.
- System mobile baseline: 461 passed across 69 suites. Physical hardware was not exercised.
- Final focused host download/events/approval checks: 38 passed across three files; canonical template manifest validation: 2 additional tests passed.
- All eight composition typechecks passed through the host-owned projection.
- All official inventories and declared compositions validated; composed Markdown closure: 284 checked, zero broken.
- Host `check:commit`, userland dependency validation, and template checkout hygiene passed.

Chromium checks render real components with controlled service boundaries; they establish the exercised interactions and layouts, not a live account or every full catalog journey. Installed checks use the ordinary template inspection, pinned workspace creation, runtime panel materialization, and native testkit rather than a second installer or test registry.

## Installed acceptance evidence

The isolated managed `template-ux-fixed-20261001` instance passed doctor and installed all four catalog templates through ordinary `templates.inspect` and pinned `workspaces.create`. Each workspace's normal root review was accepted with its offered default permissions before inspection.

Native testkit checks passed for Examples' curated welcome, Google's setup/Gmail welcome, News' empty reader, and Spectrolite's vault picker. All four materialized from the installed source, produced readable snapshots, had no horizontal overflow at 390 × 844, and reported zero console errors. Grimoire and Regency also passed their installed Begin-entry checks in the preceding snapshot; their first-use code was unchanged in the final snapshot. These checks include panel capture and archive cleanup.

The final exact managed scenario `testkit:panel-lifecycle` passed in the owning System workspace: run `st_58ca0171326740df8508e2611ee069ee`, zero failures, zero errors, and zero unexpected tool failures. It exercises shared opening, inspection, runtime replacement, and teardown after the upstream integration. The first attempt did not create a run because CLI selection still pointed at the catalog workspace used for inspection; restoring the instance's owning System selection resolved that setup error. No product assertion was waived.

## Integration

The template repair commits are Base `c3f8599`, Personal `75f1cfb`, System `a12be14`, System Testing `dcb1b39`, Examples `bbb7ae0`, Google Workspace `84e4240`, News `43adcb6`, and Spectrolite `5aa8dd4`. All eight were pushed to upstream main and their remote heads were verified.

New upstream host/Base/System commits were fast-forwarded before final verification. An unrelated schema migration began editing the shared host and Base working trees during integration. Those changes were left to their owner. The host repair's normal pre-commit gate runs against isolated Git worktrees containing the committed template repairs and the reviewed host changes, without including the in-progress migration. The managed review instance was stopped; integration worktrees and their owned dependency directories are removed after integration.

## Remaining verification limits

No live mail was sent and no Google account or external credentials were changed. Live OAuth consent, token revocation/expiry against Google, and remote Gmail effects remain unverified against an actual account; the delivery/draft boundaries have controlled API failure coverage. Live image generation, complete model-driven gameplay, real browser imports, hardware-specific Android/iOS provisioning, and every editor publish/conflict journey were not rerun as part of these repairs.

These are limits of evidence, not deferred known failing checks. The review-owned instances and inspector/panel connections are cleaned up after verification. Recommendations for release should still be backed by account- and hardware-specific acceptance where those dependencies are required.

## Baseline source inventory

The inventory below records the initial snapshot, before the new welcome panels and regression tests. It lists all declared source repositories, including skill-only content and scaffold templates which do not have package manifests. Assets, documentation, worker tests, and panel tests are included in the source inventory rather than being omitted because they are not executable units.

### base

3,292 tracked files; 97 Markdown documents; 364 test files; 29 skill documents.

- about: `about/help`, `about/new`, `about/templates`, `about/testbench`, `about/workspace`.
- extensions: `extensions/file-tools`, `extensions/git-bridge`, `extensions/image-service`, `extensions/pdf-ingest`, `extensions/shell`, `extensions/templates`, `extensions/test-runner`.
- meta: `meta`.
- packages: `packages/about-shared`, `packages/agent-loop`, `packages/agentic-chat`, `packages/agentic-core`, `packages/agentic-do`, `packages/agentic-protocol`, `packages/cdp-client`, `packages/channel-fork`, `packages/channel-policies`, `packages/eval`, `packages/harness`, `packages/integrations`, `packages/model-catalog`, `packages/omnibox-core`, `packages/pi-ai`, `packages/pi-core`, `packages/pubsub`, `packages/quickfire-core`, `packages/react`, `packages/runtime`, `packages/template-management`, `packages/test-runtime`, `packages/testkit`, `packages/tool-ui`, `packages/ui`, `packages/vcs-engine`.
- panels: `panels/chat`, `panels/terminal`.
- projects: `projects/default`.
- skills: `skills/agentic-development`, `skills/agents`, `skills/api-integrations`, `skills/architecture`, `skills/automations`, `skills/capabilities`, `skills/extensiondev`, `skills/gad-context`, `skills/messaging`, `skills/phone-setup`, `skills/problem-reporting`, `skills/provenance-orientation`, `skills/sandbox`, `skills/templates`, `skills/terminal`, `skills/vibestudio-vcs`, `skills/web-research`, `skills/website-publishing`, `skills/workspace-dev`.
- templates: `templates/default`.
- workers: `workers/agent-worker`, `workers/missions`, `workers/model-settings`, `workers/pubsub-channel`, `workers/quickfire-service`, `workers/silent-agent-worker`, `workers/testkit-driver`, `workers/workspace-presentation`, `workers/workspace-source`.

### personal

123 tracked files; 15 Markdown documents; 28 test files; 7 skill documents.

- about: `about/bookmarks`, `about/browser-import-inspector`, `about/collection`, `about/credentials`, `about/downloads`, `about/history`, `about/local-models`, `about/permissions`, `about/search`.
- extensions: `extensions/browser-data`.
- meta: `meta`.
- packages: `packages/collection-orchestration`.
- panels: `panels/tour`.
- skills: `skills/github`, `skills/memory`, `skills/onboarding`.
- workers: `workers/browser-data`, `workers/explorer-agent`, `workers/tour-sample`.

### system

508 tracked files; 18 Markdown documents; 154 test files; 9 skill documents.

- about: `about/about`, `about/adblock`, `about/automations`, `about/credentials`, `about/keyboard-shortcuts`, `about/local-models`, `about/permissions`, `about/server-logs`, `about/workspace-history`.
- apps: `apps/mobile`, `apps/remote-cli`, `apps/shell`, `apps/terminal-browser`.
- extensions: `extensions/local-models`, `extensions/mobile-debug`, `extensions/react-native`, `extensions/typecheck-service`.
- meta: `meta`.
- packages: `packages/mobile-navigation`, `packages/terminal-host-protocol`, `packages/terminal-shim`, `packages/workspace-transfer`.
- skills: `skills/appdev`, `skills/local-models`, `skills/performance`, `skills/remote-access`, `skills/server-logs`.
- workers: `workers/development`, `workers/images`, `workers/phone-provisioning`, `workers/system-agent`.

### system-testing

173 tracked files; 11 Markdown documents; 61 test files; 3 skill documents.

- packages: `packages/agentic-session`.
- skills: `skills/mobile-system-testing`, `skills/system-testing`.
- workers: `workers/system-test-runner`, `workers/test-agent`.

### examples

185 tracked files; 5 Markdown documents; 22 test files; 0 skill documents.

- packages: `packages/adventure-campaigns`, `packages/adventure-engine`, `packages/adventure-ui`, `packages/game-play-tests`, `packages/grimoire-engine`, `packages/living-canvas`, `packages/regency-engine`, `packages/svelte`.
- panels: `panels/dead-letter-office`, `panels/grimoire`, `panels/hello-svelte`, `panels/hello-vanilla`, `panels/missing-country`, `panels/regency`, `panels/wandering-house`.
- templates: `templates/svelte`, `templates/vanilla`.
- workers: `workers/adventure-agents`, `workers/adventure-world`, `workers/grimoire-agents`, `workers/grimoire-world`, `workers/hello`, `workers/images`, `workers/regency-agents`, `workers/regency-realm`, `workers/sample-do`.

### google-workspace

83 tracked files; 10 Markdown documents; 19 test files; 3 skill documents.

- packages: `packages/gmail`, `packages/google-workspace`.
- skills: `skills/google-drive`, `skills/google-workspace`.
- workers: `workers/gmail-agent`.

### news

41 tracked files; 1 Markdown documents; 10 test files; 1 skill documents.

- packages: `packages/feeds`.
- panels: `panels/news`.
- workers: `workers/news-agent`.

### spectrolite

144 tracked files; 1 Markdown documents; 24 test files; 0 skill documents.

- packages: `packages/mdx-editor-core`.
- panels: `panels/spectrolite`.
