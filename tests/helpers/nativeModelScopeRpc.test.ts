import { describe, expect, it } from "vitest";
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import { createNativeModelScopeRpc } from "./nativeModelScopeRpc.js";

describe("native model credential scope fixture", () => {
  it("exposes only its unary authority and retires each exact owned scope once", async () => {
    const owner = createNativeModelScopeRpc();
    expect(Object.keys(owner.rpc)).toEqual(["call"]);
    const { scopeId } = await owner.rpc.call(
      "main",
      mainRpcMethods["credentials.openWebSocketScope"],
      [{ url: "wss://provider.test/model", credentialId: "selected" }]
    );
    expect(owner.inspect()).toEqual({ open: [scopeId], closed: [] });
    await owner.rpc.call("main", mainRpcMethods["credentials.closeWebSocketScope"], [{ scopeId }]);
    expect(owner.inspect()).toEqual({ open: [], closed: [scopeId] });
    await expect(
      owner.rpc.call("main", mainRpcMethods["credentials.closeWebSocketScope"], [{ scopeId }])
    ).rejects.toThrow(`Scope is not owned: ${scopeId}`);
  });
});
