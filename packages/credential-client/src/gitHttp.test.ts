import type { RpcCaller } from "@vibestudio/rpc";
import { describe, expect, it, vi } from "vitest";
import { createGitHttpClient } from "./index.js";

describe("createGitHttpClient", () => {
  it("tries anonymous Git before automatic credential lookup", async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({
        url: "https://github.com/octocat/Hello-World.git/info/refs",
        method: "GET",
        statusCode: 401,
        statusMessage: "Unauthorized",
        headers: {},
        bodyBase64: "",
      })
      .mockResolvedValueOnce({
        url: "https://github.com/octocat/Hello-World.git/info/refs",
        method: "GET",
        statusCode: 200,
        statusMessage: "OK",
        headers: {},
        bodyBase64: "",
      });
    const client = createGitHttpClient({ call } as unknown as RpcCaller);

    await client.request({
      url: "https://github.com/octocat/Hello-World.git/info/refs",
    });

    expect(call).toHaveBeenNthCalledWith(1, "main", "credentials.proxyGitHttp", [
      expect.objectContaining({ credentialId: null }),
    ]);
    expect(call).toHaveBeenNthCalledWith(2, "main", "credentials.proxyGitHttp", [
      expect.objectContaining({ credentialId: undefined }),
    ]);
  });

  it("does not consult credentials when anonymous Git succeeds", async () => {
    const call = vi.fn(async () => ({
      url: "https://github.com/octocat/Hello-World.git/info/refs",
      method: "GET",
      statusCode: 200,
      statusMessage: "OK",
      headers: {},
      bodyBase64: "",
    }));
    const client = createGitHttpClient({ call } as unknown as RpcCaller);

    await client.request({
      url: "https://github.com/octocat/Hello-World.git/info/refs",
    });

    expect(call).toHaveBeenCalledOnce();
    expect(call).toHaveBeenCalledWith("main", "credentials.proxyGitHttp", [
      expect.objectContaining({ credentialId: null }),
    ]);
  });

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

  it("forwards a logical declaration without resolving or exposing a concrete id", async () => {
    const call = vi.fn(async () => ({
      url: "https://git.example.test/acme/repo.git/info/refs",
      method: "GET",
      statusCode: 200,
      statusMessage: "OK",
      headers: {},
      bodyBase64: "",
    }));
    const logicalCredential = {
      name: "company-git",
      remoteUrl: "https://git.example.test/acme/repo.git",
    };
    const client = createGitHttpClient({ call } as unknown as RpcCaller, {
      logicalCredential,
    });

    await client.request({
      url: "https://git.example.test/acme/repo.git/info/refs?service=git-upload-pack",
    });

    expect(call).toHaveBeenCalledWith("main", "credentials.proxyGitHttp", [
      expect.objectContaining({
        logicalCredential,
        credentialId: undefined,
      }),
    ]);
  });

  it("rejects mixing a logical declaration with a call-scoped concrete override", () => {
    expect(() =>
      createGitHttpClient({ call: vi.fn() } as unknown as RpcCaller, {
        credentialId: "concrete",
        logicalCredential: {
          name: "company-git",
          remoteUrl: "https://git.example.test/acme/repo.git",
        },
      })
    ).toThrow("either logicalCredential or credentialId");
  });
});
