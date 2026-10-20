import type { ElectronApplication } from "@playwright/test";
import { Ownership } from "@vibestudio/shared/ownership";
import { awaitRetirement, ledgerDirOf, listLedgers } from "@vibestudio/shared/ownershipLedger";
import { closeOwnedDesktop } from "../../scripts/lib/owned-desktop-close.mjs";

export interface OwnedDesktop {
  /** Quit the application through its own close protocol; a failed close retires its group. */
  close(): Promise<void>;
  /**
   * Prove physical retirement: the application's group has exited, the test's
   * reaper is joined, and every ownership the application itself opened has
   * retired its children. Rejects with every original failure.
   */
  retire(): Promise<void>;
}

/**
 * Own a desktop that Playwright launched. Playwright starts the application as
 * its own process group; adopting that group gives it a reaper that retires it
 * even if the test process is killed.
 *
 * `profileDir` is where the test's own ownership lives. `appProfileDir` is the
 * application's private profile (when it has one): every ledger found there
 * belongs to this launch, so its owners' retirement is awaited too.
 */
export async function ownDesktop(
  app: ElectronApplication,
  options: { profileDir: string; appProfileDir?: string; meta?: Record<string, unknown> }
): Promise<OwnedDesktop> {
  const ownership = await Ownership.open({
    profileDir: options.profileDir,
    lifetime: "leased",
    meta: { role: "e2e-desktop", ...options.meta },
  });
  const owned = ownership.adopt(app.process(), { kill: "graceful", label: "electron" });
  return {
    close: () => closeOwnedDesktop(app, owned),
    async retire() {
      const failures: unknown[] = [];
      for (const step of [
        () => owned.join(),
        () => ownership.release(),
        async () => {
          if (!options.appProfileDir) return;
          const dir = ledgerDirOf(options.appProfileDir);
          const settled = await Promise.allSettled(
            listLedgers(dir).map(({ ledger }) =>
              awaitRetirement(dir, ledger.id, { token: ledger.token })
            )
          );
          const rejected = settled.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : []
          );
          if (rejected.length) throw new AggregateError(rejected, "App ownership did not retire");
        },
      ]) {
        try {
          await step();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length) throw new AggregateError(failures, "Desktop did not retire");
    },
  };
}
