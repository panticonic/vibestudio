import { describe, expect, it } from "vitest";

import { MAX_UNIT_ICON_BYTES, assertUnitIconSize, declaredUnitIconPath } from "./unitIcon.js";

describe("unit icon declaration", () => {
  it("accepts one canonical unit-relative image path", () => {
    expect(declaredUnitIconPath({ icon: "./assets/icon.svg" })).toBe("assets/icon.svg");
    expect(declaredUnitIconPath({ icon: "💬" })).toBeNull();
  });

  it.each(["./", "./../secret.svg", "./assets/../secret.svg", "./assets\\icon.svg"])(
    "rejects non-canonical path %s",
    (icon) => {
      expect(() => declaredUnitIconPath({ icon })).toThrow(/escapes the unit source/u);
    }
  );

  it("keeps the build and direct-serving size limit identical", () => {
    expect(() => assertUnitIconSize("./icon.png", MAX_UNIT_ICON_BYTES)).not.toThrow();
    expect(() => assertUnitIconSize("./icon.png", MAX_UNIT_ICON_BYTES + 1)).toThrow(/exceeds/u);
  });
});
