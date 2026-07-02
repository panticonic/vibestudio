import { __test__ } from "./oauthHandler";

describe("oauthHandler", () => {
  it("accepts auth.snugenv.com universal-link OAuth callbacks", () => {
    expect(
      __test__.parseCallback(
        "https://auth.snugenv.com/oauth/callback/openai-codex?code=code-1&state=state-1"
      )
    ).toEqual({
      provider: "openai-codex",
      code: "code-1",
      state: "state-1",
      rawUrl: "https://auth.snugenv.com/oauth/callback/openai-codex?code=code-1&state=state-1",
    });
  });

  it("rejects vibez1 custom-scheme OAuth callbacks", () => {
    expect(
      __test__.parseCallback("vibez1://oauth/callback/openai-codex?code=code-1&state=state-1")
    ).toBeNull();
  });
});
