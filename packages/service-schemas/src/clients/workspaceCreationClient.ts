import { z } from "zod";
import { hubControlMethods, WorkspaceCreationOperationIdSchema } from "../hubControl.js";
import type { TypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { WorkspaceTemplatePin, WorkspaceCreationReceipt } from "@vibestudio/workspace-contracts/types";
import { sameWorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";

const savedSubmission = z.object({
  version: z.literal(1),
  input: hubControlMethods.createWorkspace.args.items[0],
}).strict();

export function readWorkspaceCreationSubmission(raw: string | null) {
  return raw === null ? null : savedSubmission.parse(JSON.parse(raw)).input;
}

/**
 * Persist before submitting. A recovered submission is reconciled through a new
 * authorized receipt read; neither a timeout nor document replacement mints a
 * new operation ID. The caller supplies account/workspace-scoped local storage.
 */
export async function submitWorkspaceCreation(
  client: Pick<TypedServiceClient<typeof hubControlMethods>, "createWorkspace" | "workspaceCreationReceipt">,
  input: { workspace: string; rootTemplate?: WorkspaceTemplatePin },
  persistence: {
    key: string;
    getItem(key: string): string | null | Promise<string | null>;
    setItem(key: string, value: string): void | Promise<void>;
    removeItem(key: string): void | Promise<void>;
    newOperationId(): string;
  }
): Promise<WorkspaceCreationReceipt> {
  const raw = await persistence.getItem(persistence.key);
  const saved = readWorkspaceCreationSubmission(raw);
  const retained = saved ? { input: saved } : null;
  // A pending operation is never silently replaced by a changed form submission.
  if (retained && (retained.input.workspace !== input.workspace ||
      (retained.input.rootTemplate && input.rootTemplate
        ? !sameWorkspaceTemplatePin(retained.input.rootTemplate, input.rootTemplate)
        : Boolean(retained.input.rootTemplate) !== Boolean(input.rootTemplate))))
    throw new Error(`Workspace creation ${retained.input.operationId} is still unresolved. Reconcile its original name and template before starting another creation.`);
  const request = retained?.input ?? { ...input,
    operationId: WorkspaceCreationOperationIdSchema.parse(persistence.newOperationId()) };
  if (!retained) await persistence.setItem(persistence.key, JSON.stringify({ version: 1, input: request }));
  const receipt = (retained ? await client.workspaceCreationReceipt({ operationId: request.operationId }) : null)
    ?? await client.createWorkspace(request);
  await persistence.removeItem(persistence.key);
  return receipt;
}
