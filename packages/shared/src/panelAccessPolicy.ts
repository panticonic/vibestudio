import type { CallerKind } from "./serviceDispatcher.js";

export const PANEL_AUTOMATE_CAPABILITY = "panel.automate" as const;
export const PANEL_STRUCTURAL_CAPABILITY = "panel.structural" as const;

export type PanelAccessCapability =
  | typeof PANEL_AUTOMATE_CAPABILITY
  | typeof PANEL_STRUCTURAL_CAPABILITY;

export type PanelAccessSeverity = "standard" | "severe";

export type PanelAccessOperation =
  | "read"
  | "metadata"
  | "ensureLoaded"
  | "focus"
  | "rpc.call"
  | "rpc.emit"
  | "rpc.on"
  | "cdp"
  | "navigate"
  | "reload"
  | "goBack"
  | "goForward"
  | "stop"
  | "openPanel"
  | "archive"
  | "close"
  | "unload"
  | "movePanel"
  | "takeOver"
  | "openDevTools"
  | "rebuildPanel"
  | "updatePanelState"
  | "stateArgs.set";

export interface PanelAccessRequester {
  id: string;
  kind: CallerKind | string;
  /**
   * True when the caller is itself a privileged shell/about panel. Servers
   * resolve this from the caller runtime id before calling accessDecision.
   */
  privileged?: boolean;
}

export interface PanelAccessTarget {
  id: string;
  /** Preferred privilege flag copied from PanelSnapshot. */
  privileged?: boolean;
  /** Compatibility with manifest/snapshot data that still names this shell. */
  shell?: boolean;
}

export interface PanelAccessDecision {
  allow: boolean;
  capability?: PanelAccessCapability;
  severity?: PanelAccessSeverity;
}

const openOperations = new Set<PanelAccessOperation>([
  "read",
  "metadata",
  "ensureLoaded",
  "focus",
  "rpc.call",
  "rpc.emit",
  "rpc.on",
]);

const automateOperations = new Set<PanelAccessOperation>([
  "cdp",
  "navigate",
  "reload",
  "goBack",
  "goForward",
  "stop",
]);

const structuralOperations = new Set<PanelAccessOperation>([
  "openPanel",
  "archive",
  "close",
  "unload",
  "movePanel",
  "takeOver",
  "openDevTools",
  "rebuildPanel",
  "updatePanelState",
  "stateArgs.set",
]);

export function panelAccessCapabilityForOperation(
  op: PanelAccessOperation
): PanelAccessCapability | null {
  if (openOperations.has(op)) return null;
  if (automateOperations.has(op)) return PANEL_AUTOMATE_CAPABILITY;
  if (structuralOperations.has(op)) return PANEL_STRUCTURAL_CAPABILITY;
  return PANEL_STRUCTURAL_CAPABILITY;
}

export function panelAccessSeverityForTarget(target: PanelAccessTarget): PanelAccessSeverity {
  return target.privileged === true || target.shell === true ? "severe" : "standard";
}

export function isTrustedPanelAccessRequester(requester: PanelAccessRequester): boolean {
  return (
    requester.kind === "shell" ||
    requester.kind === "shell-remote" ||
    requester.kind === "server" ||
    requester.privileged === true
  );
}

export function accessDecision(
  op: PanelAccessOperation,
  requester: PanelAccessRequester,
  target: PanelAccessTarget
): PanelAccessDecision {
  if (isTrustedPanelAccessRequester(requester)) {
    return { allow: true };
  }

  const capability = panelAccessCapabilityForOperation(op);
  if (capability === null) {
    return { allow: true };
  }

  return {
    allow: true,
    capability,
    severity: panelAccessSeverityForTarget(target),
  };
}
