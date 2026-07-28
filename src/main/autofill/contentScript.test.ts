import { describe, expect, it } from "vitest";
import { FORM_FILL_TYPES } from "@vibestudio/browser-data";
import { getContentScript, getFillValueScript } from "./contentScript.js";

describe("structured form-fill content scripts", () => {
  it("discovers and learns from every HTML autocomplete control kind", () => {
    const script = getContentScript();

    expect(script).toContain("document.querySelectorAll('input, textarea, select')");
    expect(script).toContain("submitted.querySelectorAll('input, textarea, select')");
  });

  it("injects the canonical form-fill vocabulary", () => {
    expect(getContentScript()).toContain(`var allowed = ${JSON.stringify(FORM_FILL_TYPES)}`);
  });

  it("uses the native select setter when filling a select control", () => {
    const script = getFillValueScript("#country", "DE");

    expect(script).toContain("el instanceof HTMLSelectElement");
    expect(script).toContain("HTMLSelectElement.prototype");
  });
});
