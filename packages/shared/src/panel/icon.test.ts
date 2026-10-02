import { describe, expect, it } from "vitest";
import { isSemanticEmoji } from "./icon.js";

describe("isSemanticEmoji", () => {
  it.each(["🎯", "💬", "🖥️", "👍🏽", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇩🇪", "1️⃣", "#️⃣"])(
    "accepts the single emoji %s",
    (icon) => expect(isSemanticEmoji(icon)).toBe(true)
  );

  it.each([
    undefined,
    "",
    "target",
    "lucide:target",
    "./assets/icon.svg",
    "data:image/png;base64,abc",
    "🎯 Mission",
    "💬🎯",
    "1",
    "🇩",
  ])("rejects text and non-emoji values: %s", (icon) => expect(isSemanticEmoji(icon)).toBe(false));
});
