import { mobileDrawerWidth } from "./mobileLayout";

describe("mobileDrawerWidth", () => {
  it("leaves a dismissible panel gutter on compact phones", () => {
    expect(mobileDrawerWidth(320)).toBe(272);
    expect(mobileDrawerWidth(390)).toBe(342);
  });

  it("caps the drawer on tablets and never returns a negative width", () => {
    expect(mobileDrawerWidth(768)).toBe(360);
    expect(mobileDrawerWidth(40)).toBe(0);
  });
});
