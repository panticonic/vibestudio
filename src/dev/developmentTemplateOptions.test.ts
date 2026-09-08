import { describe, expect, it } from "vitest";
import { extractDevelopmentTemplateCheckoutArguments } from "./developmentTemplateOptions.js";

describe("development template checkout arguments", () => {
  it("extracts one reviewed source without forwarding it to the product", () => {
    expect(
      extractDevelopmentTemplateCheckoutArguments([
        "--template-checkout",
        "/one",
        "--workspace=demo",
      ])
    ).toEqual({ checkouts: ["/one"], forwarded: ["--workspace=demo"] });
  });

  it("rejects multiple source reviews competing for one launch surface", () => {
    expect(() =>
      extractDevelopmentTemplateCheckoutArguments([
        "--template-checkout=/one",
        "--template-checkout=/two",
      ])
    ).toThrow("may only be selected once");
  });

  it("rejects an empty checkout option", () => {
    expect(() => extractDevelopmentTemplateCheckoutArguments(["--template-checkout="])).toThrow(
      "requires a path"
    );
  });
});

it("selects a checkout to open and keeps a reviewed source separate", () => {
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
