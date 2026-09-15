# Context-Integrity Implementation Spec (P4a / P4b)

> Isolation planning (2026-09-05): [Cross-platform isolation](isolation-plan.md) is canonical for isolation architecture, implementation order and acceptance gates. Provenance requirements remain subordinate detail. Statements below that native shell execution does not exist or that native extensions are fully mediated are obsolete; U4 incorporates those paths.

Status: implementation spec for D8 of `capability-model-redesign.md` (2026-07-21).
Companion prompts: `approval-prompt-ux-spec.md` §5.2–5.4. Vocabulary here is internal
engineering vocabulary; none of it reaches user copy.

Scope: the two-class content lattice (`internal` / `external`), the session latch and
its attestation (P4a), persisted content classes on provenance records (P4b), the vouch
and trust-policy stores, `lineageAtConsent`, and the code-lineage facts consumed by the
invocation snapshot. Non-goals (restated from D8): sub-file granularity, information
flow through model cognition, any claim about content the mediation table does not
cover.

## 1. Lineage keys

One canonical grammar identifies every piece of ingested content. Lineage keys appear
in the latch, the ingestion log, approval prompts, `lineageAtConsent`, and the vouch
store — same string everywhere.

```
LineageKey :=
    web:<registrable-domain>                      -- search/extract/fetch responses
  | api:<provider>:<account?>                     -- integrations (github, gdrive, calendar)
  | mail:<provider>:<messageId>                   -- email
  | repo:<remote-host>/<org>/<name>@<commit>      -- cloned/fetched external git content
  | pkg:<registry>:<name>@<version>#<integrity>   -- installed dependency (lockfile entry)
  | blob:<sha256>                                 -- uploaded/dragged-in content
  | file:<repositoryId>/<fileId>@<changeId>       -- workspace file version (P4b)
  | msg:<channelId>/<messageId>                   -- channel message (P4b)
  | log:<source>                                  -- log streams (panel:<id>, server, build)
  | session:<sessionId>                           -- another session's emitted content
```

Class attaches to keys, not bytes: a key is `external` unless derivation (P4b) or a
vouch says otherwise. Prompt rendering of keys is defined in the prompt spec's
`{source}` slot ("a page from example.com", "the package lodash 4.17.21").

## 2. The chokepoint table (P4a mediation inventory)

This table is the maintained checklist D8 requires. Every row is a real code location
found in the current tree. **Adding an ingestion path without a row here is a review
flag.** Classes: `EXT` = stamps external and latches the session; `DER` = derived class
(P4b lookup; `unknown` → treated as external until P4b lands, see §3.4); `INT` =
internal by construction.

