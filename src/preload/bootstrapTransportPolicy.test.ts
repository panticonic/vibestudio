import { describe, expect, it } from "vitest";

import { assertBootstrapRpcMessageAllowed } from "./bootstrapTransportPolicy.js";

describe("bootstrap transport policy", () => {
  it("allows only launch-gate RPC methods to main", () => {
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "workspace.hostTargets.beginLaunch",
      })
    ).not.toThrow();
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "workspace.hostTargets.getLaunchSession",
      })
    ).not.toThrow();
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "workspace.hostTargets.resolveLaunchSessionApproval",
      })
    ).not.toThrow();
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "stream-request",
        method: "events.watch",
      })
    ).not.toThrow();
  });

  it("rejects using the wrong RPC shape for an otherwise allowed method", () => {
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", { type: "request", method: "events.watch" })
    ).toThrow(/not allowed/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "stream-request",
        method: "workspace.hostTargets.beginLaunch",
      })
    ).toThrow(/not allowed/);
  });

  it("rejects arbitrary shell RPC methods and non-main targets", () => {
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "panel.reloadView",
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
        method: "workspace.hostTargets.launch",
      })
    ).toThrow(/not allowed/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "request",
        method: "shellApproval.resolveBootstrap",
      })
    ).toThrow(/not allowed/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("panel-1", {
        type: "request",
        method: "workspace.hostTargets.beginLaunch",
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
