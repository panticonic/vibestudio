import type { PendingCapabilityApproval } from "@vibestudio/shared/approvals";
import type { PreparedAuthoritySelection } from "@vibestudio/shared/serviceDefinition";
import type {
  AuthorityChallengePresentation,
  VerifiedCaller,
} from "@vibestudio/shared/serviceDispatcher";

/**
 * The single context-isolation capability. A control-plane action (launch a
 * panel/worker/DO, retire one, drive/close/navigate a panel) is gated by this
 * capability iff it targets a context that is NOT the caller's own AND that
 * context already exists (holds state). Same-context and fresh-foreign actions
 * are free. This replaces the former `panel.structural` / `panel.automate` /
 * `workerd.lifecycle` / `runtime.crossContextEntity` capabilities.
 */
export const CONTEXT_BOUNDARY_CAPABILITY = "context.boundary" as const;

/** Grant key: one approval covers a (subject, target-context) pair. */
export function contextBoundaryResourceKey(targetContextId: string, subjectId: string): string {
  return `context/${encodeURIComponent(targetContextId)}/requester/${encodeURIComponent(subjectId)}`;
}

export interface ContextBoundaryDeps {
  /** True when the target context already holds state (active entity OR a materialized folder). */
  contextExists(contextId: string): boolean;
  /** Human label for the entity owning the target context, for prompt copy. */
  resolveContextOwnerLabel?(contextId: string): string | undefined;
}

export interface ContextBoundaryAction {
  /** Approval operation kind (matches existing approvalCopy switch values). */
  kind: "runtime" | "panel" | "worker-lifecycle";
  /** Verb shown in the prompt, e.g. "Create panel", "Close", "Navigate", "Destroy". */
  verb: string;
  /** Optional subject/source label (e.g. the panel source) for the details list. */
  targetLabel?: string;
  /** Optional label for targetLabel in the details list. */
  targetLabelName?: string;
  severity?: PendingCapabilityApproval["severity"];
  /** Coalesce duplicate prompts for the same logical operation. */
  groupKey?: string;
  signal?: AbortSignal;
}

export interface ContextBoundaryRequest {
  /**
   * Identity the prepared authority leaf is attributed to. Callers resolve a
   * concrete acting entity (or the host-set anchor entity) before dispatch so
   * the unified evaluator can bind the prompt and grant to its sealed origin.
   */
  subjectCaller: VerifiedCaller;
  /** The acting/origin context. `null` => no usable origin (treated as foreign). */
  originContextId: string | null;
  /** The context being launched into / acted upon. */
  targetContextId: string;
  action: ContextBoundaryAction;
}

export type PreparedContextBoundarySelection = PreparedAuthoritySelection & {
  capability: typeof CONTEXT_BOUNDARY_CAPABILITY;
  challenge: AuthorityChallengePresentation;
};

function cleanActionLabel(verb: string): string {
  return verb.replace(/\s+in$/i, "").trim();
}

