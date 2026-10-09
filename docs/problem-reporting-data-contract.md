# Problem reporting: data, collection, consent, and delivery contract

Status: implementation specification, 2026-09-29. Companion to
[the implementation plan](error-reporting-and-improvement-plan.md).

This document supplies the concrete contract for the reporting pipeline. Limits
are initial product policy, defined once in code and shared by collectors,
draft service, uploader, and intake validation. They are not alternate transport
formats or a second report system.

## 1. Local observation, automatic sharing, and manual reporting

There are two report intents using one schema, encoder, outbox, and receiver:

- `automatic-diagnostic`: a small host-produced diagnostic after explicit
  opt-in, containing only the automatic field allowlist.
- `manual-problem`: a user-reviewed report, possibly prepared with an agent,
  containing selected evidence and substantial narrative.

Both can point to the same local incident. A manual report can reference an
earlier automatic receipt without overwriting it. Creating that manual report
does not count as another occurrence of the underlying error.

Bounded local operational diagnostics continue to support recovery and local
investigation when sharing is off. The UI must say this explicitly. Opting out
stops automatic external reporting; it does not claim to disable ordinary local
logs. Local report drafts and exports remain available. Sending one manual report
does not turn automatic reporting on.

Automatic sharing requires all of: a current opt-in record, a permitted subject,
an eligible failure, a fixed TLS destination, a usable automatically generated machine signing key, and automatic-field
validation. Missing consent or signing capability means no automatic error upload. Do not
retain an upload backlog during undecided/off periods for later silent upload.

## 2. Consent identity and lifecycle

Consent is host-held, keyed by authenticated user, capture installation, and
reporting destination. A capture installation is a concrete desktop/mobile
client or an owned server installation, not an entire template or account's
workspaces. Store an opaque local installation ID, never a machine fingerprint.

Fields: `state: undecided|off|on`, `revision`, `policyVersion`, `destination`,
`decidedAt`, authenticated actor identity, and decision surface. Template
publication, workspace import, agent context forks, and report evidence never
copy consent. A user on another installation gets their own first-use choice.
An agent cannot set it and a workspace administrator cannot opt in other users.

Automatic background server errors use an explicitly enrolled server owner and
that server installation's consent. An unattended instance with no enrollment
stays off; it never borrows the last connected client's preference. Headless
developer setup can make the same explicit choice through trusted CLI setup.
It uses the same consent store and authority boundary, not an environment flag
that bypasses consent.

User-owned panel/task failures use that user's enrollment and visibility.
Workspace-wide events can be enrolled only by the owning operator, and their
automatic export still contains only content-free product diagnostics. No
member's transcript, workspace code, or identity is shared by another member's
automatic consent. Local diagnostic access continues to use existing membership
and context authority.

Consent transitions are revision-checked writes. Persist before signalling UI
success. `on -> off` cancels queued automatic submissions in the same transaction;
claim and pre-network dispatch recheck the consent revision. Attempt to abort
in-flight uploads, but explain that a request already received remotely may
finish. Disabling automatic reporting leaves manually sent reports unchanged;
the history provides separate cancel/delete actions for those.

Going back to on starts with new observations after `decidedAt`; it does not
resurrect cancelled records. A broader payload allowlist or changed destination
invalidates automatic admission until a fresh choice. A cosmetic wording change
does not discard a still-valid choice. Policy compatibility is an exact product
decision, not something an agent or downloaded template can grant.

Keep consent decisions as local history without report contents. Export only
the applicable policy version/mode/time and local decision reference as an
assertion, not the user's internal account ID. The server authenticates the
uploader key; it cannot cryptographically prove a human clicked a client dialog.

## 3. Canonical wire value

`ProblemReportBundleV1` is a strict, versioned JSON object:

