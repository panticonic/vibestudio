# Error reporting and “Help vibestudio improve” implementation plan

Status: proposed implementation sequence, 2026-09-29.

Detailed implementation contracts:

- [Data, collection, consent, and delivery](problem-reporting-data-contract.md)
  specifies payloads, budgets, capture coverage, storage, receipts, and deletion.
- [First-use UI and agent assistance](problem-reporting-user-and-agent-flows.md)
  specifies opt-in/out, manual reporting, and the Base problem-reporting skill.

These companion contracts refine the corresponding sections below. There is
one report pipeline for automatic diagnostics and user-reviewed problem reports.

## Outcome

A user can report a crash, failed operation, stuck workflow, or disappointing
result from the place where it happened. The report already contains relevant,
bounded evidence. The user can investigate locally, inspect the exact content
to be shared, and send it to vibestudio. Submission survives disconnects and
restarts, produces a receipt, and can eventually link to a verified fix.

First use requires an explicit choice to enable automatic technical diagnostics
or keep them off. Opting out never prevents manual reporting. A Base agent can
help prepare an evidence-linked report with substantial narrative for user
review. The `vibestudio-dev` workspace provides overview, SQL investigation, and
the report-to-self-development loop.

The first externally usable release includes actual intake and acknowledgement.
A composer that only saves drafts is an intermediate milestone.

## 1. Existing foundations and design ownership

Use these existing mechanisms as evidence sources:

| Foundation | Current source | Planned integration |
| --- | --- | --- |
| Typed service failures | `packages/shared/src/serviceDispatcher.ts`, `packages/rpc/src/errors.ts`, RPC reply contracts | Observe operation outcomes; preserve failure identity through forwarding. |
| Unit diagnostics | `src/server/runtimeDiagnosticsStore.ts`, `src/server/bootstrap/runtimeObservability.ts`, runtime supervision | Attach exact unit health and bounded retained logs. |
| Host logs | `src/server/services/serverLogStore.ts` | Attach bounded records with boot identity and sequence coordinates. |
| Panel lifecycle | `src/main/cdpHostProvider.ts`, `src/main/workspaceRuntimeController.ts` | Observe crashes/load failures and retain their panel coordinates. |
| Startup/main-process errors | `src/main/index.ts`, `src/main/startupDiagnostics.ts` | Persist incidents before workspace services are available. |
| Agent failures | Base `packages/agentic-protocol/src/tool-failure.ts`, `gad.diagnoseInvocation()` | Keep the existing failure value and exact causal packet. |
| UI-to-agent feedback | Base `packages/agentic-do/src/feedback-ingest.ts`, chat `CustomMessage.tsx` | Associate UI failure evidence; retain existing local agent recovery behavior. |
| Panel investigation | Base `packages/runtime/src/panel/errorDebugChat.ts` | Open investigation from an incident using the existing diagnostic launcher. |

Base and System paths below refer to the configured external template checkouts,
not new copies inside the host repository.

The draft `docs/log-watcher-spec.md` and `docs/system-agent-tools-cards-spec.md`
already describe incident detection and presentation. Reconcile those drafts
with this implementation before introducing their stores: one incident owner,
one fingerprint implementation, and one incident-card projection. A future log
watcher produces incident observations through this contract; it does not own
a second incident database. Watcher/model-based triage is not a prerequisite
for user reporting. This plan owns reporting storage, export, and delivery;
the existing drafts continue to describe the broader System Agent programme.

Ownership:

- **Host:** capture, local persistence, verified origin/visibility, evidence
  limits, immutable export bundles, and durable submission delivery.
- **Base:** portable report contracts/client helpers and integration at reusable
  panel/chat error surfaces. No dependency from the host on Base packages.
- **System:** report composer/history, shell entry points, and local investigation
  presentation. System does not independently persist a second report history.
- **Vibestudio intake:** receipt deduplication, restricted evidence storage, triage,
  and resolution status.

The hosted intake is API-only. Management/triage UI lives inside the planned
`vibestudio-dev` workspace; this project supplies storage and authenticated data access.
The local report composer described below is the submitting user's product
flow, not a separate hosted administrative dashboard.

This keeps capture and queued submissions alive when the failing component is
a System worker or panel. Product UI remains ordinary workspace source.

### Valuable ideas incorporated from the drafts

| Idea | Concrete adoption |
| --- | --- |
| Mechanical facts remain visible | Incident cards always show component, code, first/last occurrence, counts, and evidence completeness beside any generated summary. |
| Small exemplars plus exact refs | Cards carry at most three 500-character exemplars; expanded log-excerpt cards show at most 20 records of 500 characters each. Full selected evidence stays in the report snapshot, not the card payload. |
| Inspectable silence | History shows suppressed notifications and capture drops, with reason and counts. Muting alerts does not delete evidence or disable reporting. |
| One live storm card | Repeated symptoms update one source-scoped card; a change in dominant failure shapes can update its explanation without producing one alert per log line. |
| Explicit investigation | Forward an incident card as a human turn, with bounded exemplars and exact refs; no automatic tool-enabled repair agent. |
| Derived summaries | Summaries, grouping views, and notification decisions are rebuildable projections. They never become the original failure or user report. |
| User decisions survive evidence expiry | Keep notification preferences separately from expiring log exemplars; an expired incident does not undo a mute or follow preference. |

Two draft choices change deliberately. Notification suppression defaults to the
acting user and affected component; shared suppression requires explicit
workspace operator authority and attribution. Similar text across components
can suggest a triage group but cannot silently share severity or suppression.
This preserves component ownership and avoids one noisy source hiding another.

