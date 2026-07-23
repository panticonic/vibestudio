import type { PanelAccessOperation, PanelAccessTarget } from "@vibestudio/shared/panelAccessPolicy";
import {
  isOpenPanelOperation,
  panelAccessSeverityForTarget,
} from "@vibestudio/shared/panelAccessPolicy";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { PreparedAuthoritySelection } from "@vibestudio/shared/serviceDefinition";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { callerHasAppCapability } from "./chromeTrust.js";
import { prepareContextBoundarySelection, type ContextBoundaryDeps } from "./contextBoundary.js";

export interface PanelAccessPermissionTarget extends PanelAccessTarget {
  title?: string;
  source?: string;
  kind?: "workspace" | "browser" | string;
  runtimeEntityId?: string;
  /** The target panel's CURRENT context (bridge metadata populates this). */
  contextId?: string;
  requestedSource?: string;
  /** The DESTINATION context for context-changing ops (create / navigate). */
  requestedContextId?: string;
  operationGroupKey?: string;
}

export interface PanelAccessPermissionDeps extends ContextBoundaryDeps {
  /** Resolve a (subject) principal's own context — durable, async. */
  resolveCallerContext(callerId: string): Promise<string | null>;
  /** Resolve a target/anchor entity's context — sync (active cache). */
  resolveEntityContext(entityId: string): string | null;
  /**
   * Build a code-identity subject caller from an anchor entity id (for
   * host-mediated `server`/`shell` calls whose true initiator is that entity).
   * Returns null when the anchor has no resolvable code identity.
   */
  resolveSubjectCaller(entityId: string): VerifiedCaller | null;
  hasAppCapability?(callerId: string, capability: AppCapability): boolean;
  /** Used by panelTreeService.targetForCreate to resolve a panel caller's own slot. */
  resolveRequesterPanel?(caller: VerifiedCaller): Promise<PanelAccessPermissionTarget | null>;
  /** Retained for wiring compatibility; the context-boundary gate no longer reads it. */
  hasApprovalSession?(): boolean;
}

/** Ops that change a panel's context (gate against the DESTINATION, not the current, context). */
function isContextChangingOp(op: PanelAccessOperation): boolean {
  return op === "openPanel" || op === "replacePanel";
}

/** The entity whose authority a host-mediated action runs under (its true initiator). */
function anchorEntityId(target: PanelAccessPermissionTarget): string | null {
  // For create, the target IS the parent panel (targetForCreate returns it); for
  // operate-on-existing it is the target panel. Either way its runtime entity is
  // the subject. Workspace-root / unresolved targets have none.
  return target.runtimeEntityId ?? null;
}

function destinationContextId(
  deps: PanelAccessPermissionDeps,
  op: PanelAccessOperation,
  target: PanelAccessPermissionTarget
): string | null {
  if (isContextChangingOp(op)) {
    // create: requestedContextId = options.contextId (absent ⇒ fresh ⇒ free).
    // navigate/navigateHistory: requestedContextId = the pre-resolved destination
    // context (absent ⇒ no context change ⇒ free).
    return target.requestedContextId ?? null;
  }
  // operate-on-existing: act on the target panel's current context.
  return (
    target.contextId ??
    (target.runtimeEntityId ? deps.resolveEntityContext(target.runtimeEntityId) : null)
  );
}

function verbFor(op: PanelAccessOperation): string {
  switch (op) {
    case "openPanel":
      return "Open panel in";
    case "navigate":
    case "replacePanel":
      return "Navigate panel in";
    case "cdp":
      return "Automate panel in";
    case "reload":
      return "Reload panel in";
    case "close":
    case "archive":
      return "Close panel in";
    case "unload":
      return "Unload panel in";
    case "movePanel":
      return "Move panel in";
    case "takeOver":
      return "Take over panel in";
    case "openDevTools":
      return "Open DevTools in";
    case "rebuildPanel":
    case "rebuildAndReload":
      return "Rebuild panel in";
    case "updatePanelState":
    case "stateArgs.set":
      return "Change panel state in";
    default:
      return "Act on";
  }
}

/** Side-effect-free panel target selection for dispatcher authority preparation. */
export async function preparePanelAccessAuthority(
  deps: PanelAccessPermissionDeps,
  ctx: ServiceContext,
  op: PanelAccessOperation,
  target: PanelAccessPermissionTarget
): Promise<PreparedAuthoritySelection[]> {
  if (isOpenPanelOperation(op) || callerHasAppCapability(ctx.caller, "panel-hosting", deps)) {
    return [];
  }
  const isAgentCaller = ctx.caller.runtime.kind === "agent";
  let subjectCaller = ctx.caller;
  if (!ctx.caller.code && !isAgentCaller) {
    const anchorId = anchorEntityId(target);
    const anchor = anchorId ? deps.resolveSubjectCaller(anchorId) : null;
    if (!anchor) return [];
    subjectCaller = anchor;
  }
  const targetContextId = destinationContextId(deps, op, target);
  if (targetContextId == null) return [];
  const originContextId = isAgentCaller
    ? (ctx.caller.agentBinding?.contextId ?? null)
    : await deps.resolveCallerContext(subjectCaller.runtime.id);
  const severity = panelAccessSeverityForTarget(target);
  const selection = prepareContextBoundarySelection(deps, {
    subjectCaller,
    originContextId,
    targetContextId,
    action: {
      kind: "panel",
      verb: verbFor(op),
      targetLabel: target.title ?? target.id,
      severity,
      ...(target.operationGroupKey ? { groupKey: target.operationGroupKey } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    },
  });
  return selection ? [{ ...selection, tier: severity === "severe" ? "critical" : "gated" }] : [];
}
