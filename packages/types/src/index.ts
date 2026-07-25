/**
 * @vibestudio/types - Shared type definitions for Vibestudio.
 *
 * This is the canonical source for all types shared between the app (src/)
 * and workspace packages. Form contracts include their canonical Zod schemas
 * and evaluators so transport validation and rendering cannot drift.
 */

// Form schema types
export type {
  PrimitiveFieldValue,
  FieldValue,
  FieldCondition,
  FieldWarning,
  FieldDefinition,
  FormSchema,
} from "./form-schema.js";
export {
  FREE_TEXT_CHOICE_VALUE,
  PrimitiveFieldValueSchema,
  FieldValueSchema,
  ConditionOperatorSchema,
  FieldConditionSchema,
  FieldWarningSchema,
  isFieldCondition,
  evaluateFieldCondition,
  evaluateFieldConditions,
  fieldWarningApplies,
} from "./form-schema.js";

// AI types
export type { AIToolDefinition } from "./ai-types.js";

// Runtime types
export type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
  PanelPlacementHint,
} from "./runtime-types.js";
