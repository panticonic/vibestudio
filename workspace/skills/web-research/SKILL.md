---
name: web-research
description: Search the web, fetch URLs into readable text, read bounded ranges, cite sources, or configure an enhanced search provider.
---

# Web research

The web tools are read-only, but authority is still evaluated per operation and
resource.

## Core workflow

1. Use `web_search` to discover candidate URLs.
2. Fetch the best source with `web_fetch`.
3. Read the returned head first. If more is needed, use `web_read` with the
   returned digest and bounded offsets.
4. Answer from fetched content and cite the source URL.

For a user-supplied URL, start with `web_fetch`. For workspace facts, use
workspace files and live docs instead. Search snippets are discovery evidence,
not a final-answer source.

Use each tool's exposed schema for current limits and fields.

## Large pages and PDFs

`web_fetch` stores extracted readable content in the blobstore and returns a
content digest. Read only the ranges needed. When location is unknown, use a
bounded blobstore grep from eval and read around the match — never return the
entire page through eval.

PDF fetches use the same digest/read flow when text extraction succeeds. For
scanned or layout-sensitive local PDFs, use [PDF
ingestion](../../extensions/pdf-ingest/SKILL.md).

## Browser fallback

`web_fetch` has no logged-in browser session and doesn't execute client
JavaScript. When a page genuinely requires the user's browser state or client
rendering:

1. Open or reuse one browser panel.
2. Acquire its canonical CDP page through the panel handle.
3. Wait for the real content condition and extract only the needed data.
4. Store large readable text by digest.
5. Close the page and temporary panel in `finally`, unless the user asked to
   keep it.

Read [browser automation](../sandbox/BROWSER_AUTOMATION.md) for the page API.
Never batch-open browser panels when ordinary fetches suffice, bypass a paywall,
or claim content the fetch/browser couldn't access.

## Targeted APIs

Use a documented domain API when more precise than general search. Call it
through host-mediated `credentials.fetch()` per [API
integrations](../api-integrations/SKILL.md). Never keep copied endpoint recipes
here — provider auth and response schemas change.

## Enhanced search setup

Built-in search works without a provider credential. When the user asks for an
enhanced provider or repeated failures justify setup, render the checked-in
workflow:

```text
inline_ui({
  path: "skills/web-research/SearchProviderSetup.tsx",
  props: {}
})
```

The component owns provider choice, signup links, credential input, status,
errors, and retry. Never ask for an API key in chat or rebuild the workflow as
separate questions.

If the user already selected a provider, use the focused helper from
`@workspace-skills/web-research`. Read `index.ts` for current helper names,
provider roster, selection order, status, and revocation APIs.

## Reporting

- Distinguish publication date from event date for time-sensitive facts.
- Prefer primary sources and fetch every source you rely on.
- State when a page was inaccessible, empty, truncated, or required a logged-in
  browser.
- Keep quotations short; cite the exact URL near the supported claim.
- Treat blob digests as content references, not public citations.
