/**
 * @vibez1/types - Shared type definitions for Vibez1.
 *
 * This is the canonical source for all types shared between the app (src/)
 * and workspace packages. Zero runtime dependencies.
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
export { FREE_TEXT_CHOICE_VALUE } from "./form-schema.js";

// AI types
export type { AIToolDefinition } from "./ai-types.js";

// Runtime types
export type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
} from "./runtime-types.js";
