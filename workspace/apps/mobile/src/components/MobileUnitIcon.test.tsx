import React from "react";
import { Image } from "react-native";
import { fireEvent, render } from "@testing-library/react-native";
import { MobileUnitIcon } from "./MobileUnitIcon";

describe("MobileUnitIcon", () => {
  it("loads a relative manifest image through the authenticated local facade", () => {
    const { getByTestId } = render(
      <MobileUnitIcon
        icon="./assets/icon.svg"
        source="workers/news-agent"
        kind="worker"
        serverUrl="http://127.0.0.1:43100"
        color="#777"
        testID="unit-icon"
      />
    );

    const image = getByTestId("unit-icon", { includeHiddenElements: true }).findByType(Image);
    expect(image.props.source.uri).toBe(
      "http://127.0.0.1:43100/__vibestudio/unit-icon?source=workers%2Fnews-agent&path=assets%2Ficon.svg"
    );
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

    fireEvent(getByTestId("unit-icon", { includeHiddenElements: true }).findByType(Image), "error");
    expect(() =>
      getByTestId("unit-icon", { includeHiddenElements: true }).findByType(Image)
    ).toThrow();
  });
});
