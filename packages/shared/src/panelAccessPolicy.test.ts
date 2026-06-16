import { describe, expect, it } from "vitest";
import {
  PANEL_AUTOMATE_CAPABILITY,
  PANEL_STRUCTURAL_CAPABILITY,
  accessDecision,
  panelAccessCapabilityForOperation,
} from "./panelAccessPolicy.js";

describe("panelAccessPolicy", () => {
  it("leaves open metadata, loading, focus, and consensual RPC operations ungated", () => {
    for (const op of ["metadata", "ensureLoaded", "focus", "rpc.call"] as const) {
      expect(accessDecision(op, { id: "panel-a", kind: "panel" }, { id: "panel-b" })).toEqual({
        allow: true,
      });
    }
  });

  it("gates CDP and browser-driving verbs with panel.automate", () => {
    for (const op of ["cdp", "navigate", "reload", "goBack", "goForward", "stop"] as const) {
      expect(panelAccessCapabilityForOperation(op)).toBe(PANEL_AUTOMATE_CAPABILITY);
      expect(accessDecision(op, { id: "panel-a", kind: "panel" }, { id: "panel-b" })).toEqual({
        allow: true,
        capability: PANEL_AUTOMATE_CAPABILITY,
        severity: "standard",
      });
    }
  });

  it("gates structural operations separately from automation", () => {
    for (const op of [
      "archive",
      "openPanel",
      "close",
      "unload",
      "movePanel",
      "replacePanel",
      "takeOver",
      "openDevTools",
      "rebuildPanel",
      "rebuildAndReload",
      "updatePanelState",
      "stateArgs.set",
    ] as const) {
      expect(panelAccessCapabilityForOperation(op)).toBe(PANEL_STRUCTURAL_CAPABILITY);
      expect(accessDecision(op, { id: "parent", kind: "panel" }, { id: "child" })).toEqual({
        allow: true,
        capability: PANEL_STRUCTURAL_CAPABILITY,
        severity: "standard",
      });
    }
  });

  it("does not grant relationship bypasses", () => {
    expect(accessDecision("cdp", { id: "parent", kind: "panel" }, { id: "child" })).toMatchObject({
      capability: PANEL_AUTOMATE_CAPABILITY,
    });
    expect(accessDecision("close", { id: "parent", kind: "panel" }, { id: "child" })).toMatchObject(
      { capability: PANEL_STRUCTURAL_CAPABILITY }
    );
  });

  it("escalates privileged targets to severe approvals", () => {
    expect(
      accessDecision("cdp", { id: "panel-a", kind: "panel" }, { id: "about", privileged: true })
    ).toEqual({
      allow: true,
      capability: PANEL_AUTOMATE_CAPABILITY,
      severity: "severe",
    });
    expect(
      accessDecision("close", { id: "panel-a", kind: "panel" }, { id: "about", shell: true })
    ).toEqual({
      allow: true,
      capability: PANEL_STRUCTURAL_CAPABILITY,
      severity: "severe",
    });
  });

  it("bypasses trusted shell/server and privileged requester panels", () => {
    for (const requester of [
      { id: "shell", kind: "shell" },
      { id: "remote", kind: "shell-remote" },
      { id: "server", kind: "server" },
      { id: "about", kind: "panel", privileged: true },
    ] as const) {
      expect(accessDecision("cdp", requester, { id: "target", privileged: true })).toEqual({
        allow: true,
      });
    }
  });
});
