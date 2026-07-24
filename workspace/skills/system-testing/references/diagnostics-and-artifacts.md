# Diagnostics and artifacts

## Start from the run, not the symptom

The durable run record is the diagnostic authority. A validator reason is one
observation, not a root cause. Correlate it with:

- the original prompt and final agent message;
- every invocation's arguments, status, result, error, and terminal outcome;
- lifecycle/debug events around turn dispatch, suspension, recovery, and close;
- participant/channel identity and test-context provenance;
- cleanup errors and fixture setup/teardown evidence;
- automatic runtime health, build provenance, GAD inspection, and server logs.

Use `inspect` for the bounded packet first. Use `trajectory --full --json` only
for the exact test whose bounded packet is insufficient.

## Concrete mismatch template

For each failure, state:

1. the user-visible goal and expected invariant;
2. the exact action the agent attempted;
3. the observed result/effect and its typed status;
4. the first point where actual behavior diverged;
5. why the evidence classifies the defect as infrastructure, documentation,
   harness, or validator;
6. the repair and the focused/category/smoke verification that proves it.

Do not infer a cause from the final answer when the trajectory shows a tool
failure, stale documentation, cleanup fault, or successful recovery hidden by
the marker.

## Invocation interpretation

An incomplete invocation is a transport or lifecycle defect unless evidence
shows explicit cancellation. A failed invocation may be expected negative-test
evidence, an agent mistake, stale docs, or platform behavior. Inspect the
arguments and terminal outcome before classifying it.

For one failed call, first use
`gad.diagnoseInvocation({ trajectoryId, branchId, invocationId })`. Its bounded
packet joins the exact invocation and turn to terminal events, semantic command
journal rows, effect intents, and receipts. Inspect
`invocation.failed.payload.failure`: `causes[0]` must remain primary and cleanup
or rollback faults must remain secondary. Honor `summary.truncated`; request a
larger bounded section or the full trajectory only when necessary.

A test may pass after an unexpected tool failure. Preserve that failure in the
report and rerun set; recovery does not make the underlying platform path
healthy.

For VCS mutations, inspect the exact working state, `commandId`, target context,
work-unit/application/change identities, resulting event, and publication
receipt. For causal questions, walk command adjacency to the exact trajectory
invocation and use content-coordinate blame edges. A rendered file result or
final marker does not prove semantic correctness.

## Runtime diagnostics

When the bounded test record indicates a runtime problem, inspect the narrowest
authoritative surface:

- explicit build/typecheck diagnostics for context-local compile or type
  failures;
- the publication result for ancestry, integration, authorization, approval,
  or atomic-ref failures;
- post-publication build events for derived projection failures;
- `workspace.units.diagnostics(name)` for running unit state, errors, and logs;
- the agent debug port for an open turn with no completion, tool call, or
  `turn.closed` event;
- joined suspension diagnostics for tool projection/effect mismatches;
- GAD health/integrity inspection for publication, branch, invocation, and
  semantic graph failures;
- `contextIntegrity.explain({ key, cursor, limit })` for verified, paged leaf
  membership when a lineage-set coordinate participates in an authority
  refusal;
- server logs for host dispatch, workerd supervision, reconnect, or startup
  behavior.

Do not infer that a successful publication certifies a build. Correlate each
explicit or post-publication build with its exact semantic event or application
state. When
activation fails, verify the failed artifact remained inactive and the previous
runnable artifact stayed selected.

## Cleanup is behavior

Session close failures, fixture leaks, stale participants, and repository
identities published outside the test's exact fixture ownership fail the run.
They are infrastructure defects even if the capability marker was present.

Capture session state before close, then inspect the normalized execution-level
cleanup errors. The snapshot retains the same raw session cleanup events as
evidence; diagnostic summaries do not count them a second time. A later test that encounters leaked state is
secondary evidence; repair the original lifecycle leak.

## Artifact handling

Artifacts default to:

```text
${XDG_CONFIG_HOME:-~/.config}/vibestudio/system-test-runs/<run-id>/
```

They are intentionally permission-restricted. Full trajectories can contain
credentials, user data, source, or tool payloads. Keep permissions intact and
share bounded redacted evidence, never the raw trajectory by default.