| Field                                        | Contents                                                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `schema`                                     | Literal `vibestudio.problem-report.v1`.                                                                                             |
| `submissionId`, `reportId`, `reportRevision` | Opaque UUIDs and positive revision; submissionId is the idempotency coordinate.                                                     |
| `intent`                                     | Automatic diagnostic or manual problem.                                                                                             |
| `createdAt`, `observedAt`                    | UTC timestamps; remote received time is recorded separately.                                                                        |
| `consent`                                    | Applicable manual approval or automatic policy reference, policy version, approval time, destination.                               |
| `environment`                                | Product/build/template versions, platform/architecture, runtime type; availability declared per field.                              |
| `problem`                                    | Category, component, operation/stage, stable failure code/kind, normalized product frames, optional user symptom/expected behavior. |
| `occurrence`                                 | Origin coordinate, fingerprint/version, observed count and first/last time, plus explicit sampling/drop completeness.               |
| `references`                                 | Report-local refs and permitted exact causal coordinates, including optional prior receipt.                                         |
| `narrative`                                  | User/agent-authored structured Markdown sections with evidence references. Empty for automatic reports.                             |
| `evidence`                                   | Bounded inline JSON/text sections with source, capture time, completeness, and sanitization metadata.                               |
| `attachments`                                | Selected files, each with local attachment ID, MIME type, byte size, SHA-256 digest, and base64 bytes.                              |

Local-only ownership IDs, credential IDs, filesystem locations, and visibility
grants are not wire fields. Nullable/unavailable versions are explicit; never
substitute the current build version for the version that actually failed.
Wire subject IDs are report-local opaque aliases by default. Stable per-install
pseudonyms for distinct-install counts are included only as a disclosed automatic
field; rotate them when enrollment is withdrawn/recreated. Never use hostname,
email, account IDs, hardware IDs, or IP addresses as report subject identifiers.

Preserve original typed failure data in a local evidence section. Automatic
sharing projects only approved typed fields. Manual sharing can select a
sanitized version of the richer failure; it never silently flattens the original.

## 4. One encoder and one bundle

Encode the strict schema using `canonicalJson` from
`@vibestudio/content-addressing`, in UTF-8. Reject unsupported/nonfinite values. Require exact
canonical bytes at intake: parse, validate, deterministically re-encode and
compare before accepting. Duplicate keys and noncanonical alternate encodings
therefore fail validation instead of ambiguously hashing the same logical value.
Do not implement a custom archive, compression,
multipart upload, presigned attachment lifecycle, or server-side extraction.
Base64 overhead is acceptable for these bounded reports and makes local export,
preview, upload, and R2 storage identical self-contained bytes.

File extension `.vibestudio-report.json`; media type
`application/vnd.vibestudio.problem-report+json`. Compute SHA-256 over the exact
encoded bytes; transmit the digest as request metadata rather than a field
inside the value that it hashes. The intake verifies the bytes, schema,
attachment digests, declared sizes, and total decoded size. Store the submitted
bytes as received; don't regenerate the bundle after accepting it.

Preview renders this frozen value, with section sizes, selected attachments,
redaction warnings, and destination. A download exports those exact bytes.
Changing text, selections, or narrative invalidates the frozen revision.
Submission checks expected report revision and prepared digest atomically.
Automatic reports use the same encoder; their approval is the applicable
allowlist policy and consent revision rather than a per-report dialog.

## 5. Payload budgets

| Item                                      | Limit / behavior                                                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Observation input message/field rendering | 16 KiB before normalization; reject/truncate unbounded fields with visible loss metadata.                   |
| Automatic bundle                          | 16 KiB encoded; no attachments or free-text narrative.                                                      |
| Manual diagnostic sections combined       | 256 KiB UTF-8 JSON/text after sanitization.                                                                 |
| Manual narrative combined                 | 128 KiB UTF-8, independent of diagnostics; substantial reports are supported.                               |
| Card summary                              | 2 KiB; a derived preview, never the full narrative.                                                         |
| Attachments                               | At most five, 7 MiB decoded total; retain per-file sizes and digests.                                       |
| Whole manual bundle                       | 10 MiB encoded, including base64, metadata, narrative, and diagnostics.                                     |
| Collection                                | Five seconds overall, concurrency two collectors; partial results remain useful.                            |
| Local background observation queue        | 256 records and 1 MiB, whichever fills first; per-record caps precede enqueue.                              |
| Automatic outbound allowance              | One initial report per fingerprint/version per 24 hours; at most 20 automatic submissions/installation/day. |