| # | Path | Code location | Content identity (LineageKey) | Class |
|---|------|--------------|-------------------------------|-------|
| 1 | Web search results | `workspace/packages/harness/src/web/{tavily,brave,duckduckgo,exa}.ts` | `web:<domain>` per result consumed | EXT |
| 2 | Web page extract/fetch | `workspace/packages/harness/src/web/extract.ts`, `web-extract.ts` | `web:<domain>` | EXT |
| 3 | External API integrations | `workspace/packages/integrations/src/{github,drive,calendar}.ts` | `api:<provider>` | EXT |
| 4 | Email | `workspace/packages/gmail/src/gmail-client.ts` | `mail:gmail:<messageId>` | EXT |
| 5 | Workspace code egress (fetch from evals/workers) | `src/server/services/egressProxy.ts` | `web:<domain>` — response classing rides the egress result envelope | EXT |
| 6 | Gateway fetch (host-mediated fetch surface) | `src/server/services/gatewayFetchService.ts` | `web:<domain>` | EXT |
| 7 | External git remotes: clone/fetch/import | `src/server/services/gitInteropService.ts` | `repo:<host>/<org>/<name>@<commit>` covering the fetched tree | EXT |
| 8 | Dependency install | `src/server/buildV2/externalDeps.ts` (+ `distBake.ts`) | `pkg:<registry>:<name>@<version>#<integrity>` | EXT |
| 9 | File upload / drag-in | `src/server/services/blobstoreService.ts` (`putBlob/putFile/putTree`) | `blob:<sha256>` (already content-addressed) | EXT |
| 10 | Browser page content via CDP | `src/server/services/panelCdpService.ts`, `workspace/packages/{cdp-client,browser-data}` | `web:<domain>` of the page | EXT |
| 11 | Panel/page console logs | `src/server/services/panelLogService.ts` | `log:panel:<panelId>` | EXT |
| 12 | Server/build logs | `src/server/services/serverLogStore.ts` (console interceptor), `serverLogService.ts` | `log:server`, `log:build` | EXT¹ |
| 13 | Workspace file reads (agent read tool) | `workspace/packages/harness/src/tools/read.ts` → fs service | `file:<repo>/<file>@<change>` for internal files; persisted upstream keys for external files | DER |
| 14 | Workspace file reads (eval/worker via fs service) | `packages/shared/src/fsService.ts` / `src/server/services/fsServiceDef.ts` | Exact internal `file:…` key or persisted upstream external keys | DER |
| 15 | Skill index + AGENTS.md at session start | `workspace/packages/harness/src/resource-loader.ts` | `file:…` per SKILL.md / AGENTS.md | DER |
| 16 | Channel messages into agent context | `workspace/packages/agentic-core/src/{agent-subscription-config,channel-chat-merge}.ts` | `msg:<channel>/<messageId>` | DER (P4b; `session:<senderSessionId>` fallback in P4a) |
| 17 | Cross-session content (forwarded cards, quoted output) | pubsub / feeds surfaces | `session:<sessionId>` — sender's latch class at send time | DER |
| 18 | Grep tool (reads file contents directly via `fs.readFile`, bypasses row 13) | `workspace/packages/harness/src/tools/grep.ts` (~L459) | Internal `file:…` keys or deduplicated upstream external keys for matching files | DER |
| 19 | Find / ls (filenames into context — names themselves can carry instructions) | `workspace/packages/harness/src/tools/{find,ls}.ts` | Internal `file:…` keys or deduplicated upstream external keys for the enclosing tree read | DER² |
| 20 | Memory recall (past chat messages + committed file content into context) | `workspace/packages/agentic-do/src/agent-vessel.ts` (`createMemoryRecallTool`, ~L1616-1660) | `msg:…` / `file:…` per recalled item (P4b); `session:<authorSessionId>` fallback in P4a | DER |
| 21 | Participant-advertised method descriptions/schemas becoming model tools | `workspace/packages/agentic-do/src/agent-vessel.ts` (roster→tool schemas, ~L1465-1480) | `session:<advertiserSessionId>` — advertiser's latch class | DER |
| 22 | Channel-call / tool-result hydration (participant results returned to the model) | `workspace/packages/agentic-do/src/agent-vessel.ts` (`hydrateTransportValue` on `invocation.completed`, ~L3009) | `session:<responderSessionId>` — responder's latch class at completion | DER |

¹ Server logs are external per the log-watcher design (log content can embed untrusted
input); build logs of internal-only compiles are still EXT in v1 — cheap, safe, and
they rarely enter privileged contexts.

² Filenames are content: a listing of an un-vouched cloned repo carries its (possibly
hostile) names into context, so find/ls ingest lineage like any read. For internal
content the exact file-version key remains the floor. For externally derived files,
the semantic work unit's persisted upstream keys are retained and deduplicated:
reading 5,000 files from one cloned repository is one outside source, not 5,000
synthetic sources. Name-vs-body remains below the tracking floor (we record that the
source-backed tree was read, not which bytes steered the model).

Rows 20–22 share one principle: **content that re-enters context through an indirect
surface keeps the class it had at its origin** — recall, advertisement, and result
hydration are transports, not laundries. In P4a, rows 20–22 resolve through the
originating session's class (`session:` keys); P4b upgrades rows 18–20 to precise
`file:`/`msg:` lookups.

**Paths checked and found NOT to be ingestion chokepoints:** `file-transfer.ts` /
`write.ts` / `edit.ts` (write-side — stamping duty, §6.1, not ingestion);
`credentialCaptureBridge.ts` (credentials are out-of-band, never context content);
model outputs (excluded by D8 non-claims — the session latch already covers them);
**terminal panels** (`terminal-host-protocol` / `terminal-shim` are a workerd runtime
for Ink terminal-UI apps — a rendering environment, not an OS shell; there is no
shell-command execution surface in the product, agent-facing or otherwise, and
terminal-app network access rides the ordinary host bindings → rows 5/6. If a real
host-shell tool is ever added, it must register a chokepoint row here first — the
standing review flag covers it).

### 2.1 Honest gaps found by this survey

1. **Egress-through-code laundering window (P4a-only).** Between P4a and P4b, an eval
   that fetches (row 5, latches its own session) and writes a file leaves no persisted
   class on the file; a *different* session reading it sees `unknown`→external only
   because of the §3.4 default. The default closes the hole conservatively; P4b closes
   it precisely.
