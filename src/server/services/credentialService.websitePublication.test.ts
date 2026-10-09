import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import { createCredentialService } from "./credentialService.js";
import { CredentialSessionGrantStore } from "./credentialSessionGrants.js";
import { WebsitePublicationJournal } from "./websitePublicationJournal.js";

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
  it("retains the reviewed intent, retires caller grants, and never reopens a submitted operation", async () => {
    const sessionGrantStore = new CredentialSessionGrantStore();
    const publicationJournal = new WebsitePublicationJournal();
    const service = createCredentialService({ sessionGrantStore, publicationJournal });
    await expect(
      service.handler({ caller }, "beginWebsitePublication", [publication])
    ).resolves.toMatchObject({ phase: "prepared" });
    await expect(
      service.handler({ caller }, "beginWebsitePublication", [
        { ...publication, artifactDigest: `sha256:${"b".repeat(64)}` },
      ])
    ).rejects.toMatchObject({ code: "WEBSITE_PUBLICATION_INTENT_CONFLICT" });
    const other = createVerifiedCaller("worker:other", "worker");
    await expect(
      service.handler({ caller: other }, "recordWebsitePublication", [
        publication,
        { phase: "uploaded" },
      ])
    ).rejects.toThrow("has not been reviewed");
    sessionGrantStore.dropForCaller(caller.runtime.id);
    await expect(
      service.handler({ caller }, "recordWebsitePublication", [publication, { phase: "uploaded" }])
    ).rejects.toThrow("has not been reviewed");
    await service.handler({ caller }, "beginWebsitePublication", [publication]);
    await service.handler({ caller }, "recordWebsitePublication", [
      publication,
      { phase: "uploaded" },
    ]);
    await expect(
      service.handler({ caller }, "beginWebsitePublication", [publication])
    ).resolves.toMatchObject({ phase: "uploaded" });
    await service.handler({ caller }, "recordWebsitePublication", [
      publication,
      { phase: "submitted", deploymentId: "deployment-1" },
    ]);
    await expect(
      service.handler({ caller }, "beginWebsitePublication", [publication])
    ).resolves.toMatchObject({ phase: "submitted", deploymentId: "deployment-1" });
    expect(
      sessionGrantStore.hasWebsitePublication(caller.runtime.id, publication.operationId)
    ).toBe(false);
    await expect(
      service.handler({ caller }, "publishFetch", [request, publication])
    ).rejects.toThrow("has not been reviewed");
  });

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
    ).rejects.toMatchObject({ code: "WEBSITE_PUBLICATION_INTENT_CONFLICT" });
  });
});
