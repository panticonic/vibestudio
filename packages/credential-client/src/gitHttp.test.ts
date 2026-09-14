import type { RpcCaller } from "@vibestudio/rpc";
import { describe, expect, it, vi } from "vitest";
import { createGitHttpClient } from "./index.js";

describe("createGitHttpClient", () => {
  const response = (status = 200, statusText = "OK") =>
    new Response(new Uint8Array(), { status, statusText });

  it("tries anonymous Git before automatic credential lookup", async () => {
    const stream = vi
      .fn()
      .mockResolvedValueOnce(response(401, "Unauthorized"))
      .mockResolvedValueOnce(response());
    const client = createGitHttpClient({ stream } as unknown as RpcCaller);

    await client.request({
      url: "https://github.com/octocat/Hello-World.git/info/refs",
    });

    expect(stream).toHaveBeenNthCalledWith(
      1,
      "main",
      "credentials.proxyGitHttp",
      [expect.objectContaining({ credentialId: null })],
      { trafficClass: "bulk" }
    );
    expect(stream).toHaveBeenNthCalledWith(
      2,
      "main",
      "credentials.proxyGitHttp",
      [expect.objectContaining({ credentialId: undefined })],
      { trafficClass: "bulk" }
    );
  });

  it("does not consult credentials when anonymous Git succeeds", async () => {
    const stream = vi.fn(async () => response());
    const client = createGitHttpClient({ stream } as unknown as RpcCaller);

    await client.request({
      url: "https://github.com/octocat/Hello-World.git/info/refs",
    });

    expect(stream).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledWith(
      "main",
      "credentials.proxyGitHttp",
      [expect.objectContaining({ credentialId: null })],
      { trafficClass: "bulk" }
    );
  });

  it("preserves an explicitly anonymous credential selection across RPC", async () => {
    const stream = vi.fn(async () => response());
    const client = createGitHttpClient({ stream } as unknown as RpcCaller, {
      credentialId: null,
    });

    await client.request({
      url: "https://github.com/octocat/Hello-World.git/info/refs",
    });

    expect(stream).toHaveBeenCalledWith(
      "main",
      "credentials.proxyGitHttp",
      [expect.objectContaining({ credentialId: null })],
      { trafficClass: "bulk" }
    );
  });

  it("forwards a logical declaration without resolving or exposing a concrete id", async () => {
    const stream = vi.fn(async () => response());
    const logicalCredential = {
      name: "company-git",
      remoteUrl: "https://git.example.test/acme/repo.git",
    };
    const client = createGitHttpClient({ stream } as unknown as RpcCaller, {
      logicalCredential,
    });

    await client.request({
      url: "https://git.example.test/acme/repo.git/info/refs?service=git-upload-pack",
    });

    expect(stream).toHaveBeenCalledWith(
      "main",
      "credentials.proxyGitHttp",
      [
        expect.objectContaining({
          logicalCredential,
          credentialId: undefined,
        }),
      ],
      { trafficClass: "bulk" }
    );
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
