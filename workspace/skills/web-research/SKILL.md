---
name: web-research
description: Search the open web and read pages with the web_search, web_fetch, and web_read tools. Use for fresh information, citations, or anything outside the workspace and the model's training cutoff.
---

# Web Research

You have three tools for reaching the open web. They are read-only and
auto-approve at approval level 1 (the default for most workspaces).

## Tools

### web_search

```
web_search({ query: string, max_results?: number })  →  { title, url, snippet }[]
```

Discovery. Returns ranked results from DuckDuckGo (zero-config), or
Tavily when the user has set `TAVILY_API_KEY` in their environment.

- Default `max_results` is 5; allowed range 1–20.
- Snippets are short — use them only to pick a URL, not to answer the
  question. Always follow up with `web_fetch` on the best result.

### web_fetch

```
web_fetch({ url: string })  →  { url, title, digest, size, head }
```

Fetches a URL, extracts the main content with Mozilla Readability, converts
to markdown, **stores the full markdown in the blobstore**, and returns:

- `url` — the final URL after redirects
- `title` — the extracted article title
- `digest` — a sha256 digest you can pass to `web_read`
- `size` — total markdown size in bytes
- `head` — the first ~5000 chars of the markdown, inline in the tool output

If `head` already contains the answer, you're done — cite the URL and reply.
If not, drill in with `web_read`.

### web_read

```
web_read({ digest: string, offset?: number, limit?: number })  →  string
```

Reads a byte range from a previously-cached page. The blobstore is content-
addressed and persistent across the session, so re-reading is free — no
network round-trip.

- `offset` defaults to 0; `limit` defaults to 8000 chars (max 32000).
- Walk a long page by issuing successive `web_read` calls with growing
  offsets, or jump near where you think the answer is.

## Typical workflow

1. `web_search({ query: "..." })` — get a small list of candidate URLs.
2. Pick one (or two) and `web_fetch({ url })`. Look at the `head`.
3. If `head` answers the question → write the reply, cite the URL.
4. If not → `web_read({ digest, offset, limit })` further into the
   cached page. Re-issue with bigger offsets until you find what you need.
5. Reply with the answer plus the source URL(s).

## When to use which

- **Workspace question** → use file tools (`read`, `grep`) on the workspace,
  not web tools.
- **Specific URL the user gave you** → go straight to `web_fetch`, skip search.
- **Fresh or external knowledge** (news, library docs, API references,
  current events) → start with `web_search`.
- **Verifying or quoting** a fact → fetch the source, cite its URL.

## Notes

- DuckDuckGo can occasionally rate-limit under heavy use. If `web_search`
  starts returning empty results or errors, tell the user they can set
  `TAVILY_API_KEY` in the worker env for a higher-quality, keyed provider.
- The cache is content-addressed: the same page fetched twice produces the
  same digest, so digests from earlier in the session are still valid.
- Pages with paywalls, login walls, or heavy client-side rendering may
  return mostly empty markdown. If `head` is shorter than expected, mention
  that to the user rather than fabricating content.
