import { describe, expect, it } from "vitest";
import {
  attachRpcDiagnosticId,
  deserializeRpcFailure,
  formatRpcFailure,
  RpcBoundaryError,
  rpcDiagnosticIdOf,
  serializeRpcFailure,
} from "./errors.js";

describe("RPC failure contract", () => {
  it("retains aggregate children, shared causes, codes and domain data through repeated JSON hops", () => {
    const primary = new RpcBoundaryError(
      "credential owner disconnected",
      "transport",
      "ENOTCONN",
      undefined,
      {
        owner: "credentials",
      }
    );
    const secondary = new RpcBoundaryError("mission release failed", "application", "EIO");
    const failure = new AggregateError(
      [primary, new AggregateError([secondary], "Closing mission subscription failed")],
      "Setup observation failed",
      { cause: primary }
    );
    attachRpcDiagnosticId(primary, "c609322e-68f1-4b6a-88d8-577f03aa86f4");
    const hop = (error: unknown) =>
      deserializeRpcFailure(JSON.parse(JSON.stringify(serializeRpcFailure(error))));
    const remote = hop(hop(failure));
    expect(remote).toBeInstanceOf(AggregateError);
    const aggregate = remote as AggregateError;
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(aggregate.errors[0]).toMatchObject({
      message: primary.message,
      code: "ENOTCONN",
      errorKind: "transport",
      errorData: { owner: "credentials" },
    });
    expect(aggregate.errors[1]).toBeInstanceOf(AggregateError);
    expect(aggregate.errors[1].errors[0]).toMatchObject({
      message: secondary.message,
      code: "EIO",
    });
    expect(rpcDiagnosticIdOf(aggregate.errors[0])).toBe(rpcDiagnosticIdOf(primary));
    expect(formatRpcFailure(remote)).toContain(primary.message);
    expect(formatRpcFailure(remote)).toContain(secondary.message);
    expect(formatRpcFailure(remote).match(/credential owner disconnected/g)).toHaveLength(1);
  });

  it("preserves cyclic cause and aggregate references without losing other failures", () => {
    const failure = new AggregateError([new Error("independent failure")], "Owned cleanup failed");
    Object.defineProperty(failure, "cause", { value: failure });
    failure.errors.push(failure);
    const remote = deserializeRpcFailure(
      JSON.parse(JSON.stringify(serializeRpcFailure(failure)))
    ) as AggregateError;
    expect(remote.cause).toBe(remote);
    expect(remote.errors[1]).toBe(remote);
    expect(formatRpcFailure(remote)).toBe("Owned cleanup failed: independent failure");
  });
});
