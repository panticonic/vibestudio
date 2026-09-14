import { describe, expect, it } from "vitest";
import { credentialsMethods } from "@vibestudio/service-schemas/credentials";
import { createGitHttpResponse } from "./gitHttpRpc.js";

describe("createGitHttpResponse", () => {
  it("keeps binary Git transport bodies on the streaming response", async () => {
    const result = createGitHttpResponse({
      url: "https://example.test/repo.git/info/refs",
      method: "GET",
      statusCode: 200,
      statusMessage: "OK",
      headers: { "content-type": "application/x-git-upload-pack-advertisement" },
      body: Uint8Array.from([0, 1, 2, 255]),
    });

    expect(result.status).toBe(200);
    expect(result.statusText).toBe("OK");
    expect(result.headers.get("content-type")).toBe("application/x-git-upload-pack-advertisement");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(Uint8Array.from([0, 1, 2, 255]));
    expect(credentialsMethods.proxyGitHttp.returns.safeParse(result).success).toBe(true);
  });

  it("accepts null as an explicit anonymous Git transport selection", () => {
    expect(
      credentialsMethods.proxyGitHttp.args.safeParse([
        {
          url: "https://github.com/octocat/Hello-World.git/info/refs",
          credentialId: null,
        },
      ]).success
    ).toBe(true);
  });
});
