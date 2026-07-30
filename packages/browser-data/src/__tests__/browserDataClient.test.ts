import { describe, expect, it, vi } from "vitest";
import { createBrowserDataClient } from "../client/browserDataClient.js";

function makeRpc() {
  return vi.fn(async (service: string, method: string, _args: unknown[]) => {
    if (service === "workers" && method === "resolveService") {
      return {
        kind: "durable-object",
        targetId: "do:vibestudio/internal:BrowserDataDO:v1_test",
      };
    }
    if (service.startsWith("do:")) {
      if (method === "recordHistoryVisit") return 1;
      return [];
    }
    if (service === "extensions" && method === "invokeProvider") return [];
    return undefined;
  });
}

describe("createBrowserDataClient", () => {
  it("resolves the builtin protocol once and calls its typed data methods directly", async () => {
    const call = makeRpc();
    const client = createBrowserDataClient({ call });

    await client.searchHistoryForAutocomplete("git", 10);
    await client.recordHistoryVisit({ url: "https://example.com", typed: true });

    expect(call).toHaveBeenNthCalledWith(1, "workers", "resolveService", [
      "vibestudio.browser-data.v1",
      null,
    ]);
    expect(call).toHaveBeenNthCalledWith(
      2,
      "do:vibestudio/internal:BrowserDataDO:v1_test",
      "searchHistoryForAutocomplete",
      [{ query: "git", limit: 10 }]
    );
    expect(call).toHaveBeenNthCalledWith(
      3,
      "do:vibestudio/internal:BrowserDataDO:v1_test",
      "recordHistoryVisit",
      [{ url: "https://example.com", typed: true }]
    );
  });

  it("keeps native import brokerage on the extension contract", async () => {
    const call = makeRpc();
    const client = createBrowserDataClient({ call });

    await client.listImportHosts();

    expect(call).toHaveBeenCalledWith("extensions", "invokeProvider", [
      "browserData",
      "listImportHosts",
      [],
    ]);
    expect(call).not.toHaveBeenCalledWith("workers", "resolveService", expect.anything());
  });

  it("does not fall back to the extension when builtin resolution fails", async () => {
    const call = vi.fn(async (service: string) => {
      if (service === "workers") throw new Error("browser.data is unavailable");
      return [];
    });
    const client = createBrowserDataClient({ call });

    await expect(client.searchBookmarks("a")).rejects.toThrow(/browser\.data is unavailable/);
    expect(call).not.toHaveBeenCalledWith("extensions", "invokeProvider", expect.anything());
  });
});
