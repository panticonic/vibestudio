import { describe, expect, it } from "vitest";

import { assertBootstrapRpcMessageAllowed } from "./bootstrapTransportPolicy.js";

describe("bootstrap transport policy", () => {
  it("allows only launch-gate RPC methods to main", () => {
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "workspace.hostTargets.launch",
      })
    ).not.toThrow();
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "shellApproval.resolveBootstrap",
      })
    ).not.toThrow();
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "shellApproval.listPending",
      })
    ).not.toThrow();
  });

  it("rejects arbitrary shell RPC methods and non-main targets", () => {
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "panel.create",
      })
    ).toThrow(/not allowed/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "workspace.select",
      })
    ).toThrow(/not allowed/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "shellApproval.resolve",
      })
    ).toThrow(/not allowed/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "shellApproval.listBootstrapPending",
      })
    ).toThrow(/not allowed/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("panel-1", {
        type: "request",
        method: "shellApproval.listBootstrapPending",
      })
    ).toThrow(/only call the host/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "event",
        event: "anything",
      })
    ).toThrow(/only send RPC requests/);
  });
});
