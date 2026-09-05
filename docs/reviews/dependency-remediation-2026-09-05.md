# Low-risk dependency remediation — 2026-09-05

This follow-up completes the compatible security updates left open by the
[initial review](project-review-2026-09-05.md). No product permissions, supported
user actions, or approval requirements were changed.

Production audit findings fell from 57 to **4**: three high and one moderate,
with no critical or low findings. The expanded audit including development
dependencies ends at **5**: four high and one moderate, with no critical or low
findings. These are dependency advisory counts, not demonstrated product exploits.
[Exact remaining versions and paths](dependency-audit-low-risk-2026-09-05.json).

## Updated dependencies

- Babel is 7.29.7, diff is 8.0.4, and the host esbuild is 0.28.2. The host and
  workspace edit/diff consumers were reviewed for the changed diff APIs; none
  uses the removed merge API, internal entry points, or custom Diff subclasses.
  Redundant `@types/diff` declarations were removed because diff 8 ships types.
- Compatible transitive updates cover gRPC, glob and brace matching, YAML,
  Browserslist, IP address parsing, editor launch, HTTP request parsing,
  Nano ID, multipart forms, and related utilities.
- The development audit also prompted patch updates to Vitest and its browser
  package to 3.2.7, plus compatible Vite, Rollup, PostCSS, lodash, XML DOM,
  and temporary-file dependency updates. Existing Vitest 3 consumers share the
  patched release rather than mixing browser/runner versions.
- Base's harness and Spectrolite use diff 8.0.4; Base's React tooling uses
  esbuild 0.28.2; News feeds use fast-xml-parser 5.7 or newer. Existing unrelated
  template edits were preserved.

Direct and transitive pnpm updates were issued separately. Mixing direct and
transitive selectors had previously left eligible transitive versions unchanged.
The package manager generated the lockfile; no dependency audit was suppressed.

## Explicit compatibility decisions

Five scoped dependency floors supplement the existing policy where parent
constraints would otherwise retain vulnerable versions:

| Consumer range    | Selected floor | Compatibility evidence                                                                                                                                                                               |
| ----------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| qs 6              | 6.16.0         | Same major API; repairs request parsing without disabling forms or queries.                                                                                                                          |
| fast-xml-parser 4 | 5.7.0          | Version 5 retained the version 4 API and CommonJS exports. Actual Android manifest parsing, launcher activity discovery, and XML text round-trip checks passed.                                      |
| uuid 8–10         | 11.1.1         | The affected Firebase/Google consumers use named `v4()` calls, not changed timestamp-generator state APIs. Version 11 retains CommonJS. Consumer-relative loading and UUID generation were verified. |
| esbuild 0.27      | 0.28.2         | The reviewed change retains build/transform APIs; it adds installer integrity checks and fixes serving/compilation bugs. This also repairs copies under development tools.                           |
| undici 7          | 7.29.1         | Keeps consumers on the same major while repairing pinned copies under local Worker tooling.                                                                                                          |

The installed UUID parent dependencies are Firebase Admin, Google Cloud Storage,
google-gax, gaxios, and teeny-request. Source inspection found named UUID v4
usage in these consumers. React/React DOM versions and the existing native TCP
socket patch were preserved.

Primary compatibility references:

