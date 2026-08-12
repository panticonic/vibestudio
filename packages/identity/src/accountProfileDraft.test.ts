import { describe, expect, it } from "vitest";
import {
  accountProfileDraftFor,
  accountProfileDraftIsDirty,
  accountProfileInitials,
  normalizedAccountProfileColor,
  validateAccountProfileDraft,
  type AccountProfileDraft,
} from "./accountProfileDraft.js";

const VALID_DRAFT: AccountProfileDraft = {
  displayName: "Ada Lovelace",
  handle: "ada",
  color: "#123abc",
};

describe("account profile drafts", () => {
  it("projects profiles into editable fields without leaking nullable colors", () => {
    expect(accountProfileDraftFor({ displayName: "Ada", handle: "ada", color: null })).toEqual({
      displayName: "Ada",
      handle: "ada",
      color: "",
    });
  });

  it.each([
    [{ ...VALID_DRAFT, displayName: " " }, "Display name is required."],
    [
      { ...VALID_DRAFT, displayName: "a".repeat(201) },
      "Display name must be 200 characters or fewer.",
    ],
    [
      { ...VALID_DRAFT, handle: "1ada" },
      "Handle must start with a letter, use at most 64 letters, numbers, _ or -, and cannot be reserved.",
    ],
    [
      { ...VALID_DRAFT, color: "blue" },
      "Color must be a 3, 4, 6, or 8 digit hex value, including #.",
    ],
  ])("returns the canonical validation message for invalid fields", (draft, expected) => {
    expect(validateAccountProfileDraft(draft)).toBe(expected);
  });

  it("accepts trimmed values and all supported hex lengths", () => {
    for (const color of ["#abc", "#abcd", "#abcdef", "#abcdef12", ""]) {
      expect(validateAccountProfileDraft({ ...VALID_DRAFT, color })).toBeNull();
    }
    expect(normalizedAccountProfileColor({ ...VALID_DRAFT, color: "  #abc  " })).toBe("#abc");
  });

  it("detects field and avatar changes against the canonical profile", () => {
    const profile = accountProfileDraftFor(VALID_DRAFT);
    expect(accountProfileDraftIsDirty(profile, VALID_DRAFT)).toBe(false);
    expect(accountProfileDraftIsDirty(profile, { ...VALID_DRAFT, handle: "augusta" })).toBe(true);
    expect(accountProfileDraftIsDirty(profile, VALID_DRAFT, true)).toBe(true);
  });

  it("uses display names first when generating compact initials", () => {
    expect(accountProfileInitials(VALID_DRAFT)).toBe("AL");
    expect(accountProfileInitials({ displayName: "", handle: "ada", color: "" })).toBe("A");
    expect(accountProfileInitials({ displayName: "", handle: "", color: "" })).toBe("?");
  });
});
