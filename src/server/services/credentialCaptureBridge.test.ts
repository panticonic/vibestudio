/**
 * credentialCaptureBridge unit tests — the server→shell credential-capture
 * roundtrip: happy-path emit + complete, the immediate `desktop-attachment-
 * required` failure when no shell is attached, shell-reported errors, timeout
 * (with pending-entry cleanup), abort, and unknown-id completion.
 */

import { describe, it, expect, vi } from "vitest";
import { EventService } from "@vibestudio/shared/eventsService";
import {
  createCredentialCaptureBridge,
  DESKTOP_ATTACHMENT_REQUIRED,
} from "./credentialCaptureBridge.js";

function makeEventService() {
  const emit = vi.fn(() => true);
  return { eventService: { emitToUser: emit } as unknown as EventService, emit };
}

describe("createCredentialCaptureBridge", () => {
  it("delivers only to the owner's shell, never another user or the owner's workspace code", async () => {
    const eventService = new EventService();
    const aliceShell = vi.fn();
    const bobShell = vi.fn();
    const alicePanel = vi.fn();
    const releases = [
      eventService.registerTransportSession({
        callerId: "alice-desktop",
        connectionId: "1",
        userId: "alice",
        callerKind: "shell",
        send: aliceShell,
      }),
      eventService.registerTransportSession({
        callerId: "bob-desktop",
        connectionId: "2",
        userId: "bob",
        callerKind: "shell",
        send: bobShell,
      }),
      eventService.registerTransportSession({
        callerId: "alice-app-panel",
        connectionId: "3",
        userId: "alice",
        callerKind: "panel",
        send: alicePanel,
      }),
    ];
    try {
      const bridge = createCredentialCaptureBridge({ eventService });
      const result = bridge.captureSessionCredential("alice", {
        signInUrl: "https://example.test",
      });
      expect(aliceShell).toHaveBeenCalledOnce();
      expect(bobShell).not.toHaveBeenCalled();
      expect(alicePanel).not.toHaveBeenCalled();
      bridge.completeCapture("alice", aliceShell.mock.calls[0]![1].captureId, { token: "owned" });
      await expect(result).resolves.toEqual({ token: "owned" });
    } finally {
      for (const release of releases) release();
    }
  });
  it("emits credential:capture-request with a minted captureId and resolves on completeCapture", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
    });

    const promise = bridge.captureSessionCredential("alice", { url: "https://example.test" });

    expect(emit).toHaveBeenCalledTimes(1);
    const [userId, channel, payload, kinds] = emit.mock.calls[0] as unknown as [
      string,
      string,
      Record<string, unknown>,
      string[],
    ];
    expect(userId).toBe("alice");
    expect(kinds).toEqual(["shell"]);
    expect(channel).toBe("credential:capture-request");
    expect(typeof payload["captureId"]).toBe("string");
    expect(payload["url"]).toBe("https://example.test");

    const captureId = payload["captureId"] as string;
    bridge.completeCapture("alice", captureId, { token: "abc" });

    await expect(promise).resolves.toEqual({ token: "abc" });
  });

  it("rejects immediately with desktop-attachment-required when no shell is connected", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
    });

    emit.mockReturnValue(false);
    const err = await bridge
      .captureSessionCredential("alice", { url: "x" })
      .then(() => null)
      .catch((e: Error & { code?: string }) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error & { code?: string }).code).toBe(DESKTOP_ATTACHMENT_REQUIRED);
    expect(emit).toHaveBeenCalledOnce();
  });

  it("rejects with the shell-reported error message", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
    });

    const promise = bridge.captureSessionCredential("alice", {});
    const captureId = ((emit.mock.calls[0] as unknown[])![2] as Record<string, unknown>)[
      "captureId"
    ] as string;
    bridge.completeCapture("alice", captureId, { error: "denied" });

    await expect(promise).rejects.toThrow("denied");
  });

  it("rejects on timeout and clears the pending entry", async () => {
    vi.useFakeTimers();
    try {
      const { eventService, emit } = makeEventService();
      const bridge = createCredentialCaptureBridge({
        eventService,
        timeoutMs: 1000,
      });

      const promise = bridge.captureSessionCredential("alice", {});
      const captureId = ((emit.mock.calls[0] as unknown[])![2] as Record<string, unknown>)[
        "captureId"
      ] as string;

      const assertion = expect(promise).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;

      // Pending entry is gone: completing the same id now throws.
      expect(() => bridge.completeCapture("alice", captureId, { token: "late" })).toThrow(
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
    });

    const controller = new AbortController();
    const promise = bridge.captureSessionCredential("alice", {}, controller.signal);
    expect(emit).toHaveBeenCalledTimes(1);

    controller.abort();
    await expect(promise).rejects.toThrow("aborted");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
    });

    const controller = new AbortController();
    controller.abort();
    await expect(bridge.captureSessionCredential("alice", {}, controller.signal)).rejects.toThrow(
      "aborted"
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("throws when completeCapture is called for an unknown id", () => {
    const { eventService } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
    });

    expect(() => bridge.completeCapture("alice", "nope", { token: "x" })).toThrow(
      "No pending credential capture"
    );
  });

  it("binds completion to the authenticated owner and replaces claimed correlation fields", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({ eventService });
    const result = bridge.captureSessionCredential("alice", { userId: "bob", captureId: "forged" });
    const payload = (emit.mock.calls[0] as unknown[])[2] as { userId: string; captureId: string };
    expect(payload.userId).toBe("alice");
    expect(payload.captureId).not.toBe("forged");
    expect(() => bridge.completeCapture("bob", payload.captureId, { token: "stolen" })).toThrow(
      "No pending credential capture"
    );
    bridge.completeCapture("alice", payload.captureId, { token: "owned" });
    await expect(result).resolves.toEqual({ token: "owned" });
  });
});
