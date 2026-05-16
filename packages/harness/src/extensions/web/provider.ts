import type { ProviderName } from "./types.js";

export type ProviderApiKeyGetter = (
  name: string,
) => string | undefined | Promise<string | undefined>;

export async function selectSearchProvider(
  getKey: ProviderApiKeyGetter | undefined,
): Promise<ProviderName> {
  if (!getKey) return "duckduckgo";
  const tavily = await getKey("TAVILY_API_KEY");
  if (tavily && tavily.trim().length > 0) return "tavily";
  return "duckduckgo";
}
