import { describe, expect, it, vi } from "vitest";
import { schemaRpcMock } from "./test-utils.js";
import type { RpcMethod } from "./types.js";

const inspect: RpcMethod<[string], string> = {
  name: "inspect",
  parseArgs: async (args) => args,
  invoke: async (args, dispatch) => {
    const result = await dispatch(args);
    if (typeof result !== "string") throw new TypeError("Invalid inspect result");
    return result;
  },
};
function compilationContract() {
  const mock = schemaRpcMock({ call: vi.fn(async () => "value") });
  // @ts-expect-error The wire spy's signature cannot bypass the public contract.
  mock.call("target", "inspect", ["input"]);
  // @ts-expect-error The receiver requires a string argument.
  mock.call("target", inspect, [123]);
}
void compilationContract;

describe("application RPC fixtures", () => {
  it("uses the public boundary and keeps spy metadata live after reset", async () => {
    const wire = { call: vi.fn(async () => "value") };
    const mock = schemaRpcMock(wire);
    await expect(mock.call("target", inspect, ["first"])).resolves.toBe("value");
    expect(mock.call).toHaveBeenCalledWith("target", "inspect", ["first"], undefined);
    mock.call.mockClear();
    expect(mock.call.mock.calls).toHaveLength(0);
    mock.call.mockResolvedValueOnce("second");
    await expect(mock.call("target", inspect, ["next"])).resolves.toBe("second");
    expect(mock.call.mock.calls).toHaveLength(1);
  });
});
