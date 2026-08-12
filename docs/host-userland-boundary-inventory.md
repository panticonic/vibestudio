# Host/userland boundary implementation inventory

Status: checked current-state evidence for `host-userland-boundary-roadmap.md`

Checked against the implementation on 2026-08-12. This document is a census,
not a target schema and not migration authorization. Its purpose is to prevent a
future change from treating a file, Durable Object, or SQLite table as an owner
when the actual authority boundary cuts through it.

The classifications use the ownership categories from the roadmap:

- **kernel**: authority, protected facts, supervision, or exact native effects;
- **product**: durable workspace-owned product facts;
- **projection**: disposable data rebuildable from named durable facts;
- **mixed**: a current record that must be split or narrowed before ownership
  can move; and
- **test-only**: fault injection or test policy, never production state.

No item marked product or projection may move until an exact external Base
target and the offline owner-cutover envelope exist. No item marked mixed may
move as a unit.

## Client panel hosting and local state

### Persistent product state

| Current owner                          | Exact facts                                                 | Current key                                                                     | Classification | Safe next action                                                                          |
| -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `src/main/shellCore/localViewState.ts` | collapsed slot ids, focused slot id, local title projection | implicit resolved client/workspace state path in `local-view-state/panels.json` | product        | Inventory only; move with all local records after A0                                      |
| `src/main/panelLayoutStore.ts`         | opaque multi-column layout                                  | device + workspace + account                                                    | product        | Preserve this exact scope in the future generic record store                              |
| `src/main/panelPinStore.ts`            | pinned slot ids                                             | device + workspace                                                              | product        | Preserve this scope; publish retention intent rather than exposing the store to native GC |

These are three records with different corruption and keying behavior. They are
not one `PanelManager` state blob and must not be migrated by one all-or-nothing
JSON conversion.

### Native and supervision facts

Electron `webContents`, mobile `WebView`, headless browser pages, CDP sessions,
native bindings, focused/attached surfaces, runtime leases, and automation
`keepLoaded` facts are native resources or supervision facts. They are
reconciled, not copied into product storage.

The shared GC now accepts generic `hasRetentionIntent`; Electron adapts the
current `PanelPinStore` at the product `PanelOrchestrator` boundary. The native
presentation controller and the GC selectors no longer import or interpret pin
storage. This is the intended seam for A0's later revisioned retention set; it
does not add a protocol or a second writer.

Current behavioral evidence:

- `packages/shared/src/panel/panelGc.test.ts` checks idle hard-retention, cap
  soft-priority, focus protection, and automation protection.
- `src/main/panelResourcePolicy.test.ts` checks Electron/headless resource
  bookkeeping and native residency.
- `workspace/apps/mobile/src/components/webViewStack.test.ts` checks the same
  selector semantics through the mobile product pin adapter.

## Workspace state builtin

Current storage owner: `packages/builtin/src/workspace-state/WorkspaceDO.ts`.

### Table and column ownership

