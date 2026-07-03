import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/runtime", () => ({
  rpc: {
    call: vi.fn(),
    stream: vi.fn(),
  },
}));

import { createBrowserDataApi } from "./index";

const CONFIG = {
  providers: {
    browserData: {
      extension: "extensions/browser-data",
    },
  },
};

function createRpc(config: unknown = CONFIG) {
  return {
    call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
      if (method === "workspace.getConfig") return config;
      if (method === "extensions.invoke") return { method: args[1], args: args[2] };
      return undefined;
    }),
    stream: vi.fn(),
  };
}

describe("createBrowserDataApi", () => {
  it("routes calls through the manifest-declared browser-data broker", async () => {
    const rpc = createRpc();
    const browserData = createBrowserDataApi(rpc as never);

    await browserData.searchHistory("git", 10);

    expect(rpc.call).toHaveBeenCalledWith("main", "workspace.getConfig", []);
    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/browser-data",
      "searchHistory",
      ["git", 10],
    ]);
  });

  it("accepts a package-name broker declaration", async () => {
    const rpc = createRpc({
      providers: {
        browserData: {
          extension: "@workspace-extensions/custom-data",
        },
      },
    });
    const browserData = createBrowserDataApi(rpc as never);

    await browserData.detectBrowsers();

    expect(rpc.call).toHaveBeenCalledWith("main", "extensions.invoke", [
      "@workspace-extensions/custom-data",
      "detectBrowsers",
      [],
    ]);
  });

  it("fails without a broker declaration instead of falling back to a hardcoded extension", async () => {
    const rpc = createRpc({});
    const browserData = createBrowserDataApi(rpc as never);

    await expect(browserData.detectBrowsers()).rejects.toThrow(/providers\.browserData\.extension/);
    expect(rpc.call).not.toHaveBeenCalledWith("main", "extensions.invoke", expect.anything());
  });

  it("retries broker resolution after a failed workspace config read", async () => {
    let fail = true;
    const rpc = {
      call: vi.fn(async (_target: string, method: string, args: unknown[]) => {
        if (method === "workspace.getConfig") {
          if (fail) throw new Error("transport down");
          return CONFIG;
        }
        if (method === "extensions.invoke") return { method: args[1] };
        return undefined;
      }),
      stream: vi.fn(),
    };
    const browserData = createBrowserDataApi(rpc as never);

    await expect(browserData.detectBrowsers()).rejects.toThrow(/transport down/);
    fail = false;
    await expect(browserData.detectBrowsers()).resolves.toEqual({ method: "detectBrowsers" });

    const configCalls = rpc.call.mock.calls.filter(
      ([, method]) => method === "workspace.getConfig"
    );
    expect(configCalls).toHaveLength(2);
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
