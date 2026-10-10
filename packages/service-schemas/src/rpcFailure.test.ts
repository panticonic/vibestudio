import { describe, expect, it } from "vitest";
import { serializeRpcFailure } from "@vibestudio/rpc";
import { rpcFailureSchema } from "./rpcFailure.js";

describe("RPC failure schema", () => {
  it("accepts complete graphs with shared references", () => {
    const shared = Object.assign(new Error("shared cause"), { code: "ESHARED" });
    const failure = Object.assign(
      new AggregateError([shared, shared], "operation failed", { cause: shared }),
      {
        code: "EOPERATION",
      }
    );
    const payload = serializeRpcFailure(failure, "application");

    expect(rpcFailureSchema.safeParse(payload).success).toBe(true);
    expect(payload.cause).toEqual({
      id: 1,
      message: "shared cause",
      errorKind: "application",
      code: "ESHARED",
      name: "Error",
      stack: expect.any(String),
    });
    expect(payload.errors?.[0]).toEqual({ reference: 1 });
    expect(payload.errors?.[1]).toEqual({ reference: 1 });
  });

  it("requires a complete root failure node and its error kind", () => {
    expect(rpcFailureSchema.safeParse({ reference: 1 }).success).toBe(false);
    expect(rpcFailureSchema.safeParse({ message: "missing kind" }).success).toBe(false);
  });
});
