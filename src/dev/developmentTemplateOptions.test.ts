import { describe, expect, it } from "vitest";
import { extractDevelopmentTemplateCheckoutArguments } from "./developmentTemplateOptions.js";

describe("development template checkout arguments", () => {
  it("extracts one explicitly extra source without forwarding it to the product", () => {
    expect(
      extractDevelopmentTemplateCheckoutArguments([
        "--extra-template-checkout",
        "/one",
        "--workspace=demo",
      ])
    ).toEqual({ checkouts: ["/one"], forwarded: ["--workspace=demo"] });
  });

  it("accepts multiple explicitly extra sources", () => {
    expect(
      extractDevelopmentTemplateCheckoutArguments([
        "--extra-template-checkout=/one",
        "--extra-template-checkout=/two",
      ])
    ).toEqual({ checkouts: ["/one", "/two"], forwarded: [] });
  });

  it("rejects an empty checkout option", () => {
    expect(() =>
      extractDevelopmentTemplateCheckoutArguments(["--extra-template-checkout="])
    ).toThrow("requires a path");
  });

  it("rejects the ambiguous former per-template official selector", () => {
    expect(() => extractDevelopmentTemplateCheckoutArguments(["--template-checkout=/one"])).toThrow(
      "official templates come from the complete configured set"
    );
  });
});

it("selects a checkout to open and keeps a reviewed source separate", () => {
  expect(
    extractDevelopmentTemplateCheckoutArguments([
      "--workspace-checkout=/app",
      "--extra-template-checkout",
      "/catalog",
      "--ephemeral",
    ])
  ).toEqual({ workspaceCheckout: "/app", checkouts: ["/catalog"], forwarded: ["--ephemeral"] });
});

it.each([
  ["--workspace-checkout"],
  ["--workspace-checkout", "--ephemeral"],
  ["--workspace-checkout=/a", "--workspace-checkout=/b"],
  ["--workspace-checkout=/a", "--workspace=existing"],
  ["--workspace-checkout=/a", "--bootstrap-workspace", "existing"],
])("rejects ambiguous or missing startup checkout selections: %s", (...args) => {
  expect(() => extractDevelopmentTemplateCheckoutArguments(args)).toThrow();
});
