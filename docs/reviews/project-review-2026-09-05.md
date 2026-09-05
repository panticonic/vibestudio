# Project and workspace review — 2026-09-05

Follow-up: [low-risk dependency remediation](dependency-remediation-2026-09-05.md)
reduces the production findings recorded here from 57 to 4 and also covers
development dependencies. The original audit below remains historical evidence.

This review covered the host checkout and the Base, Google, News, Spectrolite,
and Examples checkouts in `~/vibestudio-release-work`. It combined source review,
conventional tests, real workspace composition, headless agent tests, and native
panel inspection. It is evidence for the areas exercised below, not a claim that
every product workflow, platform, or security boundary has been exhaustively verified.
Existing uncommitted work and untracked design documents were preserved.

## Repairs

| Repository | Commit      | Result                                                                                                                                                                                                                                                |
| ---------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host       | `27d6bba24` | Download destinations are set synchronously in Electron's download callback and reserved across pending approvals and concurrent transfers.                                                                                                           |
| Host       | `bcde85100` | Authority tests assert the current authenticated task binding and concrete plan rather than obsolete call signatures.                                                                                                                                 |
| Host       | `515ae5b74` | Public download operations use their own prepared authority policies. The Downloads page can load without requiring the unrelated browser-import broker relationship. Exact manifest grants remain required; imports retain their broker restriction. |
| Host       | `a56882a98` | Compatible security floors clear both critical audit findings; the lockfile is deduplicated and the patched native socket version is explicit.                                                                                                        |
| Host       | `3f33d7116` | Model setup recognizes SDK base-path overlap without widening credential request scope.                                                                                                                                                               |
| Base       | `24a00c3`   | Bookmarks, history, and downloads share recoverable async state and action handling, responsive layouts, consistent themes, accessible labels, and real confirmation/edit dialogs.                                                                    |
| Google     | `f85342a`   | Gmail tests verify the inherited atomic credential connection/resume and concrete callback configuration; the obsolete second resume step is removed.                                                                                                 |
| News       | `3178722`   | Feed parsing preserves numeric-looking XML strings and plain JSON text, tolerates malformed entries, and discovers a valid alternate when the preferred feed URL is malformed.                                                                        |

The browser management refactor removes duplicated loading/action machinery.
Requests cannot overwrite newer search results; polling waits for completion;
unmounted views discard results; duplicate actions on one record are blocked
without disabling unrelated records. Failed edits keep user input and allow retry.
Background refreshes no longer erase action errors. Empty, loading, error, and
no-search-match states are distinct.

