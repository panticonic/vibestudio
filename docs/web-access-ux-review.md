# Web access UX review

## Findings and changes

The new-panel launcher, command palette, and browser address fields shared some ranking code but did not expose the same web capabilities.

- Bare domains already opened in about/new. Inline completion nevertheless required the stored URL's protocol, and quickfire did not complete web destinations. Completion now accepts the user's protocol/`www` style. All address fields use the same HTTP(S) input parser, including localhost, IP addresses, ports, queries, and fragments.
- About/new queried only history. It now combines canonical history, bookmarks, open browser panels, configured search engines, and search completions. Independent source failures preserve available results. History review-pending feedback remains visible.
- Autocomplete selected a recent slice before ranking, so old frequent destinations could disappear. The history query now ranks before limiting. Launcher recency also previously capped all modern millisecond timestamps at the same value; that is corrected.
- New web-search rows use the configured default, with DuckDuckGo for an unconfigured profile. DuckDuckGo, Google, and Bing are seeded choices. Imported defaults remain selected. `about/search` lets users choose a default, edit providers, and add custom search/suggestion URLs. `%s` and `{searchTerms}` receive encoded query text; keywords select a provider for one search.
- Remote suggestions use the selected provider's OpenSearch JSON endpoint, omit credentials, and have a timeout and response-size limit. Address-like inputs are excluded. Clearing a provider's suggestion URL disables its remote suggestions. Local history and bookmarks remain available when the remote request fails.
- Quickfire and command-palette web actions now create children of the bound panel, including web links in desktop agent replies. Mobile uses the same row model and child placement. Explicit agent mode remains separate from web search.

## Imported history is not a list of invented visits

The old import implementation synthesized timestamps from aggregate counts; when only a last-visit time was available it collapsed all counts to one visit. The current browser-data schema v2 stores profile summaries separately from actual visit events. Re-importing the same profile does not add its totals twice. Actual imported visits and their summary are counted together using the greater observed total per source; native visits remain additive. Autocomplete and history read one resulting history projection.

Deleting a date interval removes exact visits in that interval. An overlapping aggregate observation is removed in full because its individual visit dates are unknown; remaining exact visits are retained. Existing lost counts or invented timestamps cannot be reconstructed from the old database alone: original browser data is needed for a faithful re-import.

## Prerelease replacement

Browser-data schema v2 is the current implementation. This is a clean prerelease replacement: obsolete internal browser-data stores are recreated when adopting it, rather than migrated. Importing history from another browser remains an ordinary feature of the new system.

The application version and template epochs remain unchanged. This feature does not require a major release, a compatibility implementation, or an export/migration approval gate. No existing store was reset during this source change.

## Verification and remaining limits

Focused coverage exercises shared URL parsing/completion/ranking, about/new keyboard and navigation behavior, provider settings, search-provider RPC schemas, native panel links, imported history totals and deletion, desktop quickfire, and the mobile command sheet/slate. DuckDuckGo and Google suggestion endpoints were also checked directly using a public sample query.

This is source and component verification, not an end-to-end run against a live user profile. Newly created browser panels still record ordinary visits through the existing navigation recorder; their create operation does not carry typed-address intent, so typed-count boosts for those launches remain a separate creation-contract gap. The existing address-field navigation path does carry that intent.
