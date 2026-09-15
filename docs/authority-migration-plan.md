# Authority Migration & Branch Strategy

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. The independent isolation rollout below is superseded; historical branch and migration details remain a record, not current execution instructions.

Status: companion to `capability-model-redesign.md` (item #6 of its spec set). Defines
how the `better-provenance` branch reaches a clean P1 starting point, the pre-release
authority-store cutover, and the rollback story per phase.

## 1. Ground truth (measured 2026-07-21)

- Merge-base with `main`: `d54c7596`. Twelve committed branch commits (VCS control
  plane, identity/account authorization, durable lifecycle, remote/credential unify,
  UI/panels, CLI): **1,046 files, ~85k insertions**. None of these are the new
  authority model.
- The **entire new authority system is uncommitted**: ~85 untracked files (all of
  `packages/rpc/src/authority.ts`, `packages/shared/src/authorization.ts`,
  `serviceAuthority.ts`, `authorityManifest.ts`, `execution/`,
  `authorityRuntime.ts`, `productAuthorityGrants*`, both generated catalogs, both
  generator scripts, golden matrices, `service-schemas/src/authority/`) plus 519
  modified tracked files (`serviceDispatcher.ts`, `capabilityGrantStore.ts`,
  `packages/durable/src/index.ts` (−99 lines incl. guard machinery),
  `browserDataDO.ts` (+468/-…, guard deleted, 50 `@rpc` decls), `builder.ts`,
  and broad `@rpc`/test churn) and 7 deletions (notably
  `packages/shared/src/servicePolicy.ts` + `servicePolicyMatrix` — the old flat
  policy system).
- All redesign-era docs are untracked, including `docs/runtime-foundations/`
  (generated ledgers). The canonical R1–R4 reconciliation is
  `capability-model-redesign.md` §5; there is no parallel runtime-foundations plan.
- Consequence of the uncommitted state: **the legacy guards are byte-identical at the
  merge-base (`d54c7596`) and at HEAD (`dfc8d183`)** — the twelve committed branch
  commits touch none of them. The parity-audit baseline is canonically the
  **merge-base `d54c7596`** (matching the P1 enforcement spec, whose scripts and
  worksheet rows cite that hash); "no git archaeology needed" stands because the same
  bytes are also at HEAD. Record both hashes; the merge-base one is load-bearing for
  P1 reproducibility.

## 2. Disposition of branch content

### KEEP (commit as-is)

- All 12 already-committed branch commits (provenance VCS, identity, durable
  lifecycle, etc.).
- `packages/rpc/src/authority.ts`, `packages/shared/src/authorization.ts` + tests —
  the evaluator is the best-built part; P1 prunes dead constructs (D13) as a visible
  follow-up diff, which is cleaner than pre-editing an uncommitted file.
- `packages/shared/src/execution/` (identity/EV machinery), `serviceAuthority.ts`,
  `authorityManifest.ts`, `serviceDispatcher.ts` changes, `attestDirectRpc` stamping,
  `authorityRuntime.ts`, `capabilityGrantStore.ts` changes.
- All `@rpc({principals, sensitivity})` declarations across service schemas and DOs —
  they are the parity audit's _input_, not its output; committing them does not endorse
  them (enforcement is off until P1 step 2).
- Golden matrices (`__serviceAuthorityMatrix.golden.json`) — audit input.
- Deletion of `servicePolicy.ts`/`servicePolicyMatrix` — the old flat system is
  superseded in either architecture; keep deleted.

### SALVAGE-WITH-REWORK (commit now, rework in-phase)

- `productAuthorityGrantCatalog.generated.ts` + `productAuthorityGrants.ts`: needed at
  runtime today; P2 **freezes** the catalog as the gated-method admission table; P3
  deletes it. Commit with a `FROZEN — see capability-model-redesign.md P2` header
  comment added.
- `scripts/generate-unit-authority-manifests.mjs` and
  `generate-runtime-foundation-ledgers.mjs`: commit, then repurpose (D3) — proposal/
  CI-drift tooling and ledger/docs output only. The request→grant copying is deleted
  in P2.
- Internal-DO `@rpc` declarations: committed as-is, then tightened by the P1 parity
  audit against the HEAD baseline.

### RESTORE-BEFORE-COMMIT (the stop-the-bleeding step)

The uncommitted diff deleted effective legacy guards while the internal DO base's
inbound check is a no-op — the worktree is default-open on internal DOs _right now_.
Before the salvage commit, restore legacy guard enforcement in the small file set where
it was removed: `packages/durable/src/index.ts` (caller-kind lifecycle + inbound guard
path) and each internal DO whose guard hunk was dropped (`browserDataDO.ts`; check
`workspaceDO.ts`, `evalDO.ts`, `webhookStoreDO.ts` the same way:
`git diff HEAD -- <file>` and re-apply the guard hunks from `git show HEAD:<file>`).
The restored guards coexist with the new `@rpc` metadata (metadata is inert until P1).
This is effectively P1 step 0 and removes the only regression-in-place on the branch.

### RETAIN UNTIL D13 LANDS

- `scripts/eval-capability-acquisition.json` is still the explicit reviewed policy
  input consumed by both authority generators. Removing it before the D13 replacement
  exists makes clean builds impossible or forces the generator to infer grants
  silently. Keep it in the P0 baseline; delete it atomically with the acquisition
  fields and request-to-grant generator paths in P2/D13.
- Nothing else: everything under version control is either kept or reworked in-phase
  with visible diffs.

Implementation note (2026-07-21): D13's acquisition replacement is now live. The
obsolete generated product authority catalogs, their request-to-grant generation,
the source-rewriting authority generator role, and
`scripts/eval-capability-acquisition.json` were removed together. Runtime workspace
code admission now intersects the exact sealed manifest with a persisted human
decision for that effective version; generated ledgers remain non-authoritative audit
evidence.

## 3. Commit sequence to the P1 starting point

1. **`docs:` commit** — all untracked docs: `capability-model-redesign.md`,
   `approval-prompt-ux-spec.md`, this plan, `tier-audit-rubric.md`, the SA spec set,
   `log-watcher-spec.md`, `provenance-aware-diff-merge-plan.md`, and
   `docs/runtime-foundations/` ledgers. R1–R4 references resolve to the canonical
   reconciliation in `capability-model-redesign.md` §5. Docs land first so every
   subsequent code commit can cite them.
2. **`fix:` commit** — the RESTORE-BEFORE-COMMIT guard restoration, alone, so the
   security-relevant delta is a clean, reviewable diff.
3. **`feat(authority):` commit(s)** — the KEEP + SALVAGE sets. Split at natural
   seams: types/evaluator; runtime+stores; declarations+matrices; generators+catalogs
   (with FROZEN headers); dispatcher/builder threading. 519 modified files will not
   split perfectly — prioritize isolating the four authority-core commits; the broad
   `@rpc`-churn can land as one declarations commit.
4. Tag the result `authority-p0` — the audited, guard-restored, fully-committed
   baseline P1 builds on.

## 4. Grant & approval cutover (P3)

**This section is controlling for cutover semantics.**

Decision: **clean pre-release replacement**. The SQLite authority store is the first
supported authority-store format. Earlier development-only grant files are not read,
translated, exported, renamed, or retained by the new implementation. A checkout that
adopts P3 starts with an empty authority store and acquires decisions exclusively
through the new subject and resource model.

`CredentialUseGrantStore` remains a separate credential-system domain and is not part
of this replacement.

## 5. Rollback story per phase

Every phase lands as revertible commits on a tag (`authority-p1` … `authority-p4b`).
No runtime feature flags (explicitly rejected stance) — rollback is `git revert` plus,
where storage changed, the rule below:

- **P1** (enforcement + guard deletion): pure code; revert restores guards. The shared
  enforcement module must not change storage.
- **P2** (tiers + catalog freeze): tier table is additive; revert is clean. Catalog
  freeze is a header + codepath removal for open methods; revert restores generated
  admission for open methods (harmless over-granting for the revert window, matching
  pre-P2 behavior).
- **P3** (store consolidation): pre-release state is disposable. Rollback reverts the
  code and removes the development authority database; decisions made in either
  implementation are not translated across the boundary.
- **P4a** (latch): additive facts + gate checks; revert removes gating (degrades to
  P3 semantics, which is today's context semantics — the redesign's stated floor).
  Mission grants/preauth minted during P4a survive a P4a revert **but** their gate
  disappears — therefore the revert script must also suspend mission grants
  (`revokedAt = now`, provenance `p4a-rollback-suspension`) until the latch returns.
- **P4b** (persisted classes): additive provenance columns; revert stops stamping;
  stale classes are ignored by a reverted evaluator.

## 6. Open questions

1. Exact split of the 519-file declarations commit (mechanical; decide at commit
   time).
2. Whether the P3 expiry notice should enumerate the expired permissions (transparency)
   or stay summary-level (recommend: summary + "Details" listing, consistent with the
   prompt spec).
