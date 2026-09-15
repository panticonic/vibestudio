export interface BrowserAddressSuggestion {
  url: string;
  title?: string;
  visitCount?: number;
  typedCount?: number;
  lastVisit?: number;
  source: "history" | "session" | "bookmark" | "search-engine" | "search-suggestion";
  engineId?: number;
  engineName?: string;
  keyword?: string;
  searchTemplate?: string;
  /** Input that produced a remote completion; prevents stale-query mixing. */
  completionQuery?: string;
}

export interface WebSearchEngineInput {
  name: string;
  keyword?: string;
  searchUrl: string;
  suggestUrl?: string;
  isDefault: boolean;
}

export const DEFAULT_SEARCH_TEMPLATE = "https://duckduckgo.com/?q=%s";

export const BUILTIN_SEARCH_ENGINES: WebSearchEngineInput[] = [
  {
    name: "DuckDuckGo",
    keyword: "ddg",
    searchUrl: DEFAULT_SEARCH_TEMPLATE,
    suggestUrl: "https://duckduckgo.com/ac/?q=%s&type=list",
    isDefault: true,
  },
  {
    name: "Google",
    keyword: "g",
    searchUrl: "https://www.google.com/search?q=%s",
    suggestUrl: "https://suggestqueries.google.com/complete/search?client=firefox&q=%s",
    isDefault: false,
  },
  {
    name: "Bing",
    keyword: "b",
    searchUrl: "https://www.bing.com/search?q=%s",
    suggestUrl: "https://api.bing.com/osjson.aspx?query=%s",
    isDefault: false,
  },
];

/** Search and suggestion templates use the same encoded substitution. */
export function webSearchUrl(template: string, query: string): string {
  if (!/(%s|\{searchTerms\})/.test(template))
    throw new Error("URL must contain %s or {searchTerms}");
  const value = template.replace(/%s|\{searchTerms\}/g, encodeURIComponent(query));
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error("Search URLs must use HTTP or HTTPS without credentials");
  }
  return url.href;
}

/** OpenSearch JSON suggestions: [query, [suggestions], ...]. */
export function parseWebSearchSuggestions(value: unknown): string[] {
  if (!Array.isArray(value) || !Array.isArray(value[1])) return [];
  return [
    ...new Set(
      value[1]
        .filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0 && item.length <= 300
        )
        .map((item) => item.trim())
    ),
  ].slice(0, 6);
}
