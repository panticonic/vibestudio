import type { PanelAccessOperation, PanelAccessTarget } from "@natstack/shared/panelAccessPolicy";
import {
  PANEL_AUTOMATE_CAPABILITY,
  PANEL_STRUCTURAL_CAPABILITY,
  accessDecision,
} from "@natstack/shared/panelAccessPolicy";
import type { ServiceContext, VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { AppCapability } from "@natstack/shared/unitManifest";
import {
  panelCapabilityResourceKey,
  requestCapabilityPermission,
  type CapabilityPermissionDeps,
} from "./capabilityPermission.js";
import { isAuthorizedChrome } from "./chromeTrust.js";

export interface PanelAccessPermissionTarget extends PanelAccessTarget {
  title?: string;
  source?: string;
  kind?: "workspace" | "browser" | string;
  runtimeEntityId?: string;
  requestedSource?: string;
  requestedContextId?: string;
  operationGroupKey?: string;
}

export interface PanelAccessPermissionDeps extends CapabilityPermissionDeps {
  resolveRequesterPanel?(caller: VerifiedCaller): Promise<PanelAccessPermissionTarget | null>;
  hasApprovalSession?(): boolean;
  /** Whether a workspace-app caller holds an authorized activation capability. */
  hasAppCapability?(callerId: string, capability: AppCapability): boolean;
}

export interface PanelAccessPermissionResult {
  allowed: boolean;
  capability?: string;
  prompted?: boolean;
  reason?: string;
}

export async function requirePanelAccessPermission(
  deps: PanelAccessPermissionDeps,
  ctx: ServiceContext,
  op: PanelAccessOperation,
  target: PanelAccessPermissionTarget
): Promise<PanelAccessPermissionResult> {
  const requesterPanel =
    ctx.caller.runtime.kind === "panel" && deps.resolveRequesterPanel
      ? await deps.resolveRequesterPanel(ctx.caller)
      : null;
  if (
    (op === "stateArgs.set" || op === "replacePanel") &&
    isSelfPanelTarget(ctx.caller, target, requesterPanel)
  ) {
    return { allowed: true };
  }
  const authorizedChrome = isAuthorizedChrome(ctx.caller, {
    hasAppCapability: deps.hasAppCapability,
  });
  const decision = accessDecision(
    op,
    {
      id: ctx.caller.runtime.id,
      kind: ctx.caller.runtime.kind,
      privileged:
        requesterPanel?.privileged === true || requesterPanel?.shell === true || authorizedChrome,
    },
    target
  );

  if (!decision.allow) {
    return { allowed: false, reason: "Panel access denied by policy" };
  }
  if (!decision.capability) {
    return { allowed: true };
  }
  const requesterEntityId = ctx.caller.runtime.id;
  const targetLabel = target.title ?? target.id;
  const operationObjectValue =
    op === "openPanel" && target.requestedSource ? target.requestedSource : targetLabel;
  const headlineTarget =
    op === "openPanel" && target.requestedSource ? target.requestedSource : targetLabel;
  const resourceKey = panelCapabilityResourceKey(target.id, requesterEntityId);
  const identity = ctx.caller.code;
  const existingGrant =
    identity && deps.grantStore.hasGrant(decision.capability, resourceKey, identity);
  const impliedByAutomationGrant =
    identity &&
    decision.capability === PANEL_STRUCTURAL_CAPABILITY &&
    deps.grantStore.hasGrant(PANEL_AUTOMATE_CAPABILITY, resourceKey, identity);
  if (existingGrant || impliedByAutomationGrant) {
    return { allowed: true, capability: decision.capability };
  }
  if (!existingGrant && deps.hasApprovalSession && !deps.hasApprovalSession()) {
    return {
      allowed: false,
      capability: decision.capability,
      reason: "No approval-capable shell is connected",
    };
  }
  const result = await requestCapabilityPermission(deps, {
    caller: ctx.caller,
    capability: decision.capability,
    severity: decision.severity,
    resource: {
      type: "panel",
      label: "Panel",
      value: targetLabel,
      key: resourceKey,
    },
    operation: {
      kind: "panel",
      verb: op,
      object: { type: "panel", label: "Panel", value: operationObjectValue },
      ...(target.operationGroupKey ? { groupKey: target.operationGroupKey } : {}),
    },
    title: titleFor(op, headlineTarget, decision.severity),
    description: descriptionFor(op, targetLabel, headlineTarget),
    details: [
      { label: "Operation", value: op },
      { label: "Target panel", value: target.id },
      ...(target.requestedSource
        ? [{ label: "Requested source", value: target.requestedSource }]
        : []),
      ...(target.requestedContextId
        ? [{ label: "Requested context", value: target.requestedContextId }]
        : []),
      ...(target.source ? [{ label: "Source", value: target.source }] : []),
    ],
    deniedReason: `${op} denied for panel ${target.id}`,
  });

  if (!result.allowed) {
    return { allowed: false, capability: decision.capability, reason: result.reason };
  }
  return {
    allowed: true,
    capability: decision.capability,
    prompted: result.decision !== undefined,
  };
}

function isSelfPanelTarget(
  caller: VerifiedCaller,
  target: PanelAccessPermissionTarget,
  requesterPanel: PanelAccessPermissionTarget | null
): boolean {
  if (caller.runtime.kind !== "panel") return false;
  if (target.runtimeEntityId && target.runtimeEntityId === caller.runtime.id) return true;
  if (requesterPanel?.runtimeEntityId && target.runtimeEntityId) {
    return requesterPanel.runtimeEntityId === target.runtimeEntityId;
  }
  return Boolean(requesterPanel?.id && requesterPanel.id === target.id);
}

function titleFor(
  op: PanelAccessOperation,
  targetLabel: string,
  severity: "standard" | "severe" | undefined
): string {
  if (op === "cdp") {
    return severity === "severe" ? `Drive privileged ${targetLabel}` : `Automate ${targetLabel}`;
  }
  if (op === "navigate") return `Navigate ${targetLabel}`;
  if (op === "reload") return `Reload ${targetLabel}`;
  if (op === "openPanel") return `Open ${targetLabel}`;
  if (op === "close" || op === "archive") return `Close ${targetLabel}`;
  if (op === "unload") return `Unload ${targetLabel}`;
  if (op === "movePanel") return `Move ${targetLabel}`;
  if (op === "replacePanel") return `Navigate ${targetLabel}`;
  if (op === "takeOver") return `Take over ${targetLabel}`;
  if (op === "openDevTools") return `Open DevTools for ${targetLabel}`;
  if (op === "rebuildPanel") return `Rebuild ${targetLabel}`;
  if (op === "rebuildAndReload") return `Rebuild and reload ${targetLabel}`;
  if (op === "stateArgs.set" || op === "updatePanelState") return `Change ${targetLabel} state`;
  return `Change ${targetLabel}`;
}

function descriptionFor(
  op: PanelAccessOperation,
  targetLabel: string,
  headlineTarget: string
): string {
  if (op === "cdp") {
    return `Allow this requester to connect to ${targetLabel} over CDP.`;
  }
  if (
    op === "navigate" ||
    op === "reload" ||
    op === "goBack" ||
    op === "goForward" ||
    op === "stop"
  ) {
    return `Allow this requester to drive ${targetLabel}.`;
  }
  if (op === "openPanel") {
    return headlineTarget === targetLabel
      ? `Allow this requester to open a panel under ${targetLabel}.`
      : `Allow this requester to open ${headlineTarget} under ${targetLabel}.`;
  }
  if (op === "close" || op === "archive") {
    return `Allow this requester to close ${targetLabel}.`;
  }
  if (op === "unload") {
    return `Allow this requester to unload ${targetLabel}.`;
  }
  if (op === "movePanel") {
    return `Allow this requester to move ${targetLabel} in the panel tree.`;
  }
  if (op === "replacePanel") {
    return `Allow this requester to navigate ${targetLabel} to another panel source or context.`;
  }
  if (op === "takeOver") {
    return `Allow this requester to take over hosting for ${targetLabel}.`;
  }
  if (op === "openDevTools") {
    return `Allow this requester to open DevTools for ${targetLabel}.`;
  }
  if (op === "rebuildPanel") {
    return `Allow this requester to rebuild ${targetLabel}.`;
  }
  if (op === "rebuildAndReload") {
    return `Allow this requester to rebuild and reload ${targetLabel}.`;
  }
  if (op === "stateArgs.set" || op === "updatePanelState") {
    return `Allow this requester to change state for ${targetLabel}.`;
  }
  return `Allow this requester to change ${targetLabel}.`;
}
