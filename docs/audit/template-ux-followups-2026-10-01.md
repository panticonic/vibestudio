# Template UX follow-ups

Follow-up to [the template review](template-user-experience-review-2026-10-01.md), implementing the authorized items 1–5. Detailed game play-testing and design rework are deferred at the user’s request. Google continues to use the existing bring-your-own OAuth app, consent flow and scopes.

## Behavior and ownership

- Spectrolite preserves the current editor and recovery cards when saving or navigation fails. One queue owns file/vault transitions. A candidate vault is prepared before the accepted selection replaces the current binding. Recovery resolves against current live text and removes its card only after the editor accepts the operation. Unsupported serialization propagates its error instead of yielding an editable empty source.
- Document retirement joins the final authored save and in-flight observation, stops listeners, and preserves the original write failure. Authored editor revisions distinguish actual edits from serialization normalization during load; opening or closing an unchanged note does not author a formatting mutation.
- Google setup refreshes actual connection status when focus returns from consent, fences overlapping operations, preserves explicit recovery, and hides completed app prerequisites behind “Change app details.” Account and permission links target their existing owners. Gmail feedback distinguishes failed draft operations from accepted send/discard receipts and fences stale completions after card identity changes.
- News retains rows after failed operations, restores keyboard focus after accepted removal, labels setup fields, and preserves selection by article identity. Reader identity is persisted before bootstrap proceeds. Article actions resolve one literal, unambiguous ID instead of using SQL wildcard patterns; archive search uses literal case-insensitive substrings, including long queries. The feed worker explicitly requests the current host's reviewed network capability for user-selected sources; private destinations remain protected.
- Grimoire and Regency expose first-open recovery. Successful reads clear stale read errors while retaining uncertain write identity until the actual write is acknowledged. Repeated uncertain actions reuse their request ID. Grimoire's programmatic scrolling respects reduced motion.
- Base provides persistent, presentation-only operation feedback with semantic intent, wrapping, live announcements and keyboard-accessible recovery actions. Its chat sandbox exposes that existing shared module. System's adblock browser tests use actual keyboard activation.
- Native keyboard tests found duplicate printable CDP text on key edges plus char events. Printable text now has one owner, the char event. CDP accessible names exclude decorative `aria-hidden` label clones while ordinary text locators retain their rendered text. The runtime creation boundary preserves the original authority of an existing live shared identity instead of attempting to transfer it to a reopening task; the existing creation queue serializes concurrent calls.

## Installed acceptance

Feature-owned suites exercise ordinary first use, accepted state and real renderer reload. They remain with their feature owners rather than being imported into System Testing. News verifies its stable channel/agent identities separately from visit metadata and includes a public deterministic RSS/non-feed fixture so acceptance does not require disabling localhost protection. Use a commit-pinned raw GitHub fixture URL.

```ts
const { runSuites, summarize } = await import("@workspace/testkit");
const { spectroliteJourney } = await import("@workspace-panels/spectrolite/testkit-suite");
scope.result = await runSuites(spectroliteJourney);
return summarize(scope.result);
```

Equivalent exports are `googleSetupJourney` from `@workspace-panels/welcome/testkit-suite`, `newsReaderJourney(feedUrl)` from `@workspace-panels/news/testkit-suite`, and `grimoirePlay` / `regencyPlay` from `@workspace/game-play-tests`. Pass multiple suites as an array. Inspect returned failed/errored totals; successful eval transport is not a passing suite verdict. Resolve ordinary installation and task permission reviews in the owned isolated workspace. Cold-start allowances belong to these acceptance tests, not to production recovery policy.

## Verification boundary

Verification uses an isolated host worktree at published host main `e5c33a06e` and Base main `073a27b` plus these changes, and isolated template source worktrees containing only this tranche. This keeps concurrent, unrelated host and Base schema migrations out of the result. The shared checkout's complete dirty tree is not claimed to pass.

External templates remain source inputs: all dependency installation, builds, tests and compiler state run through host-owned projections. Browser checks cover 320, 390 and 1280 pixel layouts and actual keyboard/focus interactions. Live Google account consent, external email delivery, physical mobile devices and assistive-technology sessions are outside this tranche's verification.

## Acceptance evidence

- Host runtime and immutable task authority: 139 focused tests passed; `pnpm check:commit` passed, including host type checks, lint, formatting and boundary gates.
- Base: 83 CDP worker tests passed after integrating the published native browser APIs; 19 chat sandbox/module contract tests passed.
- Spectrolite: 68 editor, save, navigation, vault and supporting unit tests passed. The installed journey passed, including native keyboard input, durable content, navigation, reopen, actual renderer reload and 320/390/1280 pixel layouts. Final document cleanup no longer reports an unsolicited normalization write.
- Browser acceptance: 25 cases passed across shared feedback, Personal onboarding, System adblock, story first use, Google setup/Gmail composition, News reader and Spectrolite suggestion focus.
- Story recovery hooks: eight tests passed. The installed Grimoire journey passed with actual model conversations, scene generation, simulation progress and reload.
- Google setup: the credential-free installed prerequisite, owner-link, reload and layout journey passed. Browser cases cover connection observation failures and accepted Gmail send/discard receipts without sending external mail.
- Composition type checks passed for Base, Personal, System, Examples, Google Workspace, News and Spectrolite. Template checkout hygiene passed; no compiler/build caches were written into external source checkouts.

News: 36 worker tests passed, including full IDs, ambiguous abbreviations, literal wildcard characters and long queries. Its installed journey passed through non-feed recovery, real ingestion/triage, accepted saving, actual reload with the same reader identities, accepted removal, 320/390/1280 pixel layouts and a long archive query. Regency’s installed run passed discussion/treasury preservation and enactment, then reached the monthly accounting assertion. Its validator incorrectly expected total services to equal the ferry subsidy alone: the engine also pays six crowns for the seeded watch, producing eleven total. The corrected validator checks the accepted five-crown ferry subsidy, eleven-crown total and visible accounting; the existing focused simulation test and composition typecheck passed. Its final installed rerun and deeper game play-testing are deferred at the user’s request. These tests use configured model credentials only in the disposable isolated workspaces; ordinary credential and installation reviews remain in force.
