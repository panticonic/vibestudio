import { describe, expect, it, vi } from "vitest";
import { createBrowserDataClient } from "../client/browserDataClient.js";

function makeRpc() {
  const callService = vi.fn(async (service: string, method: string, _args: unknown[]) => {
    if (service === "extensions" && method === "invokeProvider") {
      return _args[1] === "recordHistoryVisit" ? 1 : [];
    }
    if (service === "browserEnvironment" && method === "listDownloads") return [];
    return undefined;
  });
  return { callService };
}

describe("createBrowserDataClient", () => {
  it("routes canonical data methods through the installed browser-data broker", async () => {
    const rpc = makeRpc();
    const client = createBrowserDataClient(rpc);

    await client.searchHistoryForAutocomplete("git", 10);
    await client.recordHistoryVisit({ url: "https://example.com", typed: true });

    expect(rpc.callService).toHaveBeenNthCalledWith(1, "extensions", "invokeProvider", [
      "browserData",
      "searchHistoryForAutocomplete",
      [{ query: "git", limit: 10 }],
    ]);
    expect(rpc.callService).toHaveBeenNthCalledWith(2, "extensions", "invokeProvider", [
      "browserData",
      "recordHistoryVisit",
      [{ url: "https://example.com", typed: true }],
    ]);
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

  it("surfaces broker failures without opening a parallel direct-DO path", async () => {
    const callService = vi.fn(async (service: string) => {
      if (service === "extensions") throw new Error("browser.data broker is unavailable");
      return undefined;
    });
    const client = createBrowserDataClient({ callService });

    await expect(client.searchBookmarks("a")).rejects.toThrow(/broker is unavailable/);
    expect(callService).toHaveBeenCalledWith("extensions", "invokeProvider", [
      "browserData",
      "searchBookmarks",
      ["a"],
    ]);
  });
});
