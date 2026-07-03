import { describe, it, expect } from "vitest";
import {
  ABOUT_SOURCE_PREFIX,
  ABOUT_PAGES,
  aboutPanelSource,
  isAboutSource,
} from "./aboutNamespace.js";

describe("isAboutSource", () => {
  it("matches canonical units under about/", () => {
    expect(isAboutSource("about/new")).toBe(true);
    expect(isAboutSource("about/keyboard-shortcuts")).toBe(true);
    expect(isAboutSource("about/nested/page")).toBe(true);
  });

  it("does not match the bare about directory or empty page", () => {
    // The rule is "units *under* about/", not the directory itself.
    expect(isAboutSource("about")).toBe(false);
    // Trailing slash with no page is not a unit.
    expect(isAboutSource("about/")).toBe(false);
  });

  it("does not match other namespaces or lookalikes", () => {
    expect(isAboutSource("panels/chat")).toBe(false);
    expect(isAboutSource("aboutx/new")).toBe(false);
    expect(isAboutSource("about-page/new")).toBe(false);
    expect(isAboutSource("")).toBe(false);
    expect(isAboutSource("browser:https://example.com")).toBe(false);
  });

  it("is case-sensitive (directory is literally lowercase 'about')", () => {
    expect(isAboutSource("About/new")).toBe(false);
    expect(isAboutSource("ABOUT/new")).toBe(false);
  });

  it("does not recognize non-canonical paths (fail-safe, not a sanitizer)", () => {
    expect(isAboutSource("./about/new")).toBe(false);
    expect(isAboutSource("/about/new")).toBe(false);
    expect(isAboutSource("about\\new")).toBe(false);
  });
});

describe("aboutPanelSource", () => {
  it("prefixes a page id to form a canonical source", () => {
    expect(aboutPanelSource("new")).toBe("about/new");
    expect(aboutPanelSource(ABOUT_PAGES.HELP)).toBe("about/help");
    expect(aboutPanelSource("new")).toBe(`${ABOUT_SOURCE_PREFIX}new`);
  });

  it("round-trips with isAboutSource for every well-known page", () => {
    for (const page of Object.values(ABOUT_PAGES)) {
      expect(isAboutSource(aboutPanelSource(page))).toBe(true);
    }
  });

  it("produces a non-matching source for an empty page", () => {
    expect(aboutPanelSource("")).toBe("about/");
    expect(isAboutSource(aboutPanelSource(""))).toBe(false);
  });
});
