import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import { createCredentialService } from "./credentialService.js";

const caller = createVerifiedCaller("worker:publisher", "worker");
const publication = {
  operationId: "publish-1",
  artifactDigest: `sha256:${"a".repeat(64)}`,
  provider: "example",
  destination: "account/site",
  environment: "preview" as const,
};
const request = {
  url: "https://api.example.test/deployments",
  method: "POST",
  body: "{}",
  audiences: [{ url: "https://api.example.test/deployments", match: "exact" as const }],
};

describe("credentialService website publication grant", () => {
  it("allows provider requests only after the exact caller-bound intent was reviewed", async () => {
    const forwardProxyFetch = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headerPairs: [],
      finalUrl: request.url,
      body: new Uint8Array(),
    }));
    const service = createCredentialService({
      workspaceId: "workspace-1",
      egressProxy: { forwardGitHttp: vi.fn(), forwardProxyFetch },
    });

    await expect(
      service.handler({ caller }, "publishFetch", [request, publication])
    ).rejects.toThrow("has not been reviewed");

    await service.handler({ caller }, "beginWebsitePublication", [publication]);
    await expect(
      service.handler({ caller }, "publishFetch", [request, publication])
    ).resolves.toMatchObject({ status: 200 });
    expect(forwardProxyFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: request.url }),
      "publish"
    );

    await expect(
      service.handler({ caller }, "publishFetch", [
        request,
        { ...publication, destination: "account/other-site" },
      ])
    ).rejects.toThrow("differs from the reviewed operation");
  });
});
