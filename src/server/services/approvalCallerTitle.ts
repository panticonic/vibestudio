import type { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityKind, EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import type {
  ApprovalRequesterBreadcrumb,
  ApprovalRequesterCategory,
  ApprovalRequesterIdentity,
  ApprovalRequesterKind,
} from "@vibestudio/shared/approvals";

export interface ApprovalCallerTitleDeps {
  entityCache: Pick<EntityCache, "resolve">;
  getTitle(entityId: string): string | undefined;
}

export interface ApprovalRequesterInput {
  callerId: string;
  callerKind: ApprovalRequesterKind;
  repoPath: string;
  effectiveVersion: string;
  requesterCategory?: ApprovalRequesterCategory;
  eval?: ApprovalRequesterIdentity["eval"];
}

function cleanTitle(title: string | undefined): string | undefined {
  const normalized = title?.trim();
  return normalized || undefined;
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function shortRuntimeId(id: string): string {
  const stripped = id.replace(/^(do-service:|do:|worker:|panel:|app:|session:)/, "");
  const parts = stripped.split(":").filter(Boolean);
  return parts[parts.length - 1] ?? stripped;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function entityKindToRequesterKind(kind: EntityKind): ApprovalRequesterBreadcrumb["kind"] {
  if (
    kind === "panel" ||
    kind === "app" ||
    kind === "worker" ||
    kind === "do" ||
    kind === "session" ||
    kind === "shell" ||
    kind === "server"
  ) {
    return kind;
  }
  return "server";
}

function isEvalRecord(record: EntityRecord | null | undefined): boolean {
  return (
    record?.kind === "do" &&
    record.className === "EvalDO" &&
    (record.source.repoPath === "vibestudio/internal" || record.id.includes(":EvalDO:"))
  );
}

function isAgentRecord(record: EntityRecord | null | undefined): boolean {
  if (!record || record.kind !== "do") return false;
  return /agent/i.test(record.className ?? "") || /agent/i.test(record.source.repoPath);
}

function categoryForRecord(
  record: EntityRecord | null | undefined,
  fallbackKind: ApprovalRequesterKind,
  override?: ApprovalRequesterCategory
): ApprovalRequesterCategory {
  if (override) return override;
  if (fallbackKind === "system") return "system";
  if (!record) {
    if (fallbackKind === "panel") return "panel";
    if (fallbackKind === "app") return "workspace-app";
    if (fallbackKind === "worker") return "worker";
    if (fallbackKind === "do") return "durable-object";
    return "unknown";
  }
  if (isEvalRecord(record)) return "eval";
  if (isAgentRecord(record)) return "agent";
  switch (record.kind) {
    case "panel":
      return "panel";
    case "app":
      return "workspace-app";
    case "worker":
      return "worker";
    case "do":
      return record.source.repoPath === "vibestudio/internal"
        ? "internal-service"
        : "durable-object";
    case "shell":
    case "server":
      return "system";
    case "session":
      return "unknown";
  }
}

function evalMeta(record: EntityRecord | null | undefined): ApprovalRequesterIdentity["eval"] {
  if (!isEvalRecord(record)) return undefined;
  const stateArgs = asRecord(record?.stateArgs);
  const ownerId =
    typeof stateArgs?.["ownerPrincipalId"] === "string"
      ? String(stateArgs["ownerPrincipalId"])
      : undefined;
  const subKey =
    typeof stateArgs?.["subKey"] === "string" ? String(stateArgs["subKey"]) : undefined;
  return {
    ...(ownerId ? { ownerId } : {}),
    ...(subKey ? { subKey } : {}),
  };
}

function fallbackLabel(record: EntityRecord | null | undefined, id: string): string {
  if (!record) return shortRuntimeId(id);
  if (isEvalRecord(record)) {
    const meta = evalMeta(record);
    return meta?.subKey && meta.subKey !== "default" ? `Eval ${meta.subKey}` : "Eval sandbox";
  }
  const sourceName = basename(record.source.repoPath);
  if (sourceName) return sourceName;
  return shortRuntimeId(id);
}

function collectLineage(deps: ApprovalCallerTitleDeps, callerId: string): EntityRecord[] {
  const lineage: EntityRecord[] = [];
  const seen = new Set<string>();
  let current: string | undefined = callerId;
  while (current && !seen.has(current)) {
    seen.add(current);
    const record = deps.entityCache.resolve(current);
    if (!record) break;
    lineage.push(record);
    current = record.parentId;
  }
  return lineage;
}

function findOwningPanel(lineage: EntityRecord[]): EntityRecord | undefined {
  return lineage.find((record) => record.kind === "panel");
}

function breadcrumbForRecord(
  deps: ApprovalCallerTitleDeps,
  record: EntityRecord,
  callerId: string,
  callerCategoryOverride?: ApprovalRequesterCategory
): ApprovalRequesterBreadcrumb {
  const category = categoryForRecord(
    record,
    record.kind === "panel" ||
      record.kind === "app" ||
      record.kind === "worker" ||
      record.kind === "do"
      ? record.kind
      : "system",
    record.id === callerId ? callerCategoryOverride : undefined
  );
  const label = cleanTitle(deps.getTitle(record.id)) ?? fallbackLabel(record, record.id);
  return {
    id: record.id,
    kind: entityKindToRequesterKind(record.kind),
    category,
    label,
    sourcePath: record.source.repoPath,
  };
}

export function resolveApprovalRequester(
  deps: ApprovalCallerTitleDeps,
  input: ApprovalRequesterInput
): ApprovalRequesterIdentity {
  const callerRecord = deps.entityCache.resolve(input.callerId);
  const lineage = collectLineage(deps, input.callerId);
  const panel = findOwningPanel(lineage);
  const panelTitle = panel ? cleanTitle(deps.getTitle(panel.id)) : undefined;
  const directTitle = cleanTitle(deps.getTitle(input.callerId));
  const category = categoryForRecord(callerRecord, input.callerKind, input.requesterCategory);
  const sourcePath = callerRecord?.source.repoPath ?? input.repoPath;
  const effectiveVersion = callerRecord?.source.effectiveVersion ?? input.effectiveVersion;
  const title =
    (input.callerKind === "worker" || input.callerKind === "do"
      ? (panelTitle ?? directTitle)
      : (directTitle ?? panelTitle)) ?? fallbackLabel(callerRecord, input.callerId);
  const evalIdentity = input.eval ?? evalMeta(callerRecord);
  const internalIdentity =
    effectiveVersion === "internal" || sourcePath === "vibestudio/internal" || category === "eval";
  const breadcrumbs =
    lineage.length > 0
      ? lineage
          .slice()
          .reverse()
          .map((record) =>
            breadcrumbForRecord(deps, record, input.callerId, input.requesterCategory)
          )
      : [
          {
            id: input.callerId,
            kind: input.callerKind,
            category,
            label: title,
            sourcePath,
          },
        ];
  return {
    id: input.callerId,
    kind: input.callerKind,
    category,
    title,
    ...(panel
      ? {
          panel: {
            id: panel.id,
            ...(panelTitle ? { title: panelTitle } : {}),
          },
        }
      : {}),
    sourcePath,
    repoPath: input.repoPath,
    effectiveVersion,
    ...(callerRecord?.contextId ? { contextId: callerRecord.contextId } : {}),
    stableIdentityKey: internalIdentity
      ? (evalIdentity?.ownerId ?? input.callerId)
      : `${input.repoPath}@${input.effectiveVersion}`,
    ephemeralInstanceKey: input.callerId,
    ...(evalIdentity ? { eval: evalIdentity } : {}),
    breadcrumbs,
  };
}

/**
 * Approval cards should lead with the visible panel a user can recognize.
 * Worker/DO/eval callers often have opaque runtime ids; their entity parent
 * chain points back to the owning panel, whose title is the better headline.
 */
export function resolveApprovalCallerTitle(
  deps: ApprovalCallerTitleDeps,
  callerId: string
): string | undefined {
  const record = deps.entityCache.resolve(callerId);
  return resolveApprovalRequester(deps, {
    callerId,
    callerKind:
      record?.kind === "panel" ||
      record?.kind === "app" ||
      record?.kind === "worker" ||
      record?.kind === "do"
        ? record.kind
        : "system",
    repoPath: record?.source.repoPath ?? "",
    effectiveVersion: record?.source.effectiveVersion ?? "",
  }).title;
}
