import { describe, expect, it, vi } from "vitest";
import { createBrowserDataClient } from "../client/browserDataClient.js";

function makeRpc() {
  return vi.fn(async (service: string, method: string, _args: unknown[]) => {
    if (service === "extensions" && method === "invokeProvider") return [];
    return undefined;
  });
}

describe("createBrowserDataClient", () => {
  it("relays calls through the browserData provider namespace", async () => {
    const call = makeRpc();
    const client = createBrowserDataClient({ call });

    await client.searchHistoryForAutocomplete("git", 10);

    expect(call).toHaveBeenCalledWith("extensions", "invokeProvider", [
      "browserData",
      "searchHistoryForAutocomplete",
      [{ query: "git", limit: 10 }],
    ]);
  });

  it("passes a single object argument through unwrapped", async () => {
    const call = makeRpc();
    const client = createBrowserDataClient({ call });

    await client.recordHistoryVisit({ url: "https://example.com", typed: true });

    expect(call).toHaveBeenCalledWith("extensions", "invokeProvider", [
      "browserData",
      "recordHistoryVisit",
      [{ url: "https://example.com", typed: true }],
    ]);
  });

  it("forwards provider routing errors without resolving an extension fallback", async () => {
    const call = vi.fn(async () => {
      throw new Error("No extension provider declared for providers.browserData");
    });
    const client = createBrowserDataClient({ call });

    await expect(client.searchBookmarks("a")).rejects.toThrow(/providers\.browserData/);
  });

  it("covers empty and multi-argument provider methods without a dynamic proxy", async () => {
    const call = makeRpc();
    const client = createBrowserDataClient({ call });

    await client.listImportHosts();
    await client.searchHistory("git", 10);

    expect(call).toHaveBeenNthCalledWith(1, "extensions", "invokeProvider", [
      "browserData",
      "listImportHosts",
      [],
    ]);
    expect(call).toHaveBeenNthCalledWith(2, "extensions", "invokeProvider", [
      "browserData",
      "searchHistory",
      ["git", 10],
    ]);
  });
});
