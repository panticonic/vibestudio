import React from "react";
import { render } from "@testing-library/react-native";
import { LoadedPanelWebView, type LoadedPanelWebViewProps } from "./LoadedPanelWebView";
import type { ThemeColors } from "../state/themeAtoms";

const mockPanelWebViewRender = jest.fn();

jest.mock("./PanelWebView", () => {
  const React = require("react") as typeof import("react");
  const { View } = require("react-native") as typeof import("react-native");
  return {
    PanelWebView: React.forwardRef((props: { panelId: string }, _ref) => {
      mockPanelWebViewRender(props);
      return <View testID={`webview-${props.panelId}`} />;
    }),
  };
});

const colors = {
  background: "#000",
  surface: "#111",
  surfaceRaised: "#222",
  surfaceSunken: "#080808",
  text: "#fff",
  textSecondary: "#ccc",
  textTertiary: "#999",
  border: "#444",
  borderSubtle: "#333",
  primary: "#80f",
  onPrimary: "#fff",
  accent: "#f08",
  accentSoft: "#202",
  success: "#0f0",
  successSoft: "#020",
  warning: "#ff0",
  warningSoft: "#220",
  danger: "#f00",
  dangerSoft: "#200",
  info: "#08f",
  infoSoft: "#002",
  codeBackground: "#111",
  overlay: "#0008",
  shadow: "#000",
  statusConnected: "#0f0",
  statusConnecting: "#ff0",
  statusDisconnected: "#f00",
} satisfies ThemeColors;

function props(overrides: Partial<LoadedPanelWebViewProps> = {}): LoadedPanelWebViewProps {
  return {
    entry: {
      panelId: "panel-1",
      url: "https://example.test",
      managed: false,
      panelInit: null,
      lastActive: 1,
    },
    visible: true,
    colors,
    managedBasePath: "",
    diagnosticsEnabled: false,
    onHandleChange: jest.fn(),
    onPanelNavigate: jest.fn(),
    onNavigationStateChange: jest.fn(),
    onTitleChange: jest.fn(),
    onBridgeCall: jest.fn(async () => null),
    onUnmount: jest.fn(),
    ...overrides,
  };
}

describe("LoadedPanelWebView", () => {
  beforeEach(() => mockPanelWebViewRender.mockClear());

  it("does not rerender the native WebView when its stable inputs are unchanged", () => {
    const stableProps = props();
    const view = render(<LoadedPanelWebView {...stableProps} />);

    view.rerender(<LoadedPanelWebView {...stableProps} />);

    expect(mockPanelWebViewRender).toHaveBeenCalledTimes(1);
  });

  it("rerenders when panel visibility changes", () => {
    const stableProps = props();
    const view = render(<LoadedPanelWebView {...stableProps} />);

    view.rerender(<LoadedPanelWebView {...stableProps} visible={false} />);

    expect(mockPanelWebViewRender).toHaveBeenCalledTimes(2);
  });
});
