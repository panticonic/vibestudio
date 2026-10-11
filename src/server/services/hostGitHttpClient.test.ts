import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
const transport = vi.hoisted(() => ({ withPublicHostHttp: vi.fn(), requestHostHttp: vi.fn() }));
vi.mock("./hostHttpTransport.js", () => transport);
import {
  assertHostGitReadRequest,
  createHostBootstrapGitReadClient,
  createHostGitReadClient,
  GitCredentialSelectionRequiredError,
} from "./hostGitHttpClient.js";
import { withPublicHostHttp } from "./hostHttpTransport.js";

function response(statusCode: number) {
  return {
    url: "https://example.test/repo.git/info/refs?service=git-upload-pack",
    method: "GET",
    statusCode,
    statusMessage: statusCode === 200 ? "OK" : "Forbidden",
    headers: {},
    body: new Uint8Array(),
  };
}

function requestAdapter(client: unknown) {
  return (
    client as unknown as {
      http: {
        request(input: {
          url: string;
          method?: string;
          headers?: Record<string, string>;
        }): Promise<unknown>;
      };
    }
  ).http.request;
}

describe("host Git read client", () => {
  it("allows upload-pack discovery and reads", () => {
    expect(() =>
      assertHostGitReadRequest({
        url: "https://example.test/repo.git/info/refs?service=git-upload-pack",
        method: "GET",
      })
    ).not.toThrow();
    expect(() =>
      assertHostGitReadRequest({
        url: "https://example.test/repo.git/git-upload-pack",
        method: "POST",
      })
    ).not.toThrow();
  });

  it("rejects receive-pack discovery and writes", () => {
    expect(() =>
      assertHostGitReadRequest({
        url: "https://example.test/repo.git/info/refs?service=git-receive-pack",
        method: "GET",
      })
    ).toThrow(/upload-pack reads/);
    expect(() =>
      assertHostGitReadRequest({
        url: "https://example.test/repo.git/git-receive-pack",
        method: "POST",
      })
    ).toThrow(/upload-pack reads/);
    expect(() =>
      assertHostGitReadRequest({
        url: "https://example.test/other/path",
        method: "GET",
      })
    ).toThrow(/upload-pack reads/);
  });

  it("limits trusted bootstrap requests to admitted anonymous smart-HTTP remotes", async () => {
    transport.withPublicHostHttp.mockImplementation(async (_input, consume) =>
      consume(new Response("git response", { status: 200 }))
    );
    const signal = new AbortController().signal;
    const bootstrap = createHostBootstrapGitReadClient({ signal });
    bootstrap.admitRemote("https://example.test/repo.git");
    const request = requestAdapter(bootstrap.git);

    const result = (await request({
      url: "https://example.test/repo.git/info/refs?service=git-upload-pack",
    })) as { body: AsyncIterable<Uint8Array> };
    const chunks = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));

    expect(Buffer.concat(chunks).toString()).toBe("git response");
    expect(withPublicHostHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        url: new URL("https://example.test/repo.git/info/refs?service=git-upload-pack"),
        signal,
      }),
      expect.any(Function)
    );
    await expect(
      request({ url: "https://example.test/other.git/info/refs?service=git-upload-pack" })
    ).rejects.toThrow(/outside the admitted template remotes/);
    await expect(
      request({ url: "https://other.test/repo.git/info/refs?service=git-upload-pack" })
    ).rejects.toThrow(/outside the admitted template remotes/);
    await expect(
      request({
        url: "https://example.test/repo.git/info/refs?service=git-upload-pack",
        headers: { authorization: "Bearer private" },
      })
    ).rejects.toThrow(/cannot forward credentials/);
    expect(withPublicHostHttp).toHaveBeenCalledTimes(1);
  });

  it("rejects bootstrap redirects without following them", async () => {
    transport.withPublicHostHttp.mockImplementation(async (_input, consume) =>
      consume(new Response(null, { status: 302, headers: { location: "https://other.test/" } }))
    );
    const bootstrap = createHostBootstrapGitReadClient();
    bootstrap.admitRemote("https://example.test/repo.git");
    await expect(
      requestAdapter(bootstrap.git)({
        url: "https://example.test/repo.git/info/refs?service=git-upload-pack",
      })
    ).rejects.toThrow(/does not follow remote redirects/);
  });

  it("retries a rejected anonymous read with automatic credential selection", async () => {
    const forwardGitHttp = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(200));
    const client = createHostGitReadClient({
      egress: { forwardGitHttp },
      caller: createVerifiedCaller("host:test", "server"),
      credential: { kind: "anonymous" },
      fallbackCredential: { kind: "automatic" },
      operation: () => ({
        service: "workspace-initialization",
        method: "test",
        resourceKey: "template:test",
        preparedStateDigest: "digest",
      }),
    });

    await requestAdapter(client)({
      url: "https://example.test/repo.git/info/refs?service=git-upload-pack",
    });

    expect(forwardGitHttp.mock.calls.map(([input]) => input.credential)).toEqual([
      { kind: "anonymous" },
      { kind: "automatic" },
    ]);
  });

  it("reports a typed selection requirement when automatic selection cannot read the remote", async () => {
    const client = createHostGitReadClient({
      egress: { forwardGitHttp: async () => response(403) },
      caller: createVerifiedCaller("host:test", "server"),
      credential: { kind: "anonymous" },
      fallbackCredential: { kind: "automatic" },
      credentialRequirement: {
        name: "template-abcdef0123456789",
        remoteUrl: "https://example.test/repo.git",
        provider: "example.test",
      },
      operation: () => ({
        service: "workspace-initialization",
        method: "test",
        resourceKey: "template:test",
        preparedStateDigest: "digest",
      }),
    });

    await expect(
      requestAdapter(client)({
        url: "https://example.test/repo.git/info/refs?service=git-upload-pack",
      })
    ).rejects.toBeInstanceOf(GitCredentialSelectionRequiredError);
  });

  it("retains the complete anonymous-fallback failure as the typed selection cause", async () => {
    const nested = new Error("credential store unavailable");
    const fallbackFailure = new AggregateError([nested], "automatic selection failed", {
      cause: nested,
    });
    const forwardGitHttp = vi
      .fn()
      .mockResolvedValueOnce(response(401))
      .mockRejectedValueOnce(fallbackFailure);
    const client = createHostGitReadClient({
      egress: { forwardGitHttp },
      caller: createVerifiedCaller("host:test", "server"),
      credential: { kind: "anonymous" },
      fallbackCredential: { kind: "automatic" },
      credentialRequirement: {
        name: "template-abcdef0123456789",
        remoteUrl: "https://example.test/repo.git",
        provider: "example.test",
      },
      operation: () => ({
        service: "workspace-initialization",
        method: "test",
        resourceKey: "template:test",
        preparedStateDigest: "digest",
      }),
    });

    const error = await requestAdapter(client)({
      url: "https://example.test/repo.git/info/refs?service=git-upload-pack",
    }).catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(GitCredentialSelectionRequiredError);
    if (!(error instanceof GitCredentialSelectionRequiredError)) {
      throw new Error("Expected the credential-selection wrapper");
    }
    expect(error.cause).toBe(fallbackFailure);
    expect((error.cause as AggregateError).errors).toEqual([nested]);
    expect((error.cause as AggregateError).cause).toBe(nested);
  });
});