| Current table                | Current facts                                                                                                                                                 | Classification                               | Exact consumer or constraint                                                                          | Target consequence                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entities`                   | identity, source/effective version, execution and authority digests, context, ownership relations, lifecycle; also `state_args`, `error`, and `display_title` | mixed                                        | Runtime identity, context enforcement, activation, cleanup, and product presentation all read the row | Keep identity/execution/context/lifecycle in the kernel. Move `display_title`. Re-derive `state_args` and `error` field-by-field; do not move the row wholesale. |
| `slots`                      | tree identity, parent, current entity and history key, ordering, owner, close state                                                                           | kernel                                       | Topology ownership and the current navigation authority pointer                                       | Retain as the topology spine. Product code may choose placement, but the committed topology remains one kernel fact.                                             |
| `panel_close_cleanup`        | close identity and pending entity cleanup                                                                                                                     | kernel                                       | Idempotent native/runtime cleanup after a slot closes                                                 | Retain until cleanup acknowledgement is complete.                                                                                                                |
| `slot_history`               | immutable entry key, cursor, entity, source, context, recorded time; `state_args` and `options` payload                                                       | mixed by interpretation, kernel by residency | History selection reads entity/context and changes the slot pointer in one transaction                | Keep the complete immutable row in the kernel. Bound and make `state_args`/`options` opaque; userland owns their meaning.                                        |
| `panel_search_metadata`      | title/path/manifest/tags/keywords projection plus per-slot `access_count`                                                                                     | mixed                                        | FTS content and ranking share one row                                                                 | Split the durable access fact before rebuilding or moving any projection.                                                                                        |
| `panel_source_usage`         | per-source access count and last-access timestamp                                                                                                             | product                                      | Launcher/ranking policy                                                                               | Durable product fact; migrate losslessly, never rebuild as an index.                                                                                             |
| `panel_fts` and its triggers | FTS projection over search metadata                                                                                                                           | projection                                   | Search query execution only                                                                           | Rebuildable after durable facts have a separate owner.                                                                                                           |
| `workspace_meta`             | currently the panel-tree revision                                                                                                                             | kernel                                       | Observation/reconciliation fencing                                                                    | Retain only named supervision revisions; do not turn this into a general product metadata bag.                                                                   |
| `context_edges`              | lifecycle and lineage relationships                                                                                                                           | kernel                                       | Context access, destruction cascade, and clone/fork provenance                                        | Authority fact; must remain atomic with its consuming context operations.                                                                                        |
| `lifecycle_epochs`           | recovery generation and epoch status                                                                                                                          | kernel                                       | Restart and lifecycle recovery                                                                        | Supervision fact.                                                                                                                                                |
| `lifecycle_leases`           | durable-object lifecycle ownership and refresh time                                                                                                           | kernel                                       | Runtime cleanup and restart recovery                                                                  | Supervision fact.                                                                                                                                                |
| `lifecycle_ops`              | prepare/resume operation state                                                                                                                                | kernel                                       | Idempotent lifecycle recovery                                                                         | Supervision fact.                                                                                                                                                |
| `do_alarms`                  | exact wake target, time, generation, and dispatch owner                                                                                                       | kernel                                       | Host alarm dispatch                                                                                   | Generic supervision fact, not product scheduling UX.                                                                                                             |
| `do_alarm_test_policies`     | alarm fault policy                                                                                                                                            | test-only                                    | Test harness                                                                                          | Must never influence a production ownership cut.                                                                                                                 |
| `durable_work_owners`        | exact object and owned queue set                                                                                                                              | kernel                                       | Queue cleanup and recovery                                                                            | Supervision fact.                                                                                                                                                |
| `recurring_jobs`             | declared target plus next-run/backoff/result timestamps                                                                                                       | mixed                                        | Host dispatch needs the exact target and next wake; product owns schedule meaning and presentation    | Re-derive separately from panel presentation work. Do not move as incidental WorkspaceDO cleanup.                                                                |

### Existing atomicity evidence

`slotCommitPreparedNavigation` executes inside one storage transaction. It
selects an immutable history row containing `entity_id`, `source`, and
`context_id`, validates the prepared incarnation, and changes
`slots.current_entity_id` plus `current_entry_key` before commit.

`WorkspaceDO.test.ts` already characterizes append/select/replace behavior and
proves stale or incomplete prepared swaps leave the current slot, history
detail, and revision unchanged. That behavior is a boundary invariant, not an
implementation detail to be weakened during extraction.

### Confirmed projection blocker

`panelRebuildIndex()` currently deletes `panel_search_metadata` and recreates
every row with `access_count = 0`. It also backfills and writes canonical entity
titles while rebuilding. Therefore it is not presently a pure projection
rebuild. Workstream B step 3 requires a real current-owner schema separation;
renaming this method or copying counts around the delete would hide the mixed
ownership rather than fix it.

## Missions and reviewed closures

Current product storage owner: `packages/builtin/src/missions/MissionsDO.ts`.
Current authority owner: `src/server/services/reviewedClosureRegistry.ts`.

| Current record or operation                                                                                      | Classification                          | Target consequence                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `missions` document fields: name, charter, permissions, restrictions, owner, seeded state, timestamps            | product                                 | Move to the Base missions service after immutable activation semantics land.                                                                                                                  |
| `missions.revision` and `revision_digest`                                                                        | product                                 | A document revision is not authority after activation.                                                                                                                                        |
| `missions.state` and `active_closure_digest`                                                                     | mixed                                   | Current UX state mirrors kernel activation. Replace with explicit product references to immutable kernel closure identities; never treat this row as the authority ledger.                    |
| `mission_revisions`                                                                                              | product                                 | Durable document history.                                                                                                                                                                     |
| `mission_runs`                                                                                                   | product, with kernel session references | Keep run workflow and outcome in userland; the kernel retains only exact closure/session binding and retirement facts.                                                                        |
| `compileClosure` and `requestReview`                                                                             | mixed operation                         | Mission policy compiles the canonical input today, while the kernel must verify and mechanically present the authority. Move only after the authority input and publisher rules are complete. |
| edit-triggered `reviewedClosure.suspend`                                                                         | cross-owner coupling                    | Replace with immutable active authority plus explicit suspend/replace before mission documents move.                                                                                          |
| reviewed closure body, digest, issuer, grants, dependency facts, active/suspended/retired state, session binding | kernel                                  | Already stored separately by `ReviewedClosureRegistry`; keep exact verification and grant mutation here.                                                                                      |

The canonical `reviewedClosureBodySchema` is already mission-independent. Do not
create a parallel closure type. The remaining prerequisite is to validate and
mechanically render that exact body before the approval challenge, then replace
builtin-only publication with exact reviewed publisher authentication.

## Browser data builtin threat classification

Current owner: `packages/builtin/src/browser-data/BrowserDataDO.ts`, using the
schema in `packages/browser-data/src/storage/schema.ts`.

The protected boundary is confidentiality and authority, not the fact that a
record came from a browser. Records that merely reveal browsing behavior are
sensitive product data, but workspace code already owns equally sensitive
product documents. Records that can authenticate, impersonate, or submit a
protected value require the vault.

| Record family              | Current tables                                | Threat if workspace code is compromised                                                         | Required target owner     | API consequence                                                                                                                                 |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved credentials          | `passwords`                                   | Account takeover and credential reuse; encrypted values are directly usable after decryption    | protected vault           | Narrow origin-scoped lookup/use and explicit reviewed export; no ordinary bulk product read                                                     |
| Reusable form-fill values  | `form_fill_values`                            | Disclosure of identity, address, payment, contact, and other high-value personal data           | protected vault           | Typed bounded suggestion/query and mutation effects; keep value, matching hash, semantic type, and necessary metadata atomic                    |
| Canonical cookies          | `cookies`, `cookie_state`, `cookie_mutations` | Session impersonation; cookie values are bearer authority                                       | protected vault           | Idempotent mutation ids, scoped snapshot/projection effects, and exact revision fencing; product code does not receive an unrestricted bulk jar |
| Password never-save policy | `password_never_save`                         | Privacy preference disclosure but no credential authority                                       | Base browser-data service | Durable product policy, independently deployable                                                                                                |
| Bookmarks                  | `bookmarks`                                   | Browsing-interest disclosure and product-data loss                                              | Base browser-data service | Durable product CRUD                                                                                                                            |
| History and visits         | `history`, `history_visits`                   | Detailed behavioral disclosure and product-data loss                                            | Base browser-data service | Durable product CRUD; deletion remains explicit and scoped                                                                                      |
| History full-text search   | `history_fts` and triggers                    | Repeats history text already present in durable rows                                            | Base-owned projection     | May be deleted and rebuilt only from `history`                                                                                                  |
| Favicons                   | `page_favicons`                               | Low additional confidentiality beyond page/origin; fetched bytes may not remain available later | Base browser-data service | Treat as durable product data, not a guaranteed-rebuild cache                                                                                   |
| Site zoom/preferences      | `site_preferences`                            | Product preference disclosure                                                                   | Base browser-data service | Workspace chrome owns policy; native host only applies an exact effect                                                                          |
| Search engines             | `search_engines`                              | Preference disclosure and product-data loss                                                     | Base browser-data service | Durable product records and default selection                                                                                                   |
| Download records           | `downloads`                                   | Local path and browsing disclosure; presentation/progress loss                                  | Base browser-data service | Product owns records; native adapter owns the file transfer/OS effect and emits exact observations                                              |
| Import workflow            | `import_jobs`, `import_batches`               | Progress and source metadata disclosure; replay can duplicate imported data                     | Base browser-data service | Userland coordinator with durable idempotency receipts; protected record batches call narrow vault operations                                   |

### Browser split invariants

- Encryption at rest does not make the monolithic builtin the right product
  owner. It just establishes that password, form-fill, and cookie plaintext
  need a protected effect boundary.
- Cookie key attributes, encrypted value, revision, and mutation receipt form
  one vault transaction. Splitting only the ciphertext would break replay and
  projection correctness.
- Form-fill presentation metadata currently shares the protected record. It
  should remain in the vault unless a concrete userland feature justifies an
  opaque-id projection; do not introduce a distributed write merely to reduce
  vault column count.
- `BrowserDataDO.test.ts` proves the typed method roster, canonical schema, and
  current authority tiers. The later split needs separate vault and product
  conformance tests before either route changes.

## Development builtin

Current workflow owner: `packages/builtin/src/development/DevelopmentDO.ts` and
`DevelopmentStore.ts`. Exact native effects are already separate behind
`developmentNative` and `developmentClientExecutor`.

| Current table or surface                                                                                               | Classification                                     | Target consequence                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `development_sessions`                                                                                                 | mixed                                              | Repository/context selection, repair policy, and presentation are product facts. Exact context/repository identities needed to fence native effects belong in a generic execution receipt. |
| `development_runs`                                                                                                     | mixed                                              | `run_json` is product workflow; `plan_json`, intent digest, and native effect identity include attested execution facts. Split by consumer, not table.                                     |
| `development_run_events`                                                                                               | product unless an event is the sole native receipt | Keep product event history in Base; exact native completion/retirement receipts belong in the generic ledger.                                                                              |
| `development_mutation_intents`                                                                                         | mixed                                              | Product retries stay with the workflow. Native effect idempotency must be enforced by the native effect/ledger owner.                                                                      |
| `development_test_faults`                                                                                              | test-only                                          | Never migrate as product state.                                                                                                                                                            |
| recipe selection, pagination, retry/repair decisions, target selection                                                 | product                                            | Move to Base only after external Base and generic receipts are proven.                                                                                                                     |
| repository materialization, exact build execution, process/terminal handles, executor attestation, inspect/stop/retire | kernel/native effect                               | Keep narrow and identity-bearing.                                                                                                                                                          |

`DevelopmentDO.test.ts` already proves the builtin method roster, that recipe
selection is product logic, and that the host supplies attested semantic ingress
and native platform/effect facts. Workstream F should preserve that cut while
removing the durable product workflow, not replace it with a second host
development facade.

## Safe work completed or enabled by this inventory

The following work changes no durable owner or route:

1. Native panel GC consumes generic product retention intent rather than
   reading or naming pin storage.
2. The three local panel-state records have explicit current and target keys.
3. Workspace, mission, browser, and development mixed-owner records are named;
   later work cannot honestly migrate them as whole tables.
4. Browser record families have an explicit threat-derived vault/product cut.
5. Existing atomicity and contract tests are identified as invariants for the
   later cutovers.

Everything beyond those points remains gated by the external Base release path,
Foundation 0, or the A0 client-host protocol.
