# Interrupted system-test evidence

The same lifecycle spans the CLI start/wait/rerun/status/cancel observers
(`src/cli/systemTestCommands.ts`), profile/artifact store (`systemTestStore.ts`),
managed supervisor (`src/dev/runInstance.ts`), and teacher collector
(`scripts/collect-live-workflow-teacher.mjs`). Native records are supplied by
Base's `vibestudio.natlang.v1` service; durable incremental exchange and native
value recording belong to Base, while the Host retains opaque original bytes.
Training export consumes completed or independently reassessed evidence, never
this retention marker as a success verdict. Other serving engines do not own
these managed VibeStudio instance roots.

The requested artifact directory gets run.json before the start RPC. It includes
the original execution address and stateDir. Failed orchestration, cancellation
and terminal failure observations attempt every requested case plus a paged raw
native record/value snapshot. Running records remain unfinished; an absent
capture leaves inferenceCount unknown. Errors are recorded independently of
original artifacts and do not manufacture full trajectories or passing outcomes.

Managed ephemeral execution state is owned scratch: its workspace copies, SQLite
runtime state, blobs, browser profiles and generated preparation trees retire only
after all owned processes join, including after owner death. Ordinary system tests
do not leave an inactive instance-state generation. Explicit `--persistent` retains
the developer's workspace across restarts.

Only an explicit collector retention request creates a separate capture-evidence
root. `developmentInstanceStorage.ts` selects it; the closed server launch environment
passes `VIBESTUDIO_NATIVE_CAPTURE_EVIDENCE_ROOT` to the workspace. Both Natlang
capture records and retained native-storage bytes use `captureEvidenceForWorkspace`,
partitioned by exact workspace identity. This path is independent of disposable
runtime state. Once stopped, the collector moves these original evidence bytes
into its capture tree, which the campaign archives with checksums before removing
local captures. A failed move leaves only that evidence recoverable; a failed stop
never moves live SQLite files. No whole workspace/build cache is kept as evidence.

Mechanism inventory: `runInstance.ts` owns instance allocation and process retirement;
`developmentInstanceEnvironment.ts` replaces ambient capture-root selection;
`captureEvidenceOwnership.ts` selects both the Natlang store and native snapshots
(`bootstrap/workerd.ts`); `collect-live-workflow-teacher.mjs` and
`lib/live-teacher-retention.mjs` archive joined evidence. `systemTestInstance.ts`
retains its existing leased versus explicit until-stop process contract. Training
readers consume archived captures, not disposable roots, and other serving engines
do not implement these Host-managed instance paths. No archive schema changes.

Wave 0028's original scratch root was already gone when investigated. The surviving
run metadata and supervisor log were archived additively. Neither an empty receipt
nor a pre-completion restart proves that no provider calls occurred; its inference
count remains unknown.
