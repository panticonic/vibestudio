export const FORM_FILL_TYPES = [
  "name",
  "given-name",
  "additional-name",
  "family-name",
  "honorific-prefix",
  "honorific-suffix",
  "nickname",
  "username",
  "new-password",
  "current-password",
  "one-time-code",
  "organization-title",
  "email",
  "tel",
  "tel-country-code",
  "tel-national",
  "tel-area-code",
  "tel-local",
  "tel-local-prefix",
  "tel-local-suffix",
  "tel-extension",
  "impp",
  "organization",
  "street-address",
  "address-line1",
  "address-line2",
  "address-line3",
  "address-level1",
  "address-level2",
  "address-level3",
  "address-level4",
  "postal-code",
  "country",
  "country-name",
  "cc-name",
  "cc-given-name",
  "cc-additional-name",
  "cc-family-name",
  "cc-number",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-csc",
  "cc-type",
  "transaction-currency",
  "transaction-amount",
  "language",
  "bday",
  "bday-day",
  "bday-month",
  "bday-year",
  "sex",
  "url",
  "photo",
] as const;

export type FormFillType = (typeof FORM_FILL_TYPES)[number];

/** Field meanings that must never be retained as reusable form history. */
export const NON_PERSISTABLE_FORM_FILL_TYPES = [
  "new-password",
  "current-password",
  "one-time-code",
  "cc-csc",
] as const satisfies readonly FormFillType[];

const NON_PERSISTABLE_FORM_FILL_TYPE_SET = new Set<FormFillType>(NON_PERSISTABLE_FORM_FILL_TYPES);

export function isPersistableFormFillType(
  type: FormFillType | null | undefined
): type is Exclude<FormFillType, (typeof NON_PERSISTABLE_FORM_FILL_TYPES)[number]> {
  return type != null && !NON_PERSISTABLE_FORM_FILL_TYPE_SET.has(type);
}
