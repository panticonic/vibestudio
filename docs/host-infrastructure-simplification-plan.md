# Host Infrastructure Simplification — scoped follow-on

Status: **placeholder — scoped, not started.** This artifact exists so that
`host-residency-redesign.md` (§1, H14) refers to a named, reviewable plan rather
than a promise. It becomes a real decision record when the work is picked up;
nothing in it is committed beyond the scope boundary itself.

## Why this plan exists

After the residency plan's P1–P9, an estimated ~130–145k non-test lines remain in
`src/server` + `src/main` + `apps/headless-host`. That remainder is kernel
infrastructure that residency migration cannot touch — code whose H2 residency
reasons are legitimate but whose *size* is its own maintenance, comprehension, and
boot-complexity burden. Raw kernel mass is a goal in its own right (residency plan
§1); this plan is the only lever that reaches it.

## Scope (from the 2026-07-29 audit)

- **`src/server/index.ts`** (~37k top-level lines): decompose into per-family
  bootstrap modules. The residency phases each delete their own wiring blocks; this
  plan finishes the decomposition and retires the god file.
- **`buildV2`** (~11k): reduce to content-addressed artifact contracts; move
  framework specifics (React/Svelte/app-target details) into declarative or
  extension-provided build drivers. The kernel should understand artifact contracts,
  not product frameworks.
- **Workerd manager**: post-P2 it is catalog-driven; audit the remaining bespoke
  paths and dead configuration.
- **Transport stack**: RPC server, streaming relay, and the WebRTC surface —
  consolidation audit.
- **`viewManager`** (~2.5k): audit against the H8 `UnitDriver` contract once panels
  are driver-backed.
- **`vcsHost` / egress / credentials**: simplification only — no boundary or
  authority changes belong in this plan.

## Constraints inherited from the residency plan

The no-façade rule (H6), friction parity (§2 principle 4), the residency import
lint, and the H14 mass ratchets (host-tree, `index.ts`, and builtin-tree line
counts) all continue to apply. This plan owns the mass metrics after the residency
plan's P9.

## Entry criteria

Starts no earlier than the residency plan's P4 — it needs the builtin platform (P2)
and metadata consolidation (P3) landed so infrastructure churn does not race the
migrations.