- [diff release notes](https://raw.githubusercontent.com/kpdecker/jsdiff/master/release-notes.md)
- [esbuild 0.28.0](https://github.com/evanw/esbuild/releases/tag/v0.28.0)
  and [0.28.1](https://github.com/evanw/esbuild/releases/tag/v0.28.1)
- [fast-xml-parser changelog](https://raw.githubusercontent.com/NaturalIntelligence/fast-xml-parser/master/CHANGELOG.md)
- [UUID 11.1.1 changelog](https://raw.githubusercontent.com/uuidjs/uuid/v11.1.1/CHANGELOG.md)

## What remains and why

| Package                    | Scope                                                          | Reason it is outside this low-risk pass                                                                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| image-size 1.2.1           | Metro mobile asset processing; two high advisories             | No patched release is listed for the malformed-image infinite loops. Needs a parser repair/replacement or a reviewed execution boundary; arbitrary image formats were not prohibited.                                                                                                                  |
| extract-zip 2.0.1          | Automatic headless browser acquisition; one high advisory      | No patched release is listed for symlink traversal. Needs extraction and artifact-trust review; automatic browser provisioning remains available.                                                                                                                                                      |
| decode-uri-component 0.2.2 | React Navigation → query-string 7; one moderate advisory       | The patched 0.5 package is ESM-only with a default export. The current query parser uses `require('decode-uri-component')` and calls the result as a function. A forced override changes that contract. Upgrade the parent navigation/query stack together; no CommonJS/ESM conversion shim was added. |
| sharp 0.34.5               | Wrangler → Miniflare development dependency; one high advisory | The 0.35 fix changes image-channel limits, AVIF output behavior, native installation, and deprecated options. This needs a coordinated Miniflare compatibility check, not an assumed interchangeable binary replacement.                                                                               |

[Sharp 0.35 changes](https://sharp.pixelplumbing.com/changelog/v0.35.0/)
explain the image-processing compatibility issue.
The executable-download question remains a separate product/design discussion.
The nested task-attribution defect was subsequently repaired; see the follow-up
in the initial review. Neither issue was used to defer ordinary compatible
dependency fixes.

## Commits and conventional verification

| Repository  | Commit      | Change                                                                                                          |
| ----------- | ----------- | --------------------------------------------------------------------------------------------------------------- |
| Host        | `44c45e7d8` | Runtime and development-tool security updates, scoped compatibility floors, and removal of obsolete diff types. |
| Base        | `fc564ea`   | Harness diff and React build tooling.                                                                           |
| News        | `737cd79`   | Feed XML parser.                                                                                                |
| Spectrolite | `d9cbcf4`   | Collaborative diff dependency; existing unrelated package changes excluded.                                     |

Final checks on the updated dependency graph:

- Host: **6,129 passed**, 17 existing opt-in skips.
- Base: **4,572 passed**, two existing skips.
- Mobile: **318 passed** across 48 suites.
- Focused News/Spectrolite checks: **48 passed** (44 feeds, four collaborative diff).
- All three Base TypeScript configurations pass, including mobile integration.
- Host pre-commit checks pass, including host/workerd types, authority and
  documentation consistency, lint, and formatting.

The full suites include 38 external-dependency tests, Git snapshot/diff tests,
library-lowering tests, six agent edit tests, and 19 edit-diff tests. The Android
consumer check uses the actual manifest and verifies its declared `.MainActivity`;
XML text round trips and named UUID v4 calls also pass. A first ad hoc Android
check incorrectly expected `MainActivity` without the manifest's leading dot;
inspection confirmed the consumer correctly preserves the declared activity,
and the check was corrected. No production behavior or existing test was changed
for that mistaken expectation.

Tests were run sequentially around commands that share build outputs. No failing
product tests were hidden by relaxed assertions, larger timeouts, or extra
compatibility shims. Existing untracked documents and template edits remain
outside these commits.

## Native workflow verification and cleanup

The isolated managed instance `lowrisk-deps-20260905-0906` passed doctor,
then passed these exact agentic checks on the final dependency graph:

- `browser-panel`: run `st_a855be3c25924d18a0b9febb1d6cc337`, one passed,
  zero tool failures.
- `fs-write-read`: run `st_85c3a658dea3413fac861e271bf94645`, one passed,
  zero tool failures.

An earlier browser run, `st_f939504d5e37435c8c9ba6f3c731353d`, ended with an
error. The command's cleanup trap stopped its instance before detailed inspection;
the runner's Durable Object was consequently unavailable to inspect. Its root
cause remains unknown. The successful browser rerun used a freshly provisioned
instance with no code, model, prompt, timeout, or permission changes. That pass
verifies the workflow on the new instance; it does not explain the earlier error.

After both successful checks, the exact owned instance was stopped through
`pnpm system-test --instance lowrisk-deps-20260905-0906 stop`. Its temporary
instance directory was verified absent. No other developer instance was stopped.
