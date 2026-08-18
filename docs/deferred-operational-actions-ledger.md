# Deferred operational actions ledger

This ledger records operational actions that remain after implementation. The
owner has returned and lifted the temporary deletion hold. Destructive cleanup
is now permitted when its exact target has been verified, while publication,
promotion, and merge remain deferred until the release candidate is complete.

## Safety rule

- Resolve every destructive target exactly before acting; never use a broad root
  or unresolved glob.
- Stop only instances and processes owned by this workstream.
- Do not rewrite, replace, or delete Git refs or published artifacts.
- Do not publish the final Base, registry, or host promotion pointer.
- Do not merge the implementation worktree into the owner's checkout.
- New evidence may refine this ledger, but may not silently execute an entry.

## Deferred actions

| ID  | Exact target or operation                                                                                                     | Why it is deferred                                                                                                                                                                                       | Prerequisites and recovery notes                                                                                                                                                                                                                                                                                                           |
| --- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D01 | Publish the final `vibestudio-workspace-base` commit and immutable release tag (planned successor to the superseded `v0.3.9`) | External Base is still changing while browser privacy/import UX is restored.                                                                                                                             | Base must be clean; all three Base type checks, focused UX tests, and four exact composed-template checks must pass. An immutable new tag is recoverable by publishing a later tag; no force update is permitted.                                                                                                                          |
| D02 | Commit and push the final template-registry revision, then adopt its exact commit/snapshot                                    | Registry publication must point only at final epoch-59 exact dependency releases.                                                                                                                        | Every referenced remote tag and snapshot must be read back and composed successfully. Existing registry refs are not rewritten.                                                                                                                                                                                                            |
| D03 | Update `build-resources/base-template-release.json` from the real publication receipt                                         | The host pointer must not promote an unverified or superseded Base.                                                                                                                                      | Receipt must pass the canonical schema and remote Git readback. The prior pointer remains recoverable in Git history.                                                                                                                                                                                                                      |
| D04 | Stop any managed system-test instance created for final acceptance                                                            | Instance termination is an operational mutation and the owner requested one approval pass.                                                                                                               | Record the unique instance ID and test run IDs before requesting approval. Never target unrelated `system-test` instances.                                                                                                                                                                                                                 |
| D05 | Recreate/remove pre-epoch-59 developer instance state, if final fleet audit still requires it                                 | This is destructive state cleanup; clean-cut formats intentionally have no compatibility reader.                                                                                                         | Enumerate exact instance roots, live ownership, size, and whether the state is reproducible. Never use a broad root or glob.                                                                                                                                                                                                               |
| D06 | Remove generated package/build outputs or derived caches produced during acceptance                                           | Space cleanup is destructive even when artifacts are reproducible.                                                                                                                                       | List exact paths and sizes. Source, semantic workspace state, credentials, and system-test evidence are never cache-cleanup targets.                                                                                                                                                                                                       |
| D07 | Commit the host implementation worktree and merge it into `/home/werg/vibestudio`                                             | The merge changes the owner's primary checkout and must occur only after the complete release proof.                                                                                                     | Inventory both worktrees, preserve unrelated owner changes, record ancestry, commit IDs, and merge result. No host-origin push is planned.                                                                                                                                                                                                 |
| D08 | Remove the implementation worktree or its branch after successful merge                                                       | Destructive cleanup is unnecessary for validation and can wait.                                                                                                                                          | Only after the merged commit is verified in the primary checkout; branch/worktree removal remains separately reviewable.                                                                                                                                                                                                                   |
| D09 | Run the final fresh managed system-test instance against the adopted epoch-59 Base pointer, then stop it                      | The current checked-in pointer still names the superseded epoch-58 `v0.3.8`; a clean host correctly refuses it, while adopting an unpublished local checkout would create a second test-only root route. | Execute only after D01-D03. Use a new unique instance ID, record every run ID, and stop only that owned instance when operational actions are approved.                                                                                                                                                                                    |
| D11 | Validate the fixed mobile bootstrap and trusted workspace RN app on macOS/iOS                                                 | Linux can validate the shared trusted-shell contract and Android build, but it cannot compile or exercise the iOS bootstrap, live bundle activation, and native lifecycle.                               | On controlled macOS/iOS hardware, install the fixed bootstrap, pair through the ordinary WebRTC invite, activate an exact reviewed Base RN bundle, verify direct trusted-shell privacy management, reconnect without retransferring a current bundle, and activate one changed workspace build. No privacy relay/carrier path is retained. |
| D12 | Remove Base worktree `/tmp/vibestudio-desktop-base-g02Zb7`, clone `/tmp/vibestudio-desktop-base-clone-RvgnSd`, and branch `codex-desktop-smoke-base-20260818` after WebRTC acceptance | The owner requested that removals be collected into the final approval block. These isolate desktop smoke coverage from unrelated uncommitted Base changes; the plain clone is required because the Git status adapter does not understand linked-worktree metadata. | Verify both exact checkouts and the branch still point to commit `7c575959912f9b30504a2cb6ed584cce27dc5ce8`; remove only the worktree and clone, then delete only that temporary branch. |
| D13 | Remove isolated Base clone `/tmp/vibestudio-browser-import-base-3iHJgJ/base` after browser-import and agentic acceptance | The owner requested one final approval block for removals. The clone isolates tests from unrelated changes in the shared Base checkout and is still in use by the 51-case agentic campaign. | Managed instance `codex-agentic-current-51-20260818` was stopped and independently verified not running on 2026-08-18; its source and run artifacts were retained. Verify the clone is clean at `71a7a36418a57a1cb3d48dd12f0ca77b05398e36`, then remove only this exact clone. |
| D14 | Remove isolated Base clone `/tmp/vibestudio-mobile-base-7c57595` after mobile WebRTC acceptance | The owner requested one final approval block for removals. The clone isolated the Android smoke from unrelated changes in the shared Base checkout. | Verify the clone is clean at `7c575959912f9b30504a2cb6ed584cce27dc5ce8`, then remove only this exact clone. |
| D15 | Remove read-only template-registry audit clone `/tmp/vibestudio-template-registry-audit-LTb6QM` | The clone established the exact remote registry epoch behind the `templates-install-examples` system-test failure; the owner requested that removals wait for one final block. | Verify the clone remains clean at remote-main commit `0da369c102e4b7c923784ae1d384d3f7234ac87f`, then remove only this exact directory. |
| D16 | Remove read-only Examples-template audit clone `/tmp/vibestudio-template-examples-audit-GRIVJm` | The clone established the promoted Examples v1.2.2 manifest epoch behind the system-test failure; the owner requested that removals wait for one final block. | Verify the clone remains clean at promoted commit `db81be8226413e4ac77cc7cb83550f8232d05f76`, then remove only this exact directory. |
| D17 | Publish epoch-60 releases of every promoted official template and update `vibestudio-template-registry` main to epoch 60 | Base commit `446c016` deliberately raised the workspace ABI for the new Quickfire Durable Object, while the remote registry and its promoted releases remain epoch 59. Strict install validation correctly rejects that combination. | Publish immutable compatible template releases first, verify every manifest, commit, and snapshot, then publish one registry revision that points only at those releases. Do not downgrade Base or bypass exact epoch validation. Rerun `templates-install-examples` only after remote readback succeeds. |
| D18 | Remove epoch-60 release-preparation clones `/tmp/vibestudio-template-google-workspace-epoch60-PFshHTI2`, `/tmp/vibestudio-template-news-epoch60-DC90ZHTJ`, and `/tmp/vibestudio-template-spectrolite-epoch60-FLzR3jHB` | These isolated clones preserve the locally validated official-template release candidates while all removals are held for the final approval block. | First make the detached candidate commits durable through D19 or archive their exact patches. Verify the clones are clean at `5f31aa2b6d1234f2e56f7f6c53da56c5410145a2`, `0633549fe3b253968eaba82b84f729876e90dfc0`, and `026bc75bf00b1860d1a8ae11574b6f002e5a8fc6`; then remove only these three exact directories. |
| D19 | Publish the four locally prepared epoch-60 template commits and immutable tags: Examples `2d8d091d8867d7c030e3951ddde247130b091c56` as `v1.2.3`, Google Workspace `5f31aa2b6d1234f2e56f7f6c53da56c5410145a2` as `v0.2.4`, News `0633549fe3b253968eaba82b84f729876e90dfc0` as `v1.2.4`, and Spectrolite `026bc75bf00b1860d1a8ae11574b6f002e5a8fc6` as `v1.2.4` | The source candidates pass canonical epoch-60 repository validation and compose locally against exact Base commit `7c575959912f9b30504a2cb6ed584cce27dc5ce8`; publishing and tagging are external mutations reserved for the final approval block. | Confirm each destination `main` still descends from the promoted source commit and every proposed tag is still absent. Push each candidate by fast-forward only, create each tag once without force, then independently read back commit and semantic snapshot: Examples `v1-sha256:5ade220367685098c5a95e1f23e691565d90182e1089f6a41d58508cb40f0598`; Google Workspace `v1-sha256:8063b01e0bfb7d0ce16c4933934342e702d7e3d79f0f26433e83b763b57e98e4`; News `v1-sha256:371a540f3089a2b8bbbfc614c6c26bf05a14bb446538602d1deb11f8d91683cf`; Spectrolite `v1-sha256:89a60c322aaa637fe3b3ada70eb79a707d4119b7d1c3c638069c9c7f5a8ce900`. Never replace a tag; recovery is a later patch release. |
| D20 | Fast-forward `vibestudio-template-registry` main with local candidate `5debb3bd3926f642f713af6b1ac638b9e0b3b1f5`, then rerun `templates-install-examples` against remote readback | Registry revision `2026-08-18.1` advances the catalog atomically to epoch 60 and binds all four entries to D19; it must never become visible while any referenced tag is absent. | Complete every D19 publication and exact remote readback first. Revalidate the registry schema at epoch 60, fetch every promoted coordinate through the ordinary exact acquirer, and compose all four closures before a fast-forward-only push. Read back registry commit/snapshot from `refs/heads/main`, provision a fresh isolated system-test instance, and rerun `templates-install-examples`. If promotion is wrong, preserve immutable tags and publish a normal reverting/follow-up registry commit; never force-update main or a release tag. |
| D21 | Remove the now-modified audit clones `/tmp/vibestudio-template-examples-audit-GRIVJm` and `/tmp/vibestudio-template-registry-audit-LTb6QM` under the final cleanup approval | D15-D16 recorded these clones before local release preparation; they now contain the detached Examples candidate and the registry candidate rather than their original read-only tips. | This row supersedes the old-tip cleanup checks in D15-D16. Complete D19-D20 or archive exact patches first, then verify Examples is clean at `2d8d091d8867d7c030e3951ddde247130b091c56` and registry is clean at `5debb3bd3926f642f713af6b1ac638b9e0b3b1f5`; remove only those exact directories. |
| D22 | Remove isolated Base verification clone `/tmp/vibestudio-agentic-23-34-fixed-20260818` after post-promotion agentic reruns | The clone preserves the exact clean Base containing the credential-inspection and automation-service authority fixes while removals remain held for the final approval block. | Managed instances `codex-agentic-23-34-20260818` and `codex-agentic-23-34-fixed-20260818` were both stopped through their owning harness. Verify the clone is clean at `caac10f589b2341edb356b68fb9033f9b5c9423d`, then remove only this exact directory after the epoch-60 registry promotion and required reruns. |

