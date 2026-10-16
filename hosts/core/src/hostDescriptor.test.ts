import { describe, expect, it } from "vitest";
import { CURRENT_HOST_ABI } from "@vibestudio/workspace-contracts/clients";
import { buildHostDescriptor } from "./hostDescriptor.js";

describe("buildHostDescriptor", () => {
  it("intersects the catalog with what the host implements", () => {
    const d = buildHostDescriptor({
      host: "desktop",
      hostVersion: "1.2.3",
      implemented: ["notifications", "tray"],
    });
    expect(d.runtimes).toEqual({ web: CURRENT_HOST_ABI.web });
    expect([...d.capabilities].sort()).toEqual(["notifications", "tray"]);
  });

  it("rejects a capability the host kind cannot implement", () => {
    expect(() =>
      buildHostDescriptor({ host: "terminal", hostVersion: "1", implemented: ["tray"] })
    ).toThrow(/cannot implement/);
  });
});
