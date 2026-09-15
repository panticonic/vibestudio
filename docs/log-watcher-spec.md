# Log Watcher — SA2 Mechanical Layer & SA3 Model Layer Spec

Status: draft for review
Depends on: `system-agent-design.md` (§6 — parent design; all calibration values
committed there are restated here unchanged), `system-agent-sa0-plan.md`,
`capability-model-redesign.md` (§5, R1–R4 reconciliation), `stage0-unified-log-spec.md`,
`system-agent-tools-cards-spec.md` (IncidentCard schema),
`multi-user-wp0-user-identity-spec.md`

This spec makes the design's §6 buildable: exact record shapes consumed, the
normalizer rule list with its test corpus, complete store DDL, the signature
state machine, the storm ladder, retention, the inbox contract, the SA3
evaluation session, and the push budget.

## 1. Placement and ingest architecture (SA2)

One watcher per hub, **host-side**, created by `src/server/index.ts` alongside
the log services. It is not an entity, not an agent session, not a workspace
unit — plain host code (`src/server/services/logWatcher/`). It holds **no
tools and no privileges**; its only outputs are rows in its own store and
notifications in the inbox (§7).

### 1.1 Stream taps

The watcher subscribes to all three log streams at their host-side fan-in
points; every tap is a synchronous callback that does an O(1) enqueue and
returns:

| Stream | Tap | Record type |
| --- | --- | --- |
| Panel | the `onRecords` dep of `createPanelLogService` — `index.ts` composes the existing diagnostics sink and `watcher.ingestPanel(records)` | `PanelLogRecord` (`packages/service-schemas/src/panelLog.ts`): `{ unitSource, panelId, timestamp, level: debug\|info\|warn\|error, message, source: console\|lifecycle, fields?, url?, line? }` |
| Worker | the `onLog` dep of `createWorkerLogService` — composed the same way | `WorkerLogRecord` (`src/server/services/workerLogService.ts`): `{ source, callerId, timestamp, level: debug\|info\|warn\|error, message }` |
| Server | `serverLogStore.onAppend(listener)` — direct store subscription, not the `serverLog` service (the watcher is host-side; no RPC hop) | `ServerLogRecord` (`src/server/services/serverLogStore.ts`): `{ seq, timestamp, level: verbose\|info\|warn\|error, tag?, message, fields?, pid }` |

Note the panel stream is pre-filtered at the source: the Electron shell only
forwards warn/error console output plus lifecycle events. The watcher watches
what the streams deliver; it does not widen them.

### 1.2 Canonical ingest record

Taps map into one internal shape before queueing:

```ts
interface IngestRecord {
  sourceKind: "panel" | "worker" | "server";
  sourceId: string;      // panel: panelId; worker: source ?? callerId; server: tag ?? "untagged"
  level: "verbose" | "info" | "warn" | "error";   // debug → verbose
  message: string;       // panel lifecycle records prefix "lifecycle: "; tap-truncated to 16KB (§1.3)
  truncated?: boolean;   // set when the 16KB tap truncation fired (§1.3)
  timestamp: number;
  logRef: LogRef;        // §1.4
}
```

The `debug → verbose` fold reconciles the three streams' level vocabularies
into the design's canonical set (`verbose|info|warn|error`). `verbose`/`info`
records are ingested (they feed rate windows and storm detection) but are
**never eligible for notification or model evaluation** — only `warn` and
`error` signatures can notify.

### 1.3 Queue and drop policy — never block logging

- **Byte discipline at the tap**: before a record is enqueued (and therefore
  before normalization), its `message` is truncated to **16 KB** with an
  explicit `… [truncated]` marker appended, and the ingest record is flagged
  `truncated: true`. This bounds every downstream cost — ring memory (8192 ×
  16 KB worst case), the normalizer's regex passes, and template hashing — at
  the single entry point. Two further caps layer on top: stored exemplar `raw`
  is capped at 2 KB at persist time (§3), and model-payload exemplars at 500
  chars (§8.3).
- A single bounded in-memory ring queue, **capacity 8192 records**. Taps push
  and return; a drain loop (setImmediate-scheduled, yielding every 256 records)
  runs normalize → hash → store.
- **Overflow drops oldest**: on push into a full queue the oldest record is
  discarded and a `droppedRecords` stats counter increments. Dropping is silent
  to the emitter — the watcher never signals back-pressure to any log path. A
  watcher crash, a full queue, a wedged model session: none can slow or fail a
  `console.error` anywhere in the system.
- The watcher's store writes are its own; it never writes to the log stores it
  reads.

### 1.4 Log references (`LogRef`)

Cards carry log *pointers* for anything beyond their bounded, demarcated
exemplar/excerpt fields (design §6.4) — bulk text is always reached by ref,
never inlined. The `LogRef` shape
is **owned by `system-agent-tools-cards-spec.md`** (`logRefSchema`); this spec
consumes it unchanged:

```ts
interface LogRef {
  sourceKind: "panel" | "worker" | "server";
  sourceId: string;
  logId: string;      // "server:{serverBootId}" | "panel:{panelId}" | "worker:{callerId}"
  fromSeq: number;    // inclusive range; a single-record ref has fromSeq === toSeq
  toSeq: number;
}
```

