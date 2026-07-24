# Permissions, credentials, identity, and content provenance

Read [`skills/capabilities/SKILL.md`](../capabilities/SKILL.md) for the authoring
workflow. This document explains the architectural boundary.

## Tokens authenticate; authority authorizes

A runtime token identifies a caller. It grants nothing by itself. Every effect is
evaluated server-side from authenticated principals, the exact executing artifact,
the authority session, live workspace relationships, the concrete resource, and
content lineage. Userland can render a prompt but cannot approve itself.

The principal families are `host`, `user`, `code`, `session`, and `mission`. Runtime
kinds such as panel, worker, Durable Object, shell, extension, and agent are facts used
to derive those principals; they are not authority.

An installed unit's checked-in authority manifest is a request ceiling, not a grant.
Open methods need no grant. Gated methods intersect the sealed request with a grant.
Critical methods require a fresh approval for every exercise and never receive a
standing grant.

Grant durability is explicit:

- `once` applies to one invocation and stores no reusable allow.
- `session` binds to one sealed authority session. Its SQLite row survives a host
  restart and is pruned when that session ends.
- `version` binds to the issuer repository and exact effective/execution version, so a
  source change invalidates it.

All capability and userland decision rows live in the unified authority grant store.
Generated catalogs, inferred code use, builds, and documentation never mint rows.

## Three permission surfaces

1. **Host capability authority** covers host effects such as egress, credentials,
   external browser opens, lifecycle control, and protected publication. Receiver
   contracts declare principals, tier, compositional relationships, and resource
   derivation. Never hand-roll this state in a service.
2. **Userland approval** answers a policy question owned by workspace code. The host
   binds the issuer to the exact calling principal and stores the choice in the same
   authority ledger. It cannot substitute for host capability authority.
3. **Protected-main publication** checks semantic ancestry/integration and authorizes
   the exact main transition. Builds are advisory checks before publication and
   derived projections after it; neither is the publication authority.

## Static host contracts and dynamic workspace contracts

Static reviewed censuses are appropriate for static host/product methods. A changed
host method, tier, receiver requirement, or direct target must produce a reviewed
census diff.

Workspace-built services are different: their declarations come from the exact
caller's live semantic `meta/vibestudio.yml`. Live docs, service resolution, provider
source/effective version, and direct-RPC enforcement use that same declaration set.
A service present in one context may be absent in another. It must never depend on a
startup-generated global workspace census, and automatic doc/catalog generation must
never become automatic authority approval.

Every boundary still enforces independently. Original caller/session facts propagate
through legitimate closure legs; a host or intermediate service must not substitute
its own principal. Receiver-specific ownership guards remain load-bearing alongside
the shared evaluator.

## Eval reachability

An agent's EvalDO is a conduit with exact code identity and the owning authority
session. Evaluated code is bounded by the owning artifact's `evalCeilings`, then by
the session envelope and ordinary grants/fresh approvals. There is no presenter
delegation that creates authority. Infrastructure failures must produce a durable
terminal invocation; timeouts are opt-in and absent by default.

## Credentials

Credentials are URL-bound and host-mediated. Userland composes requests and receives
responses but never receives secret bytes. OAuth refresh, audience matching, and
credential injection remain host-owned. External Git uses the same mediated egress
model (`credentials.gitHttp()`), never raw tokens in workspace code.

## Content integrity

Each agent session has a durable monotone latch: internal content may become external,
never the reverse. Ingestion chokepoints advance the latch before bytes become visible.
File versions and durable channel messages persist the authoring session's class and
outside lineage, so copying or paraphrasing content cannot launder its provenance.

Multiple outside leaf sources are represented by one exact content-addressed
`lineage-set:<sha256>` whose canonical membership is stored and verified by the
host. This is a bounded representation, not a provenance summary: the host can
expand every member for diagnostics and trust decisions, successive ingestion
creates the digest of the exact monotone union, and unknown or nested set
coordinates fail closed.

Session-bound explanation pages are read through
`contextIntegrity.explain`. The receiver derives the session from verified
agent binding, accepts only a set already present in that session, verifies its
content digest, and returns at most 500 exact leaves per opaque cursor. A
directory listing remains an ingestion chokepoint because names are observed
content; aggregation prevents that observation from exhausting the 256-entry
latch representation without pretending the names were not read.

The host resolves persisted file/message classes; callers never supply trusted
`contentClass` or `externalKeys`. Missing or unknown provenance fails toward external.
Standing authority approved before newly ingested outside content cannot be exercised
until the new lineage is reviewed.

## Why agents are safe by construction

An agent has a context-scoped filesystem, no credential material, no unapproved path
to protected main, mediated egress, an exact code/session identity, and receiver-side
checks on every sensitive effect. Content lineage covers what influenced the session
and what the session writes for others. Route actions through the typed runtime APIs
and repair the contract when denied; never add a retry, alternate caller, broad
wildcard, generated-manifest edit, or compatibility path to route around the gate.