The draft storm sampler hashes every line to detect novelty before sampling.
That cannot bound work for a stream of unique messages. Instead enforce byte
and queue bounds before normalization, count raw ingress at the source, and
declare sampled/dropped evidence honestly. Novelty detection is best effort
under overload; the UI must not promise that every novel shape was retained.

## 2. Three records with different lifetimes

Define Zod wire schemas in proposed `packages/service-schemas/src/problemReport.ts`.
Use the same schemas for typed RPC clients, validation, and receiver tests.

### Incident: what was observed

An incident has `incidentId`, observation time, verified origin, component,
operation/stage when known, product/template/build versions, existing failure
data, evidence references, fingerprint/version, and occurrence counts.

Preserve `agent-tool-failure.v1`, RPC categories, error codes, and typed details
as their existing values. The incident envelope adds provenance and references;
it does not replace domain failure contracts or change retry behavior.

Evidence references are a discriminated union:

- server logs: workspace, server boot, sequence range;
- runtime logs: workspace, unit identity, sequence range;
- agent evidence: trajectory, branch, invocation, and available causal IDs;
- panel evidence: device/process boot, panel identity, runtime attempt;
- build evidence: build key and available publication/workspace-state identity.

An absent coordinate stays absent. Never infer a causal relationship from nearby
timestamps, a matching message, or a similarly named operation.

### Report: what the user wants to communicate

A report has `reportId`, authenticated owner, revision, optional incident/message
references, user description, expected/actual behavior, evidence selections,
and local workflow state. A report without an incident is valid: “the agent
gave me the wrong answer” must use the same composer.

Its intent is either `automatic-diagnostic` or `manual-problem`; both use the
same schema/store/encoder/delivery path. Agent-written narrative is first-class,
with multiple Markdown sections, evidence links, author provenance, and observed/
inferred/unverified claims. Full narrative lives in the bundle; overview cards
use a separate bounded summary.

Drafts are mutable. Investigation status and remote resolution status are
separate from delivery status; receiving a report does not mean fixing it.

### Submission: the exact approved content

A submission has `submissionId`, report revision, schema version, immutable
manifest and attachment bytes, content digest, approved destination, approval
record, delivery state, and eventual receipt.

Manual approval binds the user-reviewed revision/digest. Automatic approval
binds the current explicit enrollment decision and the restricted field policy;
it cannot include narrative or arbitrary logs. The sender rechecks the applicable
consent revision before each attempt.

Preview and submit use the same frozen bytes. Retries never recollect logs,
add later conversation messages, or change attachments. Editing after freezing
creates a new report revision and requires a new preview before submission.

## 3. Storage and API

Implement proposed `src/server/services/problemReporting/` with store,
collection, export, and delivery modules. Declare its paths in `stateLayout.ts`.
Use `@vibestudio/sqlite` canonical schema lifecycle for the incident/report/
submission database. Store bounded attachment values by digest, with explicit
report/submission references governing retention.

Use one canonical installation-owned reporting store/outbox, located under the
owned server's state root or the client profile's state root. Workspace and
device attribution are verified row scopes, not separate competing outboxes.
Consent and automatic allowance are stored with that installation's queue so
revocation and cancellation can commit atomically. Server and client capture
installations remain independent. Device failures recorded before workspace
selection are not implicitly visible to workspace members; only authorized
selection attaches them to a workspace-scoped report. Opening a workspace never
grants blanket access to other rows in the same physical store.

Proposed `problemReport` RPC methods:

| Method | Contract |
| --- | --- |
| `list`, `get` | Read owner-visible drafts, incidents, and delivery/receipt state with bounded pagination. |
| `availability` | Read destination/policy, connection state, capture scope, and supported limits without credentials or hidden setup effects. |
| `consent.get`, `consent.set` | Read/change the initiating human's installation preference with expected revision; agents cannot grant consent. |
| `create`, `update`, `delete` | Manage a report; updates require the expected revision. Deletion distinguishes queued from already received content. |
| `collect` | Read permitted evidence for explicit coordinates, snapshot it, and return per-section completeness. |
| `prepareSubmission` | Freeze selected evidence and return the preview manifest and digest. No network transmission. |
| `submit` | Queue the exact reviewed digest for the authenticated human and approved destination. |
| `export` | Produce the same reviewed bundle as a local file. |
| `cancelSubmission` | Stop further delivery attempts; explain that an already accepted upload cannot be recalled locally. |
| `submissionStatus`, `deleteRemote` | Recover a receipt or delete received content with report-scoped authority; retain pending deletion status. |

Observation is an internal sink, with verified runtime ingress where necessary;
it is not a general RPC allowing arbitrary callers to invent host incidents.
Do not accept caller-supplied ownership or severity as trusted host facts.

Use existing service authority preparation to bind external transmission to
the destination and immutable bundle digest. System chrome can submit as the
human; ordinary agents can help draft or investigate but cannot grant sharing
consent. This is the report composer's Send action, not a second confirmation
after it. Automatic delivery derives authorization from the exact durable human
opt-in and current allowlist; it never self-approves richer report content.
Generated service clients/catalogs and authority declarations must
be updated through the repository's normal generators.

Collection must enforce underlying workspace, channel, context, and device
visibility. Knowing an incident or invocation ID grants no access. Avoid a
cross-workspace “collect everything” operation.

## 4. Capture and correlation