`seq` is assigned in the **authoritative log store**, not by the watcher: the
panel and worker log services assign a monotonic per-log `seq` at record time
and expose `query({sinceSeq})`, exactly as `serverLog` already does — the seq
exists in the store *before* both storage and watcher ingestion, and the
watcher's `IngestRecord` carries that store-assigned seq rather than minting a
private one. Every ref therefore resolves exactly through its owning store's
`query({sinceSeq})`; no timestamp-window fallback is needed. This is the
unified-log addressing discipline of `stage0-unified-log-spec.md` (`logId` +
monotonic `seq`) applied uniformly to all three host streams. Each signature
retains the `LogRef`s of its 3 stored exemplars.

## 2. Normalizer (SA2)

Pure code, `src/server/services/logWatcher/normalize.ts`.
`NORMALIZER_VERSION = 1`.

### 2.1 Ordered rule list

Rules apply to `message` **in this order**; each is a global regex replace.
Order is normative — later rules see earlier rules' placeholders.

| # | Rule | Regex (JS syntax) | Placeholder |
| --- | --- | --- | --- |
| 0 | Whitespace fold | `/[ \t]+/g` → single space; trim each line; keep `\n` | — |
| 1 | ISO timestamp | `/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z\|[+-]\d{2}:?\d{2})?\b/g` | `<TS>` |
| 2 | Epoch ms/s | `/\b1\d{12}\b\|\b1\d{9}\b/g` | `<TS>` |
| 3 | UUID | `/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g` | `<UUID>` |
| 4 | URL | `/\bhttps?:\/\/[^\s"'<>)\]]+/g` | `<URL>` |
| 5 | Email-like | `/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g` | `<ADDR>` |
| 6 | IP:port / host:port | `/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d{1,5})?\b/g` | `<ADDR>` |
| 7 | Absolute path | `/(?:\B~\|(?<![\w<]))\/(?:[\w.@-]+\/)*[\w.@-]+/g` | `<PATH>` |
| 8 | Hex id ≥ 8 | `/\b(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{8,}\b/g` (must contain a letter — pure digit runs are numbers, and 10/13-digit epochs were already taken by rule 2) | `<HEX>` |
| 9 | Quoted string | `/"[^"\n]*"\|'[^'\n]*'/g` | `<STR>` |
| 10 | Decimal number | `/-?\d+(?:\.\d+)?/g` | `<N>` |

Consequences of the ordering, all intended: a quoted path becomes `<STR>`
(rule 9 wins the outer shape); a URL's query string never leaks numbers;
`4523ms` → `<N>ms`; `retry 7/10` → `retry <N>/<N>`; stack-frame
`(/a/b.ts:692:15)` → `(<PATH>:<N>:<N>)`. Literal `<`/`>` in input pass through
untouched; the placeholder-collision ambiguity is accepted — it is stable,
which is all the hash needs.

The template is the normalized text **capped at 1000 characters and 12 lines**
(applied after normalization; stack traces keep their first 12 frames, where
dedupe-relevant identity lives). The cap is part of the hashed identity.

### 2.2 Hashing

```
sigHash = hex(sha256(`${NORMALIZER_VERSION}\n${sourceKind}\n${level}\n${template}`)).slice(0, 16)
```

16 hex chars (64 bits) — collision-negligible at the store's scale, index- and
URL-friendly. `sourceId` is deliberately **not** hashed: the same error shape
from two panels is one signature; storm accounting is per-source separately
(§5). Two consequences of that choice are explicit, not accidental:

