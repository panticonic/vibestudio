import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, sweep } from "@vibestudio/shared/ownership";
import { ledgerDirOf } from "@vibestudio/shared/ownershipLedger";

/**
 * A process's own ownership, opened on first use.
 *
 * A process that starts detached groups (a server's headless Chromium host and
 * reviewed development builds, a desktop's development clients) is an owner:
 * its reaper retires those groups when the process closes its ownership and,
 * because the lease is the reaper's channel to its owner, when the process is
 * killed outright. Most never start one, so the reaper is created on demand.
 */
export interface LazyOwnership {
  /** Open on first call; every caller receives the same instance or the same failure. */
  get(): Promise<Ownership>;
  /** Retire everything the server owns. A no-op if nothing was ever opened. */
  close(): Promise<void>;
}

export function createLazyOwnership(
  meta: Record<string, unknown>,
  options: {
    /**
     * Retire what dead owners of this profile left behind before opening. A
     * launcher (the desktop app) does this; a process started by one does not.
     */
    sweepStale?: boolean;
  } = {}
): LazyOwnership {
  let opening: Promise<Ownership> | null = null;
  return {
    get() {
      opening ??= (async () => {
        const profileDir = getProfileDataPath();
        if (options.sweepStale) await sweep(ledgerDirOf(profileDir));
        return Ownership.open({
          profileDir,
          lifetime: "leased",
          meta: { ...meta, pid: process.pid },
        });
      })();
      return opening;
    },
    async close() {
      if (!opening) return;
      let ownership: Ownership;
      try {
        ownership = await opening;
      } catch {
        // The open failure was delivered to the callers that asked for it;
        // nothing was started, so nothing needs retiring.
        return;
      }
      await ownership.close();
    },
  };
}
