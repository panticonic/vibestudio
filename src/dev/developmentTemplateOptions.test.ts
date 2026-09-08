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

it("selects a checkout to open and keeps catalog candidates separate", () => {
  expect(
    extractDevelopmentTemplateCheckoutArguments([
      "--workspace-checkout=/app",
      "--template-checkout",
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
  ["--workspace-checkout=/a", "--ephemeral-workspace"],
])("rejects ambiguous or missing startup checkout selections: %s", (...args) => {
  expect(() => extractDevelopmentTemplateCheckoutArguments(args)).toThrow();
});