Collectors allocate budget before reading. Keep structured failure/identity and
the nearest causal evidence first. Preserve valid JSON by dropping/trimming
whole fields/items with explicit omitted counts; never cut a JSON byte string
mid-document. Do not silently truncate manual narrative or a chosen attachment:
show the limit and let the user edit/remove it. Attachment names are sanitized
display labels, never interpreted as paths. File types render inertly and are
served as downloads with no-sniff; HTML/SVG/script content is not executable.

Local automatic allowance is exact, transactionally claimed alongside queueing;
remote rate limits remain the approximate per-location abuse controls described
in the plan. Coalesce repeats in local incident history. A later report includes
observed counts, not an invented event-by-event remote history. Expire unsent
automatic bundles after seven days; don't retry stale automatic observations
indefinitely. Manual submissions pause after 30 days queued and require the user
to resume; do not destroy their draft or change their ID/digest automatically.
For a stale manual upload, recover status first. If already received, keep the
original receipt; if not accepted, prepare a current user-reviewed revision and
new submission ID to satisfy the receiver's creation-age policy. A network error
is not evidence of non-acceptance and never triggers that replacement by itself.

## 6. Automatic field allowlist

Eligible: unexpected product process/renderer termination, failed product build/
activation, unhandled product exceptions, protocol/integrity failures, and
terminal product-owned task infrastructure failures. Report cancellation,
human denial, recovered reconnects, expected domain not-found/conflict, quota
exhaustion, and user-source compilation errors as local context, not automatic
product defects. Unknown/unstructured log errors remain local symptoms until
manual selection or structured corroboration.

Automatic fields: product-owned component identity; stable code/kind and
operation; product/runtime/template versions; platform/architecture; exact
known product frame names and relative product source coordinates; observed
time/count/recovery flag; random disclosed installation pseudonym; policy version.

Not automatic: raw exception messages or arbitrary stacks; console text; tool
arguments/results; model prompts/responses; user-source names/paths/code; panel
state args; conversation content; URLs/query strings; network bodies; usernames;
hostnames; environment variables; screenshots; SQL; agent narrative. In an
unrecognized frame preserve only an “external frame omitted” count. Derive
product frames from known build/source mapping rather than trusting a path
that merely looks product-owned.

Prefer useful sparse structured diagnostics over trying to prove arbitrary
prose is anonymous. The opt-in copy describes this actual list. Expanding it
requires the consent-policy change rule above.

## 7. Collector contract and exact selection

Each collector accepts a verified report owner, exact coordinates, allocated
record/byte budget, and cancellation/deadline. It returns an immutable section
with an ID, typed value, capture/observation time, source coordinate, visibility
decision, completeness, retained/omitted counts, and sanitization actions.

| Collector           | What it selects                                                                                                                                                                        |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime health/logs | One supervised entity. Freeze sequence ceiling; up to 100 records at/before it, prioritizing failure-level records and nearest preceding context.                                      |
| Server logs         | Exact boot, permitted source tag when known, frozen sequence ceiling; up to 100 nearby records. Time proximity is supporting context, not proof of causality.                          |
| Agent invocation    | `gad.diagnoseInvocation()` for exact trajectory/branch/invocation, bounded at 20 events, 20 commands, 50 effects. Original typed failure and receipt/outcome evidence take precedence. |
| Build               | Exact build key and failure diagnostics, related publication/revision if available; selected file snippets require manual inclusion.                                                   |
| Panel               | Exact device/process/panel/runtime attempt, health/lifecycle/component stack. State args and console excerpts are manual selections.                                                   |
| Selected chat       | Explicit message IDs plus referenced tool/card evidence; never the whole conversation unless deliberately selected within the budget.                                                  |
| User files          | Explicit picker/attachment handles with the user's read authority. No recursive workspace harvesting or arbitrary host path input.                                                     |

