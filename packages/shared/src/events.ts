/**
 * Shared event types for shell/main communication.
 *
 * These types are used by both the renderer (useShellEvent) and main (eventsService).
 * Keep them in sync by importing from this single source of truth.
 */

import type { BrowserSitePermissionCapability, PendingApproval } from "./approvals.js";
import type { PanelCommandId } from "./panelCommands.js";
import type { PanelRuntimeLeaseChangedEvent } from "./panel/panelLease.js";
import type { PanelPresentationSnapshot } from "./panel/presentation.js";
import type { PanelTreeInvalidation } from "./panel/treeIndex.js";
import type { CallerKind } from "./principalKinds.js";
import type { ProtectedPublicationEvent } from "./protectedPublicationEvents.js";
import type { WorkspacePresenceEntry } from "./workspacePresence.js";
import type { Panel, PanelPlacementHint, PanelRecoverySnapshot } from "./types.js";

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
  | "workspace:protected-refs-changed"
  | "credential:capture-request"
  | "server-log:append"
  | "presence:panel-active"
  | "panel:runtimeLeaseChanged"
  | "panel:executionActivated"
  | "panel:executionFailed"
  | "panel:stateArgsChanged"
  | "panel-presentation-changed"
  | "panel-local-presentation-changed"
  | "panel:snapshot"
  | "system-theme-changed"
  | "panel-tree-invalidated"
  | "workspace-presence-changed"
  | "open-workspace-switcher"
  | "open-connection-settings"
  | "open-command-palette"
  | "focus-approval-card"
  | "toggle-address-bar"
  | "focus-address-bar"
  | "panel-chrome-command"
  | "toggle-find-in-page"
  | "toggle-panel-devtools"
  | "panel-initialization-error"
  | "panel-responsiveness-changed"
  | "native-slot-focused"
  | "navigate-about"
  | "panel-created"
  | "navigate-to-panel"
  | "external-open:open"
  | "browser-panel:open"
  | "browser-import-progress"
  | "browser-data-changed"
  | "browser-permissions:changed"
  | "autofill:save-prompt"
  | "autofill:form-fill-save-prompt"
  | "notification:show"
  | "notification:dismiss"
  | "notification:action"
  | "user-notifications-changed"
  | "server-connection-changed"
  | "server-health"
  | "shell-approval:pending-changed"
  | "eval:run-event"
  | "development:run-event"
  | "development:client-launch-request"
  | "development:client-stop-request";

/**
 * Action button definition for notifications.
 */
export interface NotificationAction {
  id: string;
  label: string;
  variant?: "solid" | "soft" | "ghost";
  command?:
    | { type: "app.applyUpdate"; appId: string }
    | {
        type: "runtime.supervision.rollback";
        release: { kind: "app"; releaseId: string };
        buildKey?: string;
      }
    | {
        type: "runtime.supervision.restart";
        identity: {
          kind: "panel" | "worker" | "do" | "app" | "extension";
          entityId: string;
        };
      }
    | {
        type: "runtime.execution.recover";
        entityId: string;
        expectedExecutionDigest: string;
        strategy: "restore-exact" | "replace-incarnation";
      }
    | { type: "desktop.installNpmUpdate" }
    | { type: "desktop.copyNpmUpdateCommand" }
    | { type: "browser.downloadOpen"; downloadId: string }
    | { type: "browser.downloadReveal"; downloadId: string }
    | {
        type: "panel.open";
        source: string;
        stateArgs?: Record<string, unknown>;
      }
    | { type: "panel.focus"; panelId: string };
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
  /** Host-validated raster data for website notification identity. */
  iconDataUrl?: string;
}

/**
 * Event payloads for type safety.
 */
