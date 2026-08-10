import React from "react";
import { Image } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { Provider, createStore } from "jotai";
import { AppBar } from "./AppBar";
import type { AddressAutocompleteItem } from "@vibestudio/shared/panelChrome";
import { shellClientAtom, panelTreeRevisionAtom } from "../state/shellClientAtom";
import { activePanelIdAtom } from "../state/navigationAtoms";

jest.mock("@vibestudio/shared/panelChrome", () => ({
  isBrowserPanelSource: (source: string) => source.startsWith("browser:"),
  browserUrlFromPanelSource: (source: string) =>
    source.startsWith("browser:") ? source.slice("browser:".length) : null,
  splitTextByMatchRanges: (text: string, ranges?: Array<{ start: number; end: number }>) => {
    if (!ranges?.length) return [{ text, highlighted: false }];
    const [range] = ranges;
    return [
      { text: text.slice(0, range.start), highlighted: false },
      { text: text.slice(range.start, range.end), highlighted: true },
      { text: text.slice(range.end), highlighted: false },
    ].filter((part) => part.text);
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const suggestion: AddressAutocompleteItem = {
  id: "history:https://example.test/docs",
  kind: "history",
  value: "https://example.test/docs",
  label: "Example Docs",
  meta: "https://example.test/docs",
  iconKind: "history",
  matchRanges: {
    label: [{ start: 8, end: 12 }],
  },
  action: { type: "navigate-url", url: "https://example.test/docs" },
  browser: { url: "https://example.test/docs", title: "Example Docs", source: "history" },
};

describe("AppBar address UX", () => {
  it("shows the active panel's canonical image identity in the header", () => {
    const store = createStore();
    store.set(activePanelIdAtom, "panel-1");
    store.set(panelTreeRevisionAtom, 1);
    store.set(shellClientAtom, {
      serverUrl: "http://127.0.0.1:43100",
      panels: {
        registry: {
          getPanel: () => ({
            id: "panel-1",
            icon: "./assets/icon.svg",
            snapshot: { source: "panels/chat" },
          }),
        },
        getPageFaviconDataUrl: jest.fn(async () => null),
      },
    } as never);

    const { getByTestId } = render(
      <Provider store={store}>
        <AppBar title="Agentic Chat" onMenuPress={jest.fn()} />
      </Provider>
    );

    const image = getByTestId("active-panel-icon", { includeHiddenElements: true }).findByType(
      Image
    );
    expect(image.props.source.uri).toBe(
      "http://127.0.0.1:43100/__vibestudio/unit-icon?source=panels%2Fchat&path=assets%2Ficon.svg"
    );
  });

  it("updates the address query and selects shared autocomplete actions", () => {
    const onAddressQueryChange = jest.fn();
    const onSelectAddressSuggestion = jest.fn();
    const { getByTestId } = render(
      <AppBar
        title="Panel"
        onMenuPress={jest.fn()}
        addressBarVisible
        address="https://example.test"
        addressSuggestions={[suggestion]}
        onAddressQueryChange={onAddressQueryChange}
        onSelectAddressSuggestion={onSelectAddressSuggestion}
      />
    );

    fireEvent(getByTestId("address-input"), "focus");
    fireEvent.changeText(getByTestId("address-input"), "docs");
    fireEvent.press(getByTestId("address-suggestion-0"));

    expect(onAddressQueryChange).toHaveBeenCalledWith("docs");
    expect(onSelectAddressSuggestion).toHaveBeenCalledWith(suggestion);
  });
});
