import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import { createCredentialService } from "./credentialService.js";

const caller = createVerifiedCaller("worker:test", "worker");

function response(url: string) {
  return {
    url,
    method: "GET",
    statusCode: 200,
    statusMessage: "OK",
    headers: {},
    body: new Uint8Array(),
  };
}

describe("credentialService logical Git credential boundary", () => {
  it("resolves one logical binding for the exact workspace, name, and remote", async () => {
    const forwardGitHttp = vi.fn(async ({ url }: { url: string }) => response(url));
    const service = createCredentialService({
      workspaceId: "workspace-1",
      egressProxy: { forwardGitHttp, forwardProxyFetch: vi.fn() },
    });
    const remoteUrl = "https://git.example.test/acme/repo.git";

    await service.handler({ caller }, "proxyGitHttp", [
      {
        url: `${remoteUrl}/info/refs?service=git-upload-pack`,
        logicalCredential: { name: "company-git", remoteUrl },
      },
    ]);

    expect(forwardGitHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { kind: "named", label: "company-git" },
      })
    );
  });

  it("rejects a request URL outside the declared remote before resolving or egressing", async () => {
    const forwardGitHttp = vi.fn();
    const service = createCredentialService({
      workspaceId: "workspace-1",
      egressProxy: { forwardGitHttp, forwardProxyFetch: vi.fn() },
    });

    await expect(
      service.handler({ caller }, "proxyGitHttp", [
        {
          url: "https://git.example.test/acme/other.git/info/refs",
          logicalCredential: {
            name: "company-git",
            remoteUrl: "https://git.example.test/acme/repo.git",
          },
        },
      ])
    ).rejects.toThrow("does not belong to declared remote");
    expect(forwardGitHttp).not.toHaveBeenCalled();
  });

  it("keeps explicit concrete credential overrides call-scoped", async () => {
    const forwardGitHttp = vi.fn(async ({ url }: { url: string }) => response(url));
    const service = createCredentialService({
      workspaceId: "workspace-1",
      egressProxy: { forwardGitHttp, forwardProxyFetch: vi.fn() },
    });

    await service.handler({ caller }, "proxyGitHttp", [
      {
        url: "https://git.example.test/acme/repo.git/info/refs",
        credentialId: "one-call-credential",
      },
    ]);

    expect(forwardGitHttp).toHaveBeenCalledWith(
      expect.objectContaining({
        credential: { kind: "credential", credentialId: "one-call-credential" },
      })
    );
  });
});
