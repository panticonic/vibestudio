import { describe, expect, it } from "vitest";
import {
  FieldConditionSchema,
  FieldWarningSchema,
  evaluateFieldCondition,
  fieldWarningApplies,
} from "./form-schema.js";

describe("canonical form conditions", () => {
  it("uses the same schema and evaluator for cross-field warnings", () => {
    const condition = FieldConditionSchema.parse({
      field: "accessLevel",
      operator: "eq",
      value: "broad",
    });
    const warning = FieldWarningSchema.parse({
      when: condition,
      message: "Broad access",
      severity: "warning",
    });

    expect(evaluateFieldCondition(condition, { accessLevel: "limited" })).toBe(false);
    expect(fieldWarningApplies("tokenKind", warning, { accessLevel: "broad" })).toBe(true);
  });

  it("preserves same-field shorthand without a second condition language", () => {
    const warning = FieldWarningSchema.parse({
      when: ["classic", "fine-grained"],
      message: "Token choice",
    });

    expect(fieldWarningApplies("tokenKind", warning, { tokenKind: "classic" })).toBe(true);
    expect(fieldWarningApplies("tokenKind", warning, { tokenKind: "oauth" })).toBe(false);
  });
});
