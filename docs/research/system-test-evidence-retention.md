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

Managed execution state has a fresh durable root outside ownership scratch.
Generation build/preparation trees remain owned and removable. Process retirement
still stops and joins every owner. Once stopped, the collector moves the retained
state into its capture tree, which the existing campaign archives with checksums
before removing local captures. A failed move leaves original state recoverable;
a failed stop never moves live SQLite files. Standalone system-test users retain
state under instance-state until it has been archived. Workspace native databases,
blobs, revisions and interrupted records are evidence, not disposable build cache.

Wave 0028's original scratch root was already gone when investigated. The surviving
run metadata and supervisor log were archived additively. Neither an empty receipt
nor a pre-completion restart proves that no provider calls occurred; its inference
count remains unknown.