## Completed cleanup and earlier actions

- Epoch-59 contribution patch tags were published under the earlier authorization.
- A derived external-dependency cache was removed to recover disk space after an
  `ENOSPC` failure, before the owner issued this hold. No source or semantic
  workspace state was removed.
- This worktree's generated `release/linux-unpacked` directory was removed after
  explicit approval, before this hold.
- The accidental untracked copy at
  `/home/werg/vibestudio/apps/mobile/host/` was removed after the owner returned
  and explicitly lifted the deletion hold. No tracked primary-worktree file was
  changed; the intended implementation remains in this worktree.
- The obsolete `dev:self:server` launcher and its retired public-surface test
  were deleted after the owner lifted the hold. The supported paths are
  `pnpm dev` against the published Base and the Base-owned Development exact-pair
  workflow.

## Evidence still to collect

- Browser privacy management/export UX equivalence across Electron and mobile.
- Trusted workspace RN privacy-manager journeys on Android and iOS over the
  authenticated paired-shell service; Apple-native build/device validation is
  deferred as D11.
- Aggregate protected-import preview, progress, cancellation, lost-response,
  restart, and receipt replay.
- Single user-facing approval per browser-import intent; observe/cancel must not
  add approval prompts.
- Password capture/update/fill/never-save/re-enable and form-fill
  capture/edit/delete/clear.
