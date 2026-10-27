import {
  BROWSER_PRIVACY_FORM_FILL_TYPES,
  BrowserPrivacyRequestSchema,
  type BrowserPrivacyRequest,
  type BrowserCookieProjectionDiagnostics,
} from "./browserPrivacyProtocol.js";

export const formFillCreatePresentation = {
  ariaLabel: "Add autofill information",
  typeLabel: "Information type",
  labelLabel: "Label",
  valueLabel: "Value",
  submitLabel: "Add information",
  defaultType: "email",
  typeOptions: BROWSER_PRIVACY_FORM_FILL_TYPES,
} as const;

const fieldLabels: Record<string, string> = {
  "given-name": "First name",
  "additional-name": "Middle name",
  "family-name": "Last name",
  "honorific-prefix": "Title",
  "honorific-suffix": "Name suffix",
  "organization-title": "Job title",
  tel: "Phone number",
  "tel-country-code": "Phone country code",
  "tel-national": "National phone number",
  "tel-area-code": "Phone area code",
  "tel-local": "Local phone number",
  "tel-local-prefix": "Local phone prefix",
  "tel-local-suffix": "Local phone suffix",
  "tel-extension": "Phone extension",
  impp: "Messaging address",
  "street-address": "Street address",
  "address-line1": "Address line 1",
  "address-line2": "Address line 2",
  "address-line3": "Address line 3",
  "address-level1": "State or region",
  "address-level2": "City",
  "address-level3": "District",
  "address-level4": "Neighborhood",
  "postal-code": "Postal code",
  "country-name": "Country name",
  "cc-name": "Name on card",
  "cc-given-name": "First name on card",
  "cc-additional-name": "Middle name on card",
  "cc-family-name": "Last name on card",
  "cc-number": "Card number",
  "cc-exp": "Card expiry",
  "cc-exp-month": "Card expiry month",
  "cc-exp-year": "Card expiry year",
  "cc-type": "Card type",
  "transaction-currency": "Currency",
  "transaction-amount": "Amount",
  bday: "Birthday",
  "bday-day": "Birth day",
  "bday-month": "Birth month",
  "bday-year": "Birth year",
  url: "Website",
  photo: "Photo URL",
};

export function autofillFieldLabel(type: string): string {
  return fieldLabels[type] ?? type.replace(/-/g, " ").replace(/^./, (first) => first.toUpperCase());
}

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
  return `Save this ${autofillFieldLabel(type).toLowerCase()} for autofill?`;
}

export function browserSessionStatus(
  diagnostics: BrowserCookieProjectionDiagnostics | null,
  readError?: string
): {
  title: string;
  description: string;
  error: boolean;
  canRetry: boolean;
} {
  if (readError)
    return {
      title: "Session status unavailable",
      description: readError,
      error: true,
      canRetry: false,
    };
  if (!diagnostics)
    return {
      title: "Waiting for browser sessions",
      description: "Session synchronization will start when the browser environment is ready.",
      error: false,
      canRetry: false,
    };
  if (diagnostics.lastError)
    return {
      title: "Session synchronization needs attention",
      description: diagnostics.lastError,
      error: true,
      canRetry: true,
    };
  if (diagnostics.converged)
    return {
      title: "Up to date",
      description: "Your saved cookies and this browser are synchronized.",
      error: false,
      canRetry: false,
    };
  return {
    title: "Synchronizing",
    description: "Browser session changes are being synchronized automatically.",
    error: false,
    canRetry: false,
  };
}
