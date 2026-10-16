import { randomBytes } from "node:crypto";
import { deserializeRpcFailure, type RpcFailure } from "@vibestudio/rpc";
import type { EventService } from "@vibestudio/shared/eventsService";

/**
 * Operations the account's system tests run on a device the person started as
 * a test driver (a terminal CLI host or a desktop client).
 *
 * The device registers once and then answers requests the server addresses to
 * it. A request is pending until the driver answers it, the driver's last
 * transport closes, or the caller cancels: those are the only ways it can end,
 * so a wait the driver settles from its own events (a screen revision, a
 * window closing, a `clients:changed`) never needs a clock.
 */

export type DeviceKind = "terminal" | "desktop";

interface Driver {
  runtimeId: string;
  userId: string;
  kind: DeviceKind;
}

interface PendingDrive {
  userId: string;
  runtimeId: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

export type DeviceDriverEvents = Pick<
  EventService,
  "emitToCaller" | "requestCaller" | "hasLiveCaller"
>;

export class DeviceDriverRelay {
  private readonly drivers = new Map<string, Driver>();
  private readonly pending = new Map<string, PendingDrive>();

  constructor(private readonly events: DeviceDriverEvents) {}

  register(driver: Driver): void {
    this.drivers.set(driver.runtimeId, driver);
  }

  /** The user's drivers whose device is still connected. */
  list(userId: string): Array<{ deviceKind: DeviceKind; runtimeId: string }> {
    const live: Array<{ deviceKind: DeviceKind; runtimeId: string }> = [];
    for (const driver of [...this.drivers.values()]) {
      if (!this.events.hasLiveCaller(driver.runtimeId)) {
        this.drivers.delete(driver.runtimeId);
        continue;
      }
      if (driver.userId === userId)
        live.push({ deviceKind: driver.kind, runtimeId: driver.runtimeId });
    }
    return live.sort((a, b) => a.runtimeId.localeCompare(b.runtimeId));
  }

  drive(
    userId: string,
    request: { deviceKind: DeviceKind; op: string; args?: unknown },
    signal?: AbortSignal
  ): Promise<unknown> {
    const candidates = this.list(userId).filter(
      (driver) => driver.deviceKind === request.deviceKind
    );
    if (candidates.length === 0) {
      return Promise.reject(
        coded(
          "EDEVICE_UNAVAILABLE",
          `No ${request.deviceKind} device driver is connected for this account`
        )
      );
    }
    if (candidates.length > 1) {
      return Promise.reject(
        coded(
          "EDEVICE_AMBIGUOUS",
          `${candidates.length} ${request.deviceKind} device drivers are connected for this account`
        )
      );
    }
    const runtimeId = candidates[0]!.runtimeId;
    const callId = `drive-${randomBytes(12).toString("hex")}`;
    return new Promise<unknown>((resolve, reject) => {
      let release: (() => void) | null = null;
      const finish = (settle: () => void) => {
        if (!this.pending.delete(callId)) return;
        release?.();
        signal?.removeEventListener("abort", onAbort);
        settle();
      };
      const onAbort = () => {
        const reason = signal?.reason;
        this.events.emitToCaller(runtimeId, "development:device-drive-cancel", { callId });
        finish(() =>
          reject(
            reason instanceof Error ? reason : coded("ECANCELLED", "The drive call was cancelled")
          )
        );
      };
      this.pending.set(callId, {
        userId,
        runtimeId,
        resolve: (value) => finish(() => resolve(value)),
        reject: (error) => finish(() => reject(error)),
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        release = this.events.requestCaller(
          runtimeId,
          "development:device-drive-request",
          { callId, op: request.op, args: request.args },
          () =>
            finish(() =>
              reject(
                coded(
                  "EDEVICE_GONE",
                  `The ${request.deviceKind} device disconnected before it answered ${request.op}`
                )
              )
            )
        );
      } catch (error) {
        finish(() => reject(error as Error));
        return;
      }
      // Delivery may synchronously complete, abort, or close its recipients.
      if (!this.pending.has(callId)) {
        release?.();
        return;
      }
      if (!release) {
        finish(() =>
          reject(coded("EDEVICE_UNAVAILABLE", `The ${request.deviceKind} device is not connected`))
        );
      }
    });
  }

  answer(
    runtimeId: string,
    userId: string,
    callId: string,
    outcome: { ok: true; value?: unknown } | { ok: false; failure: RpcFailure }
  ): void {
    const entry = this.pending.get(callId);
    if (!entry || entry.runtimeId !== runtimeId || entry.userId !== userId) {
      throw coded("ENOENT", "Unknown device drive call");
    }
    if (outcome.ok) entry.resolve(outcome.value);
    else entry.reject(deserializeRpcFailure(outcome.failure));
  }
}

function coded(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}
