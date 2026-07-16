/**
 * Shared event types for shell/main communication.
 *
 * These types are used by both the renderer (useShellEvent) and main (eventsService).
 * Keep them in sync by importing from this single source of truth.
 */

import type { PendingApproval } from "./approvals.js";
import type {
  HostTarget,
  HostTargetLaunchResult,
  HostTargetLaunchSessionSnapshot,
} from "./hostTargets.js";
import type { PanelCommandId } from "./panelCommands.js";
import type { PanelRuntimeLeaseChangedEvent } from "./panel/panelLease.js";
import type { CallerKind } from "./principalKinds.js";
import type { ProtectedPublicationEvent } from "./protectedPublicationEvents.js";
import type { WorkspacePresenceEntry } from "./workspacePresence.js";
import type { PanelRecoverySnapshot, PanelTreeSnapshot } from "./types.js";

/**
 * Known event names that can be subscribed to.
 */
export type EventName =
  | "build:complete"
  | `extensions:${string}`
  | `apps:${string}`
  | "vcs:publication"
  | "workspace:unit-log"
  | "workspace:revision-bumped"
  | "credential:capture-request"
  | "server-log:append"
  | "presence:panel-active"
  | "panel:runtimeLeaseChanged"
  | "panel-title-updated"
  | "panel:snapshot"
  | "system-theme-changed"
  | "panel-tree-updated"
  | "workspace-presence-changed"
  | "open-workspace-switcher"
  | "open-command-palette"
  | "focus-approval-card"
  | "toggle-address-bar"
  | "focus-address-bar"
  | "panel-chrome-command"
  | "toggle-panel-devtools"
  | "panel-initialization-error"
  | "panel-responsiveness-changed"
  | "navigate-about"
  | "navigate-to-panel"
  | "external-open:open"
  | "browser-panel:open"
  | "browser-import-progress"
  | "browser-data-changed"
  | "autofill:save-prompt"
  | "notification:show"
  | "notification:dismiss"
  | "notification:action"
  | "user-notifications-changed"
  | "server-connection-changed"
  | "server-health"
  | "host-targets:changed"
  | "host-target-launch:session-changed"
  | "shell-approval:pending-changed";

/**
 * Action button definition for notifications.
 */
export interface NotificationAction {
  id: string;
  label: string;
  variant?: "solid" | "soft" | "ghost";
  command?:
    | { type: "app.applyUpdate"; appId: string }
    | { type: "app.rollback"; appId: string; buildKey?: string }
    | { type: "workspace.restartUnit"; name: string }
    | { type: "desktop.downloadUpdate" }
    | { type: "desktop.installUpdate" };
  invoke?: {
    kind: "extension";
    extension: string;
    method: string;
    args?: unknown[];
  };
}

export interface NotificationDetail {
  label: string;
  value: string;
  mono?: boolean;
}

export interface NotificationHistoryItem {
  title?: string;
  message: string;
  timestamp?: number;
  details?: NotificationDetail[];
}

/**
 * OAuth consent metadata for consent-type notifications.
 */
export interface NotificationConsentData {
  provider: string;
  scopes: string[];
  /** ID of the caller requesting access (panel ID or worker ID) */
  callerId: string;
  /** Human-readable name of the caller */
  callerTitle: string;
  /** Runtime kind requesting consent. */
  callerKind: "panel" | "app" | "worker" | "do";
}

/**
 * Payload for showing a notification in the shell chrome area.
 */
export interface NotificationPayload {
  id: string;
  type: "info" | "success" | "warning" | "error" | "consent";
  title: string;
  message?: string;
  /** Structured consent data (only for type: "consent") */
  consent?: NotificationConsentData;
  /** Auto-dismiss after this many ms (0 = manual dismiss only, default varies by type) */
  ttl?: number;
  /** Action buttons */
  actions?: NotificationAction[];
  /** Expandable diagnostic facts for long-running or failure notifications. */
  details?: NotificationDetail[];
  /** Expandable chronological records, e.g. several restart failures. */
  history?: NotificationHistoryItem[];
  /** Panel that triggered this notification */
  sourcePanelId?: string;
}

export interface HostTargetChangedPayload {
  target: HostTarget;
  status: HostTargetLaunchResult["status"] | "unknown";
  revision: number;
  reason?: string | null;
  details?: string[];
  source?: string | null;
  appId?: string | null;
  buildKey?: string | null;
  approvals?: number;
  snapshot?: boolean;
}

