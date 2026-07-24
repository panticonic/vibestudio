import { describe, expect, it } from "vitest";
import { PANEL_BOOTSTRAP_SCRIPT } from "./panelBootstrapScript.js";

describe("PANEL_BOOTSTRAP_SCRIPT", () => {
  it("requires canonical entityId bootstrap identity without the old panelId alias", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("const entityId = cfg?.entityId;");
    expect(PANEL_BOOTSTRAP_SCRIPT).not.toContain("cfg?.panelId");
  });

  it("publishes runtime lease fields before loading the WebSocket transport", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT.indexOf("__vibestudioConnectionId")).toBeGreaterThan(-1);
    expect(PANEL_BOOTSTRAP_SCRIPT.indexOf('new URL("__transport.js"')).toBeGreaterThan(-1);
    expect(PANEL_BOOTSTRAP_SCRIPT.indexOf("__vibestudioConnectionId")).toBeLessThan(
      PANEL_BOOTSTRAP_SCRIPT.indexOf('new URL("__transport.js"')
    );
  });

  it("keeps runtime lease ids out of persisted/userland bootstrap state", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).not.toContain('url.searchParams.get("connectionId")');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('typeof cfg?.connectionId === "string"');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("delete stored.connectionId");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("delete globalThis.__vibestudioConnectionId");
  });

  it("keys persisted panel init by document URL instead of one shared session key", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain(
      'const storageKey = () => "__vibestudioPanelInit:" + location.href;'
    );
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("sessionStorage.getItem(storageKey())");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("sessionStorage.setItem(storageKey()");
    expect(PANEL_BOOTSTRAP_SCRIPT).not.toContain('sessionStorage.getItem("__vibestudioPanelInit")');
    expect(PANEL_BOOTSTRAP_SCRIPT).not.toContain('sessionStorage.setItem("__vibestudioPanelInit"');
  });

  it("renders a recovery surface when the generated panel bundle cannot load", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("bundle.onerror");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("The panel bundle could not be loaded.");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("Reload panel");
  });

  it("publishes a machine-readable boot handshake instead of using DOM presence as readiness", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("__vibestudioPanelBoot");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('reportBoot("loading")');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('reportBoot("booting")');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('bundle.onload = () => reportBoot("ready")');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('reportBoot("failed"');
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain('"vibestudio:panel-boot"');
  });

  it("ties the handshake to runtime and immutable build identity", () => {
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("__vibestudioEntityId");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("__vibestudioEffectiveVersion");
    expect(PANEL_BOOTSTRAP_SCRIPT).toContain("__vibestudioBuildKey");
  });
});
