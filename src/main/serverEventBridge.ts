import type { EventService } from "@vibestudio/shared/eventsService";
import { isValidEventName, type EventName } from "@vibestudio/shared/events";
import type { PanelTreeSnapshot } from "@vibestudio/shared/types";
import type { PanelRuntimeLeaseChangedEvent } from "@vibestudio/shared/panel/panelLease";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { credentialsMethods } from "@vibestudio/shared/serviceSchemas/credentials";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { ServerClient } from "./serverClient.js";
import type { PanelOrchestrator } from "./panelOrchestrator.js";
import type { AppOrchestrator, AppAvailableEvent } from "./appOrchestrator.js";
import { handleExternalOpenPayload, type ExternalOpenPayload } from "./oauthLoopbackHandoff.js";

export interface ServerEventBridgeDeps {
  eventService: EventService;
  getPanelOrchestrator(): PanelOrchestrator | null;
  getAppOrchestrator?(): AppOrchestrator | null;
  getServerClient(): ServerClient | null;
  openExternal(url: string): Promise<void>;
  warn(message: string): void;
  notifyError?(title: string, message: string): void;
  /** OS-level attention (badge/flash/notification) for pending approvals. */
  onApprovalPendingChanged?(pending: PendingApproval[]): void;
  /** Host-target apps changed state; desktop bootstrap can retry launch. */
  onAppHostTargetChanged?(event: ServerHostTargetChangeEvent): void;
  /** Resolve server app artifact route references for this Electron connection. */
  resolveAppAvailableEvent?(payload: unknown): unknown | null;
  /** The server asked the shell to relaunch into a different workspace. */
  onWorkspaceRelaunchRequested?(name: string): void;
  /**
   * The server asked the shell to run an interactive session credential
   * capture. The handler answers with `credentials.completeCapture`.
   */
  onCredentialCaptureRequest?(payload: Record<string, unknown>): Promise<Record<string, unknown>>;
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

/**
 * Normalizes raw server events before they enter the local shell event bus.
 *
 * Raw server events are either direct control-plane messages such as
 * `build:complete`, or EventService frames prefixed as `event:<name>`. Any event
 * requiring local Electron state, ID translation, or side effects is consumed
 * here. Only normalized shell events are re-emitted to the renderer.
 */
export function createServerEventBridge(deps: ServerEventBridgeDeps) {
  const emitNormalized = (event: EventName, payload: unknown): void => {
    (deps.eventService.emit as (e: EventName, d: unknown) => void)(event, payload);
  };
  const credentialsClientFor = (client: ServerClient) =>
    createTypedServiceClient("credentials", credentialsMethods, (service, method, args) =>
      client.call(service, method, args)
    );

  return function handleServerEvent(event: string, payload: unknown): void {
    const panelOrchestrator = deps.getPanelOrchestrator();
    const appOrchestrator = deps.getAppOrchestrator?.() ?? null;

    if (event === "build:complete") {
      const { source, error } = payload as { source?: unknown; error?: unknown };
      if (typeof source === "string") {
        panelOrchestrator?.applyBuildComplete(
          source,
          typeof error === "string" ? error : undefined
        );
      }
      return;
    }

    if (!event.startsWith("event:")) return;

    const bareEvent = event.slice("event:".length);
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
          return client
            ? credentialsClientFor(client).forwardOAuthCallback(request)
            : Promise.resolve();
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

    if (bareEvent === "workspace:relaunch-requested") {
      const { name } = payload as { name?: unknown };
      if (typeof name === "string") deps.onWorkspaceRelaunchRequested?.(name);
      return;
    }

    if (bareEvent === "credential:capture-request") {
      const request = payload as Record<string, unknown>;
      const captureId = request["captureId"];
      if (typeof captureId !== "string" || !deps.onCredentialCaptureRequest) return;
      void (async () => {
        let result: Record<string, unknown>;
        try {
          result = await deps.onCredentialCaptureRequest!(request);
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
        deps.warn(
          `[panelRuntime] failed to apply lease change for ${leaseEvent.slotId}/${leaseEvent.runtimeEntityId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
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
          deps.warn(
            `[apps] failed to apply app availability: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
        });
      if (isValidEventName(bareEvent)) {
        emitNormalized(bareEvent, appPayload);
      }
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
      if (isValidEventName(bareEvent)) {
        emitNormalized(bareEvent, payload);
      }
      return;
    }

    if (bareEvent === "apps:status" || bareEvent === "extensions:status") {
      deps.onAppHostTargetChanged?.({ event: bareEvent, payload });
    }

    if (bareEvent === "panel-tree-updated") {
      void panelOrchestrator
        ?.applyServerPanelTreeSnapshot(payload as PanelTreeSnapshot)
        .catch((err: unknown) => {
          deps.warn(
            `[panelTree] failed to apply server tree snapshot: ${
              err instanceof Error ? err.message : String(err)
            }`
          );
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

    if (isValidEventName(bareEvent)) {
      emitNormalized(bareEvent, payload);
    }
  };
}