Add one observation sink to operation/lifecycle owners. It must not await
network I/O, call back through the observed service dispatcher, or change the
original exception, return value, or cancellation behavior.

For service calls, cover the entire dispatch outcome, including validation and
admission failures that currently occur before the handler's try/catch. Cover
stream termination at the owner of the stream, not just successful stream
creation. Exercise direct, worker/DO, HTTP, and session-backed call paths.

Add optional diagnostic origin identity to the structured RPC failure envelope,
outside `errorData`, so existing typed payloads retain their shape. Forwarding
preserves the origin identity. A boundary that adds transport/cleanup failure
retains the original failure and records the additional cause. Make wire
contract/catalog changes together; do not add alternate transport paths.

Existing durable trajectory failures remain authoritative. Derive their
incident observation from retained terminal events using an idempotent exact
coordinate and recoverable cursor. Do not make agent success/failure settlement
depend on a second incident write. Reprocessing an event must be harmless.

Console error records lacking structured identity can produce unattributed
symptoms. They do not prove an exception is unhandled or that two records share
a cause. Prefer typed failures for automatic incident classification; use log
level only to mark log-derived symptoms.

Cancellation, human denial, and lease/reconnect transitions retain their domain
meaning. They remain available as context but do not automatically generate
defect notifications. Recovered incidents retain a recovery observation.

Separate exact deduplication from defect grouping:

- Origin/event coordinates deduplicate one propagated occurrence.
- A versioned fingerprint groups similar occurrences by component, operation,
  stable error code, and normalized product stack frames. Strip volatile
  addresses/paths; omit user prose and conversation content from the signature.
- Missing causal identities never trigger invented joins. Fingerprint matches
  are similarity groups, not proof of a common root cause.

Bound background capture by records and bytes. Count and expose dropped
observations; coalesce repeat counts without scheduling an agent turn. A sink
failure goes to a guarded stderr fallback and does not report itself recursively.
Explicit report persistence/queueing must return a storage failure to the user;
it cannot claim “saved” when background capture failed.

## 5. Evidence collection and sharing

Use supervision health/logs, server-log queries, panel diagnostics, structured
build diagnostics, and `gad.diagnoseInvocation()` as collectors. Snapshot the
smallest relevant packet when an incident is retained, then collect additional
authorized sections when the composer opens. Full trajectories are an explicit
user selection, not the default.

Exact collector selection and budget behavior are defined in the data contract:
100 runtime/100 server records, one bounded causal packet, 256 KiB diagnostics,
128 KiB narrative, five attachments/7 MiB decoded, and 10 MiB encoded total.
Automatic diagnostic bundles are limited to 16 KiB and the content-free field
allowlist. All collectors share a five-second deadline and allocated budgets.

Every section declares `complete`, `truncated`, `unavailable`, or `denied`, its
source coordinate, and capture time. These are collection limits, not changes
to the original evidence sources. A broken server must not prevent reporting
the locally available device failure.

Automatic external selection: product/OS versions, product component/operation,
stable codes, normalized known product frames, observed counts/times, and a
disclosed random installation pseudonym. No raw exception/log prose is automatic.
Manual reports add user text and selected user/agent narrative; diagnostic
excerpts, conversation messages, source snippets, screenshots, and state args
remain visible selections. Raw environment variables, credentials, cookies,
account tokens, and whole workspaces are never automatic attachments.

Use typed field allowlists, registered-secret redaction, and URL/path
normalization before freezing the export. Existing secret regexes are additional
protection, not a proof that arbitrary logs are safe. The user can remove a
section and inspect its final content. Keep original local evidence separate
from the reviewed sanitized export; models may summarize but cannot silently
change the submitted evidence.

Initial retention: automatic incident snapshots expire after 14 days; cap
unreferenced incident evidence at 50 MiB per store, evicting oldest first with
visible loss counts. Drafts and queued submissions are explicit retention roots.
Cap total report storage at 200 MiB and reject new large attachments with an
actionable storage message rather than deleting user drafts. Received exports
expire locally after 30 days unless retained by the user. Keep local files
restrictive and exclude this evidence from public VCS publication.

## 6. User experience and crash handling

Add System `about/problem-reports/` for the shared composer and report history.
Add first-use opt-in/off choice and a settings section backed by host-owned
consent. Use the consistent **Report a problem** action in Help/command palette,
error surfaces, selected chat messages, startup recovery, and settings. Route all entry points
through the same local draft service with typed incident/message coordinates. The host assigns revisions and submission IDs; clients edit only content.

The composer asks “What should have happened?”, shows the observed behavior
and selected evidence, and offers Investigate locally, Save, Export, and Send.
It renders report text and logs inertly. Local investigation is user-initiated
and uses the existing panel diagnostic launcher or System Agent entry point;
incident capture alone never starts paid model work.

The first-use dialog offers **Enable automatic reports** and **Keep automatic
reports off** equally, with no preselected answer. A choice is required to
dismiss it; either answer permits normal use. Unknown consent fails closed.
Settings can revoke enrollment and cancel queued automatic reports. Manual
reporting remains available while opted out. Follow the companion UI contract
for exact copy, accessibility, scope, and reconnect behavior.

Add Base `skills/problem-reporting/` for ordinary agents to collect authorized
evidence, preserve the user's words, write a detailed narrative, and open the
same reviewed composer. It does not need a developer key or SQL privileges.
This is separate from `vibestudio-dev`'s developer `error-investigation` skill.

