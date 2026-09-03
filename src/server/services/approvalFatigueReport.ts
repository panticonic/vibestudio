import { createHash } from "node:crypto";
import { canonicalJson } from "@vibestudio/shared/canonicalJson";
import type { ApprovalProvenanceRecord } from "@vibestudio/shared/governance/types";

export type ApprovalRepeatReason =
  | "none"
  | "new-source"
  | "new-resource"
  | "new-actor"
  | "changed-effect"
  | "restart-undecided"
  | "duplicate";

export interface ApprovalSurfaceRecord {
  operationId: string;
  taskSubject: string;
  securityIdentity: string;
  decisionId: string;
  semanticFamily: string;
  resource: string;
  sourcesShown: readonly string[];
  title: string;
  description: string;
  rows: readonly string[];
  repeatReason: ApprovalRepeatReason;
  fallbackRoute?: string;
}

export interface ApprovalFatigueReport {
  promptsPerTask: Record<string, number>;
  promptsPerRule: Record<string, number>;
  identicalVisibleRepeats: Array<{
    taskSubject: string;
    decisionId: string;
    previousDecisionId: string;
    reason: ApprovalRepeatReason;
  }>;
  fallbackRoutes: Record<string, number>;
}

export function approvalVisibleCardDigest(
  record: Pick<ApprovalSurfaceRecord, "title" | "description" | "rows">
): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        title: record.title,
        description: record.description,
        rows: [...record.rows],
      })
    )
    .digest("hex");
}

export function buildApprovalFatigueReport(
  records: readonly ApprovalSurfaceRecord[]
): ApprovalFatigueReport {
  const promptsPerTask: Record<string, number> = {};
  const promptsPerRule: Record<string, number> = {};
  const fallbackRoutes: Record<string, number> = {};
  const identicalVisibleRepeats: ApprovalFatigueReport["identicalVisibleRepeats"] = [];
  const lastVisible = new Map<string, { decisionId: string; digest: string }>();

  for (const record of records) {
    promptsPerTask[record.taskSubject] = (promptsPerTask[record.taskSubject] ?? 0) + 1;
    const ruleKey = canonicalJson({
      taskSubject: record.taskSubject,
      semanticFamily: record.semanticFamily,
      resource: record.resource,
      sourcesShown: [...record.sourcesShown].sort(),
    });
    promptsPerRule[ruleKey] = (promptsPerRule[ruleKey] ?? 0) + 1;
    if (record.fallbackRoute) {
      fallbackRoutes[record.fallbackRoute] = (fallbackRoutes[record.fallbackRoute] ?? 0) + 1;
    }
    const digest = approvalVisibleCardDigest(record);
    const visibleKey = `${record.taskSubject}\0${record.securityIdentity}\0${digest}`;
    const previous = lastVisible.get(visibleKey);
    if (previous?.digest === digest) {
      identicalVisibleRepeats.push({
        taskSubject: record.taskSubject,
        decisionId: record.decisionId,
        previousDecisionId: previous.decisionId,
        reason: record.repeatReason,
      });
    }
    lastVisible.set(visibleKey, { decisionId: record.decisionId, digest });
  }

  return { promptsPerTask, promptsPerRule, identicalVisibleRepeats, fallbackRoutes };
}

/** Build the production fatigue input directly from the durable decision
 * records written by ApprovalQueue. Each record contains its own causal and
 * visible facts, so this projection never correlates by timestamp. */
export function approvalSurfaceRecordsFromGovernance(
  records: readonly ApprovalProvenanceRecord[]
): ApprovalSurfaceRecord[] {
  return records.flatMap((record) => {
    if (
      !record.operationId ||
      !record.taskSubject ||
      !record.securityIdentity ||
      !record.semanticFamily ||
      !record.surface
    ) {
      return [];
    }
    return [
      {
        operationId: record.operationId,
        taskSubject: record.taskSubject,
        securityIdentity: record.securityIdentity,
        decisionId: record.approvalId,
        semanticFamily: record.semanticFamily,
        resource: record.resource?.value ?? record.resource?.key ?? "",
        sourcesShown: record.sourcesShown ?? [],
        title: record.surface.title,
        description: record.surface.description,
        rows: record.surface.rows,
        repeatReason: record.repeatReason ?? "none",
      },
    ];
  });
}
