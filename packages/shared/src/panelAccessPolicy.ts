import type { CallerKind } from "./serviceDispatcher.js";

export type PanelAccessSeverity = "standard" | "severe";

export type PanelAccessOperation =
  | "read"
  | "metadata"
  | "ensureLoaded"
  | "focus"
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
  | "replacePanel"
  | "takeOver"
  | "openDevTools"
  | "rebuildPanel"
  | "updatePanelState"
  | "stateArgs.set";

export interface PanelAccessRequester {
  id: string;
  kind: CallerKind | string;
  /** True when the caller is authorized chrome or a shell/about panel classified for protected control operations. */
  privileged?: boolean;
}

export interface PanelAccessTarget {
  id: string;
  /** Protection flag copied from PanelSnapshot; it drives severe control/approval handling. */
  privileged?: boolean;
}

/**
 * Open (ungated) operations — reads / observation / consensual presence. These
 * never gate, regardless of context. Everything else is a control-plane op
 * governed by the dispatcher's prepared `context.boundary` leaf.
 *
 * NOTE: cross-entity RPC (rpc.call/emit/on) is deliberately NOT modeled here —
 * raw entity-to-entity relay RPC is left open by design and gated nowhere (see
 * `rpcServer.checkRelayAuth`); recipients self-gate on receipt.
 */
const openOperations = new Set<PanelAccessOperation>(["read", "metadata", "ensureLoaded", "focus"]);

export function isOpenPanelOperation(op: PanelAccessOperation): boolean {
  return openOperations.has(op);
}

export function panelAccessSeverityForTarget(target: PanelAccessTarget): PanelAccessSeverity {
  // This is approval/control severity only. It does not grant the target any
  // host capability.
  return target.privileged === true ? "severe" : "standard";
}
