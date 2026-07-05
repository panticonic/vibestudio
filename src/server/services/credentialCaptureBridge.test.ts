/**
 * credentialCaptureBridge unit tests — the server→shell credential-capture
 * roundtrip: happy-path emit + complete, the immediate `desktop-attachment-
 * required` failure when no shell is attached, shell-reported errors, timeout
 * (with pending-entry cleanup), abort, and unknown-id completion.
 */

import { describe, it, expect, vi } from "vitest";
import type { EventService } from "@vibestudio/shared/eventsService";
import {
  createCredentialCaptureBridge,
  DESKTOP_ATTACHMENT_REQUIRED,
} from "./credentialCaptureBridge.js";

function makeEventService() {
  const emit = vi.fn();
  return { eventService: { emit } as unknown as EventService, emit };
}

describe("createCredentialCaptureBridge", () => {
  it("emits credential:capture-request with a minted captureId and resolves on completeCapture", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
      hasConnectedShell: () => true,
    });

    const promise = bridge.captureSessionCredential({ url: "https://example.test" });

    expect(emit).toHaveBeenCalledTimes(1);
    const [channel, payload] = emit.mock.calls[0] as [string, Record<string, unknown>];
    expect(channel).toBe("credential:capture-request");
    expect(typeof payload["captureId"]).toBe("string");
    expect(payload["url"]).toBe("https://example.test");

    const captureId = payload["captureId"] as string;
    bridge.completeCapture(captureId, { token: "abc" });

    await expect(promise).resolves.toEqual({ token: "abc" });
  });

  it("rejects immediately with desktop-attachment-required when no shell is connected", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
      hasConnectedShell: () => false,
    });

    const err = await bridge
      .captureSessionCredential({ url: "x" })
      .then(() => null)
      .catch((e: Error & { code?: string }) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe(DESKTOP_ATTACHMENT_REQUIRED);
    expect(emit).not.toHaveBeenCalled();
  });

  it("rejects with the shell-reported error message", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
      hasConnectedShell: () => true,
    });

    const promise = bridge.captureSessionCredential({});
    const captureId = (emit.mock.calls[0]![1] as Record<string, unknown>)["captureId"] as string;
    bridge.completeCapture(captureId, { error: "denied" });

    await expect(promise).rejects.toThrow("denied");
  });

  it("rejects on timeout and clears the pending entry", async () => {
    vi.useFakeTimers();
    try {
      const { eventService, emit } = makeEventService();
      const bridge = createCredentialCaptureBridge({
        eventService,
        hasConnectedShell: () => true,
        timeoutMs: 1000,
      });

      const promise = bridge.captureSessionCredential({});
      const captureId = (emit.mock.calls[0]![1] as Record<string, unknown>)["captureId"] as string;

      const assertion = expect(promise).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      // Pending entry is gone: completing the same id now throws.
      expect(() => bridge.completeCapture(captureId, { token: "late" })).toThrow(
        "No pending credential capture"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects when the AbortSignal aborts", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
      hasConnectedShell: () => true,
    });

    const controller = new AbortController();
    const promise = bridge.captureSessionCredential({}, controller.signal);
    expect(emit).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
      hasConnectedShell: () => true,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(bridge.captureSessionCredential({}, controller.signal)).rejects.toThrow("aborted");
    expect(emit).not.toHaveBeenCalled();
  });

  it("throws when completeCapture is called for an unknown id", () => {
    const { eventService } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
      hasConnectedShell: () => true,
    });

    expect(() => bridge.completeCapture("nope", { token: "x" })).toThrow(
      "No pending credential capture"
    );
  });
});
