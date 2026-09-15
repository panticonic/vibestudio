import { describe, expect, it } from "vitest";
import { getSharedBrowserAddressOptions } from "./panelChrome.js";
import { parseWebSearchSuggestions, webSearchUrl } from "./webSearch.js";

describe("shared web suggestions", () => {
  it("encodes both supported query placeholders and rejects unsafe provider URLs", () => {
    expect(webSearchUrl("https://search.test/?q={searchTerms}", "cats & dogs")).toBe(
      "https://search.test/?q=cats%20%26%20dogs"
    );
    expect(() => webSearchUrl("javascript:%s", "test")).toThrow();
    expect(() => webSearchUrl("https://user:secret@search.test/?q=%s", "test")).toThrow();
    expect(() => webSearchUrl("https://search.test/", "test")).toThrow();
    expect(parseWebSearchSuggestions(["q", ["one", "one", 3, "", "two"]])).toEqual(["one", "two"]);
  });

  it("retains local history when bookmarks or remote completions fail", async () => {
    const options = await getSharedBrowserAddressOptions({
      query: "example",
      browserData: {
        searchHistoryForAutocomplete: async () => [
          { url: "https://example.com/", title: "Example" },
        ],
        getHistory: async () => [],
        searchBookmarks: async () => {
          throw new Error("unavailable");
        },
        getSearchEngines: async () => [
          { id: 1, name: "Imported", search_url: "https://search.test/?q=%s", is_default: 1 },
        ],
        getSearchSuggestions: async () => {
          throw new Error("offline");
        },
      },
    });
    expect(options.historyStatus).toBe("ready");
    expect(options.suggestions.map((row) => row.source)).toEqual(["history", "search-engine"]);
  });

  it("does not evict provider configuration when the history result budget is full", async () => {
    const options = await getSharedBrowserAddressOptions({
      query: "",
      browserData: {
        searchHistoryForAutocomplete: async () => [],
        getHistory: async () =>
          Array.from({ length: 50 }, (_, index) => ({ url: `https://example.com/${index}` })),
        searchBookmarks: async () => [],
        getSearchEngines: async () => [
          { name: "Imported", search_url: "https://search.test/?q=%s", is_default: 1 },
        ],
      },
    });
    expect(options.suggestions.filter((row) => row.source === "history")).toHaveLength(50);
    expect(options.suggestions.find((row) => row.source === "search-engine")?.engineName).toBe(
      "Imported"
    );
  });
});
