import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/runtime", () => ({
  rpc: {
    call: vi.fn(),
    stream: vi.fn(),
  },
}));

import { createBrowserDataApi } from "./index";

function createRpc() {
  return {
    call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "extensions.invokeProvider") {
        return { method: args[1], args: args[2] };
      }
      return undefined;
    }),
    stream: vi.fn(),
  };
}

describe("createBrowserDataApi", () => {
  it("routes calls through the browserData provider namespace", async () => {
    const rpc = createRpc();
    const browserData = createBrowserDataApi(rpc as never);

    await browserData.searchHistory("git", 10);

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invokeProvider", [
      "browserData",
      "searchHistory",
      ["git", 10],
    ]);
  });

  it("preserves empty provider argument tuples", async () => {
    const rpc = createRpc();
    const browserData = createBrowserDataApi(rpc as never);

    await browserData.detectBrowsers();

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invokeProvider", [
      "browserData",
      "detectBrowsers",
      [],
    ]);
  });

  it("forwards provider routing errors without resolving an extension fallback", async () => {
    const rpc = {
      call: vi.fn(async () => {
        throw new Error("No extension provider declared for providers.browserData");
      }),
      stream: vi.fn(),
    };
    const browserData = createBrowserDataApi(rpc as never);

    await expect(browserData.detectBrowsers()).rejects.toThrow(/providers\.browserData/);
  });

  it("keeps Promise assimilation and inspection keys inert", () => {
    const rpc = createRpc();
    const browserData = createBrowserDataApi(rpc as never) as unknown as Record<
      string | symbol,
      unknown
    >;

    expect(browserData["then"]).toBeUndefined();
    expect(browserData["toJSON"]).toBeUndefined();
    expect(browserData[Symbol.toPrimitive]).toBeUndefined();
    expect(rpc.call).not.toHaveBeenCalled();
  });
});
