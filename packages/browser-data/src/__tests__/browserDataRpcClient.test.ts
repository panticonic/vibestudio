import { describe, expect, it, vi } from "vitest";
import {
  createBrowserDataRpcClient,
  resolveBrowserDataExtensionName,
} from "../client/browserDataRpcClient.js";

/** Fake RPC that serves the workspace manifest (workspace.getConfig) and
 *  records extension invocations. The broker extension name is manifest-
 *  declared (providers.browserData.extension) — never hardcoded. */
function makeRpc(config: unknown) {
  return vi.fn(async (service: string, method: string, _args: unknown[]) => {
    if (service === "workspace" && method === "getConfig") return config;
    if (service === "extensions" && method === "invoke") return [];
    return undefined;
  });
}

const CONFIG = {
  id: "ws",
  extensions: [{ source: "extensions/browser-data" }],
  providers: { browserData: { extension: "extensions/browser-data" } },
};

describe("createBrowserDataRpcClient", () => {
  it("relays calls as extensions.invoke against the manifest-declared broker", async () => {
    const call = makeRpc(CONFIG);
    const client = createBrowserDataRpcClient({ call });

    await client.history.searchForAutocomplete("git", 10);

    expect(call).toHaveBeenCalledWith("workspace", "getConfig", []);
    expect(call).toHaveBeenCalledWith("extensions", "invoke", [
      "@workspace-extensions/browser-data",
      "searchHistoryForAutocomplete",
      [{ query: "git", limit: 10 }],
    ]);
  });

  it("passes a single object argument through unwrapped", async () => {
    const call = makeRpc(CONFIG);
    const client = createBrowserDataRpcClient({ call });

    await client.history.recordVisit({ url: "https://example.com", typed: true });

    expect(call).toHaveBeenCalledWith("extensions", "invoke", [
      "@workspace-extensions/browser-data",
      "recordHistoryVisit",
      [{ url: "https://example.com", typed: true }],
    ]);
  });

  it("resolves the broker once and reuses it across calls", async () => {
    const call = makeRpc(CONFIG);
    const client = createBrowserDataRpcClient({ call });

    await client.bookmarks.search("a");
    await client.bookmarks.search("b");

    const configCalls = call.mock.calls.filter(
      ([service, method]) => service === "workspace" && method === "getConfig"
    );
    expect(configCalls).toHaveLength(1);
  });

  it("fails with a manifest diagnostic when no broker is declared (no hardcoded fallback)", async () => {
    const call = makeRpc({ id: "ws" });
    const client = createBrowserDataRpcClient({ call });

    await expect(client.bookmarks.search("a")).rejects.toThrow(
      /providers\.browserData\.extension/
    );
    expect(call).not.toHaveBeenCalledWith("extensions", "invoke", expect.anything());
  });

  it("retries broker resolution after a failed getConfig", async () => {
    let fail = true;
    const call = vi.fn(async (service: string, method: string) => {
      if (service === "workspace" && method === "getConfig") {
        if (fail) throw new Error("transport down");
        return CONFIG;
      }
      if (service === "extensions" && method === "invoke") return [];
      return undefined;
    });
    const client = createBrowserDataRpcClient({ call });

    await expect(client.bookmarks.search("a")).rejects.toThrow(/transport down/);
    fail = false;
    await expect(client.bookmarks.search("a")).resolves.toEqual([]);
  });
});

describe("resolveBrowserDataExtensionName", () => {
  it("returns the declared broker package name, or null when undeclared", async () => {
    await expect(resolveBrowserDataExtensionName({ call: makeRpc(CONFIG) })).resolves.toBe(
      "@workspace-extensions/browser-data"
    );
    await expect(
      resolveBrowserDataExtensionName({ call: makeRpc({ id: "ws" }) })
    ).resolves.toBeNull();
  });
});
