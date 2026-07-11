/**
 * useWorkspacePresence — WP8 §4 workspace-USER presence, for the panel-forest UI.
 *
 * "Who is connected to THIS workspace." A HOST surface fed purely by the session
 * registry (live connections + each caller's verified userId), with ZERO channel
 * coupling — this is NOT chat/conversation presence (that is a separate userland
 * system, §3). Presence is keyed on the logical `user:<userId>`: a person on a
 * phone and a laptop is ONE present user.
 *
 * Read once on mount, then kept live by the `workspace-presence-changed` event
 * the host broadcasts on every connect/drop. Attribution for a mutually-trusting
 * team, not a security signal.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { workspacePresence, type WorkspacePresenceEntry } from "../client.js";
import { useShellEvent } from "../useShellEvent.js";

export type { WorkspacePresenceEntry } from "../client.js";

/** Presence rows keyed by `userId` for O(1) owner-band lookup. */
export type WorkspacePresenceByUser = ReadonlyMap<string, WorkspacePresenceEntry>;

/** Mirrors the host retention contract; the client schedules its own expiry so
 * a quiet workspace cannot leave an offline row visible forever. */
const LAST_SEEN_RETENTION_MS = 5 * 60_000;

function indexByUser(entries: WorkspacePresenceEntry[]): Map<string, WorkspacePresenceEntry> {
  const byUser = new Map<string, WorkspacePresenceEntry>();
  for (const entry of entries) byUser.set(entry.userId, entry);
  return byUser;
}

/**
 * Live map of `userId → presence`. Empty until the first read resolves; updates
 * in place as members connect/drop.
 */
export function useWorkspacePresence(): WorkspacePresenceByUser {
  const [byUser, setByUser] = useState<Map<string, WorkspacePresenceEntry>>(new Map());
  const eventVersionRef = useRef(0);

  // Initial snapshot on mount (the event only carries subsequent changes).
  useEffect(() => {
    let cancelled = false;
    const versionAtRequest = eventVersionRef.current;
    void workspacePresence
      .list()
      .then((entries) => {
        // An event is a newer full snapshot. Never let an older in-flight list
        // response regress it when mount races a connect/drop broadcast.
        if (!cancelled && eventVersionRef.current === versionAtRequest) {
          setByUser(indexByUser(entries));
        }
      })
      .catch((err: unknown) => console.warn("[useWorkspacePresence] initial list failed:", err));
    return () => {
      cancelled = true;
    };
  }, []);

  // Live updates: the host re-broadcasts the full presence list on every change.
  const onChange = useCallback((entries: WorkspacePresenceEntry[]) => {
    eventVersionRef.current += 1;
    setByUser(indexByUser(entries));
  }, []);
  useShellEvent("workspace-presence-changed", onChange);

  // The service intentionally emits only on connection-shape changes. Expire
  // recently-departed rows locally at the documented boundary even when the
  // workspace remains otherwise idle.
  useEffect(() => {
    let nextExpiry = Number.POSITIVE_INFINITY;
    const now = Date.now();
    for (const entry of byUser.values()) {
      if (!entry.online) nextExpiry = Math.min(nextExpiry, entry.lastSeen + LAST_SEEN_RETENTION_MS);
    }
    if (!Number.isFinite(nextExpiry)) return;
    const delay = Math.max(0, nextExpiry - now + 1);
    const timer = window.setTimeout(() => {
      const cutoff = Date.now() - LAST_SEEN_RETENTION_MS;
      setByUser((previous) => {
        let changed = false;
        const next = new Map(previous);
        for (const [userId, entry] of next) {
          if (!entry.online && entry.lastSeen <= cutoff) {
            next.delete(userId);
            changed = true;
          }
        }
        return changed ? next : previous;
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [byUser]);

  return byUser;
}
