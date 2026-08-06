import { describe, expect, it } from "vitest";
import {
  sanitizeTemplatePresentation,
  WorkspaceConfigTopLayerSchema,
} from "./workspaceConfigSchema.js";

/**
 * The two strings a template gets to assert about itself.
 *
 * Every case here is about the same question: can this string, rendered as a
 * heading next to an origin the template does not control, be mistaken for
 * something other than a heading? When the answer is yes the string is dropped
 * whole, because a partially repaired hostile name is still a name its author
 * shaped.
 */
describe("what a template says it is called", () => {
  it("keeps an ordinary name and sentence, collapsing only layout whitespace", () => {
    expect(
      sanitizeTemplatePresentation({
        name: "  News   Reader ",
        description: "Read and discuss\tpersonalized news briefings.",
      })
    ).toEqual({
      name: "News Reader",
      description: "Read and discuss personalized news briefings.",
    });
  });

  it.each([
    ["a NUL", "News\u0000Alert"],
    ["a DEL", "News\u007FAlert"],
    ["a bell", "News\u0007Alert"],
    ["a right-to-left override", "News \u202Etxt.exe"],
    ["a bidi isolate", "News \u2066github.com/vibestudio\u2069"],
    ["a zero-width space", "New\u200Bs"],
    ["an interpunct, the header's own separator", "News \u00B7 github.com/vibestudio"],
    ["a bullet", "News \u2022 verified"],
  ])("drops a name carrying %s", (_case, hostile) => {
    expect(sanitizeTemplatePresentation({ name: hostile })).toBeUndefined();
  });

  it("treats a byte-order mark as the whitespace it renders as", () => {
    // Not a forgery risk on its own — it renders as nothing — so it is stripped
    // with the rest of the layout whitespace rather than costing a valid name.
    expect(sanitizeTemplatePresentation({ name: "\uFEFFNews\uFEFF" })).toEqual({ name: "News" });
  });

  it("drops what will not fit the space it is given, rather than truncating it", () => {
    expect(sanitizeTemplatePresentation({ name: "N".repeat(61) })).toBeUndefined();
    expect(sanitizeTemplatePresentation({ name: "N".repeat(60) })).toEqual({
      name: "N".repeat(60),
    });
    expect(sanitizeTemplatePresentation({ description: "d".repeat(201) })).toBeUndefined();
  });

  it("drops one field without taking the other down with it", () => {
    expect(
      sanitizeTemplatePresentation({ name: "News", description: "Briefings \u2022 now" })
    ).toEqual({ name: "News" });
  });

  it("treats anything that is not a string as nothing at all", () => {
    expect(sanitizeTemplatePresentation({ name: 42, description: ["a"] })).toBeUndefined();
    expect(sanitizeTemplatePresentation({ name: "   " })).toBeUndefined();
    expect(sanitizeTemplatePresentation(null)).toBeUndefined();
    expect(sanitizeTemplatePresentation("News")).toBeUndefined();
  });

  it("sanitizes on the way in, so unsanitized text is never a stored state", () => {
    // A hostile manifest must cost the template its heading, never the user's
    // ability to install or remove it: parsing succeeds and the field is gone.
    const parsed = WorkspaceConfigTopLayerSchema.parse({
      systemEpoch: 1,
      template: { name: "News \u202Etxt.exe", description: "Briefings." },
    });
    expect(parsed.template).toEqual({ description: "Briefings." });

    expect(
      WorkspaceConfigTopLayerSchema.parse({
        systemEpoch: 1,
        template: { name: "News", description: "Briefings." },
      }).template
    ).toEqual({ name: "News", description: "Briefings." });
  });
});
