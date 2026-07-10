# Permissions, Credentials, and Identity

## Tokens authenticate; grants authorize

A runtime token identifies the caller — it never authorizes anything by
itself. Every sensitive action passes a **server-side** permission gate before
it runs. The renderer/panel is only a prompt surface: pending prompts, session
grants, and persistent grants all live host-side, so no userland code can
approve itself.

Grant scopes (shared vocabulary across capability and credential decisions):

- `once` — this operation only, nothing stored
- `session` — same concrete caller until the server process exits
- `version` — same source repo *and* effective version (a code change
  invalidates the grant)
- `repo` — legacy persistent scope; accepted, no longer offered

`version` scope is the interesting one: trust attaches to *reviewed code*, so
an agent editing a unit's source automatically re-triggers consent.

## Three permission surfaces

1. **Capability grants** (`requestCapabilityPermission()`) — host capabilities
   that are not credentials: `external-browser-open`,
   `workspace-repo-write`, etc. Caller identity is resolved via code
   identity; grants are keyed to `(capability, resource.key)`. Never
   hand-rolled per service.
2. **Userland approvals** (`requestApproval()` via the `userlandApproval`
   service) — for policy questions *owned by workspace code* that the host
   cannot interpret (e.g. a worker deciding whether a subject may use its
   service). Issuer identity is host-verified, subjects are
   provider-supplied; stored decisions are keyed `(issuer callerId,
   subject.id)`. Not a substitute for host capabilities — anything touching
   credentials, egress, repo writes, or browser opens must use the built-in
   flow.
3. **Workspace repo writes** — ref-aware authorizers on push. The
   `workspace-repo-write` capability is keyed to the target repo path, so
   approvals are specific to destination repo/ref/change. Unit repos
   (`apps/*`, `extensions/*`) and `meta` get richer elevated flows because
   they cross the trust line (see SYSTEM.md unit kinds).

## The credential system

Credentials are **URL-bound and host-mediated**: the host stores encrypted
material and injects it only on egress that matches an approved audience
(URL pattern). Userland code — panels, workers, agents — composes requests
and receives responses but **never sees secret bytes**.

Key patterns:

- `credentials.store` / `credentials.connect` for direct and OAuth flows
  (including device-code RFC 8628); OAuth refresh is host-owned.
- **Broad upstream, staged local bindings** — one broad upstream grant (e.g.
  a full Google Workspace consent) with narrow local bindings staged per
  audience, each individually approvable. Adding Gmail access later doesn't
  re-run OAuth; it stages a new binding.
- `grantResource` for handing a specific bound resource to a specific unit.
- Git upstream credentials follow the same model — external clone/push goes
  through host-mediated egress with bound credentials
  (`credentials.gitHttp()`), never raw tokens in userland.

## Device and principal identity

Remote clients authenticate in two layers:

- **DeviceCredential** — long-lived, client-held (device id + refresh token);
  created from a one-time **PairingInvite**.
- **PrincipalGrant** — short-lived, scoped to one concrete runtime principal
  (e.g. the react-native app principal).

Shells refresh a `shell` token from their device credential. App-caller
capabilities (e.g. `connection-management` for minting pairing invites) are
declared in the app manifest and checked at the service boundary; denial is
`EACCES`. Remote connectivity itself is one peer-to-peer WebRTC pipe with a
dumb signaling relay — the transport carries the same authenticated RPC and
the same identity layers as local connections (see the `remote-access` skill
for operations).

## Caller kinds and the eval reachability model

Host services declare per-method caller allow-lists (`panel`, `worker`, `do`,
`shell`, `server`, `agent`). Two principles keep this manageable:

- **Eval is the reachability guarantee.** An agent's eval executes in its own
  `EvalDO` as an ordinary `do` principal with a real code identity, so
  everything `do`-callable is agent-reachable — *including*
  capability-gated paths, because the grant/approval pipeline understands
  the EvalDO's identity and can prompt for consent. Adding `agent` to an
  allow-list is purely a UX shortcut for high-frequency calls, never a
  capability expansion.
- **The only `do`-closed services are deliberate user/host surfaces** (auth,
  tokens, host lifecycle, shell approval/presence, push, panel runtime) —
  things no programmatic caller should reach.

Every widening of a service policy is a reviewable diff against a golden
policy matrix.

## Why agents are safe by construction

Putting it together: an agent is a userland caller with (a) a filesystem
scoped to its context folder, (b) no credential material, ever, (c) no write
path to `main` except the build-and-approval-gated push, (d) network egress
only through host-mediated, audience-approved routes, and (e) every sensitive
capability behind a server-side prompt whose grants die with the session or
the code version. The design goal is that you never need to constrain *what
an agent writes* — only what its identity can *do* — so treat the gates as
load-bearing: route actions through the runtime APIs and let the permission
system decide, rather than looking for paths around a denial.