Electron requires `setSavePath` during the `will-download` callback. Waiting for
approval first violated that contract. The fix preserves approval and prevents
multiple pending downloads from selecting the same destination.
[Electron DownloadItem documentation](https://www.electronjs.org/docs/latest/api/download-item/)

JSON Feed allows absent titles and defines `content_text` as plain text. Treating
text as HTML or coercing XML values lost legitimate feed content.
[JSON Feed 1.1 specification](https://www.jsonfeed.org/version/1.1/)

## Native workspace and agent evidence

An isolated managed instance, `review-20260905`, passed doctor before testing.
Exact headless tests passed:

- `browser-panel`: run `st_85dba1d243f74a13b21390835b701ae1`, zero tool failures.
- `fs-write-read`: run `st_2dc23ffdebb74b6296342bf284f5911a`, zero tool failures.

A separate owned ephemeral instance, `review-templates-20260905`, composed all
four optional templates from the local checkouts through the normal template
composer and semantic VCS operations. This included the existing local template
work in progress without committing it to the source repositories. All four
installs and final context merges completed.

Combining a newer installed template with an uncommitted previous integration
produced two template-metadata conflicts. Inspection showed the incoming records
retained the earlier template and added the new one; those exact conflicts were
resolved through normal VCS merge resolution. Subsequent integrations were
committed individually. This observation does not establish a production merge bug.

Bookmarks, history, and downloads were inspected through native panel/CDP APIs
at 390px and 1280px widths. The pages had no horizontal overflow. A populated
bookmark list and its edit dialog were also inspected, including a long title.
This verifies responsive layout, not physical touch, native Android/iOS behavior,
or every desktop operating system's download integration.

## Performance evidence

Native `profileBuild` measurements for Downloads:

| Measurement           |    Before |     After |
| --------------------- | --------: | --------: |
| Initial emitted bytes | 1,145,405 | 1,148,222 |
| Total emitted bytes   | 1,558,171 | 1,560,988 |
| Sealed source bytes   | 2,450,629 | 1,929,385 |
| Cold build            |  4,267 ms |  5,769 ms |
| Verified cache lookup |   15.7 ms |   33.6 ms |

The after run overlapped broad tests and is not a controlled latency comparison.
There is no demonstrated overall startup speedup. The revised page adds 2,817
emitted bytes. Shared theme CSS dominates initial bytes; deleting it without
checking supported theme behavior would be premature. Non-overlapping polling
is verified behavior that bounds outstanding refresh work under slow responses.

## Security and behavior questions for discussion

Opening a completed download currently invokes Electron `shell.openPath` after
checking completion. Depending on OS associations and file type, this can launch
an executable. A blanket executable-file prohibition would break intentional
installer and agent workflows, so none was added. Decide whether the existing
authority approval and OS protections suffice, or whether opening executable
content warrants an explicit, contextual confirmation that still permits it.

During direct review evals, nested browser-data writes could require a separate
user approval because the nested request lacked initiating-task attribution.
Only the exact requests to add and remove the review bookmark were approved.
This is a provenance/approval UX observation to investigate; it does not justify
bypassing the authority layer or granting blanket permissions.

Native OS download execution, physical mobile interaction, real external Google
account operations, push delivery, and every optional template UI were not
end-to-end exercised. Security audit package counts are dependency findings,
not proof of reachable product exploits.

## Dependency review

Compatible dependency refreshes update Ajv and YAML, deduplicate the lockfile,
and raise the existing transitive security-floor policy for protobufjs. The
resolved versions are protobufjs 7.6.6, shell-quote 1.10.0, and websocket-driver
0.7.5. Shell-quote and websocket-driver floors remain within their consumers'
accepted ranges. The mobile TCP socket dependency now names exactly 6.4.1,
matching the existing version-specific native patch. A broad update previously
failed because a caret allowed a version to which that patch would not apply;
the patch adds real native streaming and lifecycle behavior and was preserved.

Production audit findings decreased from 73 (2 critical, 38 high, 26 moderate,
7 low) to 57 (0 critical, 29 high, 20 moderate, 8 low). Deduplication changes
which dependency versions/paths appear in the census, so these counts are not
a count of independently repaired product vulnerabilities.
The remaining package-level findings and exact dependency paths are recorded in
[the audit snapshot](dependency-audit-2026-09-05.json). They remain open; this
review is not a clean security sign-off.

- Shell-quote's critical advisory concerns attacker-controlled object operator
  tokens passed to its quoting API. Its observed dependency path is mobile
  React Native development tooling → launch-editor. A product exploit was not
  demonstrated. The patched release removes the vulnerable dependency version.
  [Maintainer advisory](https://github.com/advisories/GHSA-w7jw-789q-3m8p)
- Websocket-driver arrived through Firebase's database client. Host source
  imports Firebase app and messaging APIs for push; no database usage was found
  in that source search. This reduces the evidence of reachability, but is not
  proof of unreachability. The dependency is patched.
  [Maintainer advisory](https://github.com/advisories/GHSA-xv26-6w52-cph6)
- `image-size` 1.2.1 remains in Metro's mobile asset-processing path. The audit
  reports no patched range for its ICNS and JXL/HEIF infinite-loop findings.
  A malicious source asset is the relevant input to investigate; disabling
  arbitrary asset types was not introduced.
- `extract-zip` 2.0.1 remains under `@puppeteer/browsers`, used by the headless
  browser acquisition path. The audit reports no patched range for its symlink
  traversal finding. Browser archive origin/integrity and extraction isolation
  need explicit follow-up; removing automatic browser provisioning would break
  legitimate unattended operation and was not used as a mitigation.
- Other outstanding findings include older matching/serialization libraries,
  HTTP clients, build tooling, and Firebase dependencies. The snapshot retains
  advisory-specific versions and paths; further dependency modernization and
  reachability analysis are required. No audit findings were suppressed.

Both owned instances were stopped, CLI sessions detached, and the direct
server's process exit and temporary-state deletion were verified. Panel/page
handles were closed in finally paths. No other developer instance was stopped.

## Conventional validation

- Host: final sequential run passed 6,117 tests in 696 files; 17 tests in five
  files were skipped by their existing opt-in conditions.
- Base: the initial full suite passed 4,560 tests in 489 files, with two tests
  skipped. The later run against concurrent SDK work passed 4,571 tests and
  exposed one model-connectability failure; the repaired catalog/settings
  suites then passed all 26 tests. All three TypeScript configurations passed,
  including mobile.
- Mobile: 318 tests passed across 48 suites.
- Optional templates: the combined run covered 361 tests in 60 files. After
  correcting the inherited Gmail credential expectations, its entire 48-test
  suite passed; the other 59 files had already passed. The temporary runner used
  actual composed dependency declarations, original Base source aliases, and
  automatic JSX settings matching the build pipeline.
- Focused regressions include three download destination tests, six browser
  management UI/state tests, six direct download authority method cases, and
  44 feed package tests. Denied or undeclared authority remains denied.

The first broad host run exposed obsolete authority assertions, which were
repaired against the current production contract. A later concurrent run had a
workerd connection reset, a build-fingerprint hook timeout, and a missing shared
browser transport artifact. Inspection and the successful sequential full run
support command interference/transient harness behavior; they do not prove the
connection-reset race cannot recur. No timeout was increased and no assertion
was weakened to hide those failures.

A concurrent model SDK update and dependency-check edit appeared in the shared
checkout during final verification. They were preserved and excluded from this
review's commits. Consequently, final shared-checkout test evidence includes
that concurrent work. Review dependency changes were staged from an isolated
manifest/lockfile projection to avoid absorbing the other work.

## Model setup regression discovered during final verification

The newer catalog includes OpenRouter models using the Anthropic SDK base URL
`https://openrouter.ai/api`. The SDK appends `/v1/messages`, which is within the
existing credential audience `https://openrouter.ai/api/v1`. Quick-connect
eligibility previously treated the SDK base as an actual request URL and hid
setup for these legitimate models.

The eligibility predicate now checks whether the base-path namespace overlaps
the provider audience, in either direction. It uses the existing normalized URL
matching implementation and still rejects unrelated hosts, protocols, ports,
sibling paths, and unresolved templates. Credential creation and actual request
injection retain their existing audience. This is a setup UX correction, not a
wider credential grant. Twelve new eligibility/scope tests and eleven existing
URL-audience tests pass, as do all 26 Base catalog/settings tests.
[OpenRouter messages API](https://openrouter.ai/docs/api/api-reference/anthropic-messages/create-messages?explorer=true)

All host repair commits passed the repository pre-commit checks, including
authority/documentation consistency, host and workerd types, lint, and formatting.
