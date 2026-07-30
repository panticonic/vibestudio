# Permission System

Vibestudio treats runtime tokens as authentication, not authorization. A token
identifies the caller. Sensitive actions must still pass through the server-side
permission system before they run.

## Decision Model

Host-owned credential and capability decisions share the same scope vocabulary:

- `once`: allow this operation only, without storing a grant.
- `session`: allow matching operations for the same concrete caller until the server process exits.
- `version`: allow matching operations for the same source repo and effective version.

The renderer is only a prompt surface. Pending prompts, session grants, and
persistent grants are all held server-side.

## Capability Grants

Use `requestCapabilityPermission()` for host capabilities that are not
credentials. It handles:

- caller identity lookup via `CodeIdentityResolver`
- reusable grant lookup via `CapabilityGrantStore`
- prompt creation via `ApprovalQueue`
- `once` vs persisted grant behavior

Each permission has:

- `capability`: stable permission type, such as `external-browser-open` or
  `workspace-main-advance`
- `resource.key`: stable grant key
- `resource.value`: human-readable UI value

Do not hand-roll this flow in individual services.

## Workspace-owned capabilities

A workspace provider declares resources it owns in
`vibestudio.authority.provides` and binds each protected `@rpc` receiver method to
one local capability. The exact build seals the definition, input contract, and
resource derivation. The host evaluates it through the same acquisition
coordinator, grant store, approval queue, inventory, and audit path used by host
capabilities before provider code runs.

Receiver-object resources bind to the live service object. Prepared state uses a
host-sealed opaque handle: a declared producer returns a bounded selector and
presentation, the host persists their binding, and a declared consumer accepts
the handle at a fixed argument position. Unknown, revoked, cross-workspace,
wrong-definition, wrong-provider, wrong-receiver, and wrong-type handles fail
before method entry. Handles carry no authority and no expiry.

Provider capabilities never substitute for host capabilities. If the receiver
then opens an external browser, uses credentials, publishes protected workspace
state, or performs another host-managed effect, that effect is evaluated
independently.

## Workspace Main Advances

Protected publication uses a main-aware authorizer. Caller identity identifies
the requester; it does not authorize publication by itself.

`workspace-main-advance` is keyed to the exact protected repository ref as
`workspace-source-change:<repoPath>:main`. The host computes the changed-ref set
and content diff before authorization, so a grant for one repository cannot
publish another. A content-identical semantic advance, which has no repository
ref to scope, instead shows the exact previous and proposed workspace event IDs.

Generic workspace source changes show their affected repositories and paths.
Unit repos (`apps/*`, `extensions/*`) and `meta` retain their richer unit/config
review cards, but those cards are projections of the same canonical authority
acquisition—not a second approval queue path. They therefore share the exact
repository resource, test-policy preauthorization, grant store, cancellation,
and structured terminal outcomes. Whole-repository deletion remains a separate severe
`workspace-repo-delete` capability, so a main-advance grant cannot authorize
destructive deletion.

Every static promptable capability must have both reviewed user-facing copy and
a reviewed authority domain/verb. The shared census test covers semantic
capabilities as well as RPC-derived host methods. A partially defined
capability fails closed before presentation; do not replace missing review
metadata with generic transport names or an approval bypass.
