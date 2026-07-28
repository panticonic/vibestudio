import { describe, expect, it } from "vitest";
import { importedFormFillValue } from "../import/provider.js";
import { classifyAutofillFieldName } from "../normalize/autofill.js";

describe("browser form-fill import", () => {
  it("classifies the complete standard autocomplete vocabulary", () => {
    expect(classifyAutofillFieldName("cc-number")).toBe("cc-number");
    expect(classifyAutofillFieldName("bday-year")).toBe("bday-year");
    expect(classifyAutofillFieldName("tel-extension")).toBe("tel-extension");
    expect(classifyAutofillFieldName("one-time-code")).toBe("one-time-code");
  });

  it("preserves arbitrary browser-native fields instead of rejecting them", () => {
    expect(
      importedFormFillValue({
        fieldName: "favorite_pizza_topping",
        value: "artichoke",
        dateCreated: 100,
        dateLastUsed: 200,
        timesUsed: 3,
      })
    ).toEqual({
      fieldName: "favorite_pizza_topping",
      value: "artichoke",
      aliases: ["favorite_pizza_topping"],
      createdAt: 100,
      updatedAt: 200,
      useCount: 3,
    });
  });

  it("preserves browser-stored sensitive-looking fields without reclassifying or dropping them", () => {
    expect(
      importedFormFillValue({
        fieldName: "site_secret_answer",
        value: "the source browser retained this",
        timesUsed: 1,
      })
    ).toMatchObject({
      fieldName: "site_secret_answer",
      value: "the source browser retained this",
    });
  });

  it("keeps the native identity alongside semantic classification", () => {
    expect(
      importedFormFillValue({
        fieldName: "email_address",
        value: "person@example.test",
        timesUsed: 4,
      })
    ).toMatchObject({
      fieldName: "email_address",
      type: "email",
      aliases: ["email_address"],
    });
  });
});
