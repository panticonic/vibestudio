import type { EventService } from "@vibestudio/shared/eventsService";
import type { EventName } from "@vibestudio/shared/events";
import type { PanelTreeSnapshot } from "@vibestudio/shared/types";
import type { PanelRuntimeLeaseChangedEvent } from "@vibestudio/shared/panel/panelLease";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { credentialsMethods } from "@vibestudio/service-schemas/credentials";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { ServerClient } from "./serverClient.js";
import type { PanelOrchestrator } from "./panelOrchestrator.js";
import type { AppOrchestrator, AppAvailableEvent } from "./appOrchestrator.js";
import {
  handleExternalOpenPayload,
  type ExternalOpenPayload,
} from "../node/oauthLoopbackHandoff.js";

export interface ServerEventBridgeDeps {
  eventService: EventService;
  getPanelOrchestrator(): PanelOrchestrator | null;
  getAppOrchestrator?(): AppOrchestrator | null;
  getServerClient(): ServerClient | null;
  openExternal(url: string): Promise<void>;
  warn(message: string): void;
  notifyError?(title: string, message: string): void;
  onAttentionRequired?(title: string, message: string): void;
  /** OS-level attention (badge/flash/notification) for pending approvals. */
  onApprovalPendingChanged?(pending: PendingApproval[]): void;
  /** Host-target apps changed state; desktop bootstrap can retry launch. */
  onAppHostTargetChanged?(event: ServerHostTargetChangeEvent): void;
  /** Resolve server app artifact route references for this Electron connection. */
  resolveAppAvailableEvent?(payload: unknown): unknown | null;
  /**
   * The server asked the shell to run an interactive session credential
   * capture. The handler answers with `credentials.completeCapture`.
   */
  onCredentialCaptureRequest?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Apply actions whose implementation is owned by this desktop host. */
  onNotificationAction?(id: string, actionId: string): void | Promise<void>;
}

export interface ServerHostTargetChangeEvent {
  event:
    | "apps:available"
    | "apps:status"
    | "extensions:status"
    | "host-targets:changed"
    | "host-target-launch:session-changed";
  payload: unknown;
}

/** Parse the one notification shape that asks the desktop host for OS-level attention. */
export function notificationAttention(
  event: EventName,
  payload: unknown
): { title: string; message: string } | null {
  if (event !== "notification:show") return null;
  const notification = payload as { id?: unknown; title?: unknown; message?: unknown };
  if (
    typeof notification.id !== "string" ||
    !notification.id.startsWith("chat-attention:") ||
    typeof notification.title !== "string"
  ) {
    return null;
  }
  return {
    title: notification.title,
    message: typeof notification.message === "string" ? notification.message : "",
  };
}

/**
 * Applies typed workspace events from the response-owned server watch before
 * they enter the local shell event bus. Events requiring Electron state, ID
 * translation, or side effects are consumed here; all others are re-emitted.
 */
