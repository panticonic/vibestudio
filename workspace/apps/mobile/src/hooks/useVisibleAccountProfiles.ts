import { useEffect, useState } from "react";
import type { MobileOwnerProfile } from "../shellCore/panelForest";

const PROFILE_REFRESH_INTERVAL_MS = 30_000;

export interface AccountProfileResolver {
  resolveAccountProfiles(userIds: readonly string[]): Promise<Record<string, MobileOwnerProfile>>;
}

interface ProfileRefreshScheduler {
  setInterval(callback: () => void, delayMs: number): ReturnType<typeof setInterval>;
  clearInterval(timer: ReturnType<typeof setInterval>): void;
}

export function startVisibleAccountProfileRefresh(
  resolver: AccountProfileResolver,
  ownerIds: readonly string[],
  apply: (profiles: Map<string, MobileOwnerProfile>) => void,
  scheduler: ProfileRefreshScheduler = globalThis
): () => void {
  let cancelled = false;
  const refresh = async () => {
    try {
      const resolved = await resolver.resolveAccountProfiles(ownerIds);
      if (!cancelled) apply(new Map(Object.entries(resolved)));
    } catch {
      // Keep the last successful labels during a transient reconnect.
    }
  };
  void refresh();
  const timer = scheduler.setInterval(() => void refresh(), PROFILE_REFRESH_INTERVAL_MS);
  return () => {
    cancelled = true;
    scheduler.clearInterval(timer);
  };
}

/**
 * Resolve drawer labels while the drawer is visible. Closing the drawer stops
 * its timer but retains the last projection for an instant next open.
 */
export function useVisibleAccountProfiles(
  resolver: AccountProfileResolver | null,
  ownerIds: readonly string[],
  visible: boolean
): Map<string, MobileOwnerProfile> {
  const [profiles, setProfiles] = useState<Map<string, MobileOwnerProfile>>(new Map());

  useEffect(() => {
    if (!resolver || ownerIds.length === 0) {
      setProfiles((current) => (current.size === 0 ? current : new Map()));
      return;
    }
    if (!visible) return;
    return startVisibleAccountProfileRefresh(resolver, ownerIds, setProfiles);
  }, [ownerIds, resolver, visible]);

  return profiles;
}