On an exception before workspace startup, write the same minimal incident
envelope through a host-local capture owner. Update startup recovery UI to show
that incident and export/report it. For main-process failure, persist before
attempting notification. Replace production reliance on the test-only
`mainProcessErrorLedger` with this capture path while retaining test inspection.

Unexpected child-process exits can be observed by their supervisor. Native
process termination cannot reliably execute JavaScript handlers; record the
supervisor's exit observation on restart. Native minidump collection is a later
feature, not a promise of this implementation.

## 7. Durable delivery and vibestudio intake

Client delivery state: `queued -> sending -> received`, with retryable attempts
returning to queued, signature/policy/stale-queue issues as `paused`, permanent
content rejection as `rejected`, and cancellation as `cancelled`. Reclaim
interrupted sending attempts after restart. One lease
owns an attempt; cancellation prevents new attempts but cannot undo an accepted
request. Persist the immutable bundle before acknowledging queueing to the UI.

Retry temporary network failures, 429, and server failures with bounded
exponential backoff and jitter; honor Retry-After. Permanent validation or
authorization rejection stops retries and leaves the export available.

Define a transport-independent HTTP contract:

- `POST /v1/problem-reports`: bounded manifest and attachments, submission ID
  as idempotency key, and bundle digest.
- Return a durable receipt only after all referenced content is stored.
- Repeated ID + identical digest returns the same receipt; different digest
  rejects with conflict.
- Create a report-scoped receipt secret locally before sending; store its digest
  remotely. Exact status/deletion paths and recovery after a lost acknowledgement
  are defined in the data contract; the secret grants no listing or other-report access.
- Validate schema/size, apply abuse limits, and keep submitted content private.

### Hosting decision: existing Cloudflare Worker, D1 index, private R2 bundles

Add the intake module to `apps/webhook-relay`, served under the existing
`https://vibestudio.app/v1/problem-reports` route. Bind a dedicated D1 database
and private R2 bucket in that Worker's deployment configuration. Keep intake
independent of `RelayRegistry`, OAuth handoff, and workspace backhaul availability:
it is an ordinary request handler with its own storage bindings. Do not add a
new global Durable Object, queue, or separate server for report receipt.

- **D1:** one row per accepted submission, with unique submission identity,
  digest, receipt ID, received time, report kind, component, fingerprint,
  product/template versions, status, and bundle key/size. Index received time,
  status, component, and fingerprint. This is the authoritative acceptance and
  status record; it is not a second copy of the full evidence payload.
- **R2:** one immutable, self-contained bundle per submission containing the
  versioned manifest, report text, selected diagnostic JSON, and attachments.
  Store it under `submissions/<submissionId>/<digest>.json`; the key does
  not contain email addresses, workspace names, or message content. Use one
  documented bundle encoding, shared by local export and network submission.
- **Read API:** authenticated paginated list/filter, report metadata, and bundle
  download endpoints for the owner's vibestudio UI. Read access is distinct from
  submission permission and report-scoped receipt/status access. The bucket
  has no public listing or public object URLs.

Receive and validate the bounded bundle, recompute its digest, durably write
the immutable R2 object, then atomically insert the D1 acceptance row with its
uniqueness constraint. Return the receipt only after both operations succeed.
Concurrent retries resolve against that row: identical ID/digest returns the
same receipt, and different digest returns conflict. R2 writes use conditional
creation and verify existing object metadata on retry. There is no cross-store
transaction: a crash before the D1 insert can leave an unaccepted object, which
the retry can reuse. A scheduled sweep removes only unreferenced objects older
than a grace period exceeding the maximum in-flight request duration.

Implement and test this receiver locally before production integration.
Submission is anonymous, automatically machine-signed, and rate-limited; only developer administration requires a key. The data contract defines initial remote retention/deletion policy;
configure the actual deployment credentials and publish that policy before launch.
No shared product-wide secret
is embedded in distributed clients, no arbitrary caller-selected upload URL,
and no automatic public issue creation.

Use D1's SQL index for filtering without downloading/scanning bundles. Keep
portable JSON inside the bundle so vibestudio can analyze or export the evidence
without a vendor-specific event model. No hosted triage UI, automatic model
processing, or third-party crash-management integration is needed for this cut.
If those become useful later, consume this stored data through the API.

