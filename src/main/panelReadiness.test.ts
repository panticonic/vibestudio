import { describe, expect, it } from "vitest";
import {
  isPanelContentReady,
  isTerminalPanelReadiness,
  panelReadinessSnapshot,
  type PanelReadinessSignals,
} from "./panelReadiness.js";

const readySignals = (): PanelReadinessSignals => ({
  panelId: "panel:tree/root",
  source: "panels/chat",
  runtimeEntityId: "panel:nav-chat",
  view: {
    exists: true,
    url: "http://localhost:9000/panels/chat/",
    isLoading: false,
  },
  artifacts: {
    buildState: "ready",
    htmlPath: "http://localhost:9000/panels/chat/",
    hostedRuntimeEntityId: "panel:nav-chat",
    error: null,
    viewFailure: null,
  },
  runtime: { leased: true, platform: "desktop" },
  nativeSlotBound: true,
});

describe("panel terminal readiness", () => {
  it("distinguishes background content readiness from visible-slot readiness", () => {
    const background = readySignals();
    background.nativeSlotBound = false;

    expect(isPanelContentReady(background)).toBe(true);
    expect(isTerminalPanelReadiness(background)).toBe(false);
    expect(panelReadinessSnapshot(background)).toMatchObject({
      contentReady: true,
      terminal: false,
    });
  });

  it("accepts only the complete hosted-panel terminal state", () => {
    expect(isTerminalPanelReadiness(readySignals())).toBe(true);
  });

  it.each([
    ["registered panel", (state: PanelReadinessSignals) => (state.source = null)],
    ["current runtime entity", (state: PanelReadinessSignals) => (state.runtimeEntityId = null)],
    [
      "matching hosted runtime entity",
      (state: PanelReadinessSignals) =>
        (state.artifacts.hostedRuntimeEntityId = "panel:nav-retired"),
    ],
    ["runtime lease", (state: PanelReadinessSignals) => (state.runtime = { leased: false })],
    ["live view", (state: PanelReadinessSignals) => (state.view.exists = false)],
    ["committed URL", (state: PanelReadinessSignals) => (state.view.url = null)],
    ["completed navigation", (state: PanelReadinessSignals) => (state.view.isLoading = true)],
    [
      "completed build",
      (state: PanelReadinessSignals) => (state.artifacts.buildState = "building"),
    ],
    ["built artifact", (state: PanelReadinessSignals) => (state.artifacts.htmlPath = null)],
    ["error-free build", (state: PanelReadinessSignals) => (state.artifacts.error = "failed")],
    [
      "error-free navigation",
      (state: PanelReadinessSignals) => (state.artifacts.viewFailure = "navigation failed"),
    ],
    ["native slot binding", (state: PanelReadinessSignals) => (state.nativeSlotBound = false)],
  ])("is non-terminal without its %s signal", (_label, removeSignal) => {
    const state = readySignals();
    removeSignal(state);
    expect(isTerminalPanelReadiness(state)).toBe(false);
  });

  it.each([
    ["registered panel", (state: PanelReadinessSignals) => (state.source = null)],
    ["current runtime entity", (state: PanelReadinessSignals) => (state.runtimeEntityId = null)],
    [
      "matching hosted runtime entity",
      (state: PanelReadinessSignals) =>
        (state.artifacts.hostedRuntimeEntityId = "panel:nav-retired"),
    ],
    ["runtime lease", (state: PanelReadinessSignals) => (state.runtime = { leased: false })],
    ["live view", (state: PanelReadinessSignals) => (state.view.exists = false)],
    ["committed URL", (state: PanelReadinessSignals) => (state.view.url = null)],
    ["completed navigation", (state: PanelReadinessSignals) => (state.view.isLoading = true)],
    [
      "completed build",
      (state: PanelReadinessSignals) => (state.artifacts.buildState = "building"),
    ],
    ["built artifact", (state: PanelReadinessSignals) => (state.artifacts.htmlPath = null)],
    ["error-free build", (state: PanelReadinessSignals) => (state.artifacts.error = "failed")],
    [
      "error-free navigation",
      (state: PanelReadinessSignals) => (state.artifacts.viewFailure = "navigation failed"),
    ],
  ])("is not content-ready without its %s signal", (_label, removeSignal) => {
    const state = readySignals();
    removeSignal(state);
    expect(isPanelContentReady(state)).toBe(false);
  });
});
