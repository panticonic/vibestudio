import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import type { TemplateOperationInspection } from "@workspace/template-composer";
import { canonicalJson } from "@vibestudio/content-addressing";
import type { TemplateOperationRecord } from "./staging.js";

export async function ensureTemplateOperationIntent(input: {
  operationId: string;
  inspection: TemplateOperationInspection;
  intent: unknown;
  existing: TemplateOperationRecord | null;
  affectedParts: string[];
  migrationFacets: string[];
  persist(record: TemplateOperationRecord): Promise<void>;
}): Promise<{ record: TemplateOperationRecord; resumed: boolean }> {
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
  if (input.existing) {
    return { record: input.existing, resumed: true };
  }
  const record: TemplateOperationRecord = {
    version: 1,
    operationId: input.operationId,
    kind: input.inspection.kind,
    fingerprint: input.inspection.plan.fingerprint,
    intent: input.intent,
    pins: input.inspection.plan.nodes.map((node) => node.pin as WorkspaceTemplatePin),
    affectedParts: input.affectedParts,
    ...(input.migrationFacets.length > 0 ? { migrationFacets: input.migrationFacets } : {}),
  };
  await input.persist(record);
  return { record, resumed: false };
}
