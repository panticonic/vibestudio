export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export type ProviderName = "duckduckgo" | "tavily";

export interface SearchProviderInvocation {
  provider: ProviderName;
  results: SearchResult[];
}
