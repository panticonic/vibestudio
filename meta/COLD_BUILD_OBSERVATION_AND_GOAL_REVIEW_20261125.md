# Cold build observation and user-goal review

Before-edit mechanism inventory: sharedBuildCoordinator.ts is the shared SQLite
owner used by builder.ts, preparedWorkspaceSourceCache.ts,
preparedWorkspaceReleaseCache.ts and services/schemaProbeEvidence.ts. Its
constructor previously allocated a filesystem observer even for an uncontended
cold compiler. The prior immutable-receipt optimization covered warm evidence,
but actual terminal repair cases still failed with EMFILE at
build-results/.storage on the cold path. This identifies failed watch admission;
the historical process descriptor limit versus per-user inotify quota remains
unresolved. No kernel setting or unrelated application is changed.

The coordinator now inspects native state before acquiring observation resources.
An uncontended permit is admitted atomically with queue insertion. Only a pending
wait acquires a watcher and process-death observation interval, and the last
waiter's retirement closes them. Passive compiler-priority listeners remain
separate, with demand refreshed before permit admission and on real queue
notifications. Cancellation, cross-process promotion, producer death, original
watch errors and joined cleanup retain their existing semantics. There is no
polling fallback, invented failure deadline, or priority-specific bypass.

Actual final focused verification: 40 tests passed, including cold compilation at
every priority with watch admission unavailable, warm immutable evidence,
cross-process ownership/promotion, late interactive demand, producer death,
cancellation, initialization retirement, and a genuinely pending borrower's
original watch failure. The test does not establish the historical kernel cause.

User-goal review inventory: scripts/lib/observed-content-admission.mjs is consumed
by export-live-workflow-teacher.mjs and reviewed outcome custody tests. Base's
observed-application-outcome helper produces semanticReviewRequired and the
source-bound actual review fields; SST, System, News and read-only Spectrolite
fixtures supply native observations and persisted artifacts. Their closed
function-contract tests are separate. Every registered open user-goal kind now
requires the existing independent meaning review, including effects whose entry
has no requested return value. An optional return is not manufactured as a report
gate. Actual native checks, whole-goal reviews and genuinely requested values
remain required. Read-only Spectrolite uses native observations/hops/receipts;
writable Spectrolite retains the existing stronger source-edit scope binding and
does not enter that read-only path. Registered field projections are exact and
tamper checked; no fixture gold routes or expected prose enter the review input.

Node/browser/Workerd model engines do not implement this Host cache observer or
Host artifact-admission projection. The runtime SDK and training readers are
unchanged by these Host edits. Base/template counterparts ship in the coherent
successor; this branch alone is not a complete production cutover.
