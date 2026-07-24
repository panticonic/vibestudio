# Authority implementation checklist

Use this checklist for host enforcement and cross-cutting authority changes. The
capabilities skill contains the userland authoring loop; this reference covers the
host review inputs that must remain explicit.

## Add or change a host service method

1. Define a strict schema in `packages/service-schemas`. Reject unknown fields at the
   boundary and keep caller/session/owner identity out of arguments when the host can
   derive it.
2. Declare the receiver contract on the service definition: admitted principal kinds,
   relationship/resource derivation, sensitivity, and effect.
3. Assign the reviewed tier in
   `packages/shared/src/authority/tierTable.ts`. Tier is static method semantics:
   open, gated, or critical. Do not infer it from current callers.
4. Map the method to a semantic capability in
   `packages/shared/src/authority/hostMethodCapabilities.ts`. Several transport
   methods may intentionally share one user decision.
5. For every promptable static host method, add plain-language copy to
   `packages/shared/src/authority/hostCapabilityPresentations.ts`. Write what the
   user allows, not the RPC verb. Use `{requesterKind}` only for the panel, worker,
   app, extension, or agent kind; display identity and immutable authority identity
   are separate fields.
6. Implement the handler without accepting authority facts from arguments. Preserve
   the verified caller and authorization context on downstream calls.
7. Update the explicit receiver-review input in
   `scripts/runtime-authority-review.json`. Its census digest is a drift detector;
   the per-method rationale is the human review. Regenerating derived ledgers is not
   approval.
8. Add tests for admitted and rejected principal/relationship/resource cases,
   malformed schemas, semantic capability grouping, tier/presentation coverage, and
   downstream caller preservation.

Dynamic workspace service copy does not belong in the host presentation census. Put
its stable user-facing `title`, `action`, and `description` in the live workspace
service declaration; live docs and resolution consume that same declaration.

## Add or change an executable workspace unit

1. Put gated/critical direct requests and evaluated-code ceilings in that unit's
   checked-in `package.json#vibestudio.authority`.
2. Build the exact semantic context. The build seals the manifest and dependency
   closure but never writes or approves it.
3. Review the exact effective version: source, transitive dependencies, runtime ABI,
   direct requests, and eval ceilings.
4. Show added human-readable capabilities first. Keep unchanged capabilities
   collapsed and summarize removals. One version decision covers code plus its full
   authority contract.
5. Carry the admitted exact identity into activation. Do not ask again during build,
   startup, or first use.
6. On a fresh workspace, batch all previously unreviewed executable units into one
   progressive-disclosure startup decision rather than one prompt per unit or
   capability.

Static census generation is valid for shipped host methods. Workspace-built services
and intra-workspace capabilities stay context-relative: declare them in the semantic
workspace, discover them through live docs, and resolve them through the live service
registry. Never regenerate a product catalog to approve workspace code.

## Change a mission

Review the entire closure together:

- task specification;
- exact harness source and effective version;
- skill paths and content hashes;
- exact host service exposure;
- userland service bindings and pinned/follow-head policy;
- model and parameters;
- manual, cron, or closed-grammar event trigger;
- eval network policy and exact canonical origins;
- requested permissions; and
- standing restrictions.

Approval mints grants for the exact `mission:<id>@<closureDigest>` subject. Any closure
change requires a new revision. Start only active, digest-consistent missions.
Interruption during seed replacement must leave the mission inert and needing
reapproval; never retain the old active bit while replacing grants.

Standing restrictions are deny grants for the exact mission closure. Reconcile
removed restrictions by revoking their old deny grants, and mint current denies
alongside allows before activating the closure.

## Change a product-seeded mission

Seed files are strict, checked-in reviewed inputs under the host's seed directory.
Resolve `@seed` harness and skill hashes only from immutable product snapshot outputs.
Key reconciliation by the exact product snapshot state and preserve the host/system
owner. On snapshot drift:

1. make the old mission record inert;
2. revoke stale seeded grants;
3. mint the complete new allow/deny set; then
4. mark the exact new closure active.

Do not read mutable workspace source to construct a product seed. Do not add a
compatibility or repair path for old schemas; migrate forward and fail closed on
unknown schemas.

## Change the System Agent

Treat these invariants as one boundary:

- one deterministic conversation per workspace, authenticated user, and immutable
  product snapshot;
- host-derived context, channel, agent key, and exact locked membership;
- product-blessed worker effective version and execution digest;
- product prompt and eval handbook;
- no workspace prompt override, skill injection, or memory recall;
- exactly `eval` and `say` as model-facing tools;
- ordinary typed service/runtime APIs inside eval;
- no non-delegated approval payload or settlement;
- no delegation activation, renewal, or widening from conversation eval;
- no self-blessing, self-grant mutation, or credential extraction; and
- desktop and mobile clients call the same typed lifecycle service.

A missing shell feature is not grounds for a System Agent bypass. Add or improve the
shared semantic service, receiver contract, presentation, and mission exposure so
ordinary clients and the System Agent use the same boundary.

## Verification

Run the narrow deterministic tests first, then:

1. authority manifest and runtime receiver-review checks;
2. host, workerd, userland, and mobile type checks;
3. host and workspace conventional test suites;
4. desktop and mobile approval/lifecycle coverage;
5. WebRTC smoke coverage; and
6. vague model-backed system tests only when model capacity is available.

Model-backed failures are evidence about infrastructure, APIs, or guidance. Do not
make prompts more prescriptive to route around a platform defect, and do not increase
optional eval or model-stream timeouts. Terminal infrastructure failure must settle
the invocation and owning turn.

At tool/service boundaries, preserve structured error data and normalize the
terminal record to `agent-tool-failure.v1`. The original operation failure is
always the primary cause; cleanup, rollback, and transport failures are
secondary evidence. Include exact causal IDs and a typed retry policy when
known. Never make prose parsing, a cleanup throw, or a second error channel the
control-flow contract.
