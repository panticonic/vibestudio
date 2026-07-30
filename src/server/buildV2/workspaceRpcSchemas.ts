import { gadWireMethods } from "@vibestudio/service-schemas/workspaceSource";
import type { ServiceMethodSchemas } from "@vibestudio/shared/typedServiceClient";

/**
 * Host-reviewed typed receiver contracts available to workspace worker builds.
 * Manifests bind a DO class to a stable protocol id; builders never execute or
 * dynamically import mutable workspace modules to discover authority.
 */
const WORKSPACE_RPC_SCHEMAS = {
  "vibestudio.gad.workspace.v1": gadWireMethods,
} as const satisfies Record<string, ServiceMethodSchemas>;

export function workspaceRpcSchema(protocol: string): ServiceMethodSchemas | undefined {
  return (WORKSPACE_RPC_SCHEMAS as Record<string, ServiceMethodSchemas>)[protocol];
}
