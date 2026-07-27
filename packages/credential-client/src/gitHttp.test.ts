import type { RpcCaller } from "@vibestudio/rpc";
import { describe, expect, it, vi } from "vitest";
import { createGitHttpClient } from "./index.js";

describe("createGitHttpClient", () => {
  it("preserves an explicitly anonymous credential selection across RPC", async () => {
    const call = vi.fn(async () => ({
      url: "https://github.com/octocat/Hello-World.git/info/refs",
      method: "GET",
      statusCode: 200,
      statusMessage: "OK",
      headers: {},
      bodyBase64: "",
    }));
    const client = createGitHttpClient({ call } as unknown as RpcCaller, {
      credentialId: null,
    });

    await client.request({
      url: "https://github.com/octocat/Hello-World.git/info/refs",
    });

    expect(call).toHaveBeenCalledWith("main", "credentials.proxyGitHttp", [
      expect.objectContaining({ credentialId: null }),
    ]);
  });
});