function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value.charAt(0).toLowerCase()}${value.slice(1)}`;
}

function contextDescription(
  ownerLabel: string | undefined,
  targetContextId: string,
  _focus: "file-access" | "existing-state"
): string {
  return ownerLabel
    ? `the workspace branch owned by ${ownerLabel}`
    : `workspace branch ${targetContextId}`;
}

function genericActionLabel(actionLabel: string): string {
  switch (actionLabel) {
    case "Create do":
    case "Create worker":
      return "Launch a background process";
    case "Create panel":
    case "Open panel":
      return "Open a panel";
    case "Navigate panel":
      return "Navigate a panel";
    case "Create app":
      return "Launch an app";
    case "Create session":
      return "Start a session";
    default:
      return actionLabel;
  }
}

function accessTitle(actionLabel: string): string | null {
  switch (actionLabel) {
    case "Create do":
    case "Create worker":
      return "Launch background process in another workspace branch";
    case "Create panel":
    case "Open panel":
      return "Open panel in another workspace branch";
    case "Navigate panel":
      return "Switch panel to another workspace branch";
    case "Create app":
      return "Launch app in another workspace branch";
    case "Create session":
      return "Start session in another workspace branch";
    default:
      return null;
  }
}

function accessDescription(actionLabel: string, target: string): string | null {
  switch (actionLabel) {
    case "Create do":
    case "Create worker":
      return `This lets the requester start a background process in ${target}. It can read or modify the workspace state and running work in that branch.`;
    case "Create panel":
    case "Open panel":
      return `This lets the requester open a panel in ${target}. It can read or modify the workspace state and running work in that branch.`;
    case "Navigate panel":
      return `This lets the requester switch a panel to ${target}. The panel will then read and modify that branch instead of its current workspace branch.`;
    case "Create app":
      return `This lets the requester launch an app in ${target}. It can read or modify the workspace state and running work in that branch.`;
    case "Create session":
      return `This lets the requester start a session in ${target}. It can read or modify the workspace state and running work in that branch.`;
    default:
      return null;
  }
}

function promptTitle(action: ContextBoundaryAction): string {
  const actionLabel = cleanActionLabel(action.verb);
  const title = accessTitle(actionLabel);
  if (title) return title;
  switch (actionLabel) {
    case "Retire entity":
      return "Retire runtime entity in another context";
    case "Retire entity and remove context":
      return "Retire runtime entity and remove its context";
    case "Destroy context":
      return "Destroy existing context";
    case "Clone context":
      return "Clone existing context";
    case "Set up context":
      return "Set up existing context";
    case "Create subagent context":
      return "Create subagent context";
    default:
      return `${genericActionLabel(actionLabel)} in another context`;
  }
}

function promptDescription(
  action: ContextBoundaryAction,
  ownerLabel: string | undefined,
  targetContextId: string
): string {
  const actionLabel = cleanActionLabel(action.verb);
  const description = accessDescription(
    actionLabel,
    contextDescription(ownerLabel, targetContextId, "file-access")
  );
  if (description) return description;
  const target = contextDescription(ownerLabel, targetContextId, "existing-state");
  switch (actionLabel) {
    case "Retire entity":
      return `This stops a runtime entity in ${target}. That context belongs to another agent or panel. It does not delete worker, panel, or app source files.`;
    case "Retire entity and remove context":
      return `This stops a runtime entity in ${target} and removes that context if no live entity remains. That context belongs to another agent or panel. It does not delete source files.`;
    case "Destroy context":
      return `This retires every runtime entity in ${target} and deletes that context's workspace state. That context belongs to another agent or panel.`;
    case "Clone context":
      return `This copies durable runtime and workspace state from ${target}. That context belongs to another agent or panel.`;
    case "Create subagent context":
      return `This creates a child runtime context from ${target}. That context belongs to another agent or panel.`;
    default:
      return `This lets the requester ${lowerFirst(
        genericActionLabel(actionLabel)
      )} in ${target}. That context may include files or running work owned by another agent or panel.`;
  }
}

function defaultTargetLabelName(action: ContextBoundaryAction): string {
  const actionLabel = cleanActionLabel(action.verb);
  switch (actionLabel) {
    case "Create do":
    case "Create worker":
    case "Create panel":
    case "Open panel":
    case "Navigate panel":
    case "Create app":
    case "Create session":
      return "Source";
    case "Retire entity":
    case "Retire entity and remove context":
      return "Runtime entity";
    case "Clone context":
      return "Source context";
    case "Create subagent context":
      return "Owner entity";
    default:
      return "Target";
  }
}

/**
 * Resolve the complete context-boundary authority leaf from current host state.
 * This function is side-effect free: the dispatcher may call it before a wait
 * and again at the handler boundary to detect ownership/target drift.
 */
export function prepareContextBoundarySelection(
  deps: ContextBoundaryDeps,
  request: ContextBoundaryRequest
): PreparedContextBoundarySelection | null {
  const { subjectCaller, originContextId, targetContextId, action } = request;
  if (originContextId != null && targetContextId === originContextId) return null;
  if (!deps.contextExists(targetContextId)) return null;

  const subjectId = subjectCaller.runtime.id;
  const ownerLabel = deps.resolveContextOwnerLabel?.(targetContextId);
  const target = ownerLabel ?? targetContextId;
  const details: NonNullable<PendingCapabilityApproval["details"]> = [];
  if (ownerLabel) details.push({ label: "Owner", value: ownerLabel });
  details.push({ label: "Workspace branch", value: targetContextId });
  if (action.targetLabel) {
    details.push({
      label: action.targetLabelName ?? defaultTargetLabelName(action),
      value: action.targetLabel,
    });
  }

  return {
    capability: CONTEXT_BOUNDARY_CAPABILITY,
    resourceKey: contextBoundaryResourceKey(targetContextId, subjectId),
    authorizingCaller: subjectCaller,
    challenge: {
      title: promptTitle(action),
      description: promptDescription(action, ownerLabel, targetContextId),
      ...(action.severity ? { severity: action.severity } : {}),
      deniedReason: `${action.verb} denied: ${target} is another existing workspace branch`,
      dedupKey: `context-boundary:${subjectId}:${targetContextId}`,
      resource: { type: "context", label: "Workspace branch", value: target },
      operation: {
        kind: action.kind,
        verb: action.verb,
        object: { type: "context", label: "Workspace branch", value: target },
        ...(action.groupKey ? { groupKey: action.groupKey } : {}),
      },
      details,
      ...(action.signal ? { signal: action.signal } : {}),
    },
  };
}