Collect incident snapshots asynchronously after the observation; keep event
coordinates and current failure value in the bounded input so rotating logs do
not destroy the only failure evidence. Snapshot replay from a durable agent
terminal event uses its exact event coordinate as the idempotency key. Per-source
cursor advancement and incident projection commit together; replay after a crash
does not double-count. Do not turn volatile console logs into durable execution
retention roots or alter trajectory settlement to wait for reporting.

Do not scrape live inspector pages by default. Prefer retained diagnostics;
if an explicitly requested collector opens CDP/inspector connections, own them
and close/await cleanup on success, deadline, cancellation, and failure.

`completeness` is `complete|truncated|unavailable|denied`; add stable reason codes
such as source-expired, source-disconnected, deadline, byte-budget, and scope-denied.
Report collection starts from a report revision and frozen source ceilings.
Concurrent draft edits invalidate applying results to a stale revision; preserve
the captured snapshot as a local value for an explicit subsequent attachment.
Refreshing evidence creates a new selection/revision, never silently changes a
prepared submission. Failure of one collector doesn't cancel successful sections.

## 8. Sanitization and agent narrative

Implement one export policy used before preview, export, automatic queueing,
and manual Send. Registered-secret replacement, typed sensitive-key removal,
URL query/userinfo removal, local-home/path aliasing, and product-source mapping
are deterministic operations. Unknown objects are not automatic export input.
Manual sections disclose redaction and potential sensitive prose; a secret-free
regex match is not described as proof of anonymization. The reviewed bytes,
not unsanitized local evidence, are what the remote service receives.

Narrative is first-class. Support Markdown sections for user goal, observed
behavior, expected behavior, reproduction steps, timeline, investigation,
findings, hypotheses, attempted fixes, verification, impact, and unresolved
questions. Preserve lengthy explanatory narrative rather than reducing it to
a terse exception summary. Sections can be authored by user or agent; retain
agent/task identity locally and export a report-local author label plus available
model identifier only when selected. Do not include the agent's private reasoning
or automatically dump its conversation. Publish its findings and concise rationale.

Claims link to evidence section IDs or permitted exact references and declare
`observed|inferred|unverified`. The agent must distinguish facts, hypotheses,
and unavailable reproduction. The user can edit or deselect agent sections;
all included sections pass through the same export sanitization and preview.
An agent's text is not a trusted severity judgement or proof a fix works.
The intake labels authorship as uploader-asserted; it never authenticates an
agent identity merely because the bundle names it.

Ingestion validates structure and bounds but never executes commands, follows
links, or launches a model. Dashboard and host approval render report content with
raw HTML disabled and no executable components. Evidence links resolve through
authorized report APIs, not arbitrary URLs embedded in submitted prose.

## 9. Local tables, transactions, and ownership

Use one canonical SQLite schema/store per capture installation, with verified
workspace/device/user row scopes, as specified in the main plan. Consent and
automatic submissions share this store so opt-out cancellation is transactional.
Tables:

- `incidents`: verified origin, grouping fields, first/last/counts, completeness;
  unique source event/origin coordinate for exact deduplication.
- `incident_observations`: bounded occurrences/recovery observations and durable
  projection cursor state; per-origin uniqueness, with explicit expiry.
- `reports`: owner, revision, intent, status and editable value.
- `evidence_values`, `report_evidence`: digest-addressed sanitized/local values,
  original-vs-export classification, report selection and retention references.
- `submissions`: immutable bundle digest/path, intent/consent revision,
  receipt-secret reference, delivery state and receipt metadata.
- `delivery_attempts`: lease, attempt number, times, bounded outcome and next time.
- `consent_decisions` and `automatic_allowances`: current decision/history and
  exact per-install local queue allowance. Profile ownership is still enforced.

Index report owner/time, incident component/fingerprint/time, report revision,
submission due-state/time, and source cursor coordinates. Host methods derive
owner from verified caller; all ID lookups enforce ownership before reading
evidence. Cross-store device/workspace attachment is an authorized copy of a
snapshot with original provenance, not an implicit global read grant.

