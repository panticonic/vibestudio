import { describe, expect, it, vi } from "vitest";
import { createBrowserDataClient } from "../client/browserDataClient.js";

function makeRpc() {
  const callService = vi.fn(async (service: string, method: string, _args: unknown[]) => {
    if (service === "workers" && method === "resolveService") {
      return {
        kind: "durable-object",
        targetId: "do:vibestudio/internal:BrowserDataDO:v1_test",
      };
    }
    if (service === "extensions" && method === "invokeProvider") return [];
    if (service === "browserEnvironment" && method === "listDownloads") return [];
    return undefined;
  });
  const callTarget = vi.fn(async (_targetId: string, method: string, _args: unknown[]) => {
    if (method === "recordHistoryVisit") return 1;
    return [];
  });
  return { callService, callTarget };
}

describe("createBrowserDataClient", () => {
  it("resolves the builtin protocol once and calls its typed data methods directly", async () => {
    const rpc = makeRpc();
    const client = createBrowserDataClient(rpc);

    await client.searchHistoryForAutocomplete("git", 10);
    await client.recordHistoryVisit({ url: "https://example.com", typed: true });

    expect(rpc.callService).toHaveBeenCalledWith("workers", "resolveService", [
      "vibestudio.browser-data.v1",
      null,
    ]);
    expect(rpc.callTarget).toHaveBeenNthCalledWith(
      1,
      "do:vibestudio/internal:BrowserDataDO:v1_test",
      "searchHistoryForAutocomplete",
      [{ query: "git", limit: 10 }]
    );
    expect(rpc.callTarget).toHaveBeenNthCalledWith(
      2,
      "do:vibestudio/internal:BrowserDataDO:v1_test",
      "recordHistoryVisit",
      [{ url: "https://example.com", typed: true }]
    );
  });

  it("keeps native import brokerage on the extension contract", async () => {
    const rpc = makeRpc();
    const client = createBrowserDataClient(rpc);

    await client.listImportHosts();

    expect(rpc.callService).toHaveBeenCalledWith("extensions", "invokeProvider", [
      "browserData",
      "listImportHosts",
      [],
    ]);
    expect(rpc.callService).not.toHaveBeenCalledWith(
      "workers",
      "resolveService",
      expect.anything()
    );
  });

  it("routes Electron-native browser effects directly to their resident service", async () => {
    const rpc = makeRpc();
    const client = createBrowserDataClient(rpc);

    await client.listDownloads();
    await client.pauseDownload("download-1");

    expect(rpc.callService).toHaveBeenCalledWith("browserEnvironment", "listDownloads", []);
    expect(rpc.callService).toHaveBeenCalledWith("browserEnvironment", "pauseDownload", [
      "download-1",
    ]);
    expect(rpc.callService).not.toHaveBeenCalledWith(
      "extensions",
      "invokeProvider",
      expect.arrayContaining(["browserData", "listDownloads"])
    );
  });

  it("does not fall back to the extension when builtin resolution fails", async () => {
    const callService = vi.fn(async (service: string) => {
      if (service === "workers") throw new Error("browser.data is unavailable");
      return [];
    });
    const callTarget = vi.fn();
    const client = createBrowserDataClient({ callService, callTarget });

    await expect(client.searchBookmarks("a")).rejects.toThrow(/browser\.data is unavailable/);
    expect(callService).not.toHaveBeenCalledWith("extensions", "invokeProvider", expect.anything());
    expect(callTarget).not.toHaveBeenCalled();
  });
});
