import type { EventPayloads } from "@vibestudio/shared/events";
import type { BuildSystemV2 } from "./buildV2/index.js";

/**
 * Forward the build system's per-unit change reports as one
 * `workspace:units-changed` event per turn. Clients that list launchable units
 * (agent galleries, installed-agent recovery) re-read on this event instead of
 * polling. Returns the unsubscribe.
 */
export function forwardUnitChanges(
  buildSystem: Pick<BuildSystemV2, "onUnitChange">,
  emit: (payload: EventPayloads["workspace:units-changed"]) => void
): () => void {
  let pending: EventPayloads["workspace:units-changed"]["units"] | null = null;
  return buildSystem.onUnitChange((event) => {
    const unit = { name: event.name, relativePath: event.relativePath, kind: event.kind };
    if (pending) {
      pending.push(unit);
      return;
    }
    pending = [unit];
    queueMicrotask(() => {
      const units = pending ?? [];
      pending = null;
      emit({ units });
    });
  });
}
