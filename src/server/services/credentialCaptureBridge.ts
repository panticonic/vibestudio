/**
 * credentialCaptureBridge — server→shell roundtrip for interactive session
 * credential capture (browser sign-in flows).
 *
 * The server sends a `credential:capture-request` to the user's connected
 * shells and awaits the shell's `credentials.completeCapture` RPC with the same
 * `captureId`. A person may take as long as they need to sign in: the request
 * settles only on completion, the caller's abort, or every addressed shell
 * disconnecting. If no desktop shell is attached it fails immediately with a
 * typed `desktop-attachment-required` error so background agents get an
 * actionable failure.
 */

import { randomUUID } from "node:crypto";
import type { EventService } from "@vibestudio/shared/eventsService";
import { deserializeRpcFailure } from "@vibestudio/rpc";
import type { CredentialCaptureCompletion } from "@vibestudio/service-schemas/credentials";

export const DESKTOP_ATTACHMENT_REQUIRED = "desktop-attachment-required";

export interface CredentialCaptureBridge {
  /**
   * Ask the attached desktop shell to run an interactive capture. Resolves with
   * the shell's result payload; rejects on abort, shell-reported error, shell
   * disconnect, or when no shell is attached (`code: "desktop-attachment-required"`).
   */
  captureSessionCredential<T extends Record<string, unknown>>(
    userId: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T>;
  /** Shell-side completion callback (dispatched from `credentials.completeCapture`). */
  completeCapture(userId: string, captureId: string, completion: CredentialCaptureCompletion): void;
}

interface PendingCapture {
  userId: string;
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
}

function desktopAttachmentRequired(message: string): Error {
  return Object.assign(new Error(message), { code: DESKTOP_ATTACHMENT_REQUIRED });
}

export function createCredentialCaptureBridge(deps: {
  eventService: Pick<EventService, "requestUser">;
}): CredentialCaptureBridge {
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
        let releaseAddressees: (() => void) | null = null;
        const finish = (fn: () => void) => {
          if (!pending.has(captureId)) return;
          pending.delete(captureId);
          releaseAddressees?.();
          signal?.removeEventListener("abort", onAbort);
          fn();
        };
        const onAbort = () => finish(() => reject(new Error("Session credential capture aborted")));
        pending.set(captureId, {
          userId,
          resolve: (value) => finish(() => resolve(value as T)),
          reject: (error) => finish(() => reject(error)),
        });
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          releaseAddressees = deps.eventService.requestUser(
            userId,
            "credential:capture-request",
            { ...payload, captureId, userId } as never,
            ["shell"],
            () =>
              finish(() =>
                reject(
                  desktopAttachmentRequired(
                    "Your desktop app disconnected before the sign-in finished"
                  )
                )
              )
          );
        } catch (error) {
          finish(() => reject(error));
          return;
        }
        // Delivery may synchronously complete, abort, or close its recipients.
        if (!pending.has(captureId)) {
          releaseAddressees?.();
          return;
        }
        if (!releaseAddressees) {
          finish(() =>
            reject(
              desktopAttachmentRequired(
                "Session credential capture requires your desktop app to be attached to Personal"
              )
            )
          );
        }
      });
    },
    completeCapture(
      userId: string,
      captureId: string,
      completion: CredentialCaptureCompletion
    ): void {
      const entry = pending.get(captureId);
      if (!entry || entry.userId !== userId) {
        throw new Error(`No pending credential capture for id ${captureId}`);
      }
      if (completion.kind === "failure") {
        entry.reject(deserializeRpcFailure(completion.failure));
        return;
      }
      entry.resolve(completion.value);
    },
  };
}
