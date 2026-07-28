import { syncManagedWebViewThemes } from "./webViewThemes";
import type { PanelWebViewHandle } from "./PanelWebView";
import type { WebViewEntry } from "./webViewStack";

function entry(overrides: Partial<WebViewEntry> = {}): WebViewEntry {
  return {
    panelId: "panel-1",
    runtimeEntityId: "panel:nav-panel-1" as WebViewEntry["runtimeEntityId"],
    url: "http://127.0.0.1/panel",
    managed: true,
    panelInit: null,
    lastActive: 1,
    ...overrides,
  };
}

function handle(): PanelWebViewHandle {
  return {
    injectTheme: jest.fn(),
    dispatchHostEvent: jest.fn(),
    deliverEnvelope: jest.fn(),
    navigate: jest.fn(),
    goBack: jest.fn(),
    goForward: jest.fn(),
    reload: jest.fn(),
    stop: jest.fn(),
  };
}

describe("syncManagedWebViewThemes", () => {
  it("does not reinject when only panel activity changes", () => {
    const panelHandle = handle();
    const handles = new Map([["panel-1", panelHandle]]);
    const signatures = new Map<string, string>();

    syncManagedWebViewThemes([entry()], handles, signatures, "dark");
    syncManagedWebViewThemes([entry({ lastActive: 2 })], handles, signatures, "dark");

    expect(panelHandle.injectTheme).toHaveBeenCalledTimes(1);
  });

  it("reinjects for a theme or document change", () => {
    const panelHandle = handle();
    const handles = new Map([["panel-1", panelHandle]]);
    const signatures = new Map<string, string>();

    syncManagedWebViewThemes([entry()], handles, signatures, "dark");
    syncManagedWebViewThemes([entry()], handles, signatures, "light");
    syncManagedWebViewThemes(
      [entry({ url: "http://127.0.0.1/next" })],
      handles,
      signatures,
      "light"
    );

    expect(panelHandle.injectTheme).toHaveBeenCalledTimes(3);
  });
});
