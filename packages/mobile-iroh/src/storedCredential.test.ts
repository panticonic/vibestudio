import { describe, expect, it } from "vitest";
import {
  createPairedMobileConnection,
  createRoutedMobileConnection,
  parseStoredMobileConnection,
  selectMobileConnectionWorkspace,
} from "./storedCredential.js";

const credential = { deviceId: `dev_${"D".repeat(24)}`, refreshToken: "R".repeat(43) };
const control = {
  endpointId: "aa".repeat(32),
  relays: ["https://relay.example/"],
  v: 4 as const,
  code: "C".repeat(32),
  exp: Date.now() + 60_000,
};
const workspace = {
  endpointId: "bb".repeat(32),
  relays: ["https://relay.example/"],
  v: 4 as const,
};

describe("stored mobile Iroh connection", () => {
  it("persists paired state before adding a workspace reach", () => {
    const paired = createPairedMobileConnection(
      credential,
      control,
      "ws_default",
      "identity-1",
      123
    );
    expect(paired).toMatchObject({ schemaVersion: 5, transport: "iroh", phase: "paired" });
    expect(paired.controlPairing).not.toHaveProperty("code");
    const routed = createRoutedMobileConnection(paired, workspace);
    expect(parseStoredMobileConnection(JSON.stringify(routed))).toEqual(routed);
  });

  it("drops the old workspace reach when selection changes", () => {
    const routed = createRoutedMobileConnection(
      createPairedMobileConnection(credential, control, "ws_default", "identity-1", 123),
      workspace
    );
    expect(selectMobileConnectionWorkspace(routed, "ws_other")).toMatchObject({
      phase: "paired",
      selectedWorkspaceId: "ws_other",
    });
    expect(selectMobileConnectionWorkspace(routed, "ws_other")).not.toHaveProperty(
      "workspacePairing"
    );
  });

  it("rejects old or malformed records instead of migrating them", () => {
    expect(
      parseStoredMobileConnection(
        JSON.stringify({
          ...createPairedMobileConnection(credential, control, "ws_default", "identity-1", 123),
          schemaVersion: 4,
        })
      )
    ).toBeNull();
    expect(parseStoredMobileConnection("not-json")).toBeNull();
  });
});
