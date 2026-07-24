import type { AuthorityGrant } from "@vibestudio/rpc";
import type { PendingMissionReviewApproval } from "@vibestudio/shared/approvals";
import { authorityRow, type AuthorityRow } from "@vibestudio/shared/authority/authorityRows";
import { diffAuthorityRows } from "@vibestudio/shared/authority/authorityRowDiff";
import type {
  MissionCharter,
  MissionPermission,
  MissionRecord,
} from "@vibestudio/shared/authority/mission";
import type { CapabilityPresentationResolver } from "@vibestudio/shared/authorityPresentation";

export function missionReviewPresentation(input: {
  mission: MissionRecord;
  previous: MissionRecord | null;
  profileGrants: readonly AuthorityGrant[];
  describeCapability: CapabilityPresentationResolver;
  reviewKind?: PendingMissionReviewApproval["reviewKind"];
  blockedAt?: number;
}): Pick<
  PendingMissionReviewApproval,
  | "reviewKind"
  | "title"
  | "taskSummary"
  | "triggerSummary"
  | "authority"
  | "toolkitDomains"
  | "networkSummary"
  | "lineageSummary"
  | "charter"
  | "charterChanges"
  | "blockedAt"
> {
  const proposedRows = permissionRows(
    input.mission.permissions,
    input.describeCapability,
    "snapshot"
  );
  const profileRows = input.profileGrants
    .filter(
      (grant) =>
        grant.effect === "allow" &&
        grant.subject === `agent:${input.mission.charter.agentBindingId}` &&
        grant.revokedAt === undefined &&
        grant.consumedAt === undefined &&
        grant.suspendedAt === undefined
    )
    .map((grant) =>
      projectRow(
        {
          capability: grant.capability,
          resource: grant.resource,
          tier: "gated",
        },
        input.describeCapability,
        "allowed",
        {
          source: "profile",
          decidedAt: grant.createdAt,
          decidedBy: grant.issuedBy,
          lineageClasses: grant.constraints?.lineageAtConsent,
        }
      )
    );
  const comparisonRows = input.previous
    ? permissionRows(input.previous.permissions, input.describeCapability, "snapshot")
    : profileRows;
  const toolkitDomains = [
    ...new Set(proposedRows.map((row) => row.domain).filter((domain) => domain !== "safety")),
  ];
  return {
    reviewKind:
      input.reviewKind ?? (input.mission.revision === 1 && !input.previous ? "draft" : "revision"),
    title: input.mission.name,
    taskSummary: input.mission.charter.taskSpec,
    triggerSummary: triggerSummary(input.mission.charter),
    authority: {
      rows: proposedRows,
      diff: diffAuthorityRows(comparisonRows, proposedRows),
    },
    toolkitDomains,
    networkSummary: networkSummary(input.mission.charter),
    lineageSummary: lineageSummary(input.mission.charter),
    charter: input.mission.charter,
    charterChanges: charterChanges(input.previous?.charter ?? null, input.mission.charter),
    ...(input.blockedAt === undefined ? {} : { blockedAt: input.blockedAt }),
  };
}

function permissionRows(
  permissions: readonly MissionPermission[],
  describeCapability: CapabilityPresentationResolver,
  statement: AuthorityRow["statement"]
): AuthorityRow[] {
  return permissions.map((permission) =>
    projectRow(permission, describeCapability, statement, {
      source: "mission",
    })
  );
}

function projectRow(
  permission: MissionPermission,
  describeCapability: CapabilityPresentationResolver,
  statement: AuthorityRow["statement"],
  provenance: AuthorityRow["provenance"]
): AuthorityRow {
  const presentation = describeCapability(permission.capability, "agent-heartbeat");
  return authorityRow({
    capability: permission.capability,
    resource: permission.resource,
    tier: permission.tier,
    statement,
    provenance,
    ...(presentation.authorityCategory
      ? {
          category: presentation.authorityCategory,
          reviewedAction: presentation.action,
        }
      : {}),
  });
}

function triggerSummary(charter: MissionCharter): string {
  if (charter.trigger.kind === "manual") return "When you run it";
  if (charter.trigger.kind === "event") {
    return `When ${charter.trigger.event.source.replace(/[.-]+/gu, " ")} happens`;
  }
  return describeCron(charter.trigger.cron);
}

function describeCron(cron: string): string {
  const fields = cron.trim().split(/\s+/u);
  if (fields.length === 5 && fields[2] === "*" && fields[3] === "*" && fields[4] === "*") {
    const minute = Number(fields[0]);
    const hour = Number(fields[1]);
    if (
      Number.isInteger(minute) &&
      minute >= 0 &&
      minute < 60 &&
      Number.isInteger(hour) &&
      hour >= 0 &&
      hour < 24
    ) {
      return `Every day at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    }
  }
  return "On its reviewed schedule";
}

function networkSummary(charter: MissionCharter): string {
  if (charter.toolExposure.evalNetwork === "none") return "No websites";
  if (charter.toolExposure.evalNetwork === "unrestricted") return "Any website";
  return charter.toolExposure.declaredOrigins.join(", ");
}

function lineageSummary(charter: MissionCharter): string {
  const labels: Record<MissionCharter["declaredLineageClasses"][number], string> = {
    none: "your workspace and its own work",
    web: "websites",
    email: "email",
    "channel-external": "shared conversations",
    external: "other outside content",
  };
  return charter.declaredLineageClasses.map((lineage) => labels[lineage]).join(", ");
}

function charterChanges(
  before: MissionCharter | null,
  after: MissionCharter
): PendingMissionReviewApproval["charterChanges"] {
  if (!before) return [];
  const changes: PendingMissionReviewApproval["charterChanges"] = [];
  const add = (
    field: PendingMissionReviewApproval["charterChanges"][number]["field"],
    oldValue: string,
    newValue: string,
    widening: boolean
  ) => {
    if (oldValue !== newValue) changes.push({ field, before: oldValue, after: newValue, widening });
  };
  add("task", before.taskSpec, after.taskSpec, false);
  add("schedule", triggerSummary(before), triggerSummary(after), false);
  const oldServices = [...before.toolExposure.services].sort().join(", ");
  const newServices = [...after.toolExposure.services].sort().join(", ");
  add(
    "toolkit",
    oldServices || "No host tools",
    newServices || "No host tools",
    after.toolExposure.services.some((service) => !before.toolExposure.services.includes(service))
  );
  add(
    "network",
    networkSummary(before),
    networkSummary(after),
    networkRank(after) > networkRank(before) ||
      after.toolExposure.declaredOrigins.some(
        (origin) => !before.toolExposure.declaredOrigins.includes(origin)
      )
  );
  add(
    "data-flow",
    lineageSummary(before),
    lineageSummary(after),
    after.declaredLineageClasses.some((lineage) => !before.declaredLineageClasses.includes(lineage))
  );
  add("model", before.model.modelId, after.model.modelId, false);
  return changes;
}

function networkRank(charter: MissionCharter): number {
  return charter.toolExposure.evalNetwork === "none"
    ? 0
    : charter.toolExposure.evalNetwork === "declared-origins"
      ? 1
      : 2;
}
