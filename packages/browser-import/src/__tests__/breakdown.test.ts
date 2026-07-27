import { describe, expect, it } from "vitest";
import { computeCategoryBreakdown } from "../import/breakdown.js";

describe("computeCategoryBreakdown", () => {
  it("groups cookies by normalized domain, largest first", () => {
    const result = computeCategoryBreakdown("cookies", [
      { domain: ".google.com", name: "SID" },
      { domain: "www.google.com", name: "HSID" },
      { domain: "google.com", name: "NID" },
      { domain: "github.com", name: "_gh_sess" },
    ]);
    expect(result.groupedBy).toBe("site");
    expect(result.total).toBe(4);
    expect(result.groups).toEqual([
      { label: "google.com", count: 3 },
      { label: "github.com", count: 1 },
    ]);
    expect(result.otherGroups).toBe(0);
    expect(result.otherItems).toBe(0);
  });

  it("groups url-bearing categories by host", () => {
    const result = computeCategoryBreakdown("passwords", [
      { url: "https://github.com/login", username: "a" },
      { url: "https://github.com/session", username: "b" },
      { url: "https://trello.com/", username: "c" },
    ]);
    expect(result.groups).toEqual([
      { label: "github.com", count: 2 },
      { label: "trello.com", count: 1 },
    ]);
  });

  it("groups form fill by kind rather than site", () => {
    const result = computeCategoryBreakdown("formFill", [
      { type: "address" },
      { type: "address" },
      { fieldName: "email" },
      {},
    ]);
    expect(result.groupedBy).toBe("kind");
    expect(result.groups).toEqual([
      { label: "address", count: 2 },
      { label: "email", count: 1 },
      { label: "other", count: 1 },
    ]);
  });

  it("names search engines directly", () => {
    const result = computeCategoryBreakdown("searchEngines", [
      { name: "DuckDuckGo" },
      { name: "" },
    ]);
    expect(result.groupedBy).toBe("kind");
    expect(result.groups).toEqual([
      { label: "DuckDuckGo", count: 1 },
      { label: "unnamed", count: 1 },
    ]);
  });

  it("caps the listed groups and folds the tail into counters", () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      url: `https://site${String(index).padStart(2, "0")}.com/`,
    }));
    const result = computeCategoryBreakdown("history", items, 5);
    expect(result.groups).toHaveLength(5);
    expect(result.otherGroups).toBe(15);
    expect(result.otherItems).toBe(15);
    expect(result.total).toBe(20);
  });

  it("does not throw on unparseable or missing urls", () => {
    const result = computeCategoryBreakdown("bookmarks", [
      { url: "about:newtab" },
      { url: "" },
      {},
      null,
    ]);
    expect(result.total).toBe(4);
    expect(result.groups.reduce((sum, group) => sum + group.count, 0)).toBe(4);
    expect(result.groups.some((group) => group.label === "unknown")).toBe(true);
  });

  it("handles an empty category", () => {
    const result = computeCategoryBreakdown("cookies", []);
    expect(result).toMatchObject({ total: 0, groups: [], otherGroups: 0, otherItems: 0 });
  });
});
