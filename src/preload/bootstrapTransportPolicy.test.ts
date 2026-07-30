import { describe, expect, it } from "vitest";

import { assertBootstrapRpcMessageAllowed } from "./bootstrapTransportPolicy.js";

describe("bootstrap transport policy", () => {
  it("allows only the generic launch workflow methods on main", () => {
    for (const method of [
      "build.listUnits",
      "workspace.getConfig",
      "runtime.supervision.activate",
      "runtime.supervision.prepare",
      "runtime.supervision.rollback",
      "shellApproval.listPending",
      "shellApproval.resolveBootstrap",
    ]) {
      expect(() =>
        assertBootstrapRpcMessageAllowed("main", { type: "request", method })
      ).not.toThrow();
    }
  });

  it("rejects streams, product launch facades, arbitrary methods, and non-main targets", () => {
    expect(() =>
      assertBootstrapRpcMessageAllowed("main", {
        type: "stream-request",
        method: "events.watch",
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
        method: "panel.reloadView",
      })
    ).toThrow(/not allowed/);
    expect(() =>
      assertBootstrapRpcMessageAllowed("panel-1", {
        type: "request",
        method: "build.listUnits",
      })
    ).toThrow(/only call the host/);
  });
});