- Cookie projection, per-site count/clear, session end, clear-all, and export
  formats.
- Host and Base type checks; focused and integration tests; exact composed
  Google/News/Spectrolite/Examples templates; build/package boundary checks.
- A uniquely named fresh managed system-test acceptance run, stopped through
  the owning harness after its run IDs and evidence are recorded.

## Non-destructive acceptance observations

- On 2026-08-13, invoking the system-test entry point while inspecting its CLI
  attempted two self-provisioned ephemeral `system-test` instances. Both
  terminated through the harness's own failed-bootstrap cleanup and left no
  live process owned by this worktree. Their supervisor log is
  `/home/werg/.config/vibestudio/instance-state/f988326e7530c179/system-test-logs/system-test.log`.
- The current source prerequisites built successfully. Fresh workspace creation
  then acquired the exact checked-in Base pointer (`v0.3.8`, commit
  `edf9506eff02fbbf18b42c8ce05cf9f28b5f5a4a`) and rejected it because its
  `systemEpoch: 58` does not match the clean-cut host ABI `59`. This is the
  intended no-compatibility admission result, and makes D01-D03 a prerequisite
  for the real smoke run rather than a reason to add a local-root fallback.
- The CLI help inspection initially provisioned an instance before returning
  usage. The launcher now handles top-level `-h`/`--help` locally, with a
  focused regression test. `list` continues to require a live instance because
  its catalog belongs to the installed system-test runner; this is intentional
  and is not a reason to reuse an unrelated instance.
