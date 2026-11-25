# System-test model admission

Inventory before edits, Host 6e4664ae5, frozen V28 selection (2026-11-25).
No provider calls, network probes, or frozen-source edits.

- SST runner.ts492-510 derives case primary/fallback from the run model; explicit
  model disables fallback. runner.ts638-674 installs that route in authenticated
  case policy, and 2914-2950 seeds ordinary Pi agent creation with it.
- Host liveExecutionCaller.ts122-151 refines authenticated execution/context
  policy. agentExecutionSessionRegistry.ts62-110 retains the exact case route.
- runtimeService.ts464-505 seeds new agent configurations but previously preserved
  an explicit child model from DO callers. Base agent-worker-base.ts1470-1535
  supports those deliberate delegation overrides; ordinary delegation inherits
  the current model/fallback. This is a concrete fixed-run-policy escape.
- Base catalog.ts23-26 default is gpt-6.1-sol; profile defaults must not replace a
  test run's configured model. Native product-model-policy.ts128-181 retains the
  original configured model/fallback for generation; it is not a campaign-wide
  allowlist and cannot validate arbitrary helper choices.
- Base ModelGatewayDO.ts181-199 resolves explicit refs or model roles independently.
  packages/natlang/src/models.ts132-136 overrides only the executor role, leaving
  named/frontmatter models intact. runTurn.ts (ModelGatewayDO.ts330-361) invokes
  completeNativeModelHelper with the selected model.
- Pi generation and one-shot helper tasks both use the protected model provider
  and authenticated credentials.resolveNativeModel. Host credentialService.ts938
  verifies active native invocation and exact target, then admits credentials.
  It previously had no check against the caller's case primary/fallback route.
  This is the shared final admission boundary for existing actors, delegated
  actors and gateway helper calls, independent of configuration inheritance.
- Base agent-vessel.ts4470 completeNativeModel accepts a selected model, but no
  production caller of that protected helper exists in Base/System/Personal/
  Examples. No separate automatic title/summary model selection was found there;
  authored NL summaries use their configured runtime, and ordinary Pi generation
  uses the conversation configuration. This is static coverage, not live proof.
- Credential RPC model targets are native-operation bound and errors retain
  causes. Generic egress authorization validates credentials/endpoint authority;
  it does not parse arbitrary HTTP bodies to infer a model. This repair belongs
  at actual native model admission, not a payload-inspecting network shim.
- Standalone Core Node/browser/local-model engines do not receive authenticated
  Host case policy. The campaign's hosted native request route above does. Model
  listing/scoring catalog fixtures that only inspect identities do not generate
  Sol requests and are not rewritten. Separate deployed fixtures only inherit
  this constraint when their authenticated caller carries the case policy;
  unrelated servers/profile actors are outside this run's authority.

Repair: case policy primary/explicit fallback is authoritative at native model
credential preparation; a disabled fallback admits only the primary. New agents,
including delegated DO children, receive case primary. Normal sessions without a
case policy keep ordinary choices. No new model-route flag or parallel policy.

Boundary details: ModelGateway resolves roles/aliases to the catalog entry before
nativeModel(entry) and native-model-provider.ts246-260 submits its provider/id.
The Host constraint compares that actual native target, not an authored alias.
Local model-under-test requests use localModelRuntime.prepareNativeModel
(native-model-provider.ts220-243); host-owned deterministic inference is a
model-free branch (170-187). Neither is a Sol cloud-generation path, so those
product capability boundaries are preserved rather than globally rewriting them.

Verification: actual two-file component suite passed all 169 tests (154 runtime
and 15 native-credential tests), including authenticated generation/helper Sol
refusal, profile-default Sol refusal before credential lookup, configured Luna,
exact declared fallback, unrestricted ordinary sessions, and delegated DO child
creation under Luna. Final unit `vibe-system-test-model-admission-20261125b`
used LOW 1.5 GiB/reserve 7.5 GiB, heap 768 MiB, observed peak 534.9 MiB,
17.27 seconds. Scoped syntax lint (typed mode disabled), formatting and diff
checks passed. Full project type checks and live hosted execution were not run;
no paid/model/network calls were made.