Commit report revision changes and selections together. Freeze content to a
restrictive temporary file, fsync/rename into a digest path, then commit its
database reference; reconcile orphaned temporary files after restart. Queue
only after the immutable file/reference and applicable consent are durable.
The delivery worker leases by a compare-and-set transaction and recovers expired
leases; no second uploader owns the same live claim. Remote success that arrives
after local cancellation records the receipt without initiating another attempt.

Local history state is separate from remote status: draft, prepared, queued,
sending, paused, received, rejected, cancelled, expired. Only automatic queued
content expires automatically; manual stale delivery pauses. Pause reasons include missing/
unavailable reporting authority, expired automatic consent policy, and stale manual queue.
Transport failures return to queued. Don't classify unavailable reporting authority as a bad
report or repeatedly upload it without a connection-state change.

Apply the plan's local retention/byte limits to original and export values,
including retained narratives/attachments. Referenced draft evidence remains
pinned. Explicit user deletion removes local report content and cancels pending
delivery; a separate remote deletion operation is needed for received content.
Before clearing the final local receipt secret, offer remote deletion or local-only
deletion explicitly. Explain that discarding that secret removes report-scoped
status/deletion access; do not silently promise later remote access without it.

## 10. HTTP receipt and retry protocol

Endpoint: `POST https://vibestudio.app/v1/problem-reports`, with a machine public key and detached Ed25519 signature,
media type, submission ID, SHA-256 digest, and a report-scoped receipt secret.
Generate the receipt secret locally as 256 random bits before first upload;
store it through protected local storage, never inside the export bundle.
Transmit it in a dedicated redacted header; the receiver stores only its digest.
The uploader can recover status or request deletion even if the initial response
was lost. Possession does not permit listing or administrative SQL.

Require identity Content-Encoding and bounded UTF-8 input; reject compressed
bodies before parsing. Header and body submission IDs must agree. Invalid field
errors identify the schema field/reason without echoing report contents or
authorization headers. Use bearer headers without cookies; administrative access
is through the existing host-mediated anonymous transport path, not direct browser key storage.
No permissive credentialed CORS or reflection of caller-selected origins.

Return `{ submissionId, digest, receiptId, receivedAt, status }`: 201 for first
acceptance and 200 for an identical retry. Same submission ID with different
bytes/digest/receipt-secret identity is 409. The receiver computes digests and
validates every field before storage, including the automatic allowlist.
Verify on the primary D1 binding; do not introduce stale replica reads into
idempotency or acceptance decisions.

| Status              | Meaning / client action                                                                        |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| 400 / 415 / 422     | Invalid format/schema; retain report, reject this frozen submission, show actionable reason.   |
| 401 / 403           | Pause for signature/local authority repair; do not discard the report.                         |
| 409                 | Submission identity conflict; stop and surface integrity mismatch.                             |
| 413                 | Payload too large; open editing with exact budget feedback.                                    |
| 429                 | Retry same ID/digest after Retry-After.                                                        |
| Network error / 5xx | Ambiguous outcome; query receipt or retry same ID/digest. Never create another ID to “fix” it. |

Use jittered retry delays starting at 5 seconds and capped at 1 hour; honor a
longer Retry-After. Only one active upload per local store. Wake on network/
connection restoration without tight polling. A configurable request deadline
aborts local waiting; it does not prove the remote write was cancelled.

`GET /v1/problem-reports/submissions/:submissionId/status` uses the receipt secret
and returns only this submission's status/digest. Wrong or missing secrets do
not reveal whether an ID exists. After local cancellation, use this operation
to resolve an ambiguous accepted request before offering remote deletion.

### Fixed read/status/deletion routes

