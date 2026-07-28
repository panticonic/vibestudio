import { FORM_FILL_TYPES, type FormFillType } from "@vibestudio/browser-data";

const STANDARD_TYPES = new Set<string>(FORM_FILL_TYPES);

/**
 * Infer an HTML autocomplete meaning without replacing the source browser's
 * native field name. The native name remains the lossless storage identity;
 * this classification only lets equivalent names share suggestions.
 */
export function classifyAutofillFieldName(name: string): FormFillType | undefined {
  const field = name.trim().toLocaleLowerCase().replace(/_/g, "-");
  if (STANDARD_TYPES.has(field)) return field as FormFillType;
  if (/^(first|given)(-?name)?$/.test(field)) return "given-name";
  if (/^(last|family|sur)(-?name)?$/.test(field)) return "family-name";
  if (/^(full-?)?name$/.test(field)) return "name";
  if (/e-?mail|email-?address/.test(field)) return "email";
  if (/^(phone|mobile|telephone|phone-number)$/.test(field)) return "tel";
  if (/company|organisation|organization/.test(field)) return "organization";
  if (/^(zip|zip-code|postcode)$/.test(field)) return "postal-code";
  if (/^(city|town)$/.test(field)) return "address-level2";
  if (/^(state|province|region)$/.test(field)) return "address-level1";
  if (/^country(-name)?$/.test(field)) return "country-name";
  if (/^(address|street)$/.test(field)) return "street-address";
  if (/^(address-?1|address-line-?1)$/.test(field)) return "address-line1";
  if (/^(address-?2|address-line-?2)$/.test(field)) return "address-line2";
  return undefined;
}
