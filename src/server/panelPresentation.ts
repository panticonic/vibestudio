import type { PanelRuntimeLeaseChangedEvent } from "@vibestudio/shared/panel/panelLease";
import type { PresentationTarget, PresentResult } from "@vibestudio/service-schemas/panelRuntime";
import type {
  PanelRuntimeStore,
  PresentationAlert,
  PresentationRequestRecord,
} from "./panelRuntimeStore.js";

/**
 * Putting a panel on a chosen device (tendrils, docs/tendrils-plan.md 4.5).
 *
 * A request is durable (PanelRuntimeStore). If the device has a client
 * connected, its client is told now (`panel-presentation-requested`); either
 * way the client lists its pending requests when it connects. The device
 * taking the slot's runtime lease is what fulfils, and clears, the request.
 * An away device, or any request with an alert, is also notified by push.
 */
export interface PanelPresentation {
  listTargets(userId: string | null): PresentationTarget[];
  request(
    userId: string | null,
    request: { slotId: string; deviceId: string; focus: boolean; alert: PresentationAlert }
  ): Promise<PresentResult>;
  /** Requests addressed to the device behind `principalId`; closed slots are dropped. */
  pendingFor(principalId: string): Promise<PresentationRequestRecord[]>;
  dispose(): void;
}

export interface PanelPresentationDeps {
  store: PanelRuntimeStore;
  coordinator: {
    listClientSessions(): ReadonlyArray<{
      clientSessionId: string;
      ownerCallerId: string | undefined;
      label: string;
      platform: PresentationTarget["platform"];
    }>;
    onLeaseChanged(listener: (event: PanelRuntimeLeaseChangedEvent) => void): () => void;
  };
  /** `deviceIdOfHostPrincipal` (callerDeviceFacts.ts), so ids match provenance stamps. */
  deviceOfPrincipal(principalId: string): string | null;
  /** The user's paired, unrevoked devices. */
  pairedDevices(
    userId: string
  ): ReadonlyArray<{ deviceId: string; label: string; platform?: string }>;
  slotExists(slotId: string): Promise<boolean>;
  emit(event: { slotId: string; deviceId: string; focus: boolean; alert: PresentationAlert }): void;
  /** Push to the device's registrations; resolves true if any was delivered (or logged). */
  push(input: {
    userId: string;
    deviceId: string;
    slotId: string;
    alert: PresentationAlert;
  }): Promise<boolean>;
}

function platformOf(platform: string | undefined): PresentationTarget["platform"] {
  return platform === "ios" || platform === "android" || platform === "mobile"
    ? "mobile"
    : "desktop";
}

export function createPanelPresentation(deps: PanelPresentationDeps): PanelPresentation {
  const onlineTargets = (): PresentationTarget[] => {
    const byDevice = new Map<string, PresentationTarget>();
    for (const client of deps.coordinator.listClientSessions()) {
      const deviceId = client.ownerCallerId ? deps.deviceOfPrincipal(client.ownerCallerId) : null;
      if (!deviceId || byDevice.has(deviceId)) continue;
      byDevice.set(deviceId, {
        deviceId,
        label: client.label,
        platform: client.platform,
        online: true,
        clientSessionId: client.clientSessionId,
      });
    }
    return [...byDevice.values()];
  };

  const listTargets = (userId: string | null): PresentationTarget[] => {
    const online = onlineTargets();
    const known = new Set(online.map((target) => target.deviceId));
    const paired = userId
      ? deps
          .pairedDevices(userId)
          .filter((device) => !known.has(device.deviceId))
          .map(
            (device): PresentationTarget => ({
              deviceId: device.deviceId,
              label: device.label,
              platform: platformOf(device.platform),
              online: false,
              clientSessionId: null,
            })
          )
      : [];
    // Online clients of other users are not the caller's devices.
    const mine = userId
      ? new Set(deps.pairedDevices(userId).map((device) => device.deviceId))
      : new Set<string>();
    return [
      ...online.filter(
        (target) => mine.has(target.deviceId) || target.deviceId.startsWith("local:")
      ),
      ...paired,
    ];
  };

  const unsubscribe = deps.coordinator.onLeaseChanged((event) => {
    if (!event.next) return;
    const client = deps.coordinator
      .listClientSessions()
      .find((session) => session.clientSessionId === event.next!.clientSessionId);
    const deviceId = client?.ownerCallerId ? deps.deviceOfPrincipal(client.ownerCallerId) : null;
    if (deviceId) deps.store.clear(event.slotId, deviceId);
  });

  return {
    listTargets,
    async request(userId, request) {
      if (!(await deps.slotExists(request.slotId))) {
        throw new Error(`Unknown or closed panel slot: ${request.slotId}`);
      }
      const target = listTargets(userId).find((t) => t.deviceId === request.deviceId);
      if (!target) {
        throw new Error(
          `Device ${request.deviceId} is not one of your devices; use listPresentationTargets`
        );
      }
      deps.store.request(request);
      if (target.online) deps.emit(request);
      const wantsPush = !target.online || request.alert !== "none";
      const pushed =
        wantsPush && userId
          ? await deps.push({
              userId,
              deviceId: request.deviceId,
              slotId: request.slotId,
              alert: request.alert,
            })
          : false;
      if (target.online) return { state: "presented" };
      return { state: pushed ? "pushed" : "pending-device" };
    },
    async pendingFor(principalId) {
      const deviceId = deps.deviceOfPrincipal(principalId);
      if (!deviceId) return [];
      const pending: PresentationRequestRecord[] = [];
      for (const request of deps.store.pending(deviceId)) {
        if (await deps.slotExists(request.slotId)) pending.push(request);
        else deps.store.clearSlot(request.slotId);
      }
      return pending;
    },
    dispose: unsubscribe,
  };
}
