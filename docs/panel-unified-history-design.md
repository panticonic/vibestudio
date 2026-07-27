# Unified panel history

Status: implementation contract for P7 of `panel-surface-architecture.md`.

## Decision

A slot has one durable ordered history. Chromium's navigation history is an
execution cache for the currently loaded document, never a second source of
truth.

An entry is one of:

- `incarnation`: a committed code source or a committed external main-frame
  document. It owns an immutable runtime entity and the complete panel snapshot.
- `document`: a same-document navigation inside the current incarnation. It
  owns a URL and document state, but no new entity.

Every main-frame commit to a distinct URL is an `incarnation`. Redirects create
one entry for the final committed URL because `did-navigate`, not
`did-redirect-navigation`, is the commit signal. Hash/history-API transitions
reported by `did-navigate-in-page` are `document` entries.

## Durable schema

Extend the existing slot-history row rather than creating a parallel browser
history table:

```text
panel_slot_history
  slot_id                 text       not null
  entry_key               text       not null
  ordinal                 integer    not null
  entry_kind              text       not null  -- incarnation | document
  entity_id               text                 -- required for incarnation
  source                   text                 -- required for incarnation
  context_id               text                 -- required for incarnation
  options_json             text                 -- required for incarnation
  state_args_json          text
  document_url             text                 -- required for document
  document_state_json      text                 -- bounded structured-clone subset
  web_contents_generation text                 -- diagnostic/idempotency fact
  navigation_sequence      integer              -- monotonic within generation
  transition               text       not null  -- source | link | typed | redirect |
                                                -- history-api | hash | reload | restore
  committed_at             integer    not null
  title                    text
  favicon_ref              text
  primary key (slot_id, entry_key)
  unique (slot_id, ordinal)
```

`panel_slots.current_entry_key` remains the cursor. An incarnation row retains
the exact snapshot fields already stored today. A document row resolves its
incarnation by walking backward to the nearest incarnation entry; the writer
also validates that a document entry cannot be committed without one.

The maximum serialized `document_state_json` is 64 KiB. State that is not a
bounded structured-clone value is omitted; history ordering and URL remain
valid. No DOM snapshot, response body, cookie, form value, or credential is
persisted.

## Single-writer transaction

WorkspaceDO is the only history writer. Every mutation atomically:

1. validates the current slot cursor and expected entity;
2. truncates entries after the cursor when committing a new entry;
3. inserts or replaces the requested entry;
4. advances `current_entry_key`;
5. swaps `current_entity_id` when the destination is an incarnation;
6. increments the panel-tree revision.

The mutation carries an idempotency key:

```text
slot_id / web_contents_generation / navigation_sequence / operation
```

Replaying the same mutation returns the committed row. Reusing the key with
different content fails. A newer web-contents generation cannot append an event
from a destroyed generation.

## Event ordering

### Main-frame navigation

1. `will-navigate` is policy only. It never writes history.
2. The host records a pending navigation intent with its transition and
   generation-local sequence.
3. Redirect events update only the pending diagnostic record.
4. `did-navigate` commits the final URL once.
5. The next incarnation is prepared before the WorkspaceDO transaction.
6. The transaction appends the incarnation and swaps the slot cursor/entity.
7. The runtime lease transfers to the new entity.
8. Only after a successful transfer is the previous entity retired.

Failure before step 6 leaves no history row. Failure at step 7 rolls the
transaction back or restores the previous cursor before either entity is
retired. History never points at an unprepared or retired entity.

### Same-document navigation

`did-navigate-in-page` appends a `document` entry only when its URL differs from
the current entry. Duplicate notifications for the same generation and
sequence are idempotent. It does not mint, transfer, or retire an entity.

### Replacement and reload

- `location.replace`, history replacement, and the existing
  `replaceCurrentSnapshot` replace the current row without changing its ordinal.
- Reload annotates/replaces the current entry; it does not grow history.
- A new navigation after Back truncates the forward suffix in the same
  transaction that commits the destination.

## Traversal

Back and Forward first move the durable cursor, then realize the destination:

- For an `incarnation`, prepare/resolve that entry's entity, transfer the lease,
  and load its code URL or external URL.
- For a `document` in the currently live web-contents generation, use
  Chromium's matching navigation entry when available.
- For a `document` after recreation or restart, load its URL in the owning
  incarnation. The URL/order contract is durable; Chromium's process-local
  document object is not.

Host loads caused by traversal carry a traversal token. The subsequent Electron
navigation event acknowledges that token instead of appending a duplicate row.

## Restore and corruption rules

On restart, restore the cursor's nearest incarnation and then its document URL.
Missing entities, a document before any incarnation, duplicate ordinals, or a
cursor outside the slot history are corruption and fail the slot closed with a
repair diagnostic. They are never silently converted into a new entry.

## Migration

Existing rows become `incarnation` entries, preserving their entry keys,
ordering, snapshots, and cursor. New columns are nullable during the migration;
the migration fills `entry_kind = incarnation`, derives `ordinal` from existing
order, and then installs the constraints. Chromium's pre-migration in-document
stack is intentionally not fabricated.

## Required tests

- final redirect URL commits exactly one incarnation;
- same-document/hash changes interleave with source changes in one order;
- replace does not grow history;
- Back followed by navigation truncates the forward suffix atomically;
- stale events from a destroyed web-contents generation are rejected;
- traversal acknowledgements do not duplicate entries;
- lease-transfer failure retains the previous cursor/entity;
- restart restores an external document and a same-document URL;
- migration preserves old source history and cursor exactly;
- malformed ordering/entity references fail closed.
