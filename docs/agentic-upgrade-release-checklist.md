# Agentic upgrade release checklist

Use this checklist for every host or template release until fleet experience
earns a mechanical gate. Migration notes are living target contracts, not a
versioned script chain.

## Template release

- Does this release change what a composed workspace must look like? If yes,
  add or refresh a note in the template's own `migrations/<template-name>/`
  facet in the same commit.
- Does each note describe the target contract and recognizable old or partial
  shapes instead of a blind step sequence?
- Is each `verify` command/probe runnable in a retained composition context and
  sufficient to prove the contract?
- Is `degraded-ok` honest? It does not authorize the change; it records whether
  ordinary use can safely continue before repair.
- Have obsolete notes been pruned only after considering long-offline forks?
- Was the exact release installed and migrated on a representative workspace
  fork with local or overlapping changes? Were the transcript and verification
  evidence reviewed before promotion?
- Did **Continue upgrade** open the operation's retained repair context, name
  the Templates skill, and present the target release and incoming note titles
  without exposing internal operation or context identifiers?

## Host release

- Does the host change a userland-facing contract (service schemas, runtime
  surfaces, host/userland boundaries, or required workspace structure)? If yes,
  ship or refresh a `migrations/system/` note in the base-template release. If
  no, record the no-migration-needed judgment in the release review.
- Are host-owned database/schema migrations kept in the existing deterministic
  host-plane machinery, separate from userland notes?
- Does `pnpm check:base-template-release` pass, freezing the exact base pin and
  exposing the current system notes as the host release artifact?
- Does the base-template pin correspond to the base release that was rehearsed,
  and does the rehearsal show the host-initiated pull entering the normal
  reviewing/repairing Composer flow?
- If startup initiation is forced to fail once, does the existing notification
  surface explain that retry is automatic, does the bounded retry succeed, and
  does success dismiss the failure without creating another migration queue?
- Is the host-release operation visibly required and non-cancellable while a
  user-initiated template operation remains safely cancellable?
- If normal userland startup or Composer is intentionally affected, has the
  manual rescue runbook been rehearsed on a disposable fork?

Do not promote until every applicable answer is evidenced. Improve a note or
skill when a rehearsal is confusing; do not add a compatibility shim to make a
bad rehearsal pass.