- The candidate now requires an explicit application root at every server,
  Electron-development, headless-host, internal-DO, workerd-program, panel
  asset, and Development execution boundary. The host no longer resolves these
  artifacts or Firebase credentials from the process working directory, and it
  no longer falls back to a PATH-provided workerd or a nonfunctional inline
  panel transport. Host/workerd typechecks and the focused root, acquisition,
  headless, panel, push, Development, and workerd suites passed (128 tests in
  the final focused rerun; an earlier superset passed 149 tests).
- The local Base checkpoint adapter now derives its pin from the selected
  sibling's named branch and committed `HEAD`, rejects tracked changes, reports
  untracked exclusions, and seeds the ordinary immutable acquisition cache. It
  no longer applies the published pointer's commit and snapshot to unrelated
  sibling bytes. The acquisition suite passes its unpushed-checkpoint and
  tracked-change rejection proofs.
- The process adapter now resolves its optional Electron peer from its own
  installed package URL rather than the launch directory. Its package build,
  focused tests (2), and the complete build-artifact contract/import/executable
  smoke passed. The Base template public contract also no longer advertises the
  deleted `adopt-bootstrap` operation; its JSON and repository diff checks pass.
- The shared npm installer now requires the sealed application root when
  locating the bundled npm CLI and never searches the launch directory. Its
  focused install, retry, failure-classification, and root-refusal suite passes
  (8 tests).
