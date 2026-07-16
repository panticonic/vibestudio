/** Stable public identity binding for a materialized workspace context. */

export const CONTEXT_BINDING_FILE = ".vibestudio-context.json";
export const CONTEXT_BINDING_PROTOCOL = "vibestudio.context-binding.v1" as const;

export interface ContextBinding {
  protocol: typeof CONTEXT_BINDING_PROTOCOL;
  workspaceId: string;
  contextId: string;
}

const CONTEXT_BINDING_KEYS = new Set(["protocol", "workspaceId", "contextId"]);

function identity(value: unknown, field: "workspaceId" | "contextId"): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error(`context binding ${field} must be a non-empty canonical identity`);
  }
  return value;
}

/** Parse only the current protocol. There is deliberately no legacy shape. */
export function parseContextBinding(value: unknown): ContextBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("context binding must be an object");
  }
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).filter((key) => !CONTEXT_BINDING_KEYS.has(key));
  if (unknown.length > 0) {
    throw new Error(`context binding has unknown field ${JSON.stringify(unknown[0])}`);
  }
  if (record["protocol"] !== CONTEXT_BINDING_PROTOCOL) {
    throw new Error(`context binding protocol must be ${CONTEXT_BINDING_PROTOCOL}`);
  }
  return {
    protocol: CONTEXT_BINDING_PROTOCOL,
    workspaceId: identity(record["workspaceId"], "workspaceId"),
    contextId: identity(record["contextId"], "contextId"),
  };
}

export function contextBinding(input: { workspaceId: string; contextId: string }): ContextBinding {
  return parseContextBinding({ protocol: CONTEXT_BINDING_PROTOCOL, ...input });
}

export function encodeContextBinding(binding: ContextBinding): string {
  return `${JSON.stringify(parseContextBinding(binding), null, 2)}\n`;
}
