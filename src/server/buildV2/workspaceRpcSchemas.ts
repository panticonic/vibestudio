import { browserProductMethods } from "@vibestudio/service-schemas/browserData";
import { developmentBuiltinMethods } from "@vibestudio/service-schemas/development";
import { missionsMethods } from "@vibestudio/service-schemas/missions";
import { phoneProvisioningMethods } from "@vibestudio/service-schemas/phoneProvisioning";
import { workspacePresentationMethods } from "@vibestudio/service-schemas/workspacePresentation";
import { gadWireMethods } from "@vibestudio/service-schemas/workspaceSource";
import type { MethodSchema, ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import { BuildDiagnosticsError } from "./diagnostics.js";
import type { WorkspaceRpcSchemaMetadata } from "./workspaceRpcCatalog.js";

/**
 * Host-reviewed typed receiver contracts available to workspace worker builds.
 * Manifests bind a DO class to a stable protocol id; builders never execute or
 * dynamically import mutable workspace modules to discover authority.
 */
const WORKSPACE_RPC_SCHEMAS = {
  "vibestudio.browser-data.v1": browserProductMethods,
  "vibestudio.development.v1": developmentBuiltinMethods,
  "vibestudio.gad.workspace.v1": gadWireMethods,
  "vibestudio.missions.v1": missionsMethods,
  "vibestudio.phone-provisioning.v1": phoneProvisioningMethods,
  "vibestudio.workspace-presentation.v1": workspacePresentationMethods,
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

/** Strip executable validators before a reviewed receiver contract crosses a worker boundary. */
export function workspaceRpcSchemaMetadata(
  schema: ServiceMethodSchemas
): Record<string, WorkspaceRpcSchemaMetadata> {
  return Object.fromEntries(
    Object.entries(schema).map(([name, method]) => [
      name,
      {
        ...(method.authority ? { authority: method.authority } : {}),
        ...(method.tier ? { tier: method.tier } : {}),
        ...(method.access ? { access: method.access } : {}),
        ...(method.directEffect ? { directEffect: method.directEffect } : {}),
        ...(method.execution ? { execution: method.execution } : {}),
      },
    ])
  );
}

export function unknownWorkspaceRpcSchemaMessage(input: {
  repoPath: string;
  className: string;
  rpcSchema: string;
}): string {
  return (
    `${input.repoPath}:${input.className} names unknown workspace RPC schema ${input.rpcSchema}. ` +
    "Application-defined protocols belong in meta/vibestudio.yml services[].protocols and must omit " +
    "package.json#vibestudio.durable.classes[].rpcSchema; rpcSchema is reserved for host-reviewed built-in contracts."
  );
}

/**
 * The one structured diagnostic for the unknown-rpcSchema declaration mistake:
 * the explanatory text above plus the exact removal field and the canonical
 * workspace declaration location, so an agent repairs the source instead of
 * re-deriving policy from prose. Both diagnostic call sites throw this.
 */
export function unknownWorkspaceRpcSchemaError(input: {
  repoPath: string;
  className: string;
  rpcSchema: string;
}): BuildDiagnosticsError {
  const message = unknownWorkspaceRpcSchemaMessage(input);
  return new BuildDiagnosticsError(message, [
    {
      source: "schema",
      severity: "error",
      file: `${input.repoPath}/package.json`,
      line: 1,
      column: 1,
      message,
      suggestion:
        `Delete rpcSchema ${JSON.stringify(input.rpcSchema)} from the ${input.className} class ` +
        "entry and declare the application protocol in meta/vibestudio.yml services[].protocols.",
      repair: {
        code: "application-protocol-declaration",
        remove: {
          file: `${input.repoPath}/package.json`,
          field: `vibestudio.durable.classes[className=${JSON.stringify(input.className)}].rpcSchema`,
        },
        declareAt: { file: "meta/vibestudio.yml", field: "services[].protocols" },
        docsId: "runtime:workerRuntime.workers.resolveService",
      },
    },
  ]);
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
