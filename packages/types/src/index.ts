/**
 * @natstack/types - Shared type definitions for NatStack.
 *
 * This is the canonical source for all types shared between the app (src/)
 * and workspace packages. Zero runtime dependencies.
 */

// Form schema types
export type {
  PrimitiveFieldValue,
  FieldValue,
  FieldType,
  ConditionOperator,
  FieldCondition,
  FieldOption,
  SliderNotch,
  FieldWarning,
  FieldDefinition,
  FormSchema,
} from "./form-schema.js";
export { FREE_TEXT_CHOICE_VALUE } from "./form-schema.js";

// AI types
export type {
  AIModelInfo,
  AIRoleRecord,
  AIToolDefinition,
  MessageRole,
  TextPart,
  FilePart,
  ToolCallPart,
  ToolResultPart,
  SystemMessage,
  UserMessage,
  AssistantMessage,
  ToolMessage,
  Message,
  ToolDefinition,
  OnChunkCallback,
  OnFinishCallback,
  OnStepFinishCallback,
  OnErrorCallback,
  StepFinishResult,
  StreamTextFinishResult,
  StreamTextOptions,
  StreamEvent,
  ToolExecutionResult,
  StreamTextResult,
} from "./ai-types.js";

// Runtime types
export type {
  CreateChildOptions,
  ChildCreationResult,
  ChildSpec,
} from "./runtime-types.js";
