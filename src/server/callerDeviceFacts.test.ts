import { describe, expect, it } from "vitest";
import { deviceIdOfHostPrincipal, resolveCallerDeviceFacts } from "./callerDeviceFacts.js";

const DEVICE = "dev_abcdefghijklmnopqrstuvwx";
const PHONE = "dev_zyxwvutsrqponmlkjihgfedc";

const sources = {
  panelIdentityForRuntime: (id: string) => (id === "panel:nav-1" ? "panel:tree/slot-1" : undefined),
  presentationCallerForRuntime: (id: string) =>
    id === "panel:nav-1" ? `shell:${DEVICE}` : id === "panel:nav-2" ? "client:mobile:rn:x" : null,
  clientPrincipalDevice: (id: string) => (id === "client:mobile:rn:x" ? PHONE : null),
};

describe("caller device facts", () => {
  it("projects slot, lease-holder device and verified source for a panel", () => {
    expect(
      resolveCallerDeviceFacts(
        { runtime: { id: "panel:nav-1", kind: "panel" }, code: { repoPath: "panels/tendril" } },
        sources
      )
    ).toEqual({
      callerPanelId: "panel:tree/slot-1",
      callerDeviceId: DEVICE,
      callerPanelSource: "panels/tendril",
    });
  });

  it("resolves a client-principal host through its attested device", () => {
    expect(
      resolveCallerDeviceFacts({ runtime: { id: "panel:nav-2", kind: "panel" } }, sources)
    ).toEqual({ callerDeviceId: PHONE });
  });

  it("gives a panel without a lease no device", () => {
    expect(
      resolveCallerDeviceFacts(
        { runtime: { id: "panel:nav-9", kind: "panel" }, code: { repoPath: "panels/x" } },
        sources
      )
    ).toEqual({ callerPanelSource: "panels/x" });
  });

  it("stamps a device shell, names the local consoles, and nothing for code principals", () => {
    expect(
      resolveCallerDeviceFacts({ runtime: { id: `shell:${DEVICE}`, kind: "shell" } }, sources)
    ).toEqual({ callerDeviceId: DEVICE });
    expect(
      resolveCallerDeviceFacts({ runtime: { id: "headless-host", kind: "shell" } }, sources)
    ).toEqual({ callerDeviceId: "local:headless-host" });
    expect(deviceIdOfHostPrincipal("electron-main", sources)).toBe("local:electron-main");
    expect(
      resolveCallerDeviceFacts(
        { runtime: { id: "do:workers/x:X:k", kind: "do" }, code: { repoPath: "workers/x" } },
        sources
      )
    ).toEqual({});
    expect(deviceIdOfHostPrincipal("client:revoked", sources)).toBeNull();
  });
});
