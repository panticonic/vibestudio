---
name: provenance-tuning
description: The recurring procedure for tuning provenance ranking knobs — survey the counters and trajectories, diagnose against the named bets, propose (never apply) with evidence and a rollback trigger, and record decisions as claims.
---

# Provenance Tuning

Provenance ranking has knobs — decay, caps, kind weights, the salience floor,
budgets. None of them were pre-tuned; the design set defaults and left the
tuning to be done **on real logs, by an agent, with a human signing off on
every change**. This skill is that procedure. It is recurring, not a one-off
calibration.

**Cadence is judgment**, not a timer: run it after the first week of real use,
then when a counter drifts or the substrate changes — not on a schedule.

**Nothing here self-applies.** The output is always a proposal a human approves
or rejects, item by item.

## The procedure

### 1. Survey

Read the four behavioral counters (below) from `gad_prov_metrics`, then go
**past** them into the trajectories themselves. Sample real read moments and
trace what the agent did next:

- Did a rendered item get **cited, deepened, or edited-near** afterward? Break
  this down by item kind and rank position — that is the action rate with
  detail the counter alone hides.
- Which **tier** was chosen in which situation, and did `deep` ever surface
  something `moderate` missed?
- Which **suppressed** blocks were then followed by a manual `provenance()`
  call (suppression too aggressive), and which **rendered** blocks were
  followed by nothing, ever (floor too low)?
- Where did recall return a claim the agent plainly needed but ranked **below
  the fold**?

The render trace lives in `gad_prov_render_log` (which handles were pushed);
join it against downstream trajectory activity to compute the action rate.
Query both tables with `gad.query` (read-only CTEs allowed).

### 2. Diagnose against the named bets

Every knob exists to serve a stated behavioral bet (§7). Map each observed
**failure** to the knob that owns it — and **explicitly resist tuning knobs
whose counters look healthy**. The load-bearing mappings:

- **Action rate sagging while blocks still render → the salience floor,
  first.** This is the KPI rule: if the thing we push is being skimmed, raise
  the floor before touching anything else.
- **Tier collapsed to a constant → prompt pressure, not a default.** The tier
  is deliberately un-mapped to situations; a reflexive constant is answered by
  strengthening the prompt's tier guidance, never by silently picking a
  default for the agent.
- **Exploration sweeps flooding density → the sweep-damping knob.** A
  grep-then-read-15-files sweep floods the touch-set with shallow `observed`
  signal; damp the read-only share of the density seed.

### 3. Propose, never apply

The output is a proposal, one row per knob you want to move:

- current value and proposed value,
- the **trajectory evidence** for the change, with **handles** (`claim#…`,
  `commit:…`, `file:…`, `session:…`) so a human can follow it,
- the **expected counter movement**, and
- a **rollback trigger** — the counter reading that says "undo this".

A human approves or rejects each item. Nothing self-applies.

### 4. Record the decision as claims

Approved changes go into memory through the ordinary claim path —
`record_claim` for each decision and `relate_claims` to tie it to the bet it
serves and to the prior tuning decision it supersedes — anchored to the tuning
trajectory. The tuning history thus becomes durable memory in the same ledger
the system serves, and the **next tuning run starts by recalling the last
one's reasoning** (`memory_recall` / `provenance` over the tuning claims).

## The four counters (the tuning inputs)

Stored as counted upserts in `gad_prov_metrics(metric, bucket, count,
updated_at)`:

| # | Counter | The bet it checks | Owns / first-reach knob |
| --- | --- | --- | --- |
| 1 | **Tier distribution** over time and situation | §7.1 — the tier choice is judgment | **prompt pressure** (never a silent default) |
| 2 | **Drill-down / paging rate** | the block is a launchpad, tail is advertised | per-tier item budgets; `K`/`M`/`N` caps |
| 3 | **Claims recorded per session**, split commit-borne vs standalone | §8 — capture rides the commit | claims-capture prompt + commit nudge (not a ranking knob) |
| 4 | **Attached-claim action rate** (the real KPI) | the attachment is read, not skimmed | **salience floor, first** |

Counter #4 is the system's real KPI: how often an item we pushed gets cited,
deepened, or edited-near downstream. If it sags while attachments are being
rendered, the salience floor is too low — raise it before touching anything
else.

## The knobs (defaults live in the C7 tunables block)

Every knob is a named const in **one tunables block** inside the
`provenanceForFile` pipeline in the **gad-store DO** — that block is the single
source of truth for the live values. Read it before proposing; propose against
its current numbers, not the documented defaults below.

| Knob | Documented default | Owning counter |
| --- | --- | --- |
| Session decay λ (turns-ago leg) | `exp(-turnsAgo / 8)` | #4 action rate / #2 drill-down |
| Historical decay λ (per-anchor leg) | `exp(-laterEdits / 16)`, mild + `idf` | #4 action rate |
| Seed cap `K` | 32 | #2 drill-down |
| Fan-out cap `M` | 12 | #2 drill-down |
| Candidate cap `N` | 64 | #2 drill-down |
| Kind weights | edited/asserted `1.0`, relations `0.8`, cited `0.7`, observed `0.5` | #4 action rate |
| Similarity / provenance mix | `w_sim = 1.0`, `w_prov = 1.0` | #4 action rate |
| `hits` curve | `sqrt` | #4 action rate |
| Salience floor | `0.15` | **#4 action rate (KPI rule)** |
| Per-tier item budget | moderate `5`, deep `10` | #2 drill-down |
| `PROV_BUDGET_MS` (attachment latency ceiling) | one standalone budget | degrade-hint rate |
| Warm-set selection | ≤8 likely-next files (recent touch neighborhood + recently edited on head) | warm-cache hit rate |
| Exploration-sweep damping | (off by default) weight a read by whether the session later edits/cites near it, or cap the read-only density share | #4 action rate / density seed |
| Tier mandate | `none` / `moderate` / `deep`, no fixed mapping | **#1 tier distribution → prompt** |

Scope is the **agent read tool only** — never the fs RPC or panel/programmatic
reads (those must not flood the touch-set).

## Guardrails

- **Diagnose before you touch.** A knob whose counter is healthy is left alone.
- **The tier mandate is not a knob you set** — a collapsed distribution is a
  prompt problem, never a default you pick for the agent.
- **The floor is the first lever** whenever the KPI sags.
- **Determinism boundary:** you are tuning the *soft* ranking layer only. The
  native graph (blame, claims, relations) is mechanism-derived and integrity-
  covered — it is not a tuning surface.
