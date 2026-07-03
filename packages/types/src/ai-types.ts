/**
 * AI Types - Shared types for AI provider IPC communication.
 */

// =============================================================================
// Tool Definition (used for validation)
// =============================================================================

export interface AIToolDefinition {
  type: "function";
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}