export interface EventPayloads {
  "development:run-event": {
    runId: string;
    sessionId: string;
    event: {
      sequence: number;
      at: number;
      kind: "state" | "log" | "diagnostic" | "cleanup";
      payload?: unknown;
    };
  };
  "development:client-launch-request": {
    requestId: string;
    runId: string;
    expiresAt: number;
  };
  "development:client-stop-request": {
    requestId: string;
    runId: string;
    childPid: number;
  };
  "eval:run-event": {
    runId: string;
    scopeKey: string;
    event: {
      sequence: number;
      at: number;
      kind:
        | "state"
        | "console"
        | "progress"
        | "checkpoint"
        | "authority-requested"
        | "authority-decided"
        | "kernel"
        | "cleanup"
        | "diagnostic";
      payload: unknown;
    };
  };
  "build:complete": { source: string; error?: string };
  "system-theme-changed": "light" | "dark";
  "panel-tree-invalidated": PanelTreeInvalidation;
  /**
   * WP8 §4 host workspace-presence: the full list of present (+ recently
   * departed) workspace members, re-broadcast whenever a user's presence
   * changes (connect/drop). Pure session-derived attribution — no channel data.
   */
  "workspace-presence-changed": WorkspacePresenceEntry[];
  "panel:runtimeLeaseChanged": PanelRuntimeLeaseChangedEvent;
  /**
   * The server sealed the immutable execution identity for a panel
   * incarnation. Addressed to the presenting host so it can converge an
   * already-created native view without waiting for renderer re-entry.
   */
  "panel:executionActivated": {
    panelId: string;
    runtimeEntityId: string;
    effectiveVersion: string;
    buildKey: string;
    executionDigest: string;
    authorityRequests: NonNullable<Panel["authorityRequests"]>;
  };
  /**
   * The server-owned activation attempt failed. The durable reservation stays
   * current and may be retried by the reconciler, while every presenter shows
   * a terminal, actionable state instead of an unbounded preparation spinner.
   */
  "panel:executionFailed": {
    panelId: string;
    runtimeEntityId: string;
    message: string;
  };
  /**
   * The server committed a panel's durable state arguments. Addressed to the
   * presenting host so its bounded runtime projection and live renderer
   * converge on the authoritative snapshot.
   */
  "panel:stateArgsChanged": {
    panelId: string;
    stateArgs: Record<string, unknown>;
  };
  "panel-presentation-changed": { revision: number; panelIds: string[] };
  "panel-local-presentation-changed": PanelPresentationSnapshot;
  "panel:snapshot": PanelRecoverySnapshot;
  "open-workspace-switcher": undefined;
  "open-connection-settings": undefined;
  "open-command-palette": undefined;
  "focus-approval-card": undefined;
  "toggle-address-bar": undefined;
  "focus-address-bar": undefined;
  "panel-chrome-command": { command: PanelCommandId };
  "toggle-find-in-page": undefined;
  "toggle-panel-devtools": undefined;
  "panel-initialization-error": { path: string; error: string };
  "panel-responsiveness-changed": { panelId: string; responsive: boolean };
  /**
   * Main→shell focus feedback (multi-column plan §5.2): a slot-bound native
   * panel view's WebContents gained focus by any route (keyboard traversal,
   * programmatic focus, click), so shell layout focus can follow.
   */
  "native-slot-focused": { nativeSlotId: string; panelId: string };
  "navigate-about": { page: string };
  /**
   * A newly-created panel that the addressed host should present. The
   * tree browsers are refreshed separately through panel-tree-invalidated;
   * this event is delivered only to the shell caller that owns the selected
   * runtime host, so presentation remains device-local.
   */
  "panel-created": {
    panelId: string;
    parentId: string | null;
    focus: boolean;
    placement?: PanelPlacementHint;
  };
  /**
   * Request to present an existing panel on the addressed host. Creation uses
   * panel-created instead, so ordinary focus cannot accidentally acquire
   * creation semantics.
   */
  "navigate-to-panel": {
    panelId: string;
    /** Presentation anchor for a non-creation display request. */
    anchorPanelId?: string;
    hint?: PanelPlacementHint;
    intentId?: string;
  };
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
    /** OAuth transaction to cancel if the authenticated panel creation fails. */
    transactionId?: string;
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
  "autofill:form-fill-save-prompt": {
    panelId: string;
    origin: string;
    fields: Array<{ type: string; label: string }>;
  };
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
  "shell-approval:pending-changed": { pending: PendingApproval[] };
  "browser-permissions:changed": {
    environmentKey: string;
    grants: Array<{
      origin: string;
      capability: BrowserSitePermissionCapability;
      decision: "allow" | "block";
      scope: "session" | "always" | "block";
      updatedAt: number;
    }>;
  };
  "workspace:revision-bumped": { workspaceId: string; revision: number };
  "workspace:protected-refs-changed": { repoPaths: string[] };
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
  "development:run-event",
  "development:client-launch-request",
  "development:client-stop-request",
  "system-theme-changed",
  "panel-tree-invalidated",
  "workspace-presence-changed",
  "panel:runtimeLeaseChanged",
  "panel:executionActivated",
  "panel:executionFailed",
  "panel:stateArgsChanged",
  "panel-presentation-changed",
  "panel-local-presentation-changed",
  "panel:snapshot",
  "open-workspace-switcher",
  "open-connection-settings",
  "open-command-palette",
  "focus-approval-card",
  "toggle-address-bar",
  "focus-address-bar",
  "panel-chrome-command",
  "toggle-find-in-page",
  "toggle-panel-devtools",
  "panel-initialization-error",
  "panel-responsiveness-changed",
  "native-slot-focused",
  "navigate-about",
  "panel-created",
  "navigate-to-panel",
  "external-open:open",
  "browser-panel:open",
  "browser-import-progress",
  "browser-data-changed",
  "browser-permissions:changed",
  "autofill:save-prompt",
  "autofill:form-fill-save-prompt",
  "notification:show",
  "notification:dismiss",
  "notification:action",
  "user-notifications-changed",
  "server-connection-changed",
  "server-health",
  "shell-approval:pending-changed",
  "eval:run-event",
  "workspace:revision-bumped",
  "workspace:protected-refs-changed",
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
  if (name === "panel:executionActivated") return true;
  if (name === "panel:executionFailed") return true;
  if (name === "panel:stateArgsChanged") return true;
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

export interface EventWatchResponse {
  status: number;
  body: ReadableStream<Uint8Array> | null;
}

export async function* readEventWatchRecords(
  response: EventWatchResponse
): AsyncGenerator<EventWatchRecord, void, void> {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Event watch failed with HTTP ${response.status}`);
  }
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
