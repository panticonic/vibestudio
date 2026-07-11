import { useEffect, useMemo, useState } from "react";
import { ACCOUNT_PROFILE_CHANGED_EVENT, account, type ShellAccountProfile } from "../client.js";

const PROFILE_REFRESH_INTERVAL_MS = 30_000;

export interface CurrentAccountProfileState {
  profile: ShellAccountProfile | null;
  settled: boolean;
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Resolve the shell's verified account before selecting an owner-primary tree. */
export function useCurrentAccountProfile(): CurrentAccountProfileState {
  const [state, setState] = useState<CurrentAccountProfileState>({
    profile: null,
    settled: false,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const profile = await account.getProfile();
        if (!profile) throw new Error("The connected session has no active workspace account");
        if (!cancelled) setState({ profile, settled: true, error: null });
      } catch (error) {
        if (!cancelled) {
          setState((previous) => ({
            profile: previous.profile,
            settled: true,
            error: errorMessage(error),
          }));
        }
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), PROFILE_REFRESH_INTERVAL_MS);
    window.addEventListener(ACCOUNT_PROFILE_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(ACCOUNT_PROFILE_CHANGED_EVENT, refresh);
    };
  }, []);

  return state;
}

/**
 * Resolve persistent owner identity independently of short-lived presence.
 * Presence answers online/offline only; it must never be the source of a
 * durable panel owner's name or color.
 */
export function useAccountProfiles(
  userIds: readonly string[]
): ReadonlyMap<string, ShellAccountProfile> {
  const userIdsKey = useMemo(
    () => [...new Set(userIds.filter(Boolean))].sort().join("\n"),
    [userIds]
  );
  const [profiles, setProfiles] = useState<Map<string, ShellAccountProfile>>(new Map());

  useEffect(() => {
    const ids = userIdsKey ? userIdsKey.split("\n") : [];
    if (ids.length === 0) {
      setProfiles((previous) => (previous.size === 0 ? previous : new Map()));
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const resolved = await account.resolveProfiles(ids);
        if (!cancelled) setProfiles(new Map(Object.entries(resolved)));
      } catch (error) {
        // Preserve the last successful identity projection during transient
        // reconnects; owner labels should not flap back to opaque ids.
        console.warn("[useAccountProfiles] profile refresh failed:", error);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), PROFILE_REFRESH_INTERVAL_MS);
    window.addEventListener(ACCOUNT_PROFILE_CHANGED_EVENT, refresh);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener(ACCOUNT_PROFILE_CHANGED_EVENT, refresh);
    };
  }, [userIdsKey]);

  return profiles;
}

export type { ShellAccountProfile } from "../client.js";
