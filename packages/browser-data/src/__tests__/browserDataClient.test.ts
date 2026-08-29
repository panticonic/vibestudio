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

  it("does not expose protected browser material to workspace clients", () => {
    const rpc = makeRpc();
    const client = createBrowserDataClient(rpc);

    for (const method of [
      "listPasswordSummaries",
      "getPasswordForSite",
      "getFormFillSuggestions",
      "listCookieOrigins",
      "getCookiesForOrigin",
      "exportPasswords",
      "exportCookies",
    ]) {
      expect(client).not.toHaveProperty(method);
    }
    expect(rpc.callService).not.toHaveBeenCalled();
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

  it("routes export acquisition and transient cleanup through the same import broker", async () => {
    const rpc = makeRpc();
    const client = createBrowserDataClient(rpc);

    await client.listImportAcquisitionOptions("device:phone");
    await client.beginImportAcquisition("device:phone", "choose-export");
    await client.releaseImportSource("device:phone", "export:temporary");

    expect(rpc.callService).toHaveBeenNthCalledWith(1, "extensions", "invokeProvider", [
      "browserData",
      "listImportAcquisitionOptions",
      ["device:phone"],
    ]);
    expect(rpc.callService).toHaveBeenNthCalledWith(2, "extensions", "invokeProvider", [
      "browserData",
      "beginImportAcquisition",
      ["device:phone", "choose-export"],
    ]);
    expect(rpc.callService).toHaveBeenNthCalledWith(3, "extensions", "invokeProvider", [
      "browserData",
      "releaseImportSource",
      ["device:phone", "export:temporary"],
    ]);
  });

  it("keeps sensitive preview and durable control on the sealed provider contract", async () => {
    const rpc = makeRpc();
    const client = createBrowserDataClient(rpc);
    const request = {
      hostId: "desktop:one",
      sourceId: "profile:one",
      dataTypes: ["passwords" as const],
      operationId: "import-sensitive-1",
    };

    await client.previewSensitiveImport({
      hostId: request.hostId,
      sourceId: request.sourceId,
      dataTypes: request.dataTypes,
    });
    await client.startSensitiveImport(request);
    await client.observeSensitiveImport(request.operationId);
    await client.cancelSensitiveImport(request.operationId);
    await client.openBrowserPrivacyManager("credentials");

    expect(rpc.callService).toHaveBeenNthCalledWith(1, "extensions", "invokeProvider", [
      "browserData",
      "previewSensitiveImport",
      [{ hostId: request.hostId, sourceId: request.sourceId, dataTypes: request.dataTypes }],
    ]);
    expect(rpc.callService).toHaveBeenNthCalledWith(2, "extensions", "invokeProvider", [
      "browserData",
      "startSensitiveImport",
      [request],
    ]);
    expect(rpc.callService).toHaveBeenNthCalledWith(3, "extensions", "invokeProvider", [
      "browserData",
      "observeSensitiveImport",
      [request.operationId],
    ]);
    expect(rpc.callService).toHaveBeenNthCalledWith(4, "extensions", "invokeProvider", [
      "browserData",
      "cancelSensitiveImport",
      [request.operationId],
    ]);
    expect(rpc.callService).toHaveBeenNthCalledWith(5, "extensions", "invokeProvider", [
      "browserData",
      "openBrowserPrivacyManager",
      ["credentials"],
    ]);
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
