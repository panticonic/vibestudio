/**
 * Form Schema Types - Data-driven UI definition system.
 *
 * Type definitions for forms defined via data, with support for
 * conditionality between fields.
 *
 * Runtime rendering helpers live beside FormRenderer in @workspace/react.
 */

import { z } from "zod";

/**
 * Primitive value types (used in conditions and warnings)
 */
export const PrimitiveFieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);
export type PrimitiveFieldValue = z.infer<typeof PrimitiveFieldValueSchema>;

/**
 * Value types supported by form fields
 * - Primitives: string, number, boolean
 * - Arrays: string[] (for multiSelect fields)
 */
export const FieldValueSchema = z.union([PrimitiveFieldValueSchema, z.array(z.string())]);
export type FieldValue = z.infer<typeof FieldValueSchema>;

/**
 * Field types supported by the form renderer
 */
export type FieldType =
  // Standard form types
  | "string" // Text input
  | "textarea" // Multi-line text input
  | "number" // Numeric input
  | "boolean" // Switch/toggle
  | "select" // Dropdown
  | "slider" // Range slider (continuous or notched)
  | "segmented" // Segmented control (mutually exclusive options)
  | "toggle" // Two-state toggle with explicit labels
  // Feedback UI types
  | "readonly" // Display-only text (non-editable)
  | "code" // Syntax-highlighted code/JSON block
  | "buttonGroup" // Horizontal action buttons (Allow/Deny style)
  | "multiSelect" // Multiple selection checkboxes
  | "diff" // Unified or side-by-side diff view
  | "toolPreview" // Rich tool argument preview (Monaco diff, git previews, etc.)
  | "approvalHeader"; // Tool approval header (first-time grant or per-call)

export const FREE_TEXT_CHOICE_VALUE = "__vibestudio_free_text__";

/**
 * Comparison operators for field conditions
 */
export const ConditionOperatorSchema = z.enum([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "contains",
]);
export type ConditionOperator = z.infer<typeof ConditionOperatorSchema>;

/**
 * Condition for field visibility/enabled state
 */
export const FieldConditionSchema = z.object({
  field: z.string(),
  operator: ConditionOperatorSchema,
  value: z.union([PrimitiveFieldValueSchema, z.array(PrimitiveFieldValueSchema)]),
});
export type FieldCondition = z.infer<typeof FieldConditionSchema>;

/**
 * Option for select/segmented/toggle fields
 */
export interface FieldOption {
  value: string;
  label: string;
  description?: string;
}

/**
 * Notch definition for slider fields.
 */
export interface SliderNotch {
  value: number;
  label: string;
  description?: string;
}

/**
 * Warning to display either for a value of this field or for a condition over
 * the complete form. Value predicates keep simple forms terse; conditions
 * support cross-field warnings without a second conditionality language.
 */
export const FieldWarningSchema = z.object({
  when: z.union([
    PrimitiveFieldValueSchema,
    z.array(PrimitiveFieldValueSchema),
    FieldConditionSchema,
    z.array(FieldConditionSchema),
  ]),
  message: z.string(),
  severity: z.enum(["info", "warning", "danger"]).optional(),
});
export type FieldWarning = z.infer<typeof FieldWarningSchema>;

export function isFieldCondition(value: unknown): value is FieldCondition {
  return FieldConditionSchema.safeParse(value).success;
}

export function evaluateFieldCondition(
  condition: FieldCondition,
  values: Readonly<Record<string, FieldValue>>
): boolean {
  const fieldValue = values[condition.field];
  const conditionValue = condition.value;
  switch (condition.operator) {
    case "eq":
      return fieldValue === conditionValue;
    case "neq":
      return fieldValue !== conditionValue;
    case "gt":
      return (
        typeof fieldValue === "number" &&
        typeof conditionValue === "number" &&
        fieldValue > conditionValue
      );
    case "gte":
      return (
        typeof fieldValue === "number" &&
        typeof conditionValue === "number" &&
        fieldValue >= conditionValue
      );
    case "lt":
      return (
        typeof fieldValue === "number" &&
        typeof conditionValue === "number" &&
        fieldValue < conditionValue
      );
    case "lte":
      return (
        typeof fieldValue === "number" &&
        typeof conditionValue === "number" &&
        fieldValue <= conditionValue
      );
    case "in":
      return (
        !Array.isArray(fieldValue) &&
        fieldValue !== undefined &&
        Array.isArray(conditionValue) &&
        conditionValue.includes(fieldValue)
      );
    case "contains":
      return Array.isArray(fieldValue) && fieldValue.includes(conditionValue as string);
  }
}

export function evaluateFieldConditions(
  conditions: FieldCondition | FieldCondition[] | undefined,
  values: Readonly<Record<string, FieldValue>>
): boolean {
  if (!conditions) return true;
  return Array.isArray(conditions)
    ? conditions.every((condition) => evaluateFieldCondition(condition, values))
    : evaluateFieldCondition(conditions, values);
}

export function fieldWarningApplies(
  fieldKey: string,
  warning: FieldWarning,
  values: Readonly<Record<string, FieldValue>>
): boolean {
  if (isFieldCondition(warning.when)) {
    return evaluateFieldCondition(warning.when, values);
  }
  if (
    Array.isArray(warning.when) &&
    warning.when.length > 0 &&
    warning.when.every(isFieldCondition)
  ) {
    return warning.when.every((condition) => evaluateFieldCondition(condition, values));
  }
  const value = values[fieldKey];
  if (Array.isArray(value)) return false;
  return Array.isArray(warning.when)
    ? (warning.when as PrimitiveFieldValue[]).includes(value as PrimitiveFieldValue)
    : warning.when === value;
}

/**
 * Complete field definition
 */
export interface FieldDefinition {
  // Identity
  key: string;
  label?: string;
  description?: string;

  // Type and behavior
  type: FieldType;
  required?: boolean;
  default?: FieldValue;
  channelLevel?: boolean;

  // Options (for select, segmented, toggle, multiSelect)
  options?: FieldOption[];

  // Variant for segmented and multiSelect fields
  variant?: "buttons" | "cards" | "list";

  // Add an "Other" choice that captures arbitrary user text.
  allowFreeText?: boolean;
  freeTextLabel?: string;
  freeTextPlaceholder?: string;
  freeTextKey?: string;

  // Slider configuration
  min?: number;
  max?: number;
  step?: number;
  notches?: SliderNotch[];
  sliderLabels?: { min?: string; max?: string };

  // Layout
  group?: string;
  order?: number;

  // Conditionality
  visibleWhen?: FieldCondition | FieldCondition[];
  enabledWhen?: FieldCondition | FieldCondition[];

  // Validation and warnings
  warnings?: FieldWarning[];
  placeholder?: string;

  // Feedback UI field properties
  language?: string;
  maxHeight?: number;

  // For buttonGroup fields
  buttonStyle?: "outline" | "solid" | "soft";
  buttons?: Array<{
    value: string;
    label: string;
    color?: "gray" | "green" | "red" | "amber";
    description?: string;
  }>;

  // For select/multiSelect/buttonGroup - auto-submit when selected
  submitOnSelect?: boolean;

  // For toolPreview fields
  toolName?: string;
  toolArgs?: unknown;

  // For approvalHeader fields
  agentName?: string;
  displayName?: string;
  isFirstTimeGrant?: boolean;
  floorLevel?: number;
}

/**
 * Complete form schema
 */
export interface FormSchema {
  fields: FieldDefinition[];
  title?: string;
  description?: string;
}
