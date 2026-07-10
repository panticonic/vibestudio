import { __test__ } from "./oauthHandler";

describe("oauthHandler", () => {
  it("accepts vibestudio.app universal-link OAuth callbacks keyed by transactionId", () => {
    expect(
      __test__.parseCallback(
        "https://vibestudio.app/oauth/callback/tx-abc123?code=code-1&state=state-1"
      )
    ).toEqual({
      transactionId: "tx-abc123",
      code: "code-1",
      state: "state-1",
      rawUrl: "https://vibestudio.app/oauth/callback/tx-abc123?code=code-1&state=state-1",
    });
  });

  it("rejects vibestudio custom-scheme OAuth callbacks", () => {
    expect(
      __test__.parseCallback("vibestudio://oauth/callback/openai-codex?code=code-1&state=state-1")
    ).toBeNull();
  });
});
