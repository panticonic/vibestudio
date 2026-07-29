import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import type { TemplateOperationInspection } from "@workspace/template-composer";
import { canonicalJson } from "@vibestudio/content-addressing";
import type { TemplateOperationRecord } from "./staging.js";

export async function ensureApprovedTemplateOperation(input: {
  operationId: string;
  inspection: TemplateOperationInspection;
  intent: unknown;
  existing: TemplateOperationRecord | null;
  requestApproval(): Promise<string | null>;
  persist(record: TemplateOperationRecord): Promise<void>;
}): Promise<
  | { status: "approved"; record: TemplateOperationRecord; resumed: boolean }
  | { status: "denied"; message: string }
> {
  if (input.existing) {
    if (input.existing.fingerprint !== input.inspection.plan.fingerprint) {
      throw new Error(
        `Template operation ${input.operationId} no longer matches its approved exact plan`
      );
    }
    if (canonicalJson(input.existing.intent) !== canonicalJson(input.intent)) {
      throw new Error(
        `Template operation ${input.operationId} was reused with different normalized intent`
      );
    }
  }
  const denied = await input.requestApproval();
  if (denied) return { status: "denied", message: denied };
  if (input.existing) {
    return { status: "approved", record: input.existing, resumed: true };
  }
  const record: TemplateOperationRecord = {
    version: 1,
    operationId: input.operationId,
    kind: input.inspection.kind,
    fingerprint: input.inspection.plan.fingerprint,
    intent: input.intent,
    pins: input.inspection.plan.nodes.map((node) => node.pin as WorkspaceTemplatePin),
    addedParts: Object.keys(input.inspection.plan.repositories).sort(),
    orphanedParts: input.inspection.plan.ownershipChanges
      .filter((change) => change.reason === "orphaned")
      .map((change) => change.repoPath),
  };
  await input.persist(record);
  return { status: "approved", record, resumed: false };
}