2. **Extension host surfaces.** Extensions reach content through the same fs/egress
   services (rows 5/14) — no separate hole found, but the parity audit (P1) should
   confirm no extension-private ingestion RPC exists.

## 3. P4a: the session latch

### 3.1 Latch state

Owned by the harness session (PiRunner state), persisted with the session so restarts
don't amnesty taint:

```ts
interface ContextIntegrityLatch {
  class: "internal" | "external";      // monotone: internal → external only
  latchEpoch: number;                   // increments each time a NEW lineage key arrives
  sources: LineageEntry[];              // the ingestion log, §3.2
}
interface LineageEntry {
  key: string;                          // LineageKey
  class: "internal" | "external";
  firstSeen: string;                    // ISO time
  via: string;                          // chokepoint row id, e.g. "web-extract"
  count: number;                        // repeat ingestions collapse into count
}
```

### 3.2 Ingestion log bounding

`sources` is keyed by LineageKey and bounded to **256 distinct keys** in latch state;
repeat ingestions increment `count`. On overflow, the oldest *internal* entries drop
first (external entries are never dropped from state — they are the consent-relevant
set; 256 distinct external lineages in one session is a pathological session and may
simply refuse further ingestion until compaction). The *complete* unbounded record is
not duplicated: every tool invocation already lands in the canonical trajectory log,
and the latch entry stores `via` + timestamps sufficient to point back at it. The
in-state log is a bounded index, the trajectory is the archive.

### 3.3 Attestation on outbound calls

`AuthorizationContext` (packages/rpc/src/authority.ts) gains:

```ts
contextIntegrity: {
  class: "internal" | "external" | "not-applicable";
  latchEpoch: number;
  externalKeys: string[];   // ALL external LineageKeys, order = firstSeen; bounded per §3.2
} | null
```

- Stamped by the harness on every call it originates or relays for its evals. The host
  trusts it iff the mediating harness digest is conduit-blessed (D10); calls from an
  unblessed harness get `class: "external"` imposed host-side (fail closed).
- The attestation covers **harness-local ingestion only** (rows 1–4, 13–22 — content
  the harness itself pulled into context). Server-mediated ingestion (rows 5–12) is
  tracked server-side and joined at evaluation time per §3.5 — authority evaluation
  takes the **max** of the server latch record and the attested latch.
- `not-applicable` is for non-model callers (installed units, host): the cognition
  channel does not apply to them; their controls are code-lineage (§7) and tiers.
- The evaluator's `context-integrity` relationship (D8 gate) checks
  `externalKeys ⊆ internal ∪ grant.lineageAtConsent` (§6.1). Lineage drift between
  prompt and retry is adjudicated **by this use-time gate, not by the invocation
  digest**: the acquisition spec deliberately excludes `contextLineage` from the
  digest so a retry after the same prompt hashes identically; if new external keys
  arrived in the meantime, the gate fails ⊆ and the call re-prompts with the new
  source visible. (`latchEpoch` is bookkeeping for logs and prompts — it has no
  evaluator or CAS role.)

### 3.4 The `unknown` default (P4a interim)

Until P4b, derived rows (13–17) have no persisted class. P4a rule: reads of workspace
content resolve to `internal` **iff grandfathered (§8) or vouched**, else the key
enters as `external`. This over-taints fresh agent-written files during the interim;
that is the intended conservative direction (D8 fail-aggressive = prompts, not
lockout), and P4b replaces it with computed classes.

### 3.5 Latch-update ordering (the fetch-then-act contract)

The model depends on one happens-before rule, stated here as a contract rather than an
assumption:

> **For server-mediated ingestion (rows 5–12), the server-side latch record for the
> owning session is durably advanced *before* the external response bytes become
> visible to the caller.** No gated call issued after code has observed external
> content can be evaluated against a latch that predates that content.

Mechanics:

- The server keeps its own per-session latch record (`serverLatch`), updated
  synchronously inside the chokepoint handler (egressProxy, gatewayFetch, gitInterop,
  install, blobstore, CDP, log reads) **before** the handler returns the response.
  Same process, single writer, sequenced ahead of the response — the ordering is
  structural, not best-effort.
- Because the same server evaluates every subsequent gated call, a fetch-then-act race
  is impossible by construction: the acting call cannot reach `evaluateAuthority`
  before the ingesting call's handler returned, and the handler updated `serverLatch`
  first.
