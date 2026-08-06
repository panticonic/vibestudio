import { describe, expect, it } from "vitest";
import { normalizePanelTitle } from "./title.js";

describe("normalizePanelTitle", () => {
  it("preserves word boundaries while collapsing whitespace", () => {
    expect(normalizePanelTitle("  Support\t\nInbox  ")).toBe("Support Inbox");
  });

  it("removes non-whitespace controls without damaging unicode text", () => {
    expect(normalizePanelTitle("Inbox\u0000 \u0085 🚀")).toBe("Inbox 🚀");
  });

  it("uses undefined for an empty or overlong value", () => {
    expect(normalizePanelTitle(" \u0007 ")).toBeUndefined();
    expect(normalizePanelTitle("x".repeat(200))).toHaveLength(120);
  });
});
