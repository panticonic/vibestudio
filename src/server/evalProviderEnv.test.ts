import { describe, expect, it } from "vitest";
import { evalDoProviderEnv } from "./evalProviderEnv.js";

describe("evalDoProviderEnv", () => {
  it("maps every declared eval provider slot to its EvalDO binding", () => {
    expect(
      evalDoProviderEnv({
        evalEngine: { source: " @workspace/eval " },
        evalRuntime: { source: "@workspace/runtime" },
        cdpClient: { source: "@workspace/cdp-client" },
        natlang: { source: "@workspace/natlang" },
      })
    ).toEqual({
      EVAL_ENGINE_SOURCE: "@workspace/eval",
      EVAL_RUNTIME_SOURCE: "@workspace/runtime",
      EVAL_CDP_CLIENT_SOURCE: "@workspace/cdp-client",
      EVAL_NATLANG_SOURCE: "@workspace/natlang",
    });
  });

  it("leaves undeclared providers unbound", () => {
    expect(evalDoProviderEnv(undefined)).toEqual({});
    expect(evalDoProviderEnv({ evalEngine: { source: "@workspace/eval" } })).toEqual({
      EVAL_ENGINE_SOURCE: "@workspace/eval",
    });
  });
});
