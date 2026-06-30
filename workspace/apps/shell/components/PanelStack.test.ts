import { describe, expect, it } from "vitest";
import type { PanelArtifacts } from "@vibez1/shared/types";
import { asPanelSlotId } from "@vibez1/shared/panel/ids";
import { leasedElsewhereInfo, shouldShowPanelView } from "./PanelStackVisibility";

describe("shouldShowPanelView", () => {
  it("shows an existing native view while the panel build is still marked building", () => {
    expect(
      shouldShowPanelView({
        htmlPath: "http://localhost:1234/panels/chat/",
        buildState: "building",
      })
    ).toBe(true);
  });

  it.each<PanelArtifacts | undefined>([
    undefined,
    {},
    { buildState: "pending" },
    { htmlPath: "http://localhost:1234/panels/chat/", buildState: "pending" },
    { htmlPath: "http://localhost:1234/panels/chat/", buildState: "error" },
    { htmlPath: "http://localhost:1234/panels/chat/", buildState: "error", error: "failed" },
  ])("does not show a panel without a displayable native view: %j", (artifacts) => {
    expect(shouldShowPanelView(artifacts)).toBe(false);
  });
});

describe("leasedElsewhereInfo", () => {
  it("uses the explicit panel runtime snapshot while the async lease lookup is still empty", () => {
    expect(
      leasedElsewhereInfo("panel:tree/slot-a", null, {
        leased: true,
        holderLabel: "Headless Host",
        platform: "headless",
        clientSessionId: "headless-client",
        connectionId: "headless-connection",
      })
    ).toEqual({
      slotId: "panel:tree/slot-a",
      holderLabel: "Headless Host",
    });
  });

  it("does not treat a desktop-held runtime as elsewhere", () => {
    expect(
      leasedElsewhereInfo("panel:tree/slot-a", null, {
        leased: true,
        holderLabel: "Desktop",
        platform: "desktop",
        clientSessionId: "desktop-client",
        connectionId: "desktop-connection",
      })
    ).toBeNull();
  });

  it("prefers the full lease when it is available", () => {
    expect(
      leasedElsewhereInfo(
        "panel:tree/slot-a",
        {
          slotId: asPanelSlotId("panel:tree/slot-b"),
          holderLabel: "Mobile",
          platform: "mobile",
        },
        {
          leased: true,
          holderLabel: "Headless Host",
          platform: "headless",
        }
      )
    ).toEqual({
      slotId: "panel:tree/slot-b",
      holderLabel: "Mobile",
    });
  });
});
