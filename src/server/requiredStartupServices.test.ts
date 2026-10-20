import { describe, expect, it } from "vitest";
import { requiredStartupServices } from "./requiredStartupServices.js";

describe("requiredStartupServices", () => {
  it("omits the ClientHost where none is registered", () => {
    const required = requiredStartupServices(() => false);
    expect(required).not.toContain("clientHost");
    expect(required).toContain("extensionHost");
  });

  it("requires the ClientHost, before the extension host, where it is registered", () => {
    const required = requiredStartupServices((name) => name === "clientHost");
    expect(required.indexOf("clientHost")).toBeGreaterThan(-1);
    expect(required.indexOf("clientHost")).toBeLessThan(required.indexOf("extensionHost"));
  });
});
