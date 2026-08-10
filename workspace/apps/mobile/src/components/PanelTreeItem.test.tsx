import React from "react";
import { render } from "@testing-library/react-native";
import { createStore } from "jotai";
import { SvgUri } from "react-native-svg";
import { PanelTreeItem } from "./PanelTreeItem";
import { themeColorsAtom } from "../state/themeAtoms";

jest.mock("react-native-gesture-handler", () => {
  const React = require("react");
  const { View } = require("react-native");
  const chain = {
    activeOffsetX: jest.fn(() => chain),
    failOffsetY: jest.fn(() => chain),
    onUpdate: jest.fn(() => chain),
    onEnd: jest.fn(() => chain),
  };
  return {
    Gesture: { Pan: jest.fn(() => chain) },
    GestureDetector: ({ children }: { children: React.ReactNode }) =>
      React.createElement(View, null, children),
  };
});

jest.mock("react-native-reanimated", () => {
  const { View } = require("react-native");
  return {
    __esModule: true,
    default: { View },
    useSharedValue: (value: unknown) => ({ value }),
    useAnimatedStyle: (factory: () => unknown) => factory(),
    withTiming: (value: unknown) => value,
    runOnJS: (callback: (...args: unknown[]) => unknown) => callback,
    interpolate: () => 0,
    Extrapolation: { CLAMP: "clamp" },
  };
});

describe("PanelTreeItem identity", () => {
  it("renders the panel's canonical manifest image in the mobile drawer", () => {
    const colors = createStore().get(themeColorsAtom);
    const { UNSAFE_getByType } = render(
      <PanelTreeItem
        item={{
          id: "panel-1",
          title: "Agentic Chat",
          depth: 0,
          childCount: 0,
          isCollapsed: false,
          icon: "./assets/icon.svg",
          source: "panels/chat",
          kind: "workspace",
        }}
        isActive
        colors={colors}
        serverUrl="http://127.0.0.1:43100"
        resolveBrowserFavicon={jest.fn(async () => null)}
        onPress={jest.fn()}
        onToggleCollapse={jest.fn()}
        onArchive={jest.fn()}
      />
    );

    expect(UNSAFE_getByType(SvgUri).props.uri).toBe(
      "http://127.0.0.1:43100/__vibestudio/unit-icon?source=panels%2Fchat&path=assets%2Ficon.svg"
    );
  });
});