Follow-up custody inventory before edits: explicit-context reserveEntity skipped
onContextCreated entirely (runtimeService.ts880-931), and direct createEntity
activation only ensured semantic state (1162). Thus an actor could lose its case
policy when attached to a new explicit context. Explicit createContext (1401),
cloneContext (2222), subagent context (2524) and semantic fork (2562) already call
the canonical context hook; index.ts4641 registers inherited policy. Registry
inheritTestContext itself used an unchecked map.set, unlike guarded
markTestContext, allowing a conflicting existing context to be relabelled.

Use one case-context admission before reservation/activation/context creation:
fresh contexts inherit before executable publication; existing contexts must
already carry the same case identity, and are refused otherwise. Never relabel an
unrelated existing context. Registry inheritance must use its guarded setter.
Reserve also needs the same default model seeding as create. A DO's deliberate
model/fallback override outside the case route must be rejected honestly, while
trusted runner bootstrap can replace a profile default with the case primary.

Custody follow-up verification: final component suite passed 192/192 tests in
`vibe-system-test-case-custody-20261125b` (562 MiB peak, 15.6 s). Fresh explicit
contexts inherit before preparation/reservation publication; foreign and existing
unscoped contexts are refused; same-case reuse succeeds. Existing keyed
serialization covers the short context admission/materialization boundary so a
concurrent ordinary context cannot be relabelled. Explicit DO model/fallback
changes outside the case route now refuse before code preparation. Syntax lint,
format and diff checks passed. Full typed graph remains unchecked.

This case-only mechanism does not constrain unrelated ambient actors in unscoped
contexts. An owned-instance hosted-model route is still required for the
campaign's stronger no-Sol-in-any-role constraint; no whole-instance assurance is
claimed from the case gate alone.

Owned-instance route inventory before edits: `systemTestInstanceEnvironment`
(src/dev/systemTestInstance.ts60) spreads the trusted launch environment;
runInstance.ts855 passes it through developmentInstanceEnvironment, which starts
with `{...input.parent}`. Public server launchers also inherit that environment.
`owned-deployment-target.mjs` explicitly strips most VIBESTUDIO_* keys and must
preserve the owner route. Its installed package can be older than this Host:
require declared package support before launching under a constraint, rather
than claiming an ignored environment variable is enforcement.

A typed optional VIBESTUDIO_HOSTED_MODEL_ROUTE applies only to this owned Host
process, independent of case context. Credential native admission intersects it
with any case route. Known agent creation defaults inherit its primary, while
DO-authored explicit disallowed choices refuse. Unset keeps ordinary product
choices. Local model-under-test and deterministic branches are unchanged.
The independent review command scripts/review-live-workflow-teacher.mjs65-96
constructs a standalone Node createPiModelBackend for its explicitly chosen
reviewer; it does not acquire a hosted model through this server or case route.

Public remote-deploy is another environment boundary: it writes a systemd unit
instead of inheriting the local shell environment. Preserve the explicit owner
route in that unit and check installed package support before writing/starting
it. This covers local and SSH deployment through their existing shared script.
An older installed release refuses under the constraint; no unsupported target
is launched with a silently ignored variable. The package producer declares
support only for the new implementation.

Owned-instance configuration is exactly:
`VIBESTUDIO_HOSTED_MODEL_ROUTE='{"primary":"openai-codex:gpt-6-luna","fallback":null}'`.
It is parsed and snapshotted in the Host credential/runtime services; malformed
configuration refuses initialization. Hosted native requests in ambient contexts
are refused before credentials when outside that route, even without case policy.
Case and owner constraints intersect. Known agent-channel creation inherits the
owner primary for absent/profile defaults; deliberate DO overrides refuse.
Explicitly selected default/helper targets already resolved elsewhere are never
silently relabelled by the final gate: disallowed canonical requests refuse.

Final verification: 224/224 component tests in
`vibe-owned-hosted-model-route-20261125b` (LOW 1.5 GiB/reserve 7.5 GiB,
heap 768 MiB, peak 583.9 MiB, 17.73 s), plus 3/3 actual Node owned-target tests
in `vibe-owned-target-model-route-20261125a` (159.1 MiB, 1.05 s). These test
ambient generation/helper refusal before credential lookup, owner/case
intersection, default agent model seeding, invalid configuration, managed launch
environment, remote systemd unit propagation/preflight, and unsupported installed
target refusal before allocation/spawn. Source syntax lint, script lint with the
repository's script configuration, formatting and diff checks passed. Full typed
graph/build and live provider execution remain unchecked. No network/model calls.
The old installed 0.1.106 package lacks the feature declaration and must remain a
prerequisite refusal until replaced with a current policy-capable package.
