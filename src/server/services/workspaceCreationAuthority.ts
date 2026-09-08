import {
  WORKSPACE_CREATION_AUTHORITY_RESOLVER,
  workspaceCreationMethods,
} from "@vibestudio/service-schemas/workspaceCreation";
import { fixedPreparedAuthoritySelection } from "@vibestudio/shared/serviceDefinition";
import type { AuthorityPreparationResolver } from "@vibestudio/shared/serviceDefinition";
import type { z } from "zod";

type WorkspaceCreationInput = z.infer<typeof workspaceCreationMethods.createWorkspace.args>[0];

/**
 * Prepare the review from the same parsed request whose digest the dispatcher
 * seals before prompting. The operation id remains the grant/receipt key, but
 * it is deliberately relegated to details instead of masquerading as the
 * workspace the user is being asked to create.
 */
export const prepareWorkspaceCreationAuthority: AuthorityPreparationResolver = (
  _ctx,
  [rawInput]
) => {
  const input = workspaceCreationMethods.createWorkspace.args.items[0].parse(
    rawInput
  ) as WorkspaceCreationInput;
  const template = input.rootTemplate;
  const workspace = input.workspace.trim();
  const resource = {
    type: "workspace",
    label: "Workspace",
    value: workspace,
  };
  const facts = [
    { label: "Workspace", value: workspace },
    ...(template
      ? [
          { label: "Template source", value: template.url },
          { label: "Template ref", value: template.ref },
          { label: "Template commit", value: template.commit },
          { label: "Template snapshot", value: template.snapshot },
        ]
      : [{ label: "Template", value: "Host-selected default template" }]),
  ];
  return {
    selections: [
      fixedPreparedAuthoritySelection({
        capability: "workspaces.create",
        resourceKey: input.operationId,
        challenge: {
          title: `Create “${workspace}” workspace`,
          description: template
            ? "Create this workspace from the exact template version shown below."
            : "Create this workspace from the host's default template. The request does not specify a template pin.",
          deniedReason: `Creating the “${workspace}” workspace was not allowed`,
          dedupKey: `workspace-creation:${input.operationId}`,
          resource,
          operation: {
            kind: "workspace",
            verb: `create the “${workspace}” workspace`,
            object: resource,
            groupKey: `workspace-creation:${input.operationId}`,
          },
          substance: {
            kind: "change-set",
            summary: `Create the “${workspace}” workspace`,
            detail: template
              ? `Initialize it from ${template.url} at commit ${template.commit}.`
              : "Initialize it from the host-selected default; this request does not supply an exact template pin.",
            facts,
          },
          details: [
            ...facts.slice(1),
            { label: "Request ID", value: input.operationId, format: "code" as const },
          ],
        },
      }),
    ],
    payload: input,
  };
};

export const workspaceCreationAuthorityPreparation = {
  [WORKSPACE_CREATION_AUTHORITY_RESOLVER]: prepareWorkspaceCreationAuthority,
};
