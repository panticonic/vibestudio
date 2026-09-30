# Developer SQL recipes

Developer SQL has full read, write, and schema access, with no application query/result/rate caps. Cloudflare platform limits apply. The LIMIT clauses in these examples are optional working-set choices; remove or change them as needed.

Discover `sqlite_schema` first. Use `sqlQuery(sql, params)` on `vibestudio.error-reports.v1`. Parameters carry values; never interpolate narrative, keys, or IDs into SQL. This is a dedicated reporting database. Do not modify original submission identity, content digest, signature, receipt capability, or R2 location. Dashboard queries count retained reports, not product population error rates.

Machine aggregation (all submissions have a verified, self-issued Ed25519 key):

```sql
SELECT signing_public_key, count(*) AS reports,
       count(DISTINCT fingerprint) AS groups,
       min(received_at) AS first_received, max(received_at) AS last_received
FROM submissions
WHERE content_state='available' AND received_at>=? AND received_at<=?
GROUP BY signing_public_key ORDER BY reports DESC LIMIT 100
```

Same machine's chronological error history:

```sql
SELECT submission_id, fingerprint, component, product_version, code,
       observed_at, received_at, intent
FROM submissions WHERE signing_public_key=? AND content_state='available'
ORDER BY received_at DESC,submission_id DESC LIMIT 50
```

Compare reports across machines without treating uploader-asserted occurrences as independently observed failures:

```sql
SELECT fingerprint,product_version,count(*) AS reports,
       count(DISTINCT signing_public_key) AS machines,
       sum(occurrence_count) AS asserted_occurrences
FROM submissions WHERE content_state='available' AND received_at>=?
GROUP BY fingerprint,product_version ORDER BY machines DESC,reports DESC LIMIT 100
```

Update triage with the revision read from the dashboard; zero returned rows is a conflict requiring a fresh read:

```sql
UPDATE triage_groups SET status=?,severity=?,revision=revision+1,updated_at=?
WHERE fingerprint=? AND revision=? RETURNING fingerprint,revision
```

Pin only evidence needed for an investigation. User deletion takes precedence over pins:

```sql
UPDATE submissions SET pinned=?
WHERE submission_id=? AND content_state='available' RETURNING submission_id,pinned
```

Link the session returned by the existing local development service:

```sql
UPDATE investigations SET development_session_id=?,updated_at=?
WHERE id=? RETURNING id,development_session_id
```

Record facts/hypotheses, exact report references, reproduction/test run IDs, source versions, and cleanup in investigation events. Preserve `report_ids_json` on every derived event so deletion can remove dependent narrative. Keep protected test artifacts in their original restricted storage; reference them, do not copy complete trajectories into the database. Use a stable event UUID for idempotence:

```sql
INSERT OR IGNORE INTO investigation_events
  (id,investigation_id,kind,evidence_json,report_ids_json,created_at)
VALUES (?,?,?,?,?,?) RETURNING id
```

`evidence_json` is structured JSON with facts, hypotheses, source coordinates, verification and cleanup references; `report_ids_json` is a JSON array of the exact submission IDs it derives from. Keep narrative exclusively in referenced investigation events; the investigation row stores workflow coordinates. A fix requires actual reproduction and relevant passing verification, with unknown source versions and unavailable infrastructure recorded honestly. `regression_candidates` is a lead for investigation, never a verdict.

On timeout, inspect the stable row ID before retrying: a SQL mutation may already have committed. Take a bounded, protected snapshot before administrative writes. `BEGIN` across separate HTTP requests is not a transaction; use single revision-checked statements or native D1 batch operations where exposed.


Aggregate usage over UTC calendar days (date parameters use `YYYY-MM-DD`):

```sql
SELECT day,
       sum(CASE WHEN mode='baseline' AND metric='startup' THEN count ELSE 0 END) AS startup_pings,
       sum(CASE WHEN mode='improvement' AND metric='startup' THEN count ELSE 0 END) AS opted_in_native_startups
FROM usage_daily WHERE day>=? AND day<=?
GROUP BY day ORDER BY day
```

Opted-in product and reporting counters:

```sql
SELECT metric,sum(count) AS count
FROM usage_daily WHERE mode='improvement' AND day>=? AND day<=?
GROUP BY metric ORDER BY metric
```

These are anonymous, unauthenticated daily aggregates, retained for 400 days. Startup pings count native launches, not unique users or machines. Detailed counters require opt-in; missing delivery and short/offline sessions cause undercounting. The startup difference is only a rough unseen-startup estimate. Analytics contain no machine keys or other identifiers and cannot join to submissions. Report/component/version filters cannot filter these aggregates. Never use them to claim a population crash rate or reconstruct a user's activity.
