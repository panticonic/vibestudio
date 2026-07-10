import { describe, expect, it, vi } from "vitest";
import { createBrowserDataRpcClient } from "../client/browserDataRpcClient.js";

function makeRpc() {
  return vi.fn(async (service: string, method: string, _args: unknown[]) => {
    if (service === "extensions" && method === "invokeProvider") return [];
    return undefined;
  });
}

describe("createBrowserDataRpcClient", () => {
  it("relays calls through the browserData provider namespace", async () => {
    const call = makeRpc();
    const client = createBrowserDataRpcClient({ call });

    await client.history.searchForAutocomplete("git", 10);

    expect(call).toHaveBeenCalledWith("extensions", "invokeProvider", [
      "browserData",
      "searchHistoryForAutocomplete",
      [{ query: "git", limit: 10 }],
    ]);
  });

  it("passes a single object argument through unwrapped", async () => {
    const call = makeRpc();
    const client = createBrowserDataRpcClient({ call });

    await client.history.recordVisit({ url: "https://example.com", typed: true });

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
    const client = createBrowserDataRpcClient({ call });

    await expect(client.bookmarks.search("a")).rejects.toThrow(/providers\.browserData/);
  });
});