| Route                                                        | Authority and response                                                                                                                             |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/problem-reports/admin/reports`                      | Developer key. Bounded indexed filters for time/component/version/code/fingerprint/intent/status/machine-public-key; default 50, maximum 200 rows. |
| `GET /v1/problem-reports/admin/overview`                     | Developer key. Time-bucketed aggregate counts with selected window/filters and query timestamp.                                                    |
| `GET /v1/problem-reports/admin/reports/:submissionId`        | Developer key. Index metadata, completeness and investigation links; no implicit bundle download.                                                  |
| `GET /v1/problem-reports/admin/reports/:submissionId/bundle` | Developer key. Exact retained bytes/digest as a private download, or explicit deleted/expired outcome.                                             |
| `GET /v1/problem-reports/submissions/:submissionId/status`   | Receipt secret. This submission's status/digest/receipt only.                                                                                      |
| `DELETE /v1/problem-reports/submissions/:submissionId`       | Receipt secret. Idempotent deletion request/status for this submission.                                                                            |
| `POST /v1/problem-reports/admin/sql`                         | Developer key. Administrative SQL as specified in the main plan; no anonymous SQL route.                                                           |

List ordering is `(receivedAt, submissionId)` with opaque keyset cursors bound
to the selected filters; return `nextCursor` and completeness. Default overview
window is 24 hours, maximum 90 days, with fixed server-selected time buckets.
Admin metadata updates are revision-checked operations over the triage tables;
they cannot silently replace submitted bundles. All response sizes have budgets;
list/overview omit full narrative and all attachment bytes.

Receipt-authorized DELETE and status calls use a 20/minute limiter keyed by the
verified receipt-secret digest; don't use an arbitrary submission ID as an
authenticated limiter key. DELETE is admitted before any mutation and follows
the same 429/no-write rule as developer mutations. Auth failure uses the common
secondary failure limiter. Downloads have their independent budgets from the main plan. Developer SQL has no application rate, query, or result caps; the authenticated developer has full database authority subject only to Cloudflare platform limits. A receiver outage keeps queued client drafts intact.

## 11. Remote storage, expiry, and deletion

`submissions` in D1 owns acceptance: unique submission ID, digest, receipt-token
digest, verified machine public key, machine key ID and detached signature, received timestamp, sanitized index fields,
R2 key/size, and content state. Bundle fields such as reported time, author,
version, and occurrence count are uploader assertions; don't confuse them with
server-verified facts. Recompute grouping fingerprints using the current
normalizer for accepted product fields and retain the declared version too.

R2 key: `submissions/<submissionId>/<digest>.json`. Use conditional creation.
After immutable R2 persistence, insert D1 acceptance atomically. A duplicate
winner returns its receipt if identities match. A different digest may leave
an unaccepted R2 candidate; the orphan sweep removes only values not referenced
by D1 after a 24-hour grace. Failed requests do not become dashboard reports.

Keep remote original bundles for 90 days from receipt by default. Preserve
explicitly pinned active investigation content; disclose this in settings and
report preview. The operator can change retention as deployment policy and
must publish that policy to clients. Keep report status/fix metadata while an
investigation is retained, excluding raw narrative/evidence once expired.

`DELETE /v1/problem-reports/submissions/:submissionId` with its receipt secret,
or an authorized developer operation, immediately marks content inaccessible
and clears report-derived text/index details. Remove the R2 object and linked
exemplar copies asynchronously, retrying failures through the storage-owner's
scheduled sweep. Return pending/completed deletion status. Do not promise
immediate removal from provider-managed backups; disclose their retention.

Keep a minimal idempotency tombstone (ID, digest, receipt-secret digest, accepted
time, deleted/expired status) for 365 days. A replay cannot restore deleted
content during that window. Refuse new submissions whose declared creation time
is over 30 days old; existing accepted-ID status/retry handling precedes that
age check. Thus expired tombstones cannot resurrect an old valid upload without
an intentionally changed submission identity. Clock-skew exceptions are not
guessed: return a clear rejection and let the user prepare a current revision.

Restrict administrative reads and SQL to the developer key. R2 remains private;
downloads require authorization and use no-store/no-sniff headers. Local export
files are the user's responsibility to share; they never contain the receipt
secret, private signing key, or developer key.

## 12. Capture coverage and implementation gates

| Failure owner         | Required observation / verification                                                                                                                  |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service/RPC           | Entire validation/admission/handler outcome and terminal stream errors; preserve origin ID through HTTP, session, worker/DO paths.                   |
| Agent trajectory      | Exact terminal failed invocation plus retry/recovery observations projected from durable events with replay cursor.                                  |
| Build/activation      | Exact unit/build/revision diagnostics; user-source failures remain manual, not automatically product defects.                                        |
| Panel/mobile/headless | Render and initialization failure, main-frame load, renderer exit; no duplicate occurrence when console and lifecycle reflect the same known origin. |
| Background work       | Permanent readiness, scheduled-work, and supervision failure at the owning lifecycle boundary; retain original fault and later recovery.             |
| Server/main/bootstrap | Host-local unhandled failure and supervisor process-exit observation; useful even before pairing/server readiness.                                   |
| Quality feedback      | Selected message or user-authored symptom with no exception; same narrative and approval contract.                                                   |

Audit each path before claiming complete capture; document paths without exact
causal joins instead of inventing them. Capture remains independent of reporting
credentials, network, model provider, and reporting consent.

Acceptance must prove: no automatic report or detailed analytics traffic before consent; no retrospective
automatic backlog; opt-out/claim races; independent user/device consent; no
automatic free-text leak; exact preview/upload/export identity; duplicate receipt
recovery; bounded all-unique storms; partial/denied/expired collectors; large
agent narrative; manual reporting while opted out; deletion replay prevention;
and owned inspector/test-instance cleanup. Fixtures assert sentinel secrets,
workspace text, and conversation snippets never appear in automatic bundles.

## Machine signatures and draft identity ownership

Submission needs no account, login, enrollment, submission token, or CAPTCHA. The host silently generates one Ed25519 machine key in its existing encrypted external secret store. Desktop clients sign locally, even when using a remote server to transport bytes. Agents never receive the private key. Every submission has a detached signature persisted with its frozen local submission; retries reuse it.

Headers: `x-report-public-key` is 64 lowercase hex characters (32 raw Ed25519 public-key bytes); `x-report-signature` is 128 lowercase hex characters (64 signature bytes). Signed UTF-8 bytes are `vibestudio.problem-report-signature.v1`, fixed destination, submission UUID, content SHA-256 digest, and receipt-secret SHA-256 digest, separated by a single newline, with no trailing newline. Verification binds both the exact content and the deletion capability. TLS transports it. Receipts are authenticated by TLS and a per-report capability, not a server signature.

D1 stores `signing_public_key`, `machine_key_id` (SHA-256 of raw public-key bytes), and `signature`. The public-key index and `machine_overview` permit joins and distinct-machine aggregates across manual/automatic reports. Signatures prove key possession, not a person, hardware uniqueness, truth of report content, or trust in agent-authored narratives. Rate limiting applies both to Cloudflare source IP and verified key. IP values/limiter keys are not persisted with reports. Stable public keys intentionally link reports across opt-out/re-enrollment; key loss/profile reset yields a new identity. Replay-protection tombstones retain signature metadata for their bounded lifetime.

Draft `update(id, expectedRevision, content)` accepts only `problem`, `references`, `narrative`, `evidence`, and `attachments`. The host preserves consent/environment/provenance, computes the fingerprint, increments the revision, and assigns a new submission UUID. `reportDraftContent(value)` extracts editable fields. Stale revisions fail without mutation. Narrative also has revision-checked `appendNarrative(id, expectedRevision, sections)` and `patchNarrative(id, expectedRevision, sectionId, changes)`: the host assigns section IDs and derives `author` from the verified caller (`user` for the trusted human UI, otherwise `agent`), section ID and author are immutable, and only a human caller may edit user-authored sections. `prepare(id, revision)` returns `{ revision, submissionId, digest, bytes }`; if sanitization changes content, the sanitized draft is saved as the next revision and that revision is frozen, so the frozen bytes always equal a stored revision. Send refers to that exact host-issued revision/digest.

Aggregate usage uses the distinct identifier-free contract in [usage analytics](usage-analytics.md). An empty startup ping is not a problem report, has no signing key or payload, and updates only a UTC-day total. Detailed usage counters require improvement opt-in.
