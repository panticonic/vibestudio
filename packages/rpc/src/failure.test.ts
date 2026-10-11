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

  it("retains allowlisted SQLite diagnostics across failure graph hops", () => {
    const sqliteFailure = Object.assign(new Error("database is locked"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 5,
      errstr: "database is locked",
    });
    const failure = new AggregateError([sqliteFailure], "Dependency maintenance failed", {
      cause: sqliteFailure,
    });
    const hop = (error: unknown) =>
      deserializeRpcFailure(JSON.parse(JSON.stringify(serializeRpcFailure(error))));
    const remote = hop(hop(failure)) as AggregateError;
    const child = remote.errors[0] as Error & {
      code?: string;
      errorKind?: string;
      errorData?: unknown;
      systemError?: { sqlite?: { errcode: number; errstr: string } };
    };

    expect(remote.cause).toBe(child);
    expect(child).toMatchObject({
      message: "database is locked",
      code: "ERR_SQLITE_ERROR",
      systemError: { sqlite: { errcode: 5, errstr: "database is locked" } },
    });
    expect(formatRpcFailure(remote)).toContain("SQLite errcode=5, errstr=database is locked");
    expect(formatRpcFailure(sqliteFailure)).toContain(
      "SQLite errcode=5, errstr=database is locked"
    );

    // A plain structural copy stands in for a RemoteRpcError from another bundle/realm.
    const otherRealmCopy = Object.assign(new Error(child.message), {
      name: "RemoteRpcError",
      errorKind: child.errorKind,
      code: child.code,
      errorData: { owner: "maintenance" },
      systemError: child.systemError,
    });
    const relayed = hop(otherRealmCopy);
    expect(relayed).toMatchObject({
      systemError: { sqlite: { errcode: 5, errstr: "database is locked" } },
      errorData: { owner: "maintenance" },
    });
  });
});
