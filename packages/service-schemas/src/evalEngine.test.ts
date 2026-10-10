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
  it("allows cancellation before admission without inventing a scope snapshot", () => {
    const reply = {
      runId: "cancelled-first",
      runDigest: "d".repeat(64),
      status: "cancelled",
      existing: true,
    };
    expect(evalEngineMethods.startRun.returns.parse(reply)).toEqual(reply);
    expect(() => evalEngineMethods.startRun.returns.parse({ ...reply, status: "pending" })).toThrow(
      "scope input revision"
    );
    expect(() => evalEngineMethods.startRun.returns.parse({ ...reply, existing: false })).toThrow(
      "scope input revision"
    );
  });
});