export function createServerEventBridge(
  deps: ServerEventBridgeDeps
): (event: EventName, payload: unknown) => void {
  const emitNormalized = (event: EventName, payload: unknown): void => {
    (deps.eventService.emit as (e: EventName, d: unknown) => void)(event, payload);
  };
  const credentialsClientFor = (client: ServerClient) =>
    createTypedServiceClient("credentials", credentialsMethods, (service, method, args) =>
      client.call(service, method, args)
    );

  return function handleServerEvent(bareEvent: EventName, payload: unknown): void {
    const panelOrchestrator = deps.getPanelOrchestrator();
    const appOrchestrator = deps.getAppOrchestrator?.() ?? null;

    if (bareEvent === "build:complete") {
      const { source, error } = payload as { source?: unknown; error?: unknown };
      if (typeof source !== "string") {
        deps.warn("[build] ignored malformed build:complete event without a source");
        return;
      }
      if (!panelOrchestrator) {
        deps.warn(`[build] could not apply completion for ${source}: panel host is not ready`);
        return;
      }
      panelOrchestrator.applyBuildComplete(source, typeof error === "string" ? error : undefined);
      return;
    }
    if (bareEvent === "external-open:open") {
      const external = payload as ExternalOpenPayload;
      const transactionId = external.oauthLoopback?.transactionId;
      const pendingNotificationId = transactionId ? `oauth-pending-${transactionId}` : null;
      if (pendingNotificationId && transactionId) {
        emitNormalized("notification:show", {
          id: pendingNotificationId,
          type: "info",
          title: "Finish signing in in your browser",
          message: "Vibestudio is waiting for the provider to return you to the app.",
          ttl: 0,
          actions: [
            { id: `oauth-cancel:${transactionId}`, label: "Cancel sign-in", variant: "soft" },
          ],
        });
      }
      void handleExternalOpenPayload(external, {
        openExternal: deps.openExternal,
        forwardOAuthCallback: (request) => {
          const client = deps.getServerClient();
          if (!client) throw new Error("The workspace server connection is unavailable");
          return credentialsClientFor(client).forwardOAuthCallback(request);
        },
        cancelOAuth: (transactionId) => {
          const client = deps.getServerClient();
          if (!client) throw new Error("The workspace server connection is unavailable");
          return credentialsClientFor(client).cancelOAuth({ transactionId });
        },
      })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          deps.warn(`[externalOpen] OAuth browser handoff failed: ${message}`);
          deps.notifyError?.("Sign-in could not continue", message);
        })
        .finally(() => {
          if (pendingNotificationId) {
            emitNormalized("notification:dismiss", { id: pendingNotificationId });
          }
        });
      return;
    }

    const attention = notificationAttention(bareEvent, payload);
    if (attention) deps.onAttentionRequired?.(attention.title, attention.message);

    if (bareEvent === "notification:action") {
      const action = payload as { id?: unknown; actionId?: unknown };
      if (typeof action.id === "string" && typeof action.actionId === "string") {
        void Promise.resolve(deps.onNotificationAction?.(action.id, action.actionId)).catch(
          (error: unknown) => {
            deps.warn(
              `[notification] desktop action failed: ${
                error instanceof Error ? error.message : String(error)
              }`
            );
          }
        );
      }
    }

    if (bareEvent === "credential:capture-request") {
      const request = payload as Record<string, unknown>;
      const captureId = request["captureId"];
      const captureRequest = deps.onCredentialCaptureRequest;
      if (typeof captureId !== "string" || !captureRequest) return;
      void (async () => {
        let result: Record<string, unknown>;
        try {
          result = await captureRequest(request);
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
        }
        const client = deps.getServerClient();
        if (!client) {
          deps.warn("[credentialCapture] no server client to complete capture");
          return;
        }
        await client.call("credentials", "completeCapture", [captureId, result]).catch((err) => {
          deps.warn(
            `[credentialCapture] completeCapture failed: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        });
      })();
      return;
    }

    if (bareEvent === "browser-panel:open") {
      deps.warn(
        "[browserPanel] Ignoring browser-panel:open; panel creation must go through authenticated panelTree RPC"
      );
      return;
    }

    if (bareEvent === "panel:runtimeLeaseChanged") {
      const leaseEvent = payload as PanelRuntimeLeaseChangedEvent;
      void panelOrchestrator?.handleRuntimeLeaseChanged(leaseEvent).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        deps.warn(
          `[panelRuntime] failed to apply lease change for ${leaseEvent.slotId}/${leaseEvent.runtimeEntityId}: ${
            message
          }`
        );
        deps.notifyError?.("Panel connection could not be updated", message);
      });
      return;
    }

    if (bareEvent === "panel-title-updated") {
      const { panelId, title, explicit } = payload as {
        panelId?: unknown;
        title?: unknown;
        explicit?: unknown;
      };
      if (typeof panelId === "string" && typeof title === "string") {
        panelOrchestrator?.applyServerPanelTitleUpdate({
          panelId,
          title,
          explicit: explicit === true,
        });
      }
      return;
    }

    if (bareEvent === "apps:available") {
      const appPayload = deps.resolveAppAvailableEvent
        ? deps.resolveAppAvailableEvent(payload)
        : payload;
      if (appPayload === null) return;
      deps.onAppHostTargetChanged?.({ event: "apps:available", payload: appPayload });
      void appOrchestrator
        ?.applyAppAvailable(appPayload as AppAvailableEvent)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          deps.warn(`[apps] failed to apply app availability: ${message}`);
          deps.notifyError?.("App availability could not be updated", message);
        });
      emitNormalized(bareEvent, appPayload);
      return;
    }

    if (
      bareEvent === "host-targets:changed" ||
      bareEvent === "host-target-launch:session-changed"
    ) {
      const target =
        payload && typeof payload === "object" ? (payload as { target?: unknown }).target : null;
      if (!target || target === "electron") {
        deps.onAppHostTargetChanged?.({ event: bareEvent, payload });
      }
      emitNormalized(bareEvent, payload);
      return;
    }

    if (bareEvent === "apps:status" || bareEvent === "extensions:status") {
      deps.onAppHostTargetChanged?.({ event: bareEvent, payload });
    }

    if (bareEvent === "extensions:error") {
      const record =
        payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
      const source = typeof record["source"] === "string" ? record["source"] : "An extension";
      const message =
        typeof record["error"] === "string"
          ? record["error"]
          : typeof record["message"] === "string"
            ? record["message"]
            : "The extension failed to build or start.";
      deps.notifyError?.(`${source} failed`, message);
    }

    if (bareEvent === "panel-tree-updated") {
      void panelOrchestrator
        ?.applyServerPanelTreeSnapshot(payload as PanelTreeSnapshot)
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          deps.warn(`[panelTree] failed to apply server tree snapshot: ${message}`);
          deps.notifyError?.("Workspace panel tree is out of sync", message);
        });
      return;
    }

    if (bareEvent === "shell-approval:pending-changed") {
      const { pending } = payload as { pending?: unknown };
      if (Array.isArray(pending)) {
        deps.onApprovalPendingChanged?.(pending as PendingApproval[]);
      }
      // Fall through — the renderer's approval bar consumes the same event.
    }

    emitNormalized(bareEvent, payload);
  };
}
