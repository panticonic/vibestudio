import { mobileNavigationLayout } from "./mobileLayout";

describe("mobileNavigationLayout", () => {
  it("keeps a dismissible overlay on compact phones", () => {
    expect(mobileNavigationLayout(320, 700)).toEqual({ kind: "phone", drawerWidth: 272 });
    expect(mobileNavigationLayout(390, 844)).toEqual({ kind: "phone", drawerWidth: 342 });
  });

  it("does not turn a rotated phone into a persistent two-pane layout", () => {
    expect(mobileNavigationLayout(844, 390)).toEqual({ kind: "phone", drawerWidth: 360 });
  });

  it("gives tablets a bounded persistent sidebar in either orientation", () => {
    expect(mobileNavigationLayout(600, 960)).toEqual({ kind: "tablet", drawerWidth: 280 });
    expect(mobileNavigationLayout(1024, 768)).toEqual({ kind: "tablet", drawerWidth: 307 });
  });

  it("falls back to the phone presentation in a narrow tablet split view", () => {
    expect(mobileNavigationLayout(540, 1024)).toEqual({ kind: "phone", drawerWidth: 360 });
    expect(mobileNavigationLayout(40, 40)).toEqual({ kind: "phone", drawerWidth: 0 });
  });
});
