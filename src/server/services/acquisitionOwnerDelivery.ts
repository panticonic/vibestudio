import type { DORef } from "@vibestudio/shared/doDispatcher";
import { parseDoTargetId } from "@vibestudio/shared/workspaceServiceRpc";

export interface AcquisitionOwnerDeliveryRoute {
  storageIncarnation(ref: DORef): string;
  requestWake(ref: DORef, incarnation: string, signal: AbortSignal): Promise<"accepted" | "stale">;
  dispatchHint(ref: DORef, acquisitionId: string, signal: AbortSignal): Promise<unknown>;
  notifyAlarmChanged(): void;
}

/** The canonical receipt owns the result; this projects only an opportunity to read it. */
export function createAcquisitionOwnerNotifier(
  getRoute: () => AcquisitionOwnerDeliveryRoute | null
): (ownerRuntimeId: string, acquisitionId: string, signal: AbortSignal) => Promise<void> {
  return async (ownerRuntimeId, acquisitionId, signal) => {
    signal.throwIfAborted();
    const ref = parseDoTargetId(ownerRuntimeId);
    // Non-DO invocations retain their ordinary in-band response ownership.
    if (!ref) return;
    const route = getRoute();
    if (!route) throw new Error("Acquisition owner routing is not ready");
    const requested = await route.requestWake(ref, route.storageIncarnation(ref), signal);
    if (requested === "accepted") {
      route.notifyAlarmChanged();
      return;
    }
    if (requested !== "stale") throw new Error("Acquisition owner wake returned an invalid result");
    // Generic DO receivers do not register a Pi wake source and keep their existing callback.
    await route.dispatchHint(ref, acquisitionId, signal);
  };
}
