import { describe, expect, it } from "vitest";
import {
  FORM_FILL_TYPES,
  FormFillSuggestionQuerySchema,
  isPersistableFormFillType,
} from "../environment.js";

describe("form-fill contract", () => {
  it("covers the standard HTML autocomplete field vocabulary", () => {
    expect(FORM_FILL_TYPES).toContain("cc-number");
    expect(FORM_FILL_TYPES).toContain("one-time-code");
    expect(FORM_FILL_TYPES).toContain("bday-year");
    expect(FORM_FILL_TYPES).toContain("tel-extension");
    expect(FORM_FILL_TYPES).toContain("transaction-amount");
  });

  it("allows exact browser-native field-name queries without a semantic type", () => {
    expect(
      FormFillSuggestionQuerySchema.parse({
        fieldName: "favorite_pizza_topping",
        prefix: "art",
      })
    ).toEqual({
      fieldName: "favorite_pizza_topping",
      prefix: "art",
    });
  });

  it("requires at least one form-field identity", () => {
    expect(FormFillSuggestionQuerySchema.safeParse({ prefix: "a" }).success).toBe(false);
  });

  it("separates reusable profile data from credentials and transient secrets", () => {
    expect(isPersistableFormFillType("email")).toBe(true);
    expect(isPersistableFormFillType("cc-number")).toBe(true);
    expect(isPersistableFormFillType("current-password")).toBe(false);
    expect(isPersistableFormFillType("new-password")).toBe(false);
    expect(isPersistableFormFillType("one-time-code")).toBe(false);
    expect(isPersistableFormFillType("cc-csc")).toBe(false);
  });
});
