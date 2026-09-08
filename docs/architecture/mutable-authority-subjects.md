# Mutable authority subjects

An authority subject can retain an identity while its implementation changes. That
continuity is independent of permission scope: a grant can still name one exact
requesting revision, one execution, one operation or an explicitly continuing identity.
The capability grant database owns subject generations, consent and revocation for both
websites and installations. No default approval choices change with this infrastructure.

## Available host infrastructure

`CapabilityGrantStore.createInstallationSubject({ userId, workspaceId })` creates a
random installation handle. The installation owner persists this returned handle with
its own installation record. Calling it again creates a different installation, even
for identical code at the same path. A repository path, repository ID, template URL or
code version is never accepted as proof that two installations are the same.

`registerInstallationExecution` is a host-only admission entrypoint. It requires the
stored subject and current generation, its authenticated user and source workspace,
an exact admitted `code:` principal, a fresh execution ID, the runtime ID, and a live
execution predicate. Its producer must establish that this exact code was admitted to
this installation. It is not an RPC API and must never accept these facts from the
running unit itself. The return value retires that execution; a runtime's previous
registration must retire before another can replace it. Revocation uses the same
`invalidateAuthoritySubject` generation change and consent withdrawal as websites.

The canonical caller resolver looks up this registered evidence against the actual
runtime, exact code principal, authenticated user and workspace on each invocation.
The evaluator keeps the code principal as the authorizing origin and applies its exact
manifest ceiling. A matching installation subject can supply additional consent; it
cannot turn a session, website, different code version or different user into that
installation. Retired executions and stale generations supply no installation grants.
A remembered subject alone does not establish live execution after a host restart.

Installation grants use the ordinary `AuthorityGrant` record and require explicit
scope, current `subjectGeneration` and `sourceWorkspaceId`. A version-scoped
installation grant additionally requires `requestingCodePrincipal`: this is the
requester's authoritative code revision, not a build hash chosen by the page or a
receiver's revision. `providerExecutionDigest` remains an independent receiver
restriction. An explicitly continuing grant may omit the requesting revision; it is
still bounded by the live code manifest, resource, capability contract, generation,
expiry, revocation and other ordinary constraints. Existing code-version grants are
unchanged. Database migration adds a nullable constraint and never widens old consent.

## Deliberately not activated

No production installation lifecycle currently calls this registration entrypoint.
Existing panels, workers and extensions continue to authorize with their existing
exact code-version identities and current acquisition choices. No permission prompt
automatically offers or selects across-updates consent, and existing version grants
are not converted into installation grants.

Before a lifecycle producer activates it, that owner must record creation/adoption,
prove continuity through accepted updates, and invalidate/remove registrations on
uninstall or source replacement. An authority/contract change still requires ordinary
exact admission and matching capability consent. Adopting unrelated source under an
old name is a new installation unless the user explicitly reviews that continuity
transfer. Revocation must not be treated as permission to register old code under a
new generation automatically. These lifecycle semantics cannot be inferred from
current path-based runtime identity.

The integration tests in `installationAuthority.test.ts` exercise the actual store,
host registration, canonical resolver and evaluator: persisted revision grants,
restart without live evidence, new revisions, explicit continuing grants, manifest
confinement, identity mismatch, generation revocation and same-path replacement.
