import {
  BROWSER_PRIVACY_FORM_FILL_TYPES,
  BrowserPrivacyRequestSchema,
  type BrowserPrivacyRequest,
} from "./browserPrivacyProtocol.js";

export const formFillCreatePresentation = {
  ariaLabel: "Add form-fill value",
  typeLabel: "Form-fill type",
  labelLabel: "Form-fill label",
  valueLabel: "Form-fill value",
  submitLabel: "Save new value",
  defaultType: "email",
  typeOptions: BROWSER_PRIVACY_FORM_FILL_TYPES,
} as const;

export function createAddFormFillRequest(input: {
  type: string;
  value: string;
  displayLabel?: string;
}): BrowserPrivacyRequest {
  return BrowserPrivacyRequestSchema.parse({
    action: "addFormFill",
    type: input.type,
    value: input.value.trim(),
    ...(input.displayLabel?.trim() ? { displayLabel: input.displayLabel.trim() } : {}),
  });
}

export function addFormFillConfirmation(type: string): string {
  return `Save this ${type} value for browser form fill?`;
}
