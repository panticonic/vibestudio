/**
 * credentialCaptureBridge — server→shell roundtrip for interactive session
 * credential capture (browser sign-in flows).
 *
 * Replaces the deleted Electron-IPC `credential-session-capture-request`
 * channel: the server emits a `credential:capture-request` event to connected
 * shell principals and awaits the shell's `credentials.completeCapture`
 * RPC with the same `captureId`. If no desktop shell is attached the request
 * fails IMMEDIATELY with a typed `desktop-attachment-required` error so
 * background agents get an actionable failure instead of a 5-minute hang.
 */

import { randomUUID } from "node:crypto";
import type { EventService } from "@vibestudio/shared/eventsService";

const DEFAULT_CAPTURE_TIMEOUT_MS = 300_000;

export const DESKTOP_ATTACHMENT_REQUIRED = "desktop-attachment-required";

export interface CredentialCaptureBridge {
  /**
   * Ask the attached desktop shell to run an interactive capture. Resolves with
   * the shell's result payload; rejects on timeout, abort, shell-reported
   * error, or when no shell is attached (`code: "desktop-attachment-required"`).
   */
  captureSessionCredential<T extends Record<string, unknown>>(
    userId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T>;
  /** Shell-side completion callback (dispatched from `credentials.completeCapture`). */
  completeCapture(userId: string, captureId: string, response: Record<string, unknown>): void;
}

interface PendingCapture {
  userId: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

export function createCredentialCaptureBridge(deps: {
  eventService: Pick<EventService, "emitToUser">;
  timeoutMs?: number;
}): CredentialCaptureBridge {
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const pending = new Map<string, PendingCapture>();

  return {
    captureSessionCredential<T extends Record<string, unknown>>(
      userId: string,
      payload: Record<string, unknown>,
      signal?: AbortSignal
    ): Promise<T> {
      if (!userId)
        return Promise.reject(new Error("Credential capture requires an authenticated user"));
      if (signal?.aborted) {
        return Promise.reject(new Error("Session credential capture aborted"));
      }
      const captureId = randomUUID();
      return new Promise<T>((resolve, reject) => {
        let timer: NodeJS.Timeout | null = null;
        const finish = (fn: () => void) => {
          if (!pending.has(captureId)) return;
          pending.delete(captureId);
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = () => finish(() => reject(new Error("Session credential capture aborted")));
        pending.set(captureId, {
          userId,
          resolve: (value) => finish(() => resolve(value as T)),
          reject: (error) => finish(() => reject(error)),
        });
        timer = setTimeout(
          () => finish(() => reject(new Error("Session credential capture timed out"))),
          timeoutMs
        );
        timer.unref?.();
        signal?.addEventListener("abort", onAbort, { once: true });
        const delivered = deps.eventService.emitToUser(
          userId,
          "credential:capture-request",
          {
            ...payload,
            captureId,
            userId,
          } as never,
          ["shell"]
        );
        if (!delivered) {
          finish(() =>
            reject(
              Object.assign(
                new Error(
                  "Session credential capture requires your desktop app to be attached to Personal"
                ),
                { code: DESKTOP_ATTACHMENT_REQUIRED }
              )
            )
          );
        }
      });
    },
    completeCapture(userId: string, captureId: string, response: Record<string, unknown>): void {
      const entry = pending.get(captureId);
      if (!entry || entry.userId !== userId) {
        throw new Error(`No pending credential capture for id ${captureId}`);
      }
      if (response["error"] != null) {
        entry.reject(new Error(String(response["error"])));
        return;
      }
      entry.resolve(response);
    },
  };
}
