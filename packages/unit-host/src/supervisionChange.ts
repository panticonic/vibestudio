import type { SupervisionChange } from "@vibestudio/shared/events";
import { normalizeUnitRepoPath } from "./repoPath.js";
import type { UnitRegistry } from "./index.js";
import type { UnitRegistryEntryBase, UnitRegistryStatus } from "./types.js";

function supervisionStatus(status: UnitRegistryStatus): SupervisionChange["status"] {
  switch (status) {
    case "running":
    case "available":
      return "running";
    case "building":
    case "pending-approval":
      return "starting";
    case "stopped":
      return "stopped";
    case "error":
      return "error";
  }
}

/** Project a registry entry as the state change every client observes. */
export function unitSupervisionChange(
  entry: UnitRegistryEntryBase,
  previous: UnitRegistryEntryBase | null,
  change: SupervisionChange["change"] = "status"
): SupervisionChange {
  const superseded =
    previous?.activeBundleKey && previous.activeBundleKey !== entry.activeBundleKey
      ? previous
      : null;
  return {
    identity: { kind: entry.unitKind, entityId: entry.name },
    source: normalizeUnitRepoPath(entry.source.repo),
    status: supervisionStatus(entry.status),
    lastError: entry.lastError,
    artifact: {
      effectiveVersion: entry.activeEv,
      buildKey: entry.activeBundleKey,
      executionDigest: entry.activeExecutionDigest,
    },
    canRollback: entry.previousVersions.length > 0,
    change,
    previousBuildKey: superseded?.activeBundleKey ?? null,
    previousEffectiveVersion: superseded?.activeEv ?? null,
    adoption: null,
  };
}

/**
 * Announce every committed lifecycle change of a registry's units. The registry
 * is the single place unit state changes, so this one subscription replaces a
 * hand-placed announcement at each site that patches status or errors. A
 * removed unit is announced as stopped.
 */
export function observeUnitSupervision<Entry extends UnitRegistryEntryBase>(
  registry: UnitRegistry<Entry>,
  announce: (change: SupervisionChange, entry: Entry) => void
): () => void {
  return registry.subscribe(({ previous, current }) => {
    if (!current) {
      if (previous) {
        announce(
          unitSupervisionChange({ ...previous, status: "stopped", lastError: null }, previous),
          previous
        );
      }
      return;
    }
    if (
      previous &&
      previous.status === current.status &&
      previous.lastError === current.lastError &&
      previous.activeBundleKey === current.activeBundleKey
    ) {
      return;
    }
    announce(unitSupervisionChange(current, previous), current);
  });
}
