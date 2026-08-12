import { resolveMobileBackAction, type MobileBackState } from "./mobileBackNavigation";

const BASE_STATE: MobileBackState = {
  drawerOpen: false,
  addressBarVisible: false,
  browserCanGoBack: false,
  parentPanelId: null,
};

describe("resolveMobileBackAction", () => {
  it("lets navigation dismiss an open drawer before touching panel state", () => {
    expect(
      resolveMobileBackAction({
        ...BASE_STATE,
        drawerOpen: true,
        addressBarVisible: true,
        browserCanGoBack: true,
        parentPanelId: "parent",
      })
    ).toBe("system");
  });

  it("closes address editing before navigating browser or panel history", () => {
    expect(
      resolveMobileBackAction({
        ...BASE_STATE,
        addressBarVisible: true,
        browserCanGoBack: true,
        parentPanelId: "parent",
      })
    ).toBe("close-address");
  });

  it("uses browser history before the durable parent relationship", () => {
    expect(
      resolveMobileBackAction({
        ...BASE_STATE,
        browserCanGoBack: true,
        parentPanelId: "parent",
      })
    ).toBe("browser-back");
    expect(resolveMobileBackAction({ ...BASE_STATE, parentPanelId: "parent" })).toBe(
      "parent-panel"
    );
  });

  it("falls through to the operating system at the root", () => {
    expect(resolveMobileBackAction(BASE_STATE)).toBe("system");
  });
});
