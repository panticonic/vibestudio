import { schemaRpcCaller } from "@vibestudio/rpc/internal";
import { describe, expect, it, vi } from "vitest";
import { createCredentialClient } from "@vibestudio/service-schemas/clients/credentialClient";

describe("credential client HTTP mediation", () => {
  it("serializes FormData with the same multipart boundary sent in Content-Type", async () => {
    const stream = vi.fn(async (_target, _method, args) => {
      const request = args[0] as { headers: Record<string, string>; bodyBase64: string };
      const body = Buffer.from(request.bodyBase64, "base64").toString("utf8");
      const boundary = /boundary=([^;]+)/.exec(request.headers["content-type"]!)?.[1];
      expect(boundary).toBeTruthy();
      expect(body).toContain(`--${boundary}`);
      expect(body).toContain('name="manifest"');
      return new Response("ok");
    });
    const rpc = schemaRpcCaller({ call: vi.fn(), stream });
    const form = new FormData();
    form.set("manifest", "{}");

    await createCredentialClient(rpc).fetch("https://example.test/deploy", {
      method: "POST",
      body: form,
    });
  });

  it("sends publication intent separately and retains the caller audience ceiling", async () => {
    const stream = vi.fn(async () => new Response("ok"));
    const rpc = schemaRpcCaller({ call: vi.fn(), stream });
    const publication = {
      operationId: "publish-1",
      artifactDigest: `sha256:${"a".repeat(64)}`,
      provider: "example",
      destination: "account/site",
      environment: "preview" as const,
    };
    const audiences = [{ url: "https://api.example.test/deploy", match: "exact" as const }];

    await createCredentialClient(rpc).publishFetch(
      publication,
      audiences[0]!.url,
      { method: "POST", body: "{}" },
      { credentialId: "credential-1", audiences }
    );

    expect(stream).toHaveBeenCalledWith(
      "main",
      "credentials.publishFetch",
      [expect.objectContaining({ credentialId: "credential-1", audiences }), publication],
      { signal: undefined }
    );
  });
});
