import { statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import path from "node:path";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { Ownership, watchLease } from "@vibestudio/shared/ownership";
import { runWithOwnedCleanup } from "./owned-cleanup.mjs";

const STOP_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

/** The abort reason of an operator's stop request. It is the one abort that is
 * not a failure: `main` may let it propagate out of `throwIfAborted()`. */
function stopRequested(signal) {
  return Object.assign(new Error(`Stop requested by ${signal}`), {
    name: "AbortError",
    code: "ESTOP",
    signal,
  });
}

/**
 * Entry point of a script that owns processes or scratch storage.
 *
 * The script opens its own `Ownership` (its reaper outlives a SIGKILLed owner
 * and retires everything the script registered), so no launcher has to know
 * which paths or children the script created. `main` runs in-process with:
 *
 * - `signal`: aborts on SIGINT/SIGTERM/SIGHUP (reason `code: "ESTOP"`), on loss
 *   of an inherited lease (the script's owner is gone), and when the reaper
 *   dies. A repeated stop signal escalates graceful retirements in flight.
 * - `ownership`: spawn every child with `ownership.spawn`.
 * - `scratchRoot`: a reaper-owned private directory under the profile
 *   (disk-backed, never `/tmp`) when `scratchPrefix` is given.
 *
 * With `appRoot`, `VIBESTUDIO_APP_ROOT` is set to it for this process and its
 * children.
 *
 * The ownership is released, and every failure of `main` and of retirement
 * reported together, before this resolves with `main`'s value. A stop request
 * is not a failure, but it is not success either: unless `main` chose its own
 * `process.exitCode`, the process then exits 128 + the signal number, as a
 * shell reports a signalled command.
 */
export async function ownedEntry(
  main,
  { appRoot, scratchPrefix, profileDir = getProfileDataPath() } = {}
) {
  if (appRoot !== undefined) {
    if (
      typeof appRoot !== "string" ||
      !path.isAbsolute(appRoot) ||
      !statSync(appRoot).isDirectory()
    ) {
      throw new TypeError("Owned execution requires an existing absolute application root");
    }
    process.env["VIBESTUDIO_APP_ROOT"] = appRoot;
  }

  const controller = new AbortController();
  let ownership;
  const onStop = (signal) => {
    if (controller.signal.aborted) {
      // The operator is insisting: stop waiting politely on retirements.
      if (ownership && controller.signal.reason?.code === "ESTOP") {
        ownership.scope.track(ownership.escalate());
      }
      return;
    }
    controller.abort(stopRequested(signal));
  };
  const handlers = STOP_SIGNALS.map((signal) => [signal, () => onStop(signal)]);
  for (const [signal, handler] of handlers) process.on(signal, handler);

  const failures = [];
  let result;
  try {
    ownership = await Ownership.open({ profileDir, lifetime: "leased" });
    const lost = (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    };
    const lease = watchLease({ optional: true });
    for (const source of [lease, ownership.signal]) {
      if (source.aborted) lost(source.reason);
      else source.addEventListener("abort", () => lost(source.reason), { once: true });
    }
    const scratchRoot = scratchPrefix ? await ownership.scratch(scratchPrefix) : undefined;
    controller.signal.throwIfAborted();
    result = await main({ signal: controller.signal, ownership, scratchRoot });
  } catch (error) {
    // A requested stop is how a long-running script ends, not a failure of it.
    if (!(error === controller.signal.reason && error?.code === "ESTOP")) failures.push(error);
  } finally {
    for (const [signal, handler] of handlers) process.off(signal, handler);
    try {
      await ownership?.release();
    } catch (error) {
      failures.push(error);
    }
  }
  const stop = controller.signal.reason;
  if (controller.signal.aborted && stop?.code === "ESTOP" && process.exitCode === undefined) {
    process.exitCode = 128 + (osConstants.signals[stop.signal] ?? 0);
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw Object.assign(new AggregateError(failures, "Owned execution did not complete cleanly"), {
      code: "EOWNERSHIP",
    });
  }
  return result;
}

/** Retire an owned child as soon as `signal` aborts (now, if it already has).
 * A failure to retire surfaces from `ownership.release()`. */
export function retireOnAbort(ownership, signal, owned) {
  const retire = () => void ownership.scope.track(owned.retire());
  if (signal.aborted) retire();
  else signal.addEventListener("abort", retire, { once: true });
}

/** Run `operation` with a fresh `Ownership` and release it afterwards, for
 * library code that is not a script entry but starts owned work. A failure of
 * the operation and of retirement are reported together. */
export async function withOwnership(operation, { profileDir = getProfileDataPath() } = {}) {
  const ownership = await Ownership.open({ profileDir, lifetime: "leased" });
  return runWithOwnedCleanup(
    () => operation(ownership),
    () => ownership.release(),
    "Operation and its process retirement both failed"
  );
}
