# Scenario catalog

The live catalog is the authority:

```bash
pnpm cli system-test list --json
```

Use exact returned names. Counts and categories evolve with the product and
should not be copied into prompts or maintained as parallel prose constants.

## Coverage families

- `smoke`: eval, filesystem, package import, and basic tool health.
- `filesystem`: managed and unmanaged file behavior, directories, metadata,
  handles, and boundary rules.
- `vcs` / `vcs-advanced`: exact events and local applications, complete-chain
  commit, incremental integration, exact-event publication, move/copy identity,
  counteractions, causal/blame walks, honest import boundaries (including mixed
  native-edited and untouched imported spans), freshness, and idempotency.
- `git-interop`: external Git status, credentials, imports, and disposable
  remote publication; this is separate from workspace VCS.
- `panels`, `interaction-surfaces`, `cdp-gad-diagnostics`: panel lifecycle,
  visual/DOM behavior, interaction affordances, and browser diagnostics.
- `workers`, `rpc-communication`, `agentic-runtime`: worker/DO lifecycle,
  services, RPC, state, and agent runtime behavior.
- `build`, `extensions-surface`, `project-lifecycle`: build provenance,
  extension invocation, scaffolding, fork/lifecycle work, and real unit launch.
- `approvals-permissions`, `credentials`, `oauth`, `webhooks`: authority and
  external-integration lifecycles, with synthetic/revoked fixtures.
- `workspace`, `multi-user`, `notifications`: workspace state, identity,
  participants, presence, and notifications.
- `unit-diagnostics`, `server-logs`, `harness-tools`: bounded operational and
  provenance inspection.
- `eval-lifecycle`, `harness-resilience`, `edge-cases`: cancellation,
  persistence, cleanup, transport errors, large results, and recovery.
- `skills`, `docs-discovery`, `docs-probes`: skill discovery and realistic
  goal-driven application of documentation.
- `blobstore`: immutable blobs, ranges, search, and file-tree behavior.
- `deterministic`: exact `@workspace/testkit` suites wrapped into staged runs.

## Escalation order

Run the exact scenario first. After repair, run its category, then smoke. Use a
full suite only when the change is cross-cutting enough that category/smoke
cannot bound the risk. Run `pnpm smoke:full` separately for real remote/mobile
pairing and packaged-client coverage.

## Choosing the right layer

Choose agentic scenarios for discoverability, skill application, tool
selection, multi-step recovery, and agent-facing ergonomics. Choose
deterministic tests for exact state transitions, schema invariants, rendering,
protocol contracts, and low-level failure injection. Pair them when a user
workflow has both an agentic decision boundary and a precise durable outcome.

The live exported test arrays are the only scenario registry. Do not maintain a
second JSON protocol matrix or generate prompt variants from one. Add a small
user-goal `TestCase`, validate its actual invocations and durable effect, and
keep the VCS skill, service schema, and test trajectory in agreement.
