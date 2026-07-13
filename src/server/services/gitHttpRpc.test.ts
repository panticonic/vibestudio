import { describe, expect, it } from "vitest";
import { credentialsMethods } from "../../../packages/shared/src/serviceSchemas/credentials.js";
import { serializeGitHttpResponse } from "./gitHttpRpc.js";

describe("serializeGitHttpResponse", () => {
  it("removes the binary transport body and emits the strict public RPC shape", () => {
    const result = serializeGitHttpResponse({
      url: "https://example.test/repo.git/info/refs",
      method: "GET",
      statusCode: 200,
      statusMessage: "OK",
      headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      body: Uint8Array.from([0, 1, 2, 255]),
    });

    expect(result).toEqual({
      url: "https://example.test/repo.git/info/refs",
      method: "GET",
      statusCode: 200,
      statusMessage: "OK",
      headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      bodyBase64: "AAEC/w==",
    });
    expect(credentialsMethods.proxyGitHttp.returns.safeParse(result).success).toBe(true);
    expect(result).not.toHaveProperty("body");
  });
});
