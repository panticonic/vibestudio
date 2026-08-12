---
name: browser-environment
description: Import, inspect, and update the user's canonical browser data through the browser-data extension. Use for bookmarks, history, cookies, passwords, form fill, search engines, favicons, downloads, or installed-browser import.
---

# Browser Environment

Use the `browserData` client from `@workspace/runtime`. Use `docs_search` and
`docs_open` for the live method schemas.

The environment is derived from the verified user and workspace. Never ask for
or pass a user id, environment key, Electron partition, source profile, or
filesystem path.

## Import

Import is a migration snapshot, not sync:

For user-driven setup, open `about/browser-import-inspector`. It is the
first-party cohesive workflow for device/browser selection, data categories,
preview, warnings, progress, cancellation, retry, and history. Do not recreate
it as chat questions or chained feedback forms. Do not ask users for internal
host IDs, source IDs, profile paths, or import job IDs.

Use the API sequence below for automation, diagnostics, or code that already
has a complete user-approved selection:

1. `listImportHosts()`
2. `listImportSources(hostId)`
3. `previewImport({ hostId, sourceId, dataTypes })`
4. `startImport({ hostId, sourceId, dataTypes })`
5. Poll `getImportJob(jobId)`; use `cancelImport(jobId)` when requested.
6. Optionally call `listOpenTabs(hostId, sourceId)` and
   `openTabsAsPanels(...)`. It defaults to a new workspace root with nested
   source-window collections; use `destination: "caller"` only when the user
   wants the hierarchy attached to the invoking panel. The imported recursive
   subtree shares its root collection's orchestration context, so its resident
   conductors can title, regroup, and automate those panels without one
   context-boundary prompt per tab. See
   [the collection conductor skill](../../about/collection/SKILL.md).

Sources are opaque installed-browser records. Local profiles are merged inside
the trusted provider and are never presented to userland. The preview schema
is the source of truth for supported categories; do not infer unsupported
settings, extensions, or site permissions.

Imports commit bounded idempotent batches. A cancelled or interrupted job keeps
committed batches; starting the same source again continues through the
coordinator's deterministic batch identities. Preview returns counts, masked
samples, and warnings only.

## Runtime data

- Use bookmark/history methods for normal reads, writes, search, and deletion.
- Cookie writes go to the canonical mutation API. Electron cookies are only a
  projection; use `flushCookieProjection` before an immediate post-login read.
- Use `getFormFillSuggestions({ type, fieldName, prefix })`. Standard HTML
  autocomplete types share semantically equivalent values; browser-native
  field names preserve and match site-specific form history exactly.
- Use `putPageFavicon` and `getPageFavicon` for byte-validated, page-associated
  browser icons. PNG, JPEG, GIF, WebP, ICO, SVG, BMP, and AVIF are supported.
- Site permissions are managed by the browser-permission approval service, not
  by browser data and never imported.

Sensitive reads, exports, import discovery, and mutations are approval-gated
for userland callers. Raw secrets, local files, and decrypted import batches
must never be rendered in a panel or logged.
