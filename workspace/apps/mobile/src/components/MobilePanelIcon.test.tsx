import React from "react";
import { Image } from "react-native";
import { render, waitFor } from "@testing-library/react-native";
import { MobilePanelIcon } from "./MobilePanelIcon";

describe("MobilePanelIcon", () => {
  it("uses the captured favicon for browser panels", async () => {
    const favicon = "data:image/png;base64,captured";
    const resolveBrowserFavicon = jest.fn(async () => favicon);
    const { getByTestId } = render(
      <MobilePanelIcon
        source="browser:https://example.test/path"
        kind="browser"
        serverUrl="http://127.0.0.1:43100"
        color="#777"
        testID="panel-icon"
        resolveBrowserFavicon={resolveBrowserFavicon}
      />
    );

    await waitFor(() => {
      const image = getByTestId("panel-icon", { includeHiddenElements: true }).findByType(Image);
      expect(image.props.source.uri).toBe(favicon);
    });
    expect(resolveBrowserFavicon).toHaveBeenCalledWith("https://example.test/path");
  });
});