/**
 * Event payloads for type safety.
 */
export interface EventPayloads {
  "build:complete": { source: string; error?: string };
  "system-theme-changed": "light" | "dark";
  "panel-tree-updated": PanelTreeSnapshot;
  /**
   * WP8 §4 host workspace-presence: the full list of present (+ recently
   * departed) workspace members, re-broadcast whenever a user's presence
   * changes (connect/drop). Pure session-derived attribution — no channel data.
   */
  "workspace-presence-changed": WorkspacePresenceEntry[];
  "panel:runtimeLeaseChanged": PanelRuntimeLeaseChangedEvent;
  "panel-title-updated": { panelId: string; title: string; explicit?: boolean };
  "panel:snapshot": PanelRecoverySnapshot;
  "open-workspace-switcher": undefined;
  "open-command-palette": undefined;
  "focus-approval-card": undefined;
  "toggle-address-bar": undefined;
  "focus-address-bar": undefined;
  "panel-chrome-command": { command: PanelCommandId };
  "toggle-panel-devtools": undefined;
  "panel-initialization-error": { path: string; error: string };
  "panel-responsiveness-changed": { panelId: string; responsive: boolean };
  "navigate-about": { page: string };
  "navigate-to-panel": { panelId: string };
  "external-open:open": {
    url: string;
    callerId: string;
    callerKind: CallerKind;
    oauthLoopback?: {
      transactionId: string;
      redirectUri: string;
      host: "localhost" | "127.0.0.1";
      port: number;
      callbackPath: string;
      state: string;
      timeoutMs: number;
    };
    oauthAppScheme?: {
      transactionId: string;
      redirectUri: string;
      callbackScheme: "vibestudio";
      state: string;
      timeoutMs: number;
      prefersEphemeral?: boolean;
    };
  };
  "browser-panel:open": {
    url: string;
    parentPanelId: string;
    callerId: string;
    callerKind: CallerKind;
  };
  "browser-import-progress": {
    requestId: string;
    dataType: string;
    phase: string;
    itemsProcessed: number;
    totalItems?: number;
    error?: string;
  };
  // browser-import-complete is now emitted by the
  // `@workspace-extensions/browser-data` extension as
  // `extensions:@workspace-extensions/browser-data::import-complete`.
  "browser-data-changed": { dataType: string };
  "autofill:save-prompt": { panelId: string; origin: string; username: string; isUpdate: boolean };
  "notification:show": NotificationPayload;
  "notification:dismiss": { id: string };
  "notification:action": { id: string; actionId: string };
  /** Opaque account-targeted nudge; consumers reconcile from the durable inbox. */
  "user-notifications-changed": { changedAt: number };
  "server-connection-changed": {
    /** Current connection status */
    status: "connected" | "connecting" | "disconnected";
    /** Whether running in remote mode (false = local server child process) */
    isRemote: boolean;
    /** Remote server hostname (only when isRemote) */
    remoteHost?: string;
    /**
     * Selected ICE candidate-pair type of the remote WebRTC pipe (remote mode
     * only): `"relay"` means the session rides a TURN relay (works, but slower —
     * surfaced as a subtle "Relayed" hint); `host`/`srflx`/`prflx` are direct
     * P2P. `null`/omitted means unknown or not applicable (local server, or the
     * path has not settled yet).
     */
    candidateType?: "host" | "srflx" | "prflx" | "relay" | null;
    reconnect?: {
      phase: "scheduled" | "connecting" | "failed";
      attempt: number;
      nextRetryInMs?: number;
      reason: string;
    };
  };
  "server-health": {
    /** Server version string from /healthz response body. */
    version?: string;
    /** Process uptime in ms from /healthz. */
    uptimeMs?: number;
    /** workerd status — "running" or "stopped". */
    workerd?: string;
    /** Set when the poll failed; consumers can render "stale" state. */
    error?: string;
    /** Epoch ms when this sample was captured. */
    sampledAt: number;
  };
  "host-targets:changed": HostTargetChangedPayload;
  "host-target-launch:session-changed": HostTargetLaunchSessionSnapshot;
  "shell-approval:pending-changed": { pending: PendingApproval[] };
  "workspace:revision-bumped": { workspaceId: string; revision: number };
  /**
   * The server asks the attached desktop shell to run an interactive session
   * credential capture (browser sign-in). The shell answers with
   * `credentials.completeCapture(captureId, result)`.
   */
  "credential:capture-request": {
    captureId: string;
    kind: "cookies" | "saml";
    signInUrl: string;
    cookieNames?: string[];
    origins?: string[];
    browser?: string;
    completionUrlPattern?: string;
    maxTtlSeconds?: number;
    spAudience?: string;
    assertion?: boolean;
  };
  /**
   * Live tail of the server host's own log stream (serverLog service).
   * Batched; dedupe/catch up by record `seq` via `serverLog.query({sinceSeq})`.
   */
  "server-log:append": {
    records: Array<{
      seq: number;
      timestamp: number;
      level: "verbose" | "info" | "warn" | "error";
      tag?: string;
      message: string;
      fields?: unknown[];
      pid: number;
    }>;
  };
  "presence:panel-active": { panelId: string; ownerCallerId: string; updatedAt: number };
  [key: `extensions:${string}`]: unknown;
  [key: `apps:${string}`]: unknown;
  "vcs:publication": ProtectedPublicationEvent;
  "workspace:unit-log": {
    workspaceId: string;
    unitName: string;
    kind: "extension" | "app" | "worker" | "panel";
    timestamp: number;
    level: "debug" | "info" | "warn" | "error";
    message: string;
    fields?: Record<string, unknown>;
    source?: "stdout" | "stderr" | "ctx.log" | "console" | "lifecycle" | "system" | "runner";
  };
}