- **Shared verdict/cooldown, by design; mutes shared across users, optionally
  source-scoped.** The verdict cache and cooldown ladder live on the single
  signature row and apply across every source that emits the shape
  (trusted-team framing — one team, one answer to "is this shape worth
  notifying about"). A verdict formed on worker A's exemplars governs worker
  B's occurrences of the same shape. Mutes are likewise shared across users,
  but a mute row may optionally carry a source scope (§3, §7.2): a global
  mute (NULL `source_id`, the default) mutes the shape everywhere; a
  source-scoped mute suppresses it only for that source.
- **Per-source attribution is persisted separately.** The
  `signature_sources` table (§3) records `(sig_hash, source_id)` counts and
  first/last-seen, so cards can say *where* a shared shape is occurring. When
  a known signature first appears on a **new** source, the cached verdict
  applies (no re-evaluation), but any emitted card must attribute counts
  per-source from `signature_sources` — the new source's count starts at its
  own tally, not the shared total.

### 2.3 Versioning

Bumping `NORMALIZER_VERSION` changes every `sigHash`. Migration on first start
after an upgrade: re-normalize each signature's newest exemplar, insert/merge
under the new hash **carrying over `first_seen`, `total_count`, `state`,
`signature_sources` rows, mute/star attributions, and cooldown fields**, and **drop the cached verdict**
(`verdict*` → NULL; `benign` reverts to `new` for re-evaluation). Counters
survive; verdict caches do not.

### 2.4 Test-vector table (unit-test corpus)

These 16 vectors are the normative corpus for
`src/server/services/logWatcher/normalize.test.ts`; the suite asserts exact
template equality.

| # | Source/level | Raw line | Expected template |
| --- | --- | --- | --- |
| 1 | server/warn | `connection refused to 127.0.0.1:8787` | `connection refused to <ADDR>` |
| 2 | panel/error | `Uncaught TypeError: Cannot read properties of undefined (reading 'map')` | `Uncaught TypeError: Cannot read properties of undefined (reading <STR>)` |
| 3 | worker/error | `Error: fetch failed\n    at ChannelDO.dispatch (/workspace/workers/channel/channel-do.ts:692:15)` | `Error: fetch failed\nat ChannelDO.dispatch (<PATH>:<N>:<N>)` |
| 4 | server/warn | `Session ctx-8f3a9b2c71d04e55 expired at 2026-07-12T14:03:22.117Z` | `Session ctx-<HEX> expired at <TS>` |
| 5 | server/error | `approval 550e8400-e29b-41d4-a716-446655440000 not found` | `approval <UUID> not found` |
| 6 | worker/warn | `heartbeat missed, last seen 1778313802117` | `heartbeat missed, last seen <TS>` |
| 7 | worker/error | `GET https://api.example.com/v1/models?key=abc123 failed with status 503` | `GET <URL> failed with status <N>` |
| 8 | server/error | `ENOENT: no such file or directory, open '/home/werg/vibestudio/state/logs/server-log.jsonl'` | `ENOENT: no such file or directory, open <STR>` |
| 9 | worker/error | `WebSocket connect ETIMEDOUT 192.168.1.44:9229` | `WebSocket connect ETIMEDOUT <ADDR>` |
| 10 | server/warn | `pairing request from wergomat@gmail.com rejected` | `pairing request from <ADDR> rejected` |
| 11 | server/info | `build completed in 4523ms (37 modules)` | `build completed in <N>ms (<N> modules)` |
| 12 | worker/warn | `retry 7/10 in 250ms` | `retry <N>/<N> in <N>ms` |
| 13 | panel/error | `lifecycle: Renderer process crashed (reason: oom, exitCode: 139)` | `lifecycle: Renderer process crashed (reason: oom, exitCode: <N>)` |
| 14 | worker/error | `sync failed for panel 3f2b9c0d-11aa-4bde-9c77-0e5f2a91d844 after 3 attempts: "socket hang up"` | `sync failed for panel <UUID> after <N> attempts: <STR>` |
| 15 | server/info | `blob 9e107d9d372bb6826bd81d3542a419d6 uploaded 2026-07-12 14:03:22` | `blob <HEX> uploaded <TS>` |
| 16 | worker/info | `worker restarted` | `worker restarted` |

Vectors 3, 9, and 12 are the shapes that dominate real storms (crash loop,
dead endpoint, retry loop); the storm-ladder tests (§5) replay vector 9 at
400/min mixed with novel one-off variants of vector 3.

## 3. Store DDL (SA2)

Substrate: `node:sqlite`, host-owned file `<statePath>/watcher/watcher.db`,
WAL mode — the same shared-host-file mechanism as the identity DB. Complete
schema (schema version 1, recorded in `watcher_meta`):

```sql
CREATE TABLE IF NOT EXISTS watcher_meta (
  key   TEXT PRIMARY KEY,          -- 'schemaVersion', 'normalizerVersion'
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signatures (
  sig_hash            TEXT PRIMARY KEY,                  -- 16 hex chars (§2.2)
  normalizer_version  INTEGER NOT NULL,
  source_kind         TEXT    NOT NULL CHECK (source_kind IN ('panel','worker','server')),
  source_id           TEXT    NOT NULL,                  -- first-seen source; per-source tallies live in signature_sources
  level               TEXT    NOT NULL CHECK (level IN ('verbose','info','warn','error')),
  template            TEXT    NOT NULL,
  exemplars           TEXT    NOT NULL DEFAULT '[]',     -- JSON: up to 3 of {raw, sourceId, logRef}; newest-kept; raw capped at 2KB at persist time (marker appended; §1.3 layering)
  first_seen          INTEGER NOT NULL,                  -- epoch ms
  last_seen           INTEGER NOT NULL,
  total_count         INTEGER NOT NULL DEFAULT 0,
  window_counts       TEXT    NOT NULL DEFAULT '{}',     -- JSON ring buffer {baseMinute, slots:[60]} (§4.2)
  ewma_rate_per_min   REAL    NOT NULL DEFAULT 0,        -- trailing-24h EWMA baseline (§4.2)
  state               TEXT    NOT NULL DEFAULT 'new'
                      CHECK (state IN ('new','notified','muted','benign','storming')),
  prev_state          TEXT,                              -- state to restore on storm exit
  verdict             TEXT    CHECK (verdict IN ('notify','ignore')),
  verdict_severity    TEXT    CHECK (verdict_severity IN ('info','warn','critical')),
  verdict_summary     TEXT,                              -- model one-liner; NULL under mechanical-only mode
  verdict_at          INTEGER,
  cooldown_step       INTEGER NOT NULL DEFAULT 0,        -- 0..3 → ladder index (§4.3)
  notify_cooldown_until INTEGER,                         -- epoch ms; NULL = may notify now
  last_notified_at    INTEGER,
  quiet_since         INTEGER,                           -- start of current <1/min quiet period (§4.3)
  muted_suppressed_count INTEGER NOT NULL DEFAULT 0      -- would-have-notified cards suppressed by mute (§7.2) — visible in the signature list
);
CREATE INDEX IF NOT EXISTS idx_signatures_source    ON signatures (source_kind, source_id);
CREATE INDEX IF NOT EXISTS idx_signatures_last_seen ON signatures (last_seen);
CREATE INDEX IF NOT EXISTS idx_signatures_state     ON signatures (state);

-- Per-source occurrence attribution for a shared signature (§2.2). The
-- signatures row stays global (one template/verdict/mute/cooldown per shape);
-- this table answers "which sources, how often, when" for cards.
CREATE TABLE IF NOT EXISTS signature_sources (
  sig_hash   TEXT    NOT NULL REFERENCES signatures(sig_hash) ON DELETE CASCADE,
  source_id  TEXT    NOT NULL,
  count      INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,                            -- epoch ms
  last_seen  INTEGER NOT NULL,
  muted_suppressed_count INTEGER NOT NULL DEFAULT 0,      -- per-source share of mute-suppressed cards (§7.2)
  PRIMARY KEY (sig_hash, source_id)
);
CREATE INDEX IF NOT EXISTS idx_signature_sources_source ON signature_sources (source_id);

-- Per-user mute attribution, optionally scoped to one source. Mutes are
-- shared truth across USERS (rows record who and when — design §6.1); the
-- optional source scope narrows WHERE the mute applies. `source_id` NULL =
-- mute everywhere (the default offered in the UI); non-NULL = mute only for
-- that source. A signature is suppressed for source S iff a row exists with
-- source_id NULL or source_id = S.
CREATE TABLE IF NOT EXISTS signature_mutes (
  sig_hash  TEXT    NOT NULL REFERENCES signatures(sig_hash) ON DELETE CASCADE,
  user_id   TEXT    NOT NULL,
  source_id TEXT,                                          -- NULL = all sources
  muted_at  INTEGER NOT NULL,
  PRIMARY KEY (sig_hash, user_id, source_id)
);

-- Per-user star attribution (push routing, §10; retention exemption, §6).
CREATE TABLE IF NOT EXISTS signature_stars (
  sig_hash   TEXT    NOT NULL REFERENCES signatures(sig_hash) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL,
  starred_at INTEGER NOT NULL,
  PRIMARY KEY (sig_hash, user_id)
);
CREATE INDEX IF NOT EXISTS idx_stars_user ON signature_stars (user_id);

-- Per-user source-level watch subscriptions ("watch this worker/panel", §10).
-- While a row exists, any NEW error-severity signature on the source — and any
-- notify-verdict incident on it — is push-eligible for that user immediately,
-- without requiring a prior star on the signature.
CREATE TABLE IF NOT EXISTS watched_sources (
  user_id     TEXT    NOT NULL,
  source_kind TEXT    NOT NULL CHECK (source_kind IN ('panel','worker','server')),
  source_id   TEXT    NOT NULL,
  watched_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, source_kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_watched_sources_source ON watched_sources (source_kind, source_id);

CREATE TABLE IF NOT EXISTS storm_state (
  source_kind           TEXT    NOT NULL,
  source_id             TEXT    NOT NULL,
  since                 INTEGER NOT NULL,               -- storm entry, epoch ms
  peak_rate             REAL    NOT NULL,               -- records/min
  sample_k              INTEGER NOT NULL DEFAULT 1,     -- current 1-in-K (§5.2)
  sig_mix_hash          TEXT    NOT NULL,               -- §5.3
  below_threshold_since INTEGER,                        -- exit-timer start; NULL while above
  notification_id       TEXT    NOT NULL,               -- the live storm card
  PRIMARY KEY (source_kind, source_id)
);

-- Lifetime counters for signatures dropped by retention (§6).
CREATE TABLE IF NOT EXISTS tombstones (
  source_kind        TEXT    NOT NULL,
  source_id          TEXT    NOT NULL,
  folded_signatures  INTEGER NOT NULL DEFAULT 0,
  folded_total_count INTEGER NOT NULL DEFAULT 0,
  last_folded_at     INTEGER,
  PRIMARY KEY (source_kind, source_id)
);

-- Hub-owned inbox (§7). One row per card; storm cards update in place.
CREATE TABLE IF NOT EXISTS notifications (
  notification_id TEXT    PRIMARY KEY,                  -- 'ntf_' + 21-char nanoid
  kind            TEXT    NOT NULL CHECK (kind IN ('signature','storm')),
  sig_hash        TEXT,                                 -- NULL for storm cards
  source_kind     TEXT    NOT NULL,
  source_id       TEXT    NOT NULL,
  severity        TEXT    NOT NULL CHECK (severity IN ('info','warn','critical')),
  summary         TEXT,                                 -- model one-liner; NULL in mechanical-only mode
  mechanical_json TEXT    NOT NULL,                     -- MechanicalFacts (§7.1) — always rendered
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  dismissed_at    INTEGER,                              -- shared dismiss (§7.2)
  dismissed_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_active
  ON notifications (created_at) WHERE dismissed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_sig ON notifications (sig_hash);

-- Sliding-window push accounting (§10).
CREATE TABLE IF NOT EXISTS push_ledger (
  user_id         TEXT    NOT NULL,
  sent_at         INTEGER NOT NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('storm','starred','watched','overflow')),
  notification_id TEXT                                  -- NULL for collapsed overflow pushes
);
CREATE INDEX IF NOT EXISTS idx_push_ledger_user_time ON push_ledger (user_id, sent_at);
```

Per-source rate ring buffers for storm *detection* are in-memory only,
rebuilt from zero on restart — a restart mid-storm re-trips the ladder within
the 2-minute sustain window; `storm_state` rows persist so an open storm card
survives restart and keeps updating.

## 4. Signature state machine (SA2 mechanics, SA3 verdicts)

### 4.1 States and transitions

States: `new | notified | muted | benign | storming`.

| From → To | Trigger |
| --- | --- |
| (absent) → `new` | novel insert: normalize → hash → no row. Record enqueued for evaluation (§8); under mechanical-only mode it notifies directly with template text. |
| `new` → `notified` | model verdict `notify` (or mechanical-only notify): card emitted, `last_notified_at` set, `cooldown_step` stays 0, `notify_cooldown_until` = now + ladder[1] (10 min — the *next* re-notify earliest). |
| `new` → `benign` | model verdict `ignore`: verdict cached; keeps counting; never notifies unless a rate transition overrides. |
| `benign` → `notified` | **rate transition**: current 5-min mean rate ≥ 100 × `ewma_rate_per_min` AND ≥ 10/min absolute. Re-enqueued for evaluation with a `rateTransition: true` flag; a second `ignore` returns it to `benign` and doubles the transition threshold for this signature (in-memory) until quiet reset. |
| `notified` → `notified` | cooldown expiry re-notify: signature still occurring (`last_seen` > `last_notified_at`), `now ≥ notify_cooldown_until` → new card, `cooldown_step = min(step+1, 3)`, `notify_cooldown_until` = now + ladder[step]. |
| any → `muted` | **global** mute action (§7.2, a `signature_mutes` row with NULL `source_id`). `prev_state` records the prior state. Muted signatures keep counting; they never notify, never re-evaluate, and are retention-exempt. A **source-scoped** mute (non-NULL `source_id`) does *not* change signature state — the signature stays in its current state and only occurrences on the muted source are suppressed (§7.2); scoped-muted signatures are also retention-exempt. |
| `muted` → `benign` | unmute action (from the signature list view) removing the last global mute row. Always lands on `benign` regardless of `prev_state` — an unmute means "watch again quietly"; the rate-transition path re-escalates if warranted. |
| any except `muted` → `storming` | source storm entry (§5.1): every signature of that source with activity in the last 5 min moves to `storming`, `prev_state` saved. Per-signature notification is suppressed; occurrences fold into the storm card. |
| `storming` → `prev_state` | source storm exit (§5.4). Signatures whose `prev_state` was `new` and which were never evaluated re-enter the evaluation queue. |

### 4.2 Rate windows and baseline

Each signature carries a **60-slot per-minute ring buffer** (`window_counts`
JSON: `{ baseMinute, slots[60] }`): on each hit, advance/zero slots as needed
and increment the current slot. Derived: 1-min rate, 5-min mean, 60-min sum.
Per-source storm detection uses parallel in-memory 60-slot buffers keyed by
`(sourceKind, sourceId)`. `ewma_rate_per_min` is an exponentially weighted
moving average with a 24-hour half-life, updated per minute for active
signatures, floored at 0.05/min so the 100× rate-transition threshold is never
satisfied by a signature going from ~0 to trivial rates.

### 4.3 Cooldown ladder

`ladder = [0, 10 min, 1 h, 6 h]`, indexed by `cooldown_step` (0..3). First
notification is immediate; each re-notify advances one rung; the ladder caps
at 6 h. **Reset conditions** (both set `cooldown_step = 0`,
`notify_cooldown_until = NULL`):

1. **Quiet period**: 24 consecutive hours below 1/min (`quiet_since` tracks
   the current quiet run; any minute ≥ 1/min clears it).
2. **User interaction with the card**: dismiss, star, unstar, open/expand, or
   "Investigate with System Agent" — a user who touched the card has re-armed
   it deliberately.

## 5. Storm ladder (SA2)

### 5.1 Entry

Per `(sourceKind, sourceId)`: rate > **120 records/min sustained for 2
consecutive minutes** (both of the last two completed minute-slots above 120).
On entry: insert `storm_state`, move the source's active signatures to
`storming` (§4.1), emit **one storm card** (`kind: 'storm'`), and push it
(§10).

### 5.2 Sampling

While storming the source is sampled **1-in-K** through the full pipeline
(normalize/hash/count), where

```
K = max(1, ceil(observedRatePerMin / 60))
```

recomputed at each minute boundary from the previous slot — K adapts so
processed lines cap at ~60/min per storming source. Two exceptions:
(a) **novel signatures are always kept** — the sampler hashes every record
and only drops records whose `sig_hash` already exists; (b) sampled-out
records still increment the in-memory source rate buffer (exit detection sees
true rates). Known-signature counters undercount by ~K during storms; the
storm card's tallies are marked `sampled: true, sampleK` in `mechanical_json`.

### 5.3 One live card; re-notify on mix change only

The storm card updates in place (counts, rate, dominant signatures) —
`updated_at` bumps, clients re-render, no new inbox row, no new push.

```
sigMixHash = hex(sha256(top3 sigHashes by 5-min count, sorted lexically, joined "\n")).slice(0, 16)
```

Recomputed each minute while storming. A change in `sigMixHash` (the storm's
character changed — a new dominant signature) re-notifies: the card gets a
"mix changed" annotation and one new push, subject to the budget (§10). Nothing
else re-pushes during a storm.

### 5.4 Exit

Rate below 120/min for **10 consecutive minutes**
(`below_threshold_since` + 10 min elapsed; any minute back above clears it).
On exit: final tally update to the card ("storm ended — N records over M min,
S signatures, dominant: …"), delete `storm_state`, restore signature states
from `prev_state` (§4.1). The card stays in the inbox until dismissed.

## 6. Retention (SA2)

A daily sweep (and on startup) drops every signature with
`last_seen > 30 days` ago, folding its `total_count` into
`tombstones(source_kind, source_id)` (`folded_signatures += 1`,
`folded_total_count += total_count`). Exempt from retention:

- **Muted signatures** (any `signature_mutes` row, global or source-scoped) — a mute is a user
  decision; expiry would resurrect the shape as "novel" and re-notify, undoing
  the mute.
- **Starred signatures** (any `signature_stars` row) — same reasoning: a star
  is a user decision ("tell me when this happens"), and expiry would silently
  demote a starred shape to an unstarred novel one. Stars and mutes are the
  two user-authored bits on a signature; both pin it.

Dropping a signature cascades its mute/star rows (there are none, by the
exemptions) and leaves its historical notifications untouched (`sig_hash` on a
notification row is a soft reference; cards render from `mechanical_json`).

## 7. Notification inbox (SA2)

### 7.1 Record and fan-out

The inbox is the `notifications` table (§3), **hub-owned and shared**: one
inbox per hub, fanned out to every client of the workspace over the existing
events surface (`watcher-inbox:changed` event carrying changed rows; clients
catch up with a `watcherInbox.list` service method — read-only, gated by a
`system.watcher.read`-class capability granted to chrome and panel principals;
caller kind is routing information only, per foundations R3). `mechanical_json` is the
`MechanicalFacts` object and is always rendered by the card, verbatim and
inert, regardless of what `summary` says:

```jsonc
{
  "sigHash": "9c2f4ab318d0e6f1",       // null for storm cards
  "sourceKind": "worker",
  "sourceId": "workers/blog-drafts",
  "level": "error",
  "template": "WebSocket connect ETIMEDOUT <ADDR>",
  "counts": { "total": 412, "last5m": 96, "last60m": 401 },
  "sourceCounts": [                      // per-source attribution from signature_sources (§2.2/§3)
    { "sourceId": "workers/blog-drafts", "count": 412, "firstSeen": 1784281400000, "lastSeen": 1784281960000 }
  ],
  "window": { "firstSeen": 1784281400000, "lastSeen": 1784281960000 },
  "logRefs": [ { "sourceKind": "worker", "sourceId": "workers/blog-drafts", "logId": "worker:do:workers/blog-drafts:BlogDO:ctx-a1b2", "fromSeq": 5541, "toSeq": 5541 } ],
  "storm": null                        // storm cards: { since, peakRate, sampleK, sigMix: [top-3 {sigHash, template, count}], sampled: true }
}
```

### 7.2 Actions

- **Dismiss** — sets `dismissed_at`/`dismissed_by`; clears the card for
  **everyone**, attributed. The signature keeps counting and can re-notify per
  the cooldown ladder (§4.3) — dismissing a card also resets that signature's
  ladder (user interaction).
- **Mute signature** — the card offers two options: **"Mute this shape"**
  (the default — inserts a `signature_mutes` row with NULL `source_id`,
  state → `muted`, suppresses everywhere) and **"Mute this shape for
  {source} only"** (inserts a row with `source_id` = the card's source —
  per-source attribution comes from `signature_sources`; signature state is
  unchanged and only that source is suppressed). A signature is suppressed
  for source S iff a mute row exists with `source_id` NULL or = S. Both
  variants are shared across users (mute for everyone), attributed, and
  reversible from the **signature list view** (a watcher settings surface
  listing signatures with state, counts, mutedBy/starredBy per scope, and
  `muted_suppressed_count`; unmute deletes the caller's row *and all other
  rows of the same scope* — unmute is also a shared action, symmetric with
  mute; a source-scoped unmute removes only that source's mute rows).
  Whenever a mute suppresses a card that would otherwise have notified (a
  re-notify per §4.3, a rate transition, or a would-be novel notification),
  the signature's `muted_suppressed_count` increments, along with the
  emitting source's row in `signature_sources` — this per-source counter is
  what attributes suppression cost to a source-scoped mute — so a mute one
  teammate placed is discoverable, with its cost visible, in the signature
  list rather than being invisible silence.
- **Star / unstar** — inserts/deletes `signature_stars`. Per-user rows; a
  star routes pushes to that user (§10) and pins the signature (§6).
- **Watch / unwatch source** — inserts/deletes a `watched_sources` row for the
  acting user on the card's `(sourceKind, sourceId)` (also available from the
  signature list and source views). Per-user, like stars. While watched, new
  error-shape and notify-verdict activity on that source is push-eligible for
  the watcher immediately (§10) — the forward-looking counterpart to starring,
  which can only be applied to a signature the user has already seen.
- **Investigate with System Agent** — the explicit human gate (design §4).
  The client composes the **IncidentCard** — schema defined in
  `system-agent-tools-cards-spec.md`:
  `{ sourceKind, sourceId, sigHash, template, severity (info|warn|critical),
  summary, counts { total, last5m, last60m }, firstSeen, lastSeen, refs[] }` —
  and posts it as a **user turn** into the acting
  user's System Agent conversation
  (`systemAgent.resolveConversation`), opening that surface. The forward
  payload **automatically includes the signature's stored exemplar lines**
  (≤ 3, each capped at 500 chars for the model payload — the innermost of
  the §1.3/§3/§8.3 cap layering — demarcated as untrusted content): the
  forward gesture already expressed investigation intent, so the user does
  not have to manually share lines afterward. The IncidentCard additionally
  carries the template (normalized, parameter-stripped) and card-ref
  pointers; the System Agent can use full eval to page the authorized unified-log service,
  aggregate/filter records in code, and return compact counts/refs/cards. A rendered
  `LogExcerptCard` remains capped at ≤ 20 records × 500 chars, but that is a UI payload limit,
  not the agent's log-access limit. The user's explicit share-log-lines action remains useful for
  directing attention to specific lines.
  To be plain about what crosses: the template, the watcher summary, and
  the exemplar lines are **attacker-influenceable text that does reach the
  System Agent's model context**, as demarcated untrusted fields on the
  IncidentCard. Inert rendering prevents UI execution, but full eval means this text can influence
  model-chosen shell actions after the human forward; the design accepts and tests that risk.

### 7.3 Inspectable silence

Silence must be auditable, not absolute. Two mechanisms make what the watcher
*didn't* say visible:

- **Ignored-shapes row.** The inbox renders one collapsed row — **"N shapes
  ignored this week"** — below the active cards, counting signatures the model
  verdicted `ignore` (state `benign`) with activity in the trailing 7 days.
  Expanding it lists each signature (template, level, sources from
  `signature_sources`, counts, `verdict_summary`), and each row carries a
  one-tap **"notify me about this"** override: it flips the cached verdict to
  `notify`, emits a card immediately, and stars the signature for the acting
  user. A wrong `ignore` verdict costs one tap to discover and one tap to
  reverse.
- **Mute suppression counters.** Every card a mute suppresses increments the
  visible `muted_suppressed_count` on the signature row and on the emitting
  source's `signature_sources` row (§3, §7.2) — for a source-scoped mute the
  per-source row is the primary attribution: it shows exactly how many cards
  that source's mute swallowed, while other sources of the same shape keep
  notifying. The signature list surfaces the counters next to mutedBy (with
  each mute's scope) — a shared mute another user placed, global or
  per-source, is discoverable by anyone wondering why a source has gone
  quiet.

## 8. SA3 — model layer

### 8.1 One long-running evaluation session per hub

A single host-side **pi-ai conversation** — not an entity, not an agent
session, not a channel participant; the watcher drives the pi client directly
with **no tools registered** and no system-prompt extensibility. Its
accumulated context is its pattern memory of the stream; all exact state
(counts, cooldowns, mutes, verdicts) lives only in the store — the model is
never asked to count (design §6.1/§6.2).

### 8.2 Batching

Novel signatures and rate-transition events queue for evaluation; the queue
drains **every 30 seconds or at 16 items, whichever comes first**. Items for
`muted` (globally muted) signatures and `verbose`/`info` levels never enqueue;
a source-scoped mute suppresses notification for that source but does not
block evaluation of the shape. One drained
batch = one turn.

### 8.3 Turn input

The user turn is exactly one JSON object — no digest, no store dump; the
session's own history is the stream context:

```jsonc
{
  "batch": [
    {
      "sigHash": "9c2f4ab318d0e6f1",
      "sourceKind": "worker",
      "sourceId": "workers/blog-drafts",
      "level": "error",
      "template": "WebSocket connect ETIMEDOUT <ADDR>",
      "exemplars": [
        "WebSocket connect ETIMEDOUT 192.168.1.44:9229",
        "WebSocket connect ETIMEDOUT 192.168.1.44:9230",
        "WebSocket connect ETIMEDOUT 10.0.0.7:9229"
      ],
      "counts": { "total": 412, "last5m": 96 },
      "firstSeen": "2026-07-12T14:03:20Z",
      "rateTransition": false          // true for benign-at-100×-baseline re-evaluations
    }
  ]
}
```

Exemplars are raw lines (untrusted by design, §9), at most 3, each capped at
500 chars. This is the innermost of three byte caps: 16 KB at the tap (§1.3),
2 KB on stored exemplar `raw` (§3), 500 chars in the model payload here — each
layer trims further; none changes the `sigHash` identity, which was computed
from the (tap-truncated) normalized template.

### 8.4 Turn output, validation, fallback

Structured output, one entry per input item, keyed by `sigHash`:

```jsonc
{ "verdicts": [ { "sigHash": "9c2f4ab318d0e6f1", "verdict": "notify",   // "notify" | "ignore"
                  "severity": "warn",                                    // "info" | "warn" | "critical"
                  "summary": "blog-drafts worker cannot reach its websocket backend" } ] }
```

Validation: parse against a zod schema; every input `sigHash` must appear
exactly once with valid enums and a non-empty single-line `summary`
(≤ 200 chars, newlines rejected). On mismatch, **retry once** with the
validation error appended to the turn. On second failure, the whole batch
falls back to **mechanical handling**: each item notifies with template text,
no summary (`summary` NULL), severity mapped from level (`error → warn`,
`warn → info`; `critical` is model-only), and the verdict cache is left empty
so a later rate transition re-evaluates. Verdicts that do validate are cached
on the signature row (`verdict`, `verdict_severity`, `verdict_summary`,
`verdict_at`); `notify` emits the card, `ignore` sets state `benign`.

### 8.5 Compaction at 50k tokens

When the session's context reaches **50k tokens** (provider-reported usage),
the watcher runs a compaction turn and restarts the session:

1. **Self-summary turn**: the session is asked to author a summary that MUST
   contain: (a) **active pattern narratives** — recurring shapes and their
   temporal relationships ("this warning precedes that crash"), (b) **source
   personalities** — per-source noise floors and what "normal" looks like for
   each chatty source, (c) **known correlations** — cross-source co-occurrence
   it has inferred. Capped at 4k tokens.
2. **Restart**: a fresh session seeded with the fixed system prompt, the
   self-summary, and a **store digest** composed mechanically: the top 50
   active signatures by `last_seen` (template, level, state, total/5-min
   counts each), all current `storm_state` rows, and the last 20 verdicts
   (`sigHash`, verdict, severity, summary).

Losing the old context loses only nuance; verdicts and counters are in the
store. A crash without a self-summary restarts from digest alone.

### 8.6 Model selection and degradation ladder

- Host config key **`systemWatcher.model`**, default
  **`openai-codex:gpt-5.3-codex-spark`** — pinned in hub config (host-owned,
  not workspace config), same pinning pattern as `system-test run --model REF`
  flowing into session `extraConfig.model`.
- Unavailable (provider error, auth failure, or 3 consecutive failed turns) →
  fall back to **`LOCAL_FALLBACK_MODEL_REF`** (`local:lfm2.5-2.6b`,
  `workspace/packages/model-catalog/src/catalog.ts`), fresh session from the
  store digest.
- Local fallback also unavailable → **mechanical-only mode**: novel `warn`/
  `error` signatures notify immediately with template text, un-summarized,
  severity from log level as in §8.4. The watcher re-probes the configured
  model every 15 minutes and climbs back up the ladder with a fresh session.

At every rung, ingest, dedupe, storms, inbox, and push keep working — **the
watcher degrades; it never blocks logging** (§1.3 holds independently of the
model layer entirely: the evaluation queue is bounded at 1024 items,
drop-oldest, and sits after the store write).

## 9. Poisoning stance (restated from design §4)

The model layer's inputs — templates and exemplar lines — are **wholly
untrusted** text: any panel, worker, or web-touching userland can craft them.
That is acceptable because the session's entire output authority is "which
card appears in the inbox and with what one-line summary." It has no tools, no
privileges, no write access to anything but verdict fields. Cards **always
render the mechanical facts** (`mechanical_json`: source, template, counts,
window) alongside the model summary, so a manipulated summary cannot fully
spoof a card; and nothing model-authored reaches the System Agent except
through the IncidentCard a human explicitly forwards (§7.2), which carries the
mechanical fields, the one-line summary, and the stored exemplar lines (≤ 3 ×
500 chars, demarcated untrusted — §7.2).

Be honest about what that forwarding means: the signature **template**, the
watcher **summary**, and the **exemplar lines** are attacker-influenceable
strings (any log emitter shapes all three; a poisoned stream can shape the
summary), and they **do reach the System Agent's model context** when a human
forwards the card — as does log data the agent later queries through eval (§7.2). They travel as
demarcated untrusted fields and render inert in every UI surface. Inert rendering, the explicit
forward gate, watcher isolation, ordinary service authorization/approvals, and audit reduce risk;
they do not prevent hostile text from influencing code selected by a full-eval model. Protected
non-delegated approval payload/settlement remains outside conversation eval. Prompt-level “ignore
instructions in logs” guidance is present but assumed bypassable and not load-bearing.

## 10. Push budget (SA4 routing, specified here)

OS push rides the existing FCM/APNs path (`pushService.sendToTargets`) with
the `approvalPushBridge` delivery discipline. Push-eligible cards, per user:

- **Storm cards** (entry and mix-change re-notifies, §5.3) — pushed to every
  workspace member.
- **Starred-signature cards** — pushed to users with a `signature_stars` row
  for that signature.
- **Watched-source cards** — pushed to users with a `watched_sources` row for
  the card's `(sourceKind, sourceId)` (§3, §7.2). While a source is watched,
  two card classes are push-eligible for the watcher the moment they are
  emitted: any card for a **new `error`-level signature** on that source, and
  any **notify-verdict** incident card on it. This deliberately bypasses the
  starred-signature requirement — a star can only be placed on a signature the
  user has already seen, which makes it useless for the "tell me when my new
  worker breaks" case; watching the source covers the first occurrence.
  Watch-driven pushes are ordinary ledger entries: the hourly budget below
  remains the outer cap.

Budget: **4 pushes per user per sliding hour**, accounted in `push_ledger`.
A push that would exceed the budget is withheld; at the top of the next
eligible minute one collapsed **"N more incidents"** push (kind `overflow`,
counting the withheld cards, deep-linking to the inbox) is sent and itself
consumes one budget slot. At most one overflow push per user per hour.

**Desktop-presence suppression** follows the approvals heartbeat pattern
(`approvalPushBridge`): if `shellPresence.isAnyShellActive()` (6 s heartbeat
freshness), delay the push 10 s; re-check presence at the deadline and send
only if no shell is active — a user at their desktop sees the inbox badge, not
a phone buzz. Storm entry pushes skip the delay only when no shell has been
active for 60 s. In-app inbox fan-out (§7.1) is never budgeted or suppressed —
it always receives everything.

## 11. Phase mapping

- **SA2** ships §1–§7 in mechanical-only mode (§8.6's last rung as the only
  mode), producing the burn-in data that recalibrates the committed values —
  recalibration changes numbers, not shapes.
- **SA3** ships §8: evaluation session, verdict caching, summaries, severity,
  compaction, degradation ladder.
- **SA4** (mobile) consumes §10's push routing and adds the starring and
  source-watch UI; the
  ledger, budget, and suppression logic land with SA2 so accounting is
  exercised before any OS push exists.
