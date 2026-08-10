import type { StateArgsSchema, StateArgsValidation } from "./stateArgs.js";
import { normalizeStateArgs } from "./stateArgsSerialization.js";

/**
 * Browser-runtime entry for the canonical state-args validator. Host code keeps
 * the synchronous API; panels load AJV only when an operation actually carries
 * a schema that must be checked.
 */
export async function validateStateArgsAsync(
  args: unknown,
  schema: StateArgsSchema | undefined
): Promise<StateArgsValidation> {
  if (!schema) return normalizeStateArgs(args);
  const { validateStateArgs } = await import("./stateArgsValidator.js");
  return validateStateArgs(args, schema);
}
