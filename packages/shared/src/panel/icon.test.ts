import { describe, expect, it } from "vitest";
import { isSemanticEmoji, isUnitIconAssetPath } from "./icon.js";

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

describe("isUnitIconAssetPath", () => {
  it.each([
    "./assets/icon.svg",
    "./icon.PNG",
    "./my art/icon.jpeg",
    "./a/b.webp",
    "./icon.avif",
    "./icon.gif",
    "./icon.ico",
  ])("accepts a unit-owned image %s", (icon) => expect(isUnitIconAssetPath(icon)).toBe(true));
  it.each([
    undefined,
    "./",
    "./../icon.svg",
    "./assets/../icon.svg",
    "./assets//icon.svg",
    "./assets\\icon.svg",
    "./icon.svg?x",
    "./icon.svg#x",
    "./%2e%2e/icon.svg",
    "./icon.ts",
    "./icon.svg\n",
    "lucide:orbit",
    "https://example.com/icon.svg",
  ])("rejects a noncanonical declaration %s", (icon) =>
    expect(isUnitIconAssetPath(icon)).toBe(false)
  );
});
