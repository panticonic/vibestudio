import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { DeriveCredentialParamsSchema } from "@vibestudio/service-schemas/credentials";
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

const derivationSourceUrl = "https://api.example.test/upload-token";
const derivedAssetUrl = "https://assets.example.test/upload";

function jwtWithPayload(payload: string): string {
  return `eyJhbGciOiJub25lIn0.${Buffer.from(payload).toString("base64url")}.signature`;
}

function createDerivationFixture(token: string) {
  const saved: Array<Record<string, unknown>> = [];
  const credentialStore = {
    listUrlBound: vi.fn(() => saved),
    saveUrlBound: vi.fn((credential: Record<string, unknown>) => saved.push(credential)),
  };
  const forwardProxyFetch = vi.fn(async () => ({
    status: 200,
    statusText: "OK",
    headerPairs: [],
    finalUrl: derivationSourceUrl,
    body: Buffer.from(JSON.stringify({ result: { jwt: token } })),
  }));
  const service = createCredentialService({
    credentialStore: credentialStore as never,
    egressProxy: { forwardGitHttp: vi.fn(), forwardProxyFetch },
  });
  const params = {
    publication,
    source: {
      url: derivationSourceUrl,
      credentialId: "cloudflare-api",
      audiences: [{ url: derivationSourceUrl, match: "exact" as const }],
    },
    extract: { jsonPath: ["result", "jwt"] },
    credential: {
      label: "Cloudflare upload token",
      audience: [{ url: derivedAssetUrl, match: "exact" as const }],
      injection: {
        type: "header" as const,
        name: "Authorization",
        valueTemplate: "Bearer {token}",
      },
      expiry: "jwt" as const,
    },
  };
  return { service, params, credentialStore, forwardProxyFetch };
}

describe("credentialService website publication grant", () => {
  it("stores a derived credential with the provider JWT's fractional NumericDate expiry", async () => {
    const expiry = Math.floor(Date.now() / 1000) + 60.25;
    const { service, params, credentialStore, forwardProxyFetch } = createDerivationFixture(
      jwtWithPayload(JSON.stringify({ exp: expiry }))
    );
    expect(DeriveCredentialParamsSchema.parse(params)).toEqual(params);
    await service.handler({ caller }, "beginWebsitePublication", [publication]);

    const summary = await service.handler({ caller }, "deriveCredential", [params]);

    expect(summary).toMatchObject({
      expiresAt: expiry * 1000,
      audience: [{ url: derivedAssetUrl, match: "exact" }],
    });
    expect(credentialStore.saveUrlBound).toHaveBeenCalledWith(
      expect.objectContaining({ expiresAt: expiry * 1000 })
    );
    expect(forwardProxyFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        caller,
        url: derivationSourceUrl,
        method: "GET",
        credentialId: "cloudflare-api",
        audiences: [{ url: derivationSourceUrl, match: "exact" }],
      }),
      "publish"
    );
  });

  it.each([
    ["malformed JWT", "not.a.jwt"],
    ["missing expiry", jwtWithPayload(JSON.stringify({ sub: "upload" }))],
    ["non-numeric expiry", jwtWithPayload(JSON.stringify({ exp: "future" }))],
    ["non-finite expiry", jwtWithPayload('{"exp":1e309}')],
    [
      "unrepresentable epoch milliseconds",
      jwtWithPayload(JSON.stringify({ exp: Number.MAX_VALUE })),
    ],
    ["expired JWT", jwtWithPayload(JSON.stringify({ exp: Math.floor(Date.now() / 1000) - 1 }))],
  ])("does not persist a derived credential with %s", async (_case, token) => {
    const { service, params, credentialStore } = createDerivationFixture(token);
    await service.handler({ caller }, "beginWebsitePublication", [publication]);

    await expect(service.handler({ caller }, "deriveCredential", [params])).rejects.toMatchObject({
      message: "Credential derivation source returned no usable JWT expiry",
      cause: expect.any(Error),
    });
    expect(credentialStore.saveUrlBound).not.toHaveBeenCalled();
  });

  it("keeps derivation within the reviewed publication and exact source audience", async () => {
    const { service, params, credentialStore, forwardProxyFetch } = createDerivationFixture(
      jwtWithPayload(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 }))
    );

    await expect(service.handler({ caller }, "deriveCredential", [params])).rejects.toThrow(
      "Website publication has not been reviewed for this caller"
    );
    expect(forwardProxyFetch).not.toHaveBeenCalled();

    await service.handler({ caller }, "beginWebsitePublication", [publication]);
    await expect(
      service.handler({ caller }, "deriveCredential", [
        { ...params, source: { ...params.source, url: "https://other.example.test/token" } },
      ])
    ).rejects.toThrow("Credential request is outside the caller-bound audience");
    expect(forwardProxyFetch).not.toHaveBeenCalled();
    expect(credentialStore.saveUrlBound).not.toHaveBeenCalled();
  });

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
