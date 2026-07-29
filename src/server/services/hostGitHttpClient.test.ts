import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  assertHostGitReadRequest,
  createHostGitReadClient,
  GitCredentialSelectionRequiredError,
} from "./hostGitHttpClient.js";

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

function requestAdapter(client: ReturnType<typeof createHostGitReadClient>) {
  return (
    client as unknown as {
      http: { request(input: { url: string; method?: string }): Promise<unknown> };
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
    ).toThrow(/cannot publish/);
    expect(() =>
      assertHostGitReadRequest({
        url: "https://example.test/repo.git/git-receive-pack",
        method: "POST",
      })
    ).toThrow(/cannot publish/);
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
});