Storage choice verified against Cloudflare's
[storage guide](https://developers.cloudflare.com/workers/platform/storage-options/),
[D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/),
and [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

### Developer authentication and write rate limits

Submission is anonymous and requires no login, account enrollment, configured submission key, or interactive challenge. Every capture machine automatically creates one Ed25519 key in the host's encrypted, sandbox-external secret store. Multiple workspaces/connections in the same host profile reuse that key. A new profile or erased key creates a new identity; this is proof of key possession, not hardware attestation or an authenticated person.

Every POST carries a detached signature, raw 32-byte public key, unique submission UUID, exact canonical-content SHA-256 digest, and independent random receipt secret. The domain-separated signed bytes bind the fixed destination, submission UUID, content digest, and receipt-secret digest. The server verifies before accepting content. Store the public key, its SHA-256 machine key ID, and signature with the submission. Index the raw public key for joins/filters and expose distinct-machine counts and `machine_overview`. No registration database is necessary. A signer can create unlimited new keys, so a verified signature alone is not an abuse control.

The private key never crosses a workspace boundary or enters RPC, reports, logs, or SQL. Each local submission persists its detached signature so retry/restart or key replacement does not change an ambiguous submission. The public key links manual and automatic reports from this machine, including across opt-out/re-enrollment; disclose that clearly. Opting out stops sharing, not identity rotation. Server and desktop capture sign on their originating host, including when desktop delivery uses a remote host transport broker.

Developer administration uses independently rotatable 256-bit bearer keys. Store only key IDs and SHA-256 digests in the Worker `REPORT_KEYS` secret. Enter developer keys once through the existing host credential UI; the sandbox-external secret store and URL-bound broker inject them only at the admin path. Workspace code receives an opaque credential ID, never the token. Keys grant reporting administration and direct SQL on this database, not Cloudflare account or relay/OAuth access. No login website, password database, or OAuth provider is required.

| Route class | Initial limit | Enforcement key |
| --- | --- | --- |
| Report submissions | 20 requests/minute per boundary | Hash of Cloudflare-provided source IP before body read; verified machine public-key digest before storage |
| Metadata mutations | 30 requests/minute | Verified developer key ID |
| Developer SQL | No application rate limit | Verified developer key ID |
| Dashboard/list/download requests | 120 requests/minute | Verified developer key ID |
| Receipt status/deletion | 20 requests/minute | Verified receipt-secret digest |
| Failed administrative/receipt authentication | 20 failures/minute | Hash of Cloudflare-provided source IP |

Use distinct Workers limiter namespaces. Transient IP-derived limiter keys are not stored in submission rows or SQL audit. Only trust Cloudflare's injected source-IP metadata. Stream body limits reject oversized/compressed bodies before any storage. Return 429 with Retry-After; retry the same frozen UUID, bytes and signature. Duplicate attempts consume allowance but do not duplicate acceptance. Public intake works without `REPORT_KEYS`; missing developer configuration denies administration.

Workers rate limits are eventually consistent and per Cloudflare location, not exact global quotas. Payload bounds, signature verification, private storage and IP limits are independent controls. An exact global admission budget, if later needed, belongs at one storage owner. Tests cover unregistered signed submission, forged signatures, content/receipt binding, replay/conflicts, machine aggregation, protected administration, limits with no writes, and lost-ack recovery.

References: [Workers Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/), [Workers rate limits](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

### Administrative SQL access

SQL is exclusively a developer investigation capability in `vibestudio-dev`, after reports have arrived. The Base problem-reporting agent never uses SQL or developer credentials: it prepares a local report, and the user reviews and sends it through anonymous signed intake. Developer SQL is unrestricted at the application layer; public report-submission limits are independent.

Expose `POST /v1/problem-reports/admin/sql` with `{ sql, params }`, authenticated
only by the developer key. Execute parameter-bound SQL through the dedicated
D1 binding and return the complete result and affected-row metadata. Developers
have full read, write, and schema authority on the canonical database. There
are no application query-size, parameter-count, row-count, response-size, or SQL
rate caps, no SELECT-only restriction, and no mandatory LIMIT. D1/Workers' own
platform limits still apply and execution errors are surfaced. Aggregation and
pagination are useful choices for agents, not restrictions on developer access.

Keep the anonymous-intake limiter separate. Dashboard overview/list endpoints
can paginate for usability; the SQL endpoint exposes all data directly.
Capture key ID, request time, query digest, outcome, and affected-row counts in
operational audit records; never log credentials or raw parameter values.
Audit is diagnostic, not tamper-proof against an administrative SQL operator.

Schema introspection should return the current actual table/view definitions.
Keep original submitted evidence immutable in R2. Normal triage updates affect
separate D1 investigation/status records and leave the accepted bundle intact.
Provide a documented backup/export and restore procedure before allowing
write-enabled agent SQL against production developer data.

References: [D1 prepared statements](https://developers.cloudflare.com/d1/worker-api/prepared-statements/), [D1 platform limits](https://developers.cloudflare.com/d1/platform/limits/).

Triage first separates product defects, workspace-source problems, provider/
infrastructure failures, and quality feedback. Grouping can suggest duplicates;
retain each report's context. Any automated summary is a derived view with links
to evidence. Treat submitted content as untrusted data, including when agents
inspect it. Reproduction runs use isolated environments and explicit authority.

Resolution links a report/group to a focused regression case, fix, verification
evidence, and release version. Status is available from report history; email or
other outbound messages are outside the initial implementation.

## 7a. The `vibestudio-dev` workspace

Create an independent developer workspace/template named `vibestudio-dev`, using
the ordinary external template authoring and import flow described in
`docs/official-template-repositories-plan.md`. It declares Base dependencies;
the account's existing System workspace continues to own DevelopmentDO and
system-test tooling. Discover those ordinary services rather than copying
System workers into this template. Inspect composition before declaring any
additional dependencies. No privileged new workspace kind or special host
bootstrap flag is required.

Proposed locally owned parts:

| Part | Responsibility |
| --- | --- |
| `panels/error-dashboard/` | Overview, drill-down, selected evidence, investigation actions. |
| `workers/error-reports/` | Ordinary workspace service that calls the Cloudflare API through mediated credentials; query/schema, dashboard, evidence, and investigation helpers. |
| `skills/error-investigation/` | SQL-driven triage and the report-to-self-development workflow. |
| `meta/vibestudio.yml` | Template dependencies, source declarations, and required unit/capability manifests; no concrete credentials. |

The service registers through existing workspace-service discovery. It owns
neither a replicated error database nor Cloudflare credentials. Declare ordinary
egress/credential-use authority and explicit SQL/investigation authority in its
manifest. The published workspace is reusable source; each actual installation
connects its own key and separately adopts source repositories. Start with a
private developer instance; add discovery-catalog publication only if wanted.

Import the current host as `projects/vibestudio` and bind/adopt Base, System,
and `vibestudio-dev` source through the existing self-development import and
development-session flows. Record actual upstreams and revisions rather than
guessing from report filenames. The dashboard itself can be improved through
the same workflow. Template publication must exclude imported application
repos, concrete accounts, report evidence, and credentials.

### Dashboard: overview to investigation

Open with a useful 24-hour / 7-day / 30-day overview:

- report volume over time; new/recurring fingerprints; open, investigating,
  fixed-awaiting-verification, and resolved groups;
- top affected components and product/template versions, showing counts and
  first/last seen; new failures since a selected release;
- technical failures versus quality feedback; recent high-impact crashes;
- active investigations, stale investigations, and links to test/fix evidence.

Use shared filters for time window, component, version, failure code/kind,
fingerprint, and status. Cards/charts link to the exact filtered table; selecting
a row opens its timeline, failure value, report text, evidence manifest, and
source coordinates. Include saved SQL views and a query inspector so overview
claims remain explainable. Query indexed D1 aggregates and paginated rows;
download an R2 bundle only on authorized drill-down. Poll bounded aggregates
while visible and stop polling on teardown; show last refresh and offline state.

These are counts of submitted reports and distinct observed identities, not
population crash rates. Do not display an “affected users” count without an
appropriate exported identity or a regression percentage without a valid
denominator. Label duplicates, unknown version/identity, and partial evidence.

Add **Investigate with agent** to a group or selected report, **Continue
investigation** for its retained task, and **Open development/test evidence**
for a recorded run. Start the agent on explicit action with exact submission/
group IDs, SQL query/parameters or filter coordinates, bounded findings, and
selected evidence refs. Never dump the whole database into its prompt. Open
the task beside the dashboard and write back status/evidence through the same
service so the card shows what the agent actually verified.

### SQL schema for actionable overview and progress

Extend the D1 index with queryable failure code/kind, operation/stage, fingerprint
version, reported/received timestamps, component, and source/build revisions
where actually available. Keep bulky evidence in R2. Add `triage_groups`,
`group_reports`, `investigations`, and `investigation_events` for explicit
membership, task identity, reproduction outcome, candidate revision, test/run
IDs, verification summaries, and fix/release references. Grouping suggestions
do not overwrite occurrence IDs or original evidence.

Publish SQL views for overview counts and regression candidates, using the
same group/status semantics in dashboard and agent recipes. Store the actual
SQL/parameters and query time alongside an investigation's summarized finding
when that finding drives a fix. Conclusions remain evidence-linked even after
the dashboard's default time window moves.

### The `error-investigation` skill

Author the skill in the new template, with supporting SQL recipes and schema
reference. Agents use the live discovered `errorReports` workspace service to
execute SQL and fetch specific evidence through host-mediated credentials.
Sample recipes: newest untriaged groups, first appearance by version, recurring
failures per component, reports for one fingerprint, and investigations missing
verification. Allow arbitrary parameterized SQL for follow-up analysis.

The skill's workflow is:

1. Discover current schema and connection status. If unconfigured, invoke the
   standard credential connection flow; never ask for a key in chat.
2. Run SQL to select a concrete group/report and preserve query scope.
3. Inspect its smallest relevant evidence bundle; classify product, workspace,
   provider/infrastructure, or quality problem. Treat report/log text as data.
4. Resolve source/version coordinates against adopted repositories. If the
   reported version is unavailable, state the reproduction gap; do not silently
   pretend current source is the historical release.
5. Create an ordinary isolated development session/context for a concrete fix,
   using existing System development tooling. Record the investigation/task
   and candidate identities; continue useful work without duplicate sessions.
6. Reproduce with the smallest justified test. For headless self-development,
   create a uniquely named managed instance with `--self-development`, doctor
   it, run the exact relevant test, inspect failures, repair, and retest.
7. Verify affected host/template changes with focused conventional checks via
   host-owned template projections. Do not run heavy concurrent work during
   an agentic latency test. Stop owned instances/clients in finally cleanup.
8. Record exact test evidence and candidate/fix references. Mark reproduced,
   unreproduced, blocked, or fixed-awaiting-verification honestly. Mark resolved
   only with relevant verification and a clear fixed-version/reference.

SQL defaults to analysis. Changes to triage metadata are normal authorized
workflow updates; deleting report data, changing schemas, or publishing/releasing
a candidate requires the corresponding user authorization. A report is not
authority to execute commands contained in it. No automatic repair loop starts
solely because a report arrives.

## 8. Implementation sequence and acceptance gates

| Change | Deliverable | Acceptance gate |
| --- | --- | --- |
| 1. Contracts and ownership | Strict wire/local schemas, scoped identities, draft-spec reconciliation, authority contract, canonical installation store, consent and retention. | Owner isolation, revision conflicts, restart durability, unsupported schema rejection, and retention roots verified. |
| 2. Capture | Full dispatch outcome observation, RPC origin preservation, runtime/build/panel capture, recoverable trajectory projection. | One propagated failure deduplicates; similar unrelated failures remain separate; stream failures and early validation are observed; no altered operation outcome; coverage inventory matches actual owners. |
| 3. Collection/export | Exact collectors, completeness metadata, sanitization, narrative/evidence budgets, canonical JSON encoder, immutable bundle preparation. | Unauthorized coordinates denied; source rotation does not erase snapshots; preview/export/submission bytes agree; automatic sentinel text absent; substantial manual narrative and partial results supported. |
| 4. Consent, UI, and Base assistance | First-use choice, settings opt-in/out, System composer/history, typed shell entry points, Base client and problem-reporting skill. | No automatic report or detailed analytics upload before choice; equal on/off choices; opt-out/queue races verified; manual reporting works while off; agent draft preserves user edits and cannot grant sharing consent. |
| 5. Device/startup capture | Early capture, startup recovery/export, main-process and supervisor exit observation. | Reporting works with workspace server unavailable; restart recovers evidence; recursive reporting failure stays bounded. |
| 6. Delivery and intake | Durable outbox, Cloudflare intake module, D1/R2 bindings, scoped keys, rate-limit bindings, status/deletion protocol and fixture. | Lost acknowledgement/restarts produce one receipt; auth/429/payload rejection prevents writes; opt-out respected; deletion replay cannot restore data; partial cross-store writes recover safely. |
| 7. Developer workspace/dashboard | Private `vibestudio-dev` template, mediated API service, SQL endpoint, D1 triage schema/views, overview and investigation entry points. | Live data is filterable/drillable; SQL queries canonical D1; dashboard carries no key; chart values match query evidence; group selection opens one retained agent task. |
| 8. Developer skill/self-development proof | `error-investigation` skill, SQL recipes, adoption/setup instructions, evidence-to-isolated-fix workflow. | One reported failure is queried, reproduced, fixed in an isolated session, verified, and linked back; owned instances/clients cleaned; unavailable historical source and unverified fixes labelled honestly. |
| 9. Launch | Actual keys and policy configuration, matching host/Base/System/vibestudio-dev publications, API-only hosted backend. | First-use and off behavior verified on a fresh installation; real reviewed and opted-in automatic reports reach private storage; dashboard/skill read actual receipts; expiry/deletion/rotation rehearsed. |

Changes 1-3 precede UI integration; changes 5 and 6 depend on the same canonical
contracts/store. External delivery is never enabled before change 4's consent
gate and change 6's auth/limits pass. Changes 7-9 complete the developer feedback
loop and launch. Default state remains undecided/off throughout incremental rollout.
Do not require the broader System Agent/log-watcher programme to complete first.

### Concrete implementation locations

| Location | Implementation |
| --- | --- |
| Host `packages/service-schemas/src/problemReport.ts` and generated clients/catalogs | Strict methods, records, privacy/byte policy, authority preparation and shell target references. |
| Host `src/server/services/problemReporting/` | `store`, `capture`, `consent`, `collection`, `exportPolicy`, `bundle`, `delivery` modules; one canonical writer per installation. |
| Host `src/server/stateLayout.ts` and reporting bootstrap | Dedicated reporting state paths, owned lifecycle, database initialization, queue recovery and shutdown. |
| Host service/RPC/runtime/build lifecycle owners | Outcome observations and preserved diagnostic origin identity; no console-only claim of coverage. |
| Host `src/main/` startup and client observation paths | Early device capture, first-use/consent bridge, typed shell opening, crash recovery/export. |
| Base `packages/runtime/src/shared/problemReports.ts` and `skills/problem-reporting/` | Public typed client and ordinary user-assistance skill with narrative/privacy/API references. |
| System `about/problem-reports/`, shell first-use/settings/error components | Report composer/history, mandatory choice, settings and discoverable actions. |
| Cloudflare `apps/webhook-relay/src/problemReports/` and deployment config | Auth, rate limits, intake/read/status/delete/SQL routes, D1 schema, R2 bindings and scheduled cleanup. |
| New external `vibestudio-dev` template | Error dashboard, ordinary `errorReports` service, developer skill, SQL views/recipes, self-development setup. |

Tests live beside their owner. Do not introduce an independent telemetry SDK,
duplicate template files in the host repository, or a second credential path.

### Notification policy within changes 2 and 4

Use one incident-card projection in report history and existing notification
surfaces. Do not create a watcher-specific inbox database or event protocol.
Events are invalidation hints; bounded list/get queries recover current state
after disconnection. Report mutations and preference changes carry revisions
and authenticated actor attribution.

Automatically surface user-visible crashes, startup failures, and failed
operations with no recovery surface. Routine typed failures handled by an agent
remain evidence unless the user reports them or the workflow is visibly blocked.
Log-derived symptoms start in history; level alone does not justify a critical
notification. Manual reporting is always available regardless of suppression.

Borrow the draft's mechanical calibration as initial policy, centralized in
one module and tested with a fake clock:

- Update repeated cards in place, with exact observed counts, first/last seen,
  5-minute and 60-minute counts, and component attribution.
- For eligible repeat notifications, use cooldowns of 10 minutes, 1 hour,
  and 6 hours; reset after 24 hours of quiet or explicit re-arming. Merely
  opening a card does not re-arm alerts.
- Enter source storm mode above 120 records/minute for two completed minutes;
  exit after ten consecutive minutes below that threshold. Count incoming
  records separately from retained/sampled evidence and label each correctly.
- Show capture drops and suppression reasons in an expandable history row.
  Per-user mute/unmute changes alert eligibility, not occurrence capture.

No phone pushes are necessary for the first reporting release. If later added,
reuse existing notification transport, cap at four pushes per user per sliding
hour, coalesce overflow, and suppress when that user's desktop is active.
Recipient visibility and device ownership must be checked before fan-out;
workspace incidents are not automatically broadcast to every member.

Optional model-assisted triage comes after the mechanical/reporting loop works.
Run it without tools or write authority, in bounded batches (initially 30 seconds
or 16 items), and persist its output only as a derived suggestion. Provider
failure returns to mechanical presentation. No fallback-model hierarchy or
long-running conversation memory is required for reporting. A model may not
suppress original evidence, declare a verified resolution, or approve sharing.

### Coordinated contract publication

Follow `docs/agentic-upgrade-migrations-plan.md` for host/template ABI changes:
one current schema and writer, exact epoch bump where required, matching Base
and System publications, and no compatibility readers or old/new route coexistence.
Fingerprint/grouping projections can be rebuilt from retained current evidence;
explicit user preferences remain separate durable facts. Test unsupported local
schema rejection unchanged rather than inventing speculative migration machinery.

## 9. Verification workflow

Use focused conventional tests for state transitions, ownership, causal identity,
stream outcomes, evidence selection, byte limits, sanitization, and delivery
idempotency. Failure injection should include disk-full/store failure, an
unavailable collector, disconnect during upload, lost receipt, restart mid-send,
and reporting-sink recursion. A small burst test verifies bounded memory and
exposed loss counts without becoming a general performance project.

Also verify an all-unique-message storm stays bounded, model summaries cannot
replace mechanical facts, mute does not stop capture, expired exemplars do not
reset preferences, and reconnect restores cards without duplicate alerts.

The companion contracts add concrete consent, payload, capture, and narrative
fixtures. Exercise fresh/off/on/policy-invalid states, queued/in-flight revocation,
independent device/user decisions, automatic allowlist sentinel secrets, manual
reporting while off, revision conflicts, large agent narrative, receipt-secret
recovery, deletion tombstones, expired collectors, and key/SQL scope separation.
Use a local Cloudflare fixture for protocol/state failures and verify limiter
bindings, key rotation, and private storage once on a non-production deployment.

Run host typechecks and relevant generated-contract/authority checks. Test Base
and System changes only through host-owned projections, for example:

```sh
pnpm test:userland -- --template base --filter packages/runtime/src/panel/errorDebugChat.test.ts
pnpm type-check:userland -- --template base
pnpm type-check:userland -- --template system
pnpm check:template-checkout-hygiene
```

Add focused System test scenarios alongside the existing System runner:
`problem-report-runtime-failure`, `problem-report-quality-feedback`,
`problem-report-delivery-recovery`, `problem-report-first-use-consent`,
`problem-report-agent-narrative`, and `vibestudio-dev-error-to-fix` (proposed names).
Use an isolated stable
instance ID, run doctor first, and run each exact scenario only when its changed
behavior warrants it. Inspect failed runs and their bounded evidence before
expanding diagnostics. Stop the owned instance in a finally-equivalent cleanup.
Keep agentic latency tests on an otherwise idle host.

Use `--self-development` only for the error-to-fix scenario that actually builds
the adopted monorepo. Import/compose the current `vibestudio-dev` test source through
ordinary template/workspace setup; the existing flag adopts the host and linked
core templates, not an undeclared developer template. Verify the new template
through its host-owned projection once configured and run checkout hygiene.

Use conventional process-level fault injection for bootstrap/main-process
failures that cannot safely be exercised inside a live agentic run. If profiling
becomes necessary, use the configured System performance skill and its owned
instance cleanup rules.

## Completion criteria

A user reports a real technical failure or a wrong result, reviews bounded
evidence, submits it once despite network/restart interruptions, sees a durable
receipt, and can later see its resolution. The same incident supports local
investigation. Evidence remains scoped to its owner, existing error/recovery
contracts retain their meaning, and the reporting system does not become a
dependency of the operation it observes.

First-use consent and settings reliably govern automatic diagnostics, including
revocation races. Manual reports can carry substantial agent-authored narrative
through the Base skill. The authenticated/rate-limited Cloudflare backend feeds
the `vibestudio-dev` dashboard and SQL skill, and a focused self-development proof
records reproduction, candidate, tests, cleanup, and fix references end to end.

## Implementation refinement: development ownership

`vibestudio-dev` inherits the canonical System template (which inherits Base), rather than calling System's private development service across workspace boundaries. System ingress deliberately rejects such calls. Template composition reuses the existing development implementation locally, with its ordinary authority and reviewed creation flow; it does not copy a development worker into the reporting project or weaken isolation. The dashboard and skill discover local `vibestudio.development.v1` and link the existing session to the investigation record.

## Aggregate usage analytics

Implement [the usage analytics contract](usage-analytics.md): one payload-free, unsigned startup ping is counted only as a daily total, including opted-out/undecided use. The product has no separate disclosure, preference, or approval flow for that ping, per the user's explicit direction. Detailed fixed usage counters and automatic error reports remain opt-in, and manual reports still require explicit review/Send. Counter data cannot join to report machine public keys. Developer analytics and SQL operate on the canonical `usage_daily` aggregates.


## Integration audit

See [normal workflow integration](problem-reporting-user-and-agent-flows.md#normal-workflow-integration) for the implemented first-use/device-owned-server choices, ordinary agent guidance, error-screen reporting paths, service error classification, native forwarded-failure capture, and diagnostic-origin deduplication. The automated proof includes a user request that does not mention reporting: the agent still saves an unsent evidence-linked report and recommends review while completing the original task. A deployed intake and current template publications remain launch requirements; source/build checks alone do not establish live delivery.
