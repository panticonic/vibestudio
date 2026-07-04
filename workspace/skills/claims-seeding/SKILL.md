---
name: claims-seeding
description: The one-time distillation pass that seeds the claim base at the bang — sweep docs, design files, and recent history and record initial claims through the normal dedup path.
---

# Claims Seeding

An empty claims table means weeks of thin provenance blocks — and habituation
(§7) is decided in the first days of real use. This skill is the **one-time
distillation pass** that seeds the claim base right after the provenance bang,
so attachments have semantics to show from day one.

**This is a one-time run, not a recurring skill.** It happens post-bang, once
the claim write path exists. Seeded claims are ordinary claims — provenance-
anchored to the seeding trajectory, revisable, retractable — nothing special.

The point is not volume. It is to plant a base of **durable, reusable
judgements** and to **exercise the dedup + FTS index immediately** so both are
warm when normal traffic starts.

## What a claim is

A claim is a past judgement worth recalling — an invariant, an ownership
boundary, a gotcha, or a decision and the reason for it. It can stand as an
**entity**, a **predicate**, or a full **statement** (`claim_kind`), and its
content is either free `text` or a `subject` / `predicate` / `object` triple.

Distill the shape a good commit claim takes, not a changelog: the one-line
insight a future session touching this area should see.

## The pass

### 1. Sweep the sources

Cover the workspace's durable knowledge:

- **`docs/`** — design docs, plans, decision records, handoff/merge notes.
- **Design files** — the architecture and boundary documents (e.g. the host/
  userland boundary, the narrow-host VCS plan, the provenance design itself).
- **Recent history** — trajectory and commit messages worth distilling. Use
  `memory_recall` and `gad.query` over recent commits/messages to surface the
  decisions and gotchas that already happened.

### 2. Distill, don't transcribe

For each source, extract the small number of durable judgements it encodes.
Prefer:

- **Invariants** — "X is always true / X must never happen".
- **Ownership boundaries** — "component A owns X; B must not write it".
- **Gotchas** — the trap someone already hit, stated so the next agent avoids it.
- **Decisions + reasons** — "we chose X over Y because Z".

Skip narrative, status, and anything that is only true today. One claim per
reusable judgement.

### 3. Record through the normal dedup path

Record each claim with the ordinary tool — the same path normal traffic uses,
so FTS dedup and indexing are exercised as you go:

```ts
record_claim({ text: "vcsService must never write trajectory events or ledger entries", kind: "statement" })
// or the triple form:
record_claim({ subject: "gad-store DO", predicate: "owns", object: "all VCS semantics", kind: "statement" })
```

`record_claim` **FTS-dedups on write**. If it returns near-duplicate
candidates, do **not** force a second near-identical node — **revise or relate
the existing one instead**:

```ts
revise_claim({ claimId, patch: { text: "…sharper wording…" } })
// or, when they are genuinely distinct but connected:
relate_claims({ src, relation: "refines", dst })
```

Only pass `force` when you have confirmed the candidate is genuinely a
different claim. Fragmented memory is weaker than one claim that accretes.

### 4. Relate into structure

A flat list of claims has no belief structure for `deep` provenance to expand.
Tie the seed claims together with `relate_claims`, using the relation
vocabulary:

`supports` · `contradicts` · `about` · `refines` · `depends_on`

Relations are **agent-asserted, never auto-detected** — an asserted
`contradicts` is exactly what later surfaces as a `⚠ contradicts` exception
line, so assert them deliberately where two documents genuinely disagree.

## Guardrails

- **Dedup never blocks** — but heed the candidates it returns; the whole value
  of seeding through the normal path is that dedup is exercised.
- **Anchor honestly** — seeded claims carry the seeding trajectory as their
  provenance; they are not privileged and can be revised or retracted like any
  other.
- **Quality over count** — a smaller base of sharp, well-related claims beats a
  large flat dump that buries the signal.
- **Ownership boundary** — claims are written through the agent's normal claim
  tools (which record to the durable ledger and emit `knowledge.*` causality on
  the trajectory log). Never write claim content through `vcsService`.
