import { describe, expect, it } from "vitest";
import { PANEL_CSP, PANEL_CSP_META } from "./constants.js";

describe("panel content security policy", () => {
  it("permits runtime code generation used by panel libraries", () => {
    expect(PANEL_CSP).toContain("script-src");
    expect(PANEL_CSP).toContain("'unsafe-eval'");
    expect(PANEL_CSP_META).toContain("'unsafe-eval'");
  });
});
