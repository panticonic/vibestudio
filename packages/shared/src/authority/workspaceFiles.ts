import type { ResourceScope } from "@vibestudio/rpc";
import { requirementForPrincipals } from "../authorization.js";
import {
  fixedPreparedAuthorityRequirement,
  type MethodAuthorityDescriptor,
} from "../typedServiceClient.js";
export type WorkspaceFileEffect = "list" | "read" | "write";
export interface WorkspaceFileAccess {
  effect: WorkspaceFileEffect;
  /** Receiver-resolved workspace-relative path, never a native host path. */
  path: string;
  kind: "file" | "folder";
}

export function workspaceFileResource(
  access: Pick<WorkspaceFileAccess, "path" | "kind">
): Extract<ResourceScope, { kind: "exact" | "prefix" }> {
  const logicalPath = access.path.replace(/\/+$/, "");
  const key = `workspace-path/${logicalPath}${access.kind === "folder" && logicalPath ? "/" : ""}`;
  return access.kind === "folder" ? { kind: "prefix", prefix: key } : { kind: "exact", key };
}

/** Ordinary code keeps its existing admission; website effects select bounded leaves. */
export function workspaceFileMethodAuthority(
  resolver: string,
  effects: readonly WorkspaceFileEffect[],
  capability = "$method"
): MethodAuthorityDescriptor {
  return {
    requirement: requirementForPrincipals(["code", "host", "user", "website"], capability),
    resource: { kind: "literal", key: resolver },
    ...(effects.length
      ? {
          prepared: {
            resolver,
            leaves: effects.map((effect) => ({
              capability: `filesystem.${effect}`,
              requirement: fixedPreparedAuthorityRequirement(
                requirementForPrincipals(["website"], `filesystem.${effect}`)
              ),
              tier: "gated" as const,
            })),
          },
        }
      : {}),
  };
}
