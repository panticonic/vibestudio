import { describe, expect, it, vi } from "vitest";
import { workspaceIrohReach } from "./workspaceIrohReach.js";
import { IROH_REACH_VERSION } from "@vibestudio/iroh-transport";

const relays = ["https://relay.example.test/"];
const coordinate = { endpointId: "a".repeat(64), relays, v: IROH_REACH_VERSION };

describe("bound workspace Iroh coordinates", () => {
  it("publishes the bound endpoint identity without waiting for relay availability", () => {
    const waitUntilOnline = vi.fn(() => new Promise(() => {}));
    const reach = vi.fn(() => coordinate);
    const ingress = { endpoint: { reach }, waitUntilOnline, isOnline: false };
    expect(workspaceIrohReach(ingress, relays)).toBe(coordinate);
    expect(reach).toHaveBeenCalledExactlyOnceWith(relays);
    expect(waitUntilOnline).not.toHaveBeenCalled();
  });

  it("does not invent coordinates for an unbound or retired ingress", () => {
    expect(() => workspaceIrohReach(null, relays)).toThrow("Workspace Iroh ingress is not ready");
    const failure = new Error("bound generation retired");
    const ingress = {
      get endpoint(): { reach(): typeof coordinate } {
        throw failure;
      },
    };
    expect(() => workspaceIrohReach(ingress, relays)).toThrow(failure);
  });

  it("preserves native coordinate failures and rejects invalid endpoint evidence", () => {
    const failure = new Error("native endpoint address unavailable");
    expect(() =>
      workspaceIrohReach(
        {
          endpoint: {
            reach: () => {
              throw failure;
            },
          },
        },
        relays
      )
    ).toThrow(failure);
    expect(() =>
      workspaceIrohReach(
        { endpoint: { reach: () => ({ ...coordinate, endpointId: "invalid" }) } },
        relays
      )
    ).toThrow();
  });
});