- The harness attestation (§3.3) is additive, covering harness-local ingestion the
  server never saw. At evaluation time the effective latch is
  `max(serverLatch(sessionId), attestation.contextIntegrity)` — classes join to the
  worse one, external key sets union. A harness that under-reports (buggy or unblessed)
  cannot launder server-observed ingestion; an unblessed harness is additionally
  floored to external per §3.3.
- Eval relays: the eval's session identity rides every gateway call (acquisition spec),
  so `serverLatch` keys on the same sessionId the evaluator sees — an eval that
  fetches through row 5 advances the latch that gates its own next call.

## 4. (Removed) There is no shell gap

An earlier draft claimed terminal/shell output as an unmediated ingestion path and
designed a `networkCapable` command classifier for it. That was wrong: the product has
no OS-shell execution surface (see §2's not-a-chokepoint list — the terminal packages
are an Ink TUI runtime inside workerd, whose egress rides the existing chokepoints).
The section number is retained so cross-references stay stable. The durable rule that
survives from it: **any future feature that executes host commands or otherwise reaches
the network outside rows 5–8 must add a chokepoint row and a classification design
before it ships** — that requirement is part of the D8 mediation-inventory review flag.

## 5. Vouch store and trust policies

Host-owned SQLite (`governance/content-trust.db`), hub-writable, children read-only —
same topology as the identity DB.

```sql
CREATE TABLE vouches (
  id            TEXT PRIMARY KEY,          -- vch_<rand>
  subject_kind  TEXT NOT NULL
                CHECK (subject_kind IN ('repo','pkg','blob','file')),
  subject_key   TEXT NOT NULL,             -- exact LineageKey (digest/version-bound)
  decided_by    TEXT NOT NULL,             -- userId (human only; enforced at service)
  decided_at    TEXT NOT NULL,
  via_prompt    TEXT,                      -- card instance id (trust.content)
  revoked_at    TEXT,
  UNIQUE (subject_kind, subject_key)
);
CREATE TABLE trust_policies (               -- name-level; critical ceremony (D8)
  id            TEXT PRIMARY KEY,          -- tpol_<rand>
  pattern_kind  TEXT NOT NULL,             -- 'pkg-name' | 'repo-remote'
  pattern_key   TEXT NOT NULL,             -- 'pkg:npm:lodash' | 'repo:github.com/org/name'
  decided_by    TEXT NOT NULL,
  decided_at    TEXT NOT NULL,
  ceremony      TEXT NOT NULL,             -- serialized confirmation record (checkbox, card id)
  revoked_at    TEXT,
  UNIQUE (pattern_kind, pattern_key)
);
```

**Only content-addressed key kinds are vouchable** — `repo:…@commit`, `pkg:…#integrity`,
`blob:<sha256>`, `file:…@changeId` — enforced by the store CHECK above and the service.
`web:` / `api:` / `mail:` / `log:` / `session:` keys are **never vouchable**: a domain or
provider key has no version to bind, so "vouching" one would silently be a trust decision
over all future content from that source — exactly the pattern-over-future-content
semantics D8 reserves for trust policies, which deliberately exist only for `pkg-name`
and `repo-remote`. The consent surface for non-vouchable sources is `lineageAtConsent`
on individual grants (§6.1), which expires with the grant instead of durably
reclassifying the source.

Resolution order for a key: exact vouch → matching un-revoked trust policy → class
from derivation/stamp. Vouches are attributed and listed in the Trust inspector;
revocation flips future resolution only (no retroactive re-taint of closed sessions —
the governance log records the window). Writes go through a `contentTrust` host
service: user/host principals only, vouch = gated + human-only, policy = critical, per
D8's classification.

## 6. Grant-side integration

### 6.1 `lineageAtConsent`

On `AuthorityGrant.constraints`:

```ts
lineageAtConsent?: string[]   // LineageKeys shown on the approval card when consented
```

Populated from the invocation snapshot's `externalKeys` at mint time for session-rule
**and once** grants (the card showed the same sources either way; a once-approval given
with taint visible must be consumable under exactly that taint, or approving it would
be meaningless); **always absent (empty) for mission/standing grants** (D8: standing
authority never pre-consents to taint). Evaluator check per §3.3. Prompt spec §5.2
renders the same keys the constraint will store — WYSIWYG consent.

