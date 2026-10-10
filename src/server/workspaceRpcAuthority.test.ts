import { describe, expect, it } from "vitest";
import { workspaceMethodPrincipals } from "./workspaceRpcAuthority.js";

describe("workspace RPC method principals", () => {
  it("intersects method restrictions with the service allowlist", () => {
    expect(workspaceMethodPrincipals(["host", "code"], ["host"])).toEqual(["host"]);
  });

  it("keeps service authority when the method has no narrower declaration", () => {
    const servicePrincipals = ["host", "code"] as const;
    expect(workspaceMethodPrincipals(servicePrincipals)).toBe(servicePrincipals);
  });
});
