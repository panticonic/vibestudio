import { describe, expect, it } from "vitest";
import { extractDevelopmentTemplateCheckoutArguments } from "./developmentTemplateOptions.js";

describe("development template checkout arguments", () => {
  it("extracts repeatable path options without forwarding them to the product", () => {
    expect(
      extractDevelopmentTemplateCheckoutArguments([
        "--template-checkout",
        "/one",
        "--workspace=demo",
        "--template-checkout=/two",
      ])
    ).toEqual({ checkouts: ["/one", "/two"], forwarded: ["--workspace=demo"] });
  });

  it("rejects an empty checkout option", () => {
    expect(() => extractDevelopmentTemplateCheckoutArguments(["--template-checkout="])).toThrow(
      "requires a path"
    );
  });
});
