# Test temporary lifecycle inventory (2026-11-25)

Baseline 0cc0a88d2fad1333b3841c8f7f11be34e8d7a74e. Inventory before edits.

* tests/config/playwright.globalSetup.ts creates the run root with mkdtemp and only deletes during teardown; earlier stop errors skip later stages.
* tests/setup/electronSetup.ts creates case profiles under that root, falls back to an unowned os.tmpdir path, and can skip retirement when diagnostic attachment fails. ownDesktop uses a distinct worker/app profile ownership ledger.
* tests/setup/managedServerApp.ts creates a case directory; managedServerLease.ts leases a separate resource-owner process. Its ledger metadata names runRoot; stopRunResourceOwners only waits, rather than forcibly ending live owners.
* tests/setup/ownedXvfb.ts uses plain spawn and therefore has no coordinator-death custody.
* tests/setup/e2eCleanupLedger.ts deliberately retains the entire run root when any fixture lacks a release event, including a killed worker's fixture.
* tests/setup/vitestTempRoot.ts redirects os.tmpdir fixtures into one root, but only its ordinary teardown removes it. vitest.setup.ts propagates it to workers; vitest.sharedConfig.ts installs the setup and userland projects reuse it once.
* 61 test files directly mention tmpdir/mkdtemp; helper and ordinary test fixtures inside the redirected root share its lifetime. Individual tests remain responsible for joining their work; their temporary bytes also require run-level crash custody.
* e2eRootTemplate.ts creates work within the explicit run/case roots. websiteInventionScenario.ts uses the explicit run root. Artifacts in e2eRun.ts are explicit caller-facing outputs and must survive temporary-root cleanup.

Dependency graph: coordinator -> worker -> desktop/managed server -> detached runtime groups -> profile bytes. Existing Ownership joins registered process groups before its own paths, but has no cross-owner dependency join. Merely owning the outer root races independent worker/app reapers on SIGKILL. A process-group scan or recursive all-profile scan would not provide exact durable authority.

Required shared extension: an authenticated parent descriptor identifies one exact ledger token. Child registration is durably acknowledged by the parent's reaper before Ownership.open returns, hence before child resources can publish. Parent retirement seals admission, requests and joins those exact child ownerships concurrently with its groups (avoiding graceful-stop deadlocks), then removes paths. Closed parent admission rejects and retires the unadmitted child. No unrelated ledger is scanned or stopped. Existing plain-file reaper packaging must continue to work.

The run root installs a cooperative trusted descriptor in worker environments; only the worker adapter explicitly transfers whole-process lifetime, and independent owners can opt out with parent:null. The default removes temporary data after all joined owners; explicit keep mode preserves scratch bytes while still retiring resources. No timeouts/TTL or periodic sweeper establish completion. Root/Assembly owns removal of historical /tmp data; this strand never deletes inherited data. Assembly separately repairs composition/raw script scratch creators; production instance-state is Runtime's strand. Model engines do not create these test run roots and are outside this lifecycle mechanism.

## Final mechanism and evidence

Parent control seals new child admission and requests live owners to close their
OwnedScope before acknowledging retirement. A failed scope still propagates its
original error, but independently joined resource data is removed. Test worker
claims explicitly transfer cross-process lifetime; their exact recorded process
is terminated/joined before parent bytes are removed. Same-process/thread claims
are never signalled. In-process work gates, late child rejection, and real
coordinator/worker SIGKILL are conventional regression controls. Reaper-loss
fallback also joins owner work and cannot recreate or overwrite a successor claim.

The inherited authority descriptor is trusted test-host metadata. Native launch
constructs an explicit guest environment (process-adapter isolation/policy.ts
and native-launch.ts); the regression supplies the descriptor in host env and
proves it absent in the guest. Workerd user env is explicitly assembled by
workerdManager.ts forwardDiagnosticEnv/addSharedRuntimeEnv, not inherited from
the supervisor. Until-stop supervisors explicitly use parent:null; their transfer
contract and unrelated-owner exclusions remain exercised by existing tests.

Raw Git preparation in e2eRootTemplate/workspaceTemplateSource/checkpoint is
executed through the same canonical implementation in an owned preparation
process group. Its Git descendants join before deleting the run; the original
source-customization callback remains in its caller and is scope-tracked. Actual
tiny Git clones, commits and canonical Personal/project materialization pass;
a failing callback preserves its original error. No workspace source is copied
to evade identity or authority checks.

Scratch allocation remains the existing record-before-mkdir Ownership.scratch;
the optional directory selects the real temp filesystem and short E2E roots
avoid private bus/socket length regressions. Caller artifact roots stay outside
temporary cleanup. Diagnostic attachment failures cannot skip desktop retirement;
unreleased fixture events record a bounded sample rather than retain a whole
profile. The explicit VIBESTUDIO_KEEP_SCRATCH=1 optout keeps requested bytes while
still joining child resources.

Actual checks (fresh /home/werg/vibe-test-lifecycle-probes; no historical /tmp
paths, models, installs or builds):

* Final Node lifecycle unit vibe-test-parent-lifecycle-20261125e: 10/10 PASS,
  2.76 seconds, 86.7 MiB peak; LOW 0.35 GiB claim / 0.75 GiB hard limit.
* Six-file Vitest unit vibe-test-temp-final-20261125a: 48 PASS / one Windows-only
  skip, 9.31 seconds, 328 MiB peak; LOW 1 GiB claim / 1.5 GiB hard limit.
* Final closing-environment gate unit vibe-test-temp-adapter-final-20261125c:
  4/4 PASS, 1.31 seconds, 141.1 MiB peak; LOW 0.5 GiB claim / 1 GiB hard limit.

Root expressly authorized 5.5 GiB reserve for these small checks. Earlier
7.5-reserve waiters were unadmitted and joined/stopped; no pass claimed for them.
The first broader run exposed three introduced claim/loss regressions; all were
fixed against unchanged existing tests before the passing rerun. Full Host types,
real Electron suites and platform-native Windows execution were not run.

The managed-server resource body explicitly stays under its outer graceful
process-group owner (parent:null), so a sibling dependency release cannot bypass
its canonical until-stop shutdown ordering. The run descriptor itself grants
cooperative scope closure, not blanket worker termination; ownTestWorker alone
opts into the exact cross-process policy. Independent SIGKILL of that managed
resource body and Electron's pre-adoption launch window were not exercised by
these small checks; no broad Electron/managed-server kill qualification is claimed.

Final follow-ups joined: adapter unit vibe-test-temp-adapter-final-20261125d
passed 4/4 after worker-only termination policy (141.5 MiB); E2E prep unit
vibe-test-root-prep-final-20261125c passed real selected-source inspection,
Personal/project clone/commit/materialization and original callback-error
retention (one test, 4.03 seconds, 242.6 MiB). This also covers the selected
template inspection call in electronSetup, not just initial root preparation.
The final static change annotates setup locals without changing runtime behavior.
Across the meaningful suites, 59 distinct tests passed and one Windows-only test
was skipped; overlapping focused reruns are not counted as additional coverage.