- The headless-host launcher now accepts only its app-root artifact or an
  explicit absolute operator override; relative overrides are rejected instead
  of being interpreted through the launch directory. Its lifecycle, retry,
  process-tree, and root-contract suite passes (14 tests).
- Panel esbuild jobs now set their owned build directory as the single
  `absWorkingDir`; asset collection, shared-style lookup, and executable-source
  provenance resolve the resulting metadata against that same root. The app,
  extension, vanilla/Svelte framework, shared-style, and bundle-report suites
  pass (14 tests). Their fixtures now inject the host/dependency roots explicitly
  instead of inheriting a prior test's process-global build configuration.
- Electron's native panel adapter now accepts only complete, generation- and
  revision-fenced desired snapshots. The obsolete optional ordering/direct-call
  compatibility semantics and their tests are gone; host/workerd typechecks and
  the ViewManager/service suites pass (86 tests).
- Mobile retains a small fixed native/React Native bootstrap for pairing,
  recovery, bundle verification, and activation. It then runs the Base-owned RN
  app as the sole trusted, privileged, live-editable workspace shell. The
  abandoned privacy relay, secondary trust root, sealed-response protocol, and
  native scanner/manager paths were deleted; the trusted shell uses one direct,
  typed browser-privacy service. Workspace panels continue to render in WebViews,
  but the Base RN shell itself is intentionally trusted rather than contained.
- Desktop browser import and site-data boundaries retain native/parser
  diagnostics only in trusted host logs. Workspace-visible preview warnings,
  failures, tab/source discovery errors, cookie-count failures, and clear-data
  failures use bounded actionable product messages; aggregate counts remain
  available. The focused import/ledger/panel boundary suite passes 29 tests.
  Password and cookie exports use the native save dialog and normalize the
  final file mode to `0600` even when overwriting an existing file; the focused
  privacy presentation/manager suite passes six tests.
- The current Base validates as a dependency-free epoch-59 root with 1,853
  files. The exact host/Base authority boundary is current: 149 reviewed
  capabilities, 58 presentations, 295 RPC methods across 17 Durable Object
  packages, three product seeds, and 23 VCS methods all pass their structural
  gates. Aggregate authority generation remains deferred until the mobile
  contract stops changing, so one deliberate review covers the final schema.
- The host release pointer schema, exact snapshot acquisition, fresh root
  bootstrap, root/contribution manifest rules, and packaged host/userland
  separation pass their focused suite (20 tests). Inspection of the existing
  Electron ASAR confirms that it contains no bundled Base source. The pointer
  still intentionally names the last published epoch-58 Base and is not runtime
  acceptance evidence until D01-D03 are approved.
- A fresh filesystem and Git-index census finds no host `workspace/` or
  `workspace-template/` tree. The only matching directory is the host contract
  package `packages/workspace`, not copied Base source.
- Current-only workspace creation/registration/compensation, descriptor
  admission, root manifest composition, dependency-root enforcement, build
  startup/retention, and exact external-dependency installation pass a combined
  focused suite (109 tests).
- All four official contribution checkouts validate at epoch 59 with exact Base
  dependency declarations and remain correctly non-root-capable: Examples (21
  files), Google Workspace (83), News (41), and Spectrolite (143). Their clean
  published patch-tag checkouts match the held registry draft; the registry
  itself remains one uncommitted file pending D02.
- The external Base passes all three exact semantic-projection typechecks
  (main, integration, and mobile integration) against the current host.
- Static agent API generation no longer constructs the deployment-bound Eval
  service factory, and it omits services with no paired-agent-facing methods.
  The generated reference is current; trusted-shell-only privacy methods are
  not misleadingly advertised to agents.
