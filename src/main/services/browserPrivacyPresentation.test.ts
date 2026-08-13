import { describe, expect, it } from "vitest";
import {
  addFormFillConfirmation,
  createAddFormFillRequest,
  formFillCreatePresentation,
} from "./browserPrivacyPresentation.js";

describe("browser privacy form-fill presentation", () => {
  it("provides explicit accessible labels and only persistable field types", () => {
    expect(formFillCreatePresentation).toMatchObject({
      ariaLabel: "Add form-fill value",
      typeLabel: "Form-fill type",
      labelLabel: "Form-fill label",
      valueLabel: "Form-fill value",
      submitLabel: "Save new value",
      defaultType: "email",
    });
    expect(formFillCreatePresentation.typeOptions).toContain("email");
    expect(formFillCreatePresentation.typeOptions).not.toContain("current-password");
    expect(formFillCreatePresentation.typeOptions).not.toContain("cc-csc");
  });

  it("trims a new protected value and label and rejects blank values", () => {
    expect(
      createAddFormFillRequest({
        type: "email",
        value: "  new@example.com  ",
        displayLabel: "  Work email  ",
      })
    ).toEqual({
      action: "addFormFill",
      type: "email",
      value: "new@example.com",
      displayLabel: "Work email",
    });
    expect(() => createAddFormFillRequest({ type: "email", value: "   " })).toThrow();
    expect(addFormFillConfirmation("email")).toBe("Save this email value for browser form fill?");
  });
});
