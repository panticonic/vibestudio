import type { PanelAccessOperation, PanelAccessTarget } from "@vibestudio/shared/panelAccessPolicy";
import {
  isOpenPanelOperation,
  panelAccessSeverityForTarget,
} from "@vibestudio/shared/panelAccessPolicy";
import type { ServiceContext, VerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { AppCapability } from "@vibestudio/shared/unitManifest";
import { callerHasAppCapability } from "./chromeTrust.js";
import { requireContextBoundaryPermission, type ContextBoundaryDeps } from "./contextBoundary.js";

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

export interface PanelAccessPermissionResult {
  allowed: boolean;
  capability?: string;
  prompted?: boolean;
  reason?: string;
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

/**
 * The single context-boundary gate for panel control-plane operations. Prompts
 * iff the action targets another, already-existing context. The prompt is
 * attributed to a code-identity SUBJECT — the direct userland caller, or (for a
 * host-mediated `server`/`shell` call) the host-set anchor entity — never the
 * host itself. Same-context, fresh-context, and open (read) ops are free.
 */
export async function requirePanelAccessPermission(
  deps: PanelAccessPermissionDeps,
  ctx: ServiceContext,
  op: PanelAccessOperation,
  target: PanelAccessPermissionTarget
): Promise<PanelAccessPermissionResult> {
  if (isOpenPanelOperation(op)) return { allowed: true };
  if (callerHasAppCapability(ctx.caller, "panel-hosting", deps)) {
    return { allowed: true };
  }

  // Resolve the subject. A direct userland caller carries `.code`; an `agent`
  // caller (linked external session) carries a host-verified entity binding and
  // is its own subject — it must NOT fall into the anchor branch below, which
  // would substitute the TARGET panel's entity and make every access read as
  // same-context. A host-mediated call arrives as `server`/`shell` (no code
  // identity) and runs under the host-set anchor entity instead. No code
  // identity AND no resolvable anchor ⇒ a genuine system action ⇒ free.
  const isAgentCaller = ctx.caller.runtime.kind === "agent";
  let subjectCaller: VerifiedCaller = ctx.caller;
  if (!ctx.caller.code && !isAgentCaller) {
    const anchorId = anchorEntityId(target);
    const anchor = anchorId ? deps.resolveSubjectCaller(anchorId) : null;
    if (!anchor) return { allowed: true };
    subjectCaller = anchor;
  }

  const targetContextId = destinationContextId(deps, op, target);
  if (targetContextId == null) return { allowed: true }; // fresh / no-change / unknown

  // Agent callers: same-context (per the host-verified credential binding) is
  // free; cross-context is DENY-not-prompt — the capability-approval pipeline
  // is code-identity-shaped (grants key on repoPath/version), which an agent
  // credential does not carry, and the correct agent workflow is to open its
  // own preview panel in its own context rather than automate another
  // context's live panel. The structured reason tells the agent exactly that.
  if (isAgentCaller) {
    const agentContextId = ctx.caller.agentBinding?.contextId ?? null;
    if (agentContextId !== null && targetContextId === agentContextId) {
      return { allowed: true };
    }
    if (!deps.contextExists(targetContextId)) return { allowed: true };
    return {
      allowed: false,
      reason:
        `${verbFor(op)} ${targetContextId} denied: agents may only automate panels in ` +
        `their own context (${agentContextId ?? "unbound"}). Open a preview instance in ` +
        `your context instead (eval: openPanel(source, { contextId }) ), or ask a user ` +
        `in the conversation to act on the foreign panel.`,
    };
  }

  const originContextId = await deps.resolveCallerContext(subjectCaller.runtime.id);

  const result = await requireContextBoundaryPermission(deps, {
    subjectCaller,
    originContextId,
    targetContextId,
    action: {
      kind: "panel",
      verb: verbFor(op),
      targetLabel: target.title ?? target.id,
      severity: panelAccessSeverityForTarget(target),
      ...(target.operationGroupKey ? { groupKey: target.operationGroupKey } : {}),
    },
  });

  return {
    allowed: result.allowed,
    ...(result.reason ? { reason: result.reason } : {}),
    ...(result.decision !== undefined ? { prompted: true } : {}),
  };
}
