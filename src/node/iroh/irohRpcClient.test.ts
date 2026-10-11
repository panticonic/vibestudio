import { describe, expect, it } from "vitest";
import { IrohRpcClient } from "./irohRpcClient.js";

describe("IrohRpcClient direct RPC method contract", () => {
  it("rejects dynamically supplied unqualified methods before connecting", async () => {
    const client = Object.create(IrohRpcClient.prototype);

    await expect(Reflect.apply(client.call, client, ["retireEntity", []])).rejects.toThrow(
      'Expected a service-qualified RPC method (service.method), received "retireEntity"'
    );
  });
});
