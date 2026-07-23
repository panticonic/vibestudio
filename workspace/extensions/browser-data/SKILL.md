---
name: browser-environment
description: Import into and manage the user's canonical Vibestudio browser environment.
---

# Browser Environment

Use the `browserData` client from `@workspace/runtime`. BrowserDataDO is the
authority for bookmarks, history, cookies, passwords, structured form-fill
values, search engines, favicons, import jobs, and download metadata.

The environment is derived from the verified user and workspace. Never ask for
or pass a user id, environment key, Electron partition, source profile, or
filesystem path.

## Import

Import is a migration snapshot, not sync:

1. `listImportHosts()`
2. `listImportSources(hostId)`
3. `previewImport({ hostId, sourceId, dataTypes })`
4. `startImport({ hostId, sourceId, dataTypes })`
5. Poll `getImportJob(jobId)`; use `cancelImport(jobId)` when requested.
6. Optionally call `listOpenTabs(hostId, sourceId)` and
   `openTabsAsPanels(...)`.

Sources are opaque installed-browser records. Local profiles are merged inside
the trusted provider and are never presented to userland. Supported categories
are bookmarks, history, cookies, passwords, form fill, search engines, and
favicons. Extensions, settings, and imported site permissions are deliberately
unsupported.

Imports commit bounded idempotent batches. A cancelled or interrupted job keeps
committed batches; starting the same source again continues through the
coordinator's deterministic batch identities. Preview returns counts, masked
samples, and warnings only.

## Runtime data

- Use bookmark/history methods for normal reads, writes, search, and deletion.
- Cookie writes go to the canonical mutation API. Electron cookies are only a
  projection; use `flushCookieProjection` before an immediate post-login read.
- Use structured `getFormFillSuggestions({ type, prefix })`; there is no flat
  field-name autofill API.
- Use `putPageFavicon` and `getPageFavicon` for safe page-associated PNGs.
- Site permissions are managed by the browser-permission approval service, not
  by browser data and never imported.

Sensitive reads, exports, import discovery, and mutations are approval-gated
for userland callers. Raw secrets, local files, and decrypted import batches
must never be rendered in a panel or logged.
