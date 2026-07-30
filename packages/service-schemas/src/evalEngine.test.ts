import { describe, expect, it } from "vitest";
import { evalEngineMethods } from "./evalEngine.js";

describe("eval engine run admission", () => {
  it("accepts the host-normalized authority manifest digest", () => {
    const authorityManifestDigest = "a".repeat(64);
    expect(
      evalEngineMethods.startRun.args.parse([
        {
          runId: "run-1",
          code: "return 1",
          gatewayToken: "gateway-run-1",
          authorityManifestDigest,
        },
      ])
    ).toEqual([
      {
        runId: "run-1",
        code: "return 1",
        gatewayToken: "gateway-run-1",
        authorityManifestDigest,
      },
    ]);
  });
});
