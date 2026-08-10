import React from "react";
import { Image } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { SvgUri } from "react-native-svg";
import { MobileUnitIcon } from "./MobileUnitIcon";

describe("MobileUnitIcon", () => {
  it("renders a relative SVG manifest image through the authenticated local facade", () => {
    const { UNSAFE_getByType } = render(
      <MobileUnitIcon
        icon="./assets/icon.svg"
        source="workers/news-agent"
        kind="worker"
        serverUrl="http://127.0.0.1:43100"
        color="#777"
        testID="unit-icon"
      />
    );

    expect(UNSAFE_getByType(SvgUri).props.uri).toBe(
      "http://127.0.0.1:43100/__vibestudio/unit-icon?source=workers%2Fnews-agent&path=assets%2Ficon.svg"
    );
  });

  it("keeps raster image identities on the native image renderer", () => {
    const { UNSAFE_getByType } = render(
      <MobileUnitIcon
        icon="./assets/icon.png"
        source="apps/files"
        kind="app"
        serverUrl="http://127.0.0.1:43100"
        color="#777"
      />
    );

    expect(UNSAFE_getByType(Image).props.source.uri).toContain("path=assets%2Ficon.png");
  });

  it("falls back to the semantic unit kind when an image fails", () => {
    const { getByTestId } = render(
      <MobileUnitIcon
        icon="./assets/missing.svg"
        source="extensions/git-bridge"
        kind="extension"
        serverUrl="http://127.0.0.1:43100"
        color="#777"
        testID="unit-icon"
      />
    );

    fireEvent(getByTestId("unit-icon-svg", { includeHiddenElements: true }), "error");
    expect(() => getByTestId("unit-icon-svg", { includeHiddenElements: true })).toThrow();
  });
});
