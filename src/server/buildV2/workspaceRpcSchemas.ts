import { gadWireMethods } from "@vibestudio/service-schemas/workspaceSource";
import type { MethodSchema, ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";

/**
 * Host-reviewed typed receiver contracts available to workspace worker builds.
 * Manifests bind a DO class to a stable protocol id; builders never execute or
 * dynamically import mutable workspace modules to discover authority.
 */
const WORKSPACE_RPC_SCHEMAS = {
  "vibestudio.gad.workspace.v1": gadWireMethods,
} as const satisfies Record<string, ServiceMethodSchemas>;

function schemaIdentity(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === "function") return `[function:${value.toString()}]`;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[cycle]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => schemaIdentity(entry, seen));
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      result[key] = schemaIdentity(record[key], seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

export function workspaceRpcSchema(protocol: string): ServiceMethodSchemas | undefined {
  return (WORKSPACE_RPC_SCHEMAS as Record<string, ServiceMethodSchemas>)[protocol];
}

/** Digest the host-owned authority surface that affects static userland folds. */
export function workspaceRpcSchemaVersion(): string {
  return sha256Canonical(
    Object.fromEntries(
      Object.entries(WORKSPACE_RPC_SCHEMAS).map(([protocol, methods]) => [
        protocol,
        Object.fromEntries(
          Object.entries(methods).map(([method, rawDefinition]) => {
            const definition = rawDefinition as MethodSchema;
            return [
              method,
              {
                authority: definition.authority ?? null,
                tier: definition.tier ?? null,
                access: definition.access ?? null,
                directEffect: definition.directEffect ?? null,
                capability: definition.capability ?? null,
                presentation: definition.presentation ?? null,
                agentFacing: definition.agentFacing ?? null,
                execution: definition.execution ?? null,
                args: schemaIdentity(definition.args),
                returns: schemaIdentity(definition.returns ?? null),
              },
            ];
          })
        ),
      ])
    )
  );
}
