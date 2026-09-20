# Static checking for declared authority

Status: active scope, 2026-09-21. This replaces the one-cutover runtime redesign
in [holistic-authority-static-checking-plan.md](holistic-authority-static-checking-plan.md).

## Goal

When checked source makes a statically known privileged call, the build should
report a missing authority declaration before that source is published. The
diagnostic should name the call, the required capability, and the declaration
that needs review. A declaration remains a request for authority, never a grant.

Keep the existing RPC transport, native Durable Object SQLite, dynamic service
resolution, and agent eval. Agents can create or discover a service and call it
later without predicting its methods or capabilities at the start of the run.
The runtime receiver remains responsible for admitting those calls. A static
checker cannot prove the future behavior of arbitrary eval source or dynamic
method names, and must not pretend that it can.

## Existing implementation to retain

- Service schemas produce typed client method and argument surfaces through
  `packages/shared/src/typedServiceClient.ts`.
- `src/server/buildV2/authorityFold.ts` checks known host service use against
  the unit's explicit authority requests.
- `userlandAuthorityAnalyzer.ts`, `userlandAuthority.ts`, and the sealed
  `workspaceRpcCatalog.ts` connect known consumer service/method calls to the
  provider's declared method capability. The exact-state dependency index
  invalidates consumers when provider contracts change.
- The authority fold participates in build diagnostics and publication
  validation. Runtime enforcement continues independently through the existing
  service dispatcher and receiver declarations.

These checks were present before the abandoned cutover. The focused
`typecheckFold`, `userlandAuthorityAnalyzer`, and `authorityFold.userland`
tests pass 35/35 on that baseline. Isolated desktop boots from both the clean
worktree and the restored shared checkout reached the System shell and
completed startup. The cutover was preserved in local
`authority-cutover-checkpoint-20260920` branches across the host and Base,
System, and Personal template repositories; it is not part of this design.

The authority review gate now reads manifests and service notability from all
configured template checkouts. Previously it read agent manifests in Base but
only Base's service declarations, so it incorrectly rejected the agents'
`workspace-service:images` request even though System declares `images` with
reviewed notability. The full `check:pair-authority` gate now passes without
removing that agent capability.

Typed-client inference now recognizes literal element access and nested method
paths such as `client["confirmSave"]()` and `client.passwords.list()`. Dynamic
method selection remains a runtime concern. The shipped-unit manifest check
reads all configured templates, and URL construction with `buildPanelLink` is
not treated as navigation: constructing a link does not commit navigation.
The final isolated desktop run reached the System shell and completed startup
with these checker changes.

## Future coverage work

1. Audit checked host and workspace source for statically known operations
   missed by the existing analyzer. Add a finding only where the exact service,
   method, and capability can be derived from the TypeScript program and sealed
   provider catalog. Preserve source locations and package provenance.
2. For a call whose destination or method is genuinely dynamic, report the
   boundary honestly if useful for review, without converting it into a build
   error that prevents agent eval or dynamic RPC. The runtime still checks the
   actual caller, target, method, resource, and current grant.
3. Add one publication-level provider/consumer fixture that combines the
   already tested missing-request and accepted-request diagnostics with a
   provider capability change and consumer recheck. Existing focused tests
   cover these paths separately.
4. Keep desktop startup and a representative agent eval workflow as regression
   checks as checker coverage grows. The checker is not complete if ordinary
   authoring or eval breaks.

No CapTP replacement, SES rollout, engine switch, per-method reference
transport, or complete skill rewrite is required for this goal. Such changes
need their own product justification and bootable acceptance path. Existing
resource controls and runtime authorization are unchanged by this scope reset.
