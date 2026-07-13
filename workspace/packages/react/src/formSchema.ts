import type {
  FieldCondition,
  FieldDefinition,
  FieldValue,
  FieldWarning,
  PrimitiveFieldValue,
} from "@vibestudio/types";

export function evaluateCondition(
  condition: FieldCondition,
  values: Record<string, FieldValue>
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
      if (Array.isArray(fieldValue) || fieldValue === undefined) return false;
      return Array.isArray(conditionValue) && conditionValue.includes(fieldValue);
    case "contains":
      if (!Array.isArray(fieldValue)) return false;
      return fieldValue.includes(conditionValue as string);
    default:
      return false;
  }
}

function evaluateConditions(
  conditions: FieldCondition | FieldCondition[] | undefined,
  values: Record<string, FieldValue>
): boolean {
  if (!conditions) return true;
  return Array.isArray(conditions)
    ? conditions.every((condition) => evaluateCondition(condition, values))
    : evaluateCondition(conditions, values);
}

export function isFieldVisible(
  field: FieldDefinition,
  values: Record<string, FieldValue>
): boolean {
  return evaluateConditions(field.visibleWhen, values);
}

export function isFieldEnabled(
  field: FieldDefinition,
  values: Record<string, FieldValue>
): boolean {
  return evaluateConditions(field.enabledWhen, values);
}

export function getFieldWarning(field: FieldDefinition, value: FieldValue): FieldWarning | null {
  if (!field.warnings || Array.isArray(value)) return null;
  for (const warning of field.warnings) {
    if (
      (Array.isArray(warning.when) && warning.when.includes(value as PrimitiveFieldValue)) ||
      (!Array.isArray(warning.when) && warning.when === value)
    ) {
      return warning;
    }
  }
  return null;
}

export function groupFields(fields: FieldDefinition[]): Map<string, FieldDefinition[]> {
  const groups = new Map<string, FieldDefinition[]>();
  for (const field of fields) {
    const groupName = field.group ?? "General";
    const group = groups.get(groupName) ?? [];
    group.push(field);
    groups.set(groupName, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  }
  return groups;
}
