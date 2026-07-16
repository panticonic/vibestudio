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

## Userland Approval Grants

Use the `userlandApproval` service through `requestApproval()` when panel or
worker code owns a policy question that Vibestudio cannot interpret as a built-in
host capability. Examples: a worker exposes a workspace-local service and wants
the user to decide whether a provider-supplied subject may access it, or a panel
has a domain-specific "allow/deny" decision for one of its own resources.

Userland approvals default to scoped host choices: allow once, allow for this
concrete caller session, trust the current source version, or deny. Positive
scoped choices return `choice: "allow"` to userland; deny returns
`choice: "deny"`. Callers can opt into `promptOptions: "choices"` to present
provider-defined buttons such as a simple allow/deny pair.

```ts
{ kind: "choice", choice: "allow" }
{ kind: "dismissed" }
```

Scoped userland grants are stored according to their selected scope. Custom
`choices` grants persist server-side under a flat key:

```text
(verified issuer callerId, provider subject.id)
```

The issuer is read from `ServiceContext` and verified through
`CodeIdentityResolver`; the requester cannot supply or spoof it. The subject is
provider-supplied and validated before reaching the queue. A later request from
the same issuer with the same `subject.id` returns the stored choice without a
new prompt. `revokeApproval(subjectId)` removes that stored decision.

Do not use userland approvals as a substitute for host capabilities. If the
action opens an external browser, stores or uses credentials, writes workspace repo state,
imports a project, or otherwise touches host-managed resources, call the
corresponding runtime API and let the built-in permission flow choose the right
scope and audit model.

## Workspace Main Advances

Protected publication uses a main-aware authorizer. Caller identity identifies
the requester; it does not authorize publication by itself.

`workspace-main-advance` is keyed to the protected workspace main resource. The
host computes the exact changed-ref set and content diff; a content-identical
semantic advance instead shows the exact previous and proposed event IDs.

Generic workspace source changes show their affected repositories and paths.
Unit repos (`apps/*`, `extensions/*`) and `meta` retain their richer unit/config
approval flows. Whole-repository deletion remains a separate severe
`workspace-repo-delete` capability, so a main-advance grant cannot authorize
destructive deletion.
