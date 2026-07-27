import { describe, expect, it } from "vitest";
import {
  classifyError,
  hueFor,
  initialsFor,
  mask,
  plural,
  prettyHost,
  prettyPath,
  relativeTime,
} from "./format";

describe("classifyError", () => {
  it("maps EACCES to denied", () => {
    expect(classifyError(Object.assign(new Error("nope"), { code: "EACCES" }))).toEqual({
      status: "denied",
      message: "nope",
    });
  });

  it("maps 'denied by user' messages to denied", () => {
    expect(classifyError(new Error("browser-data.getCookies denied by user")).status).toBe("denied");
  });

  it("maps other errors to error", () => {
    expect(classifyError(new Error("boom")).status).toBe("error");
  });
});

describe("relativeTime", () => {
  const now = 1_000_000_000_000;
  it("returns never for nullish", () => {
    expect(relativeTime(null, now)).toBe("never");
    expect(relativeTime(0, now)).toBe("never");
  });
  it("formats minutes and hours", () => {
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h ago");
  });
  it("formats days", () => {
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d ago");
  });
});

describe("mask", () => {
  it("hides by default and reveals when asked", () => {
    expect(mask("supersecret", false)).toMatch(/^•+$/);
    expect(mask("supersecret", true)).toBe("supersecret");
  });
  it("returns empty for empty input", () => {
    expect(mask("", false)).toBe("");
  });
});

describe("prettyHost / prettyPath", () => {
  it("strips the scheme and www", () => {
    expect(prettyHost("https://www.reddit.com/r/LocalLLaMA")).toBe("reddit.com");
  });
  it("keeps the path but drops a bare slash", () => {
    expect(prettyPath("https://example.com/a/b?c=1")).toBe("/a/b?c=1");
    expect(prettyPath("https://example.com/")).toBe("");
  });
  it("survives non-URL strings like about:newtab", () => {
    expect(prettyHost("about:newtab")).toBe("about:newtab");
    expect(prettyPath("about:newtab")).toBe("");
  });
});

describe("hueFor", () => {
  it("is stable and in range", () => {
    expect(hueFor("github.com")).toBe(hueFor("github.com"));
    expect(hueFor("github.com")).toBeGreaterThanOrEqual(0);
    expect(hueFor("github.com")).toBeLessThan(360);
  });
  it("separates different hosts", () => {
    expect(hueFor("github.com")).not.toBe(hueFor("reddit.com"));
  });
});

describe("initialsFor", () => {
  it("takes the first two letters of the label", () => {
    expect(initialsFor("github.com")).toBe("GI");
  });
  it("splits hyphenated labels", () => {
    expect(initialsFor("my-site.com")).toBe("MS");
  });
  it("falls back for empty input", () => {
    expect(initialsFor("")).toBe("?");
  });
});

describe("plural", () => {
  it("uses the singular for one", () => {
    expect(plural(1, "tab")).toBe("1 tab");
    expect(plural(2, "tab")).toBe("2 tabs");
  });
  it("accepts an irregular plural", () => {
    expect(plural(3, "category", "categories")).toBe("3 categories");
  });
});