/**
 * List of valid event names for runtime validation.
 */
export const VALID_EVENT_NAMES: EventName[] = [
  "build:complete",
  "system-theme-changed",
  "panel-tree-updated",
  "workspace-presence-changed",
  "panel:runtimeLeaseChanged",
  "panel-title-updated",
  "panel:snapshot",
  "open-workspace-switcher",
  "open-command-palette",
  "focus-approval-card",
  "toggle-address-bar",
  "focus-address-bar",
  "panel-chrome-command",
  "toggle-panel-devtools",
  "panel-initialization-error",
  "panel-responsiveness-changed",
  "navigate-about",
  "navigate-to-panel",
  "external-open:open",
  "browser-panel:open",
  "browser-import-progress",
  "browser-data-changed",
  "autofill:save-prompt",
  "notification:show",
  "notification:dismiss",
  "notification:action",
  "user-notifications-changed",
  "server-connection-changed",
  "server-health",
  "host-targets:changed",
  "host-target-launch:session-changed",
  "shell-approval:pending-changed",
  "workspace:revision-bumped",
  "credential:capture-request",
  "server-log:append",
  "presence:panel-active",
];

/**
 * Check if a string is a valid event name.
 */
export function isValidEventName(name: string): name is EventName {
  if (name.startsWith("extensions:")) return true;
  if (name.startsWith("apps:")) return true;
  if (name === "vcs:publication") return true;
  if (name === "workspace:unit-log") return true;
  if (name === "workspace:revision-bumped") return true;
  if (name === "presence:panel-active") return true;
  if (name === "panel:runtimeLeaseChanged") return true;
  if (name === "panel-title-updated") return true;
  if (name === "panel:snapshot") return true;
  return VALID_EVENT_NAMES.includes(name as EventName);
}

/** Records carried by the destructive `events.watch` response. */
export type EventWatchRecord =
  | { kind: "watching"; events: EventName[]; epoch: string }
  | { kind: "snapshot"; event: EventName; payload: unknown; sequence: number }
  | { kind: "event"; event: EventName; payload: unknown; sequence: number };

const eventWatchEncoder = new TextEncoder();

export function encodeEventWatchRecord(record: EventWatchRecord): Uint8Array {
  return eventWatchEncoder.encode(`${JSON.stringify(record)}\n`);
}

export async function* readEventWatchRecords(
  response: Response
): AsyncGenerator<EventWatchRecord, void, void> {
  if (!response.ok) throw new Error(`Event watch failed with HTTP ${response.status}`);
  if (!response.body) throw new Error("Event watch returned no response body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let terminal = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) {
        terminal = true;
        pending += decoder.decode();
        break;
      }
      pending += decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) yield JSON.parse(line) as EventWatchRecord;
      }
    }
    const finalLine = pending.trim();
    if (finalLine) yield JSON.parse(finalLine) as EventWatchRecord;
  } finally {
    if (!terminal) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
