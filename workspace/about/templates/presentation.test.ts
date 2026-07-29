import { describe, expect, it } from "vitest";
import { templateRelationshipActions, templateStatePresentation, templateVersion } from "./presentation.js";
import {
  filterTemplateCatalog,
  isTemplateHttpUrl,
  templateCatalogEmptyMessage,
} from "@workspace/about-shared/templates";

describe("template settings presentation", () => {
  it("uses the panel state names from the template UX", () => {
    expect(templateStatePresentation({ state: "reviewing", pendingReviews: 2, verification: "verified" } as never)).toEqual({
      label: "Reviewing changes — 2 to review",
      color: "blue",
    });
    expect(templateStatePresentation({ state: "error", pendingReviews: 0, verification: "verified" } as never)).toEqual({
      label: "Needs attention",
      color: "red",
    });
    expect(templateVersion("refs/tags/v4")).toBe("v4");
    expect(templateStatePresentation({ state: "current", pendingReviews: 0, verification: "deferred" } as never)).toEqual({
      label: "Available offline",
      color: "gray",
    });
    expect(templateRelationshipActions(true)).toEqual({ check: true, update: true, remove: true, suggest: true });
    expect(templateRelationshipActions(false)).toEqual({ check: false, update: false, remove: false, suggest: false });
  });
});

describe("template catalog presentation", () => {
  const entries = [
    { name: "News", description: "A daily digest", tags: ["agents", "news"] },
    { name: "Support", description: "Customer help", tags: ["service"] },
  ];

  it("shares honest search, empty-state, and address handling across template surfaces", () => {
    expect(filterTemplateCatalog(entries, "digest")).toEqual([entries[0]]);
    expect(templateCatalogEmptyMessage(0, "")).toContain("No featured templates");
    expect(templateCatalogEmptyMessage(2, "nope")).toContain("No templates match");
    expect(isTemplateHttpUrl("https://example.test/template.git")).toBe(true);
    expect(isTemplateHttpUrl("git@example.test:template.git")).toBe(false);
  });
});
