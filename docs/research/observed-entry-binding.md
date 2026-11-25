# Observed entry binding

The authored teacher wrapper and capture both retain `entry.resultType`, including nonvoid types. The common application exporter must compare that complete declared entry, rather than projecting only the special void type. The 2026-11-25 wave0056 native-pass Print preview draft capture demonstrated the mismatch: all native checks passed but its `OpenProblemOutcome` metadata was rejected.

Inventory: `openOutcomeGoalEvidence` is the common application-entry consumer in `scripts/export-live-workflow-teacher.mjs`; both verifier `proof.entry` and capture `exercise.entry` use that same check. `loadLiveTeacherCases` supplies the immutable authored entry. The system-testing `openGoalOutcomeCode` producer and `captureWorkflow` preserve this metadata; their return-presence repair is a separate producer change. Non-application workflow evidence implementations do not perform this entry projection. Native IR and training readers consume the exported verification and require no schema change.

The regression fixture projects the exact original captured proof, root input/output references and entries, retaining the original compressed capture SHA. It tests metadata admission only; it does not manufacture a new semantic verdict or replay workspace effects. The existing application and client fixtures now reflect the real producer shape. Altered proof or capture return types still fail; actual input and return byte checks remain strict.

Actual validation: 15 Node tests passed under the 1 GiB low-priority ledger unit `vibe-entry-binding-actual-20261125`, including the original capture projection, independent outcome negatives, optional root errors, returned values and mandatory semantic review bindings. No model calls or teacher reruns.