**Consent is source-scoped, stated honestly.** A LineageKey identifies a *source* at
the granularity the latch tracks — `web:example.com` is the domain, not one page;
`api:github` is the provider, not one object; `log:server` is the stream, not one
line. `lineageAtConsent` therefore covers **the sources shown**, exactly as the prompt
copy says ("This task has read outside content: a page from example.com"): later
content from an already-consented source does not re-prompt; a **new source** does.
This matches the prompt spec's scope table (network trust is origin-shaped) and is the
deliberate legibility/granularity trade — per-page consent keys would turn every
research session into a prompt storm. The corollary is stated rather than hidden: for
source-keyed content, consent and vouching are decisions about the *source relationship*,
not about specific bytes; byte-exact trust exists only for the content-addressed kinds
(§5).

### 6.2 Invocation snapshot fields

The snapshot (acquisition spec) carries `contextIntegrity` verbatim (class, epoch,
externalKeys) plus the code-lineage facts of §7 — **as facts, not digest input**. The
acquisition spec is authoritative here: `contextLineage` is display/consent-only and
excluded from the invocation digest (only the code-lineage *class* participates), so a
latch change between prompt and retry is the **same** invocation. What changed context
means for authority is decided at use time by the §3.3 gate, never by digest mismatch.

## 7. Code lineage (execution channel)

- **Eval snippet:** inherits the generating session's latch class *at spawn*, recorded
  on the eval's run record: `codeLineage: {class, externalKeys}`. Persisted — a snippet
  generated under taint stays external-lineage even if re-run later from a clean
  session.
- **Installed unit:** at build, the builder queries (P4b) the max class over the
  unit's source closure file versions → `sourceLineageClass` sealed in artifact
  metadata; `unknown` (pre-P4b) builds as external-lineage unless all sources are
  grandfathered/vouched. Consumed by SA1 severity (external floors at sensitive) and
  the D8 issuance rule (standing grants only to internal-or-vouched code; D12 install
  requires the vouch step).

## 8. Grandfathering migration (cutover)

One-shot at P4a enablement: every file version, blob, and channel message existing at
cutover resolves as `internal` via a recorded `grandfather` marker (a synthetic vouch
row `subject_kind='cutover'` keyed by the cutover state root — one row, not millions).
Anything ingested after cutover classifies live. Declared external git remotes that
fetch *after* cutover produce external keys even for repos that existed before —
fetches are new content. No attempt to reconstruct pre-cutover taint: stated,
accepted, aligned with D8's migration rule.

## 9. P4b: persisted content classes

- **Provenance record field.** The semantic VCS already records
  `authoredByWorkUnitId` on changes and full trajectory nodes
  (`packages/service-schemas/src/vcs.ts`; `vcs-engine/src/semantic/model.ts`). P4b
  adds `contentClass: 'internal'|'external'` + `externalKeys?: string[]` to the
  **work-unit** node at creation (from the authoring session's latch) and lets every
  applied-change/file-version derive it: `class(fileVersion) = class(work unit that
  authored it)`, with ingestion commands (rows 7–9) overriding per-change to their
  ingestion key.
- **Computed-internal query.** `class(file@change)` = walk to authoring work unit →
  its stamped class; no transitive recomputation needed at read time because the
  stamp already folded the authoring session's ingested set (the latch is the fold).
- **Channels (R4 coordination).** `trajectory-message` nodes gain the same
  `contentClass` stamped from the sender's latch at send; row 16 switches from the
  session-fallback to per-message lookup. Lands with R4's structural channel work.
- **Builder integration** for §7's `sourceLineageClass`.
- Read-side: fs service resolves `file:` keys via the provenance store with an LRU;
  a class lookup must stay O(1)-ish per read — benchmark gate before enabling.

## 10. Rollout order

1. LineageKey module + latch + ingestion log in harness (rows 1–4, 15–17 fallback).
2. Server-side EXT stamping (rows 5–12) with the §3.5 `serverLatch` ordering contract
   + attestation field + evaluation-time max-join + host-side fail-closed for
   unblessed harnesses.
3. Evaluator gate + `lineageAtConsent` + snapshot fields (with acquisition spec).
4. Vouch/trust stores + prompt cards 5.2–5.4 + grandfather marker. ← P4a complete;
   mission minting unlocks (per redesign P3/P4a gate).
5. P4b provenance field + computed classes + channel messages + builder stamp.

## 11. Open questions

1. `web:` granularity: registrable domain vs full origin — domain chosen for prompt
   legibility (matches prompt-spec scope table); revisit if per-subdomain trust
   becomes a real need.
2. Whether `session:` keys should resolve transitively to the sender's external keys
   (more precise consent lists) or stay opaque (simpler, current choice).
3. Latch overflow behavior beyond 256 external keys: refuse-further-ingestion vs
   coarsen-to-wildcard; pathological either way, pick during implementation.
