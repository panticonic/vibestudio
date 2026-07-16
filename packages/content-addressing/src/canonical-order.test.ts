import { describe, expect, it } from "vitest";
import { compareUtf16CodeUnits, utf16CodeUnitSortKey } from "./canonical-order.js";

describe("canonical UTF-16 ordering", () => {
  it("projects JavaScript code-unit order into an ordinary persistent text key", () => {
    const values = ["a", "aa", "ä", "\uE000", "😀", "B"];
    const canonical = [...values].sort(compareUtf16CodeUnits);
    const indexed = [...values].sort((left, right) =>
      utf16CodeUnitSortKey(left) < utf16CodeUnitSortKey(right)
        ? -1
        : utf16CodeUnitSortKey(left) > utf16CodeUnitSortKey(right)
          ? 1
          : 0
    );

    expect(indexed).toEqual(canonical);
    expect(canonical.indexOf("😀")).toBeLessThan(canonical.indexOf("\uE000"));
  });
});
