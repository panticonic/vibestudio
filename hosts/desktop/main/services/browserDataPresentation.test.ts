import { describe, expect, it } from "vitest";
import {
  addFormFillConfirmation,
  autofillFieldLabel,
  browserSessionStatus,
  createAddFormFillRequest,
  formFillCreatePresentation,
} from "./browserDataPresentation.js";

describe("browser data presentation", () => {
  it("labels persisted autofill fields clearly and excludes password and security-code fields", () => {
    expect(formFillCreatePresentation).toMatchObject({
      ariaLabel: "Add autofill information",
      typeLabel: "Information type",
      labelLabel: "Label",
      valueLabel: "Value",
      submitLabel: "Add information",
      defaultType: "email",
    });
    expect(autofillFieldLabel("given-name")).toBe("First name");
    expect(autofillFieldLabel("cc-exp-month")).toBe("Card expiry month");
    expect(autofillFieldLabel("email")).toBe("Email");
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
    expect(addFormFillConfirmation("given-name")).toBe("Save this first name for autofill?");
  });

  it("offers recovery only for a real synchronization failure and preserves recovered details", () => {
    const diagnostics = {
      revision: 4,
      hostId: "host",
      converged: false,
      mismatchCount: 0,
      outboxDepth: 1,
    };
    expect(browserSessionStatus(null)).toMatchObject({
      title: "Waiting for browser sessions",
      error: false,
      canRetry: false,
    });
    expect(browserSessionStatus(null, "The protected status request failed")).toMatchObject({
      title: "Session status unavailable",
      description: "The protected status request failed",
      error: true,
      canRetry: false,
    });
    expect(browserSessionStatus(diagnostics)).toMatchObject({
      title: "Synchronizing",
      error: false,
      canRetry: false,
    });
    expect(browserSessionStatus({ ...diagnostics, lastError: "Vault unavailable" })).toMatchObject({
      description: "Vault unavailable",
      error: true,
      canRetry: true,
    });
    expect(
      browserSessionStatus({
        ...diagnostics,
        converged: true,
        outboxDepth: 0,
        lastFailure: {
          message: "Vault unavailable",
          occurredAt: "2026-10-27T11:00:00.000Z",
          recoveredAt: "2026-10-27T11:00:01.000Z",
        },
      })
    ).toMatchObject({ title: "Up to date", error: false, canRetry: false });
  });
});
