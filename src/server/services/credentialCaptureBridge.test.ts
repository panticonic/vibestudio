/**
 * credentialCaptureBridge unit tests — the server→shell credential-capture
 * roundtrip: happy-path emit + complete, the immediate `desktop-attachment-
 * required` failure when no shell is attached, shell-reported errors, shell
 * disconnect (with pending-entry cleanup), abort, and unknown-id completion.
 */

import { describe, it, expect, vi } from "vitest";
import { EventService } from "@vibestudio/shared/eventsService";
import type { EventName } from "@vibestudio/shared/events";
import { RemoteRpcAggregateError, serializeRpcFailure } from "@vibestudio/rpc";
import { createServerEventBridge } from "../../main/serverEventBridge.js";
import type { CredentialCaptureCompletion } from "@vibestudio/service-schemas/credentials";
import {
  createCredentialCaptureBridge,
  DESKTOP_ATTACHMENT_REQUIRED,
} from "./credentialCaptureBridge.js";

function makeEventService() {
  const emit = vi.fn((): (() => void) | null => () => undefined);
  return { eventService: { requestUser: emit } as unknown as EventService, emit };
}

describe("createCredentialCaptureBridge", () => {
  it("propagates delivery failure and retires the pending capture", async () => {
    const original = new Error("shell transport failed");
    let captureId = "";
    const eventService = new EventService();
    const release = eventService.registerTransportSession({
      callerId: "alice-desktop",
      connectionId: "1",
      userId: "alice",
      callerKind: "shell",
      send: (_event, payload) => {
        captureId = (payload as { captureId: string }).captureId;
        throw original;
      },
    });
    try {
      const bridge = createCredentialCaptureBridge({ eventService });
      await expect(bridge.captureSessionCredential("alice", {})).rejects.toBe(original);
      expect(() =>
        bridge.completeCapture("alice", captureId, {
          kind: "success",
          value: {},
        })
      ).toThrow("No pending credential capture");
    } finally {
      release();
    }
  });
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
      bridge.completeCapture("alice", aliceShell.mock.calls[0]![1].captureId, {
        kind: "success",
        value: { token: "owned" },
      });
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
    bridge.completeCapture("alice", captureId, { kind: "success", value: { token: "abc" } });

    await expect(promise).resolves.toEqual({ token: "abc" });
  });

  it("rejects immediately with desktop-attachment-required when no shell is connected", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({
      eventService,
    });

    emit.mockReturnValue(null);
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
    bridge.completeCapture("alice", captureId, {
      kind: "failure",
      failure: serializeRpcFailure(Object.assign(new Error("denied"), { code: "DENIED" })),
    });

    await expect(promise).rejects.toMatchObject({ message: "denied", code: "DENIED" });
  });

  it("preserves the full failure graph through the shell observer to its waiting caller", async () => {
    const eventService = new EventService();
    const captureBridge = createCredentialCaptureBridge({ eventService });
    const shared = Object.assign(new Error("shared credential failure"), {
      code: "SHARED_FAILURE",
      errorData: { source: "browser" },
    });
    const leaf = Object.assign(new Error("cookie extraction failed"), {
      code: "COOKIE_FAILURE",
      errorData: { stage: "extract" },
    });
    const original = Object.assign(
      new AggregateError([leaf, shared, shared], "credential capture failed", { cause: shared }),
      { code: "CAPTURE_FAILURE", errorData: { captureId: "capture-graph" } }
    );

    let dispatchServerEvent: (event: string, payload: unknown) => void = () => {};
    const clientRelease = eventService.registerTransportSession({
      callerId: "alice-desktop",
      connectionId: "capture-graph",
      userId: "alice",
      callerKind: "shell",
      send: (event, payload) => dispatchServerEvent(String(event), payload),
    });
    const serverClient = {
      call: vi.fn(async (_service: string, _method: string, args: unknown[]) => {
        captureBridge.completeCapture(
          "alice",
          args[0] as string,
          args[1] as CredentialCaptureCompletion
        );
      }),
    };
    const eventHandler = createServerEventBridge({
      eventService,
      getPanelOrchestrator: () => null,
      getServerClient: () => serverClient as never,
      openExternal: async () => {},
      warn: () => {},
      onCredentialCaptureRequest: async () => {
        throw original;
      },
    });
    dispatchServerEvent = (event, payload) => eventHandler(event as EventName, payload);

    try {
      const waitingCaller = captureBridge.captureSessionCredential("alice", { kind: "cookies" });
      let received: unknown;
      try {
        await waitingCaller;
      } catch (error) {
        received = error;
      }

      expect(received).toBeInstanceOf(RemoteRpcAggregateError);
      const aggregate = received as RemoteRpcAggregateError;
      expect(aggregate).toMatchObject({
        message: "credential capture failed",
        code: "CAPTURE_FAILURE",
        errorData: { captureId: "capture-graph" },
      });
      expect(aggregate.errors).toHaveLength(3);
      expect(aggregate.errors[0]).toMatchObject({
        message: "cookie extraction failed",
        code: "COOKIE_FAILURE",
        errorData: { stage: "extract" },
      });
      expect(aggregate.errors[1]).toMatchObject({
        message: "shared credential failure",
        code: "SHARED_FAILURE",
        errorData: { source: "browser" },
      });
      expect(aggregate.errors[1]).toBe(aggregate.errors[2]);
      expect(aggregate.cause).toBe(aggregate.errors[1]);
      expect(serverClient.call).toHaveBeenCalledWith(
        "credentials",
        "completeCapture",
        expect.arrayContaining([
          expect.any(String),
          expect.objectContaining({ kind: "failure", failure: expect.any(Object) }),
        ])
      );
    } finally {
      clientRelease();
    }
  });

  it("waits for the person and rejects only when the addressed shell disconnects", async () => {
    vi.useFakeTimers();
    const eventService = new EventService();
    const shell = vi.fn();
    const release = eventService.registerTransportSession({
      callerId: "alice-desktop",
      connectionId: "1",
      userId: "alice",
      callerKind: "shell",
      send: shell,
    });
    try {
      const bridge = createCredentialCaptureBridge({ eventService });
      let settled = false;
      const promise = bridge.captureSessionCredential("alice", {});
      void promise.then(
        () => (settled = true),
        () => (settled = true)
      );
      const captureId = shell.mock.calls[0]![1].captureId as string;

      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(settled).toBe(false);

      const assertion = expect(promise).rejects.toMatchObject({
        code: DESKTOP_ATTACHMENT_REQUIRED,
      });
      release();
      await assertion;

      // Pending entry is gone: completing the same id now throws.
      expect(() =>
        bridge.completeCapture("alice", captureId, {
          kind: "success",
          value: { token: "late" },
        })
      ).toThrow("No pending credential capture");
    } finally {
      release();
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

    expect(() =>
      bridge.completeCapture("alice", "nope", {
        kind: "success",
        value: { token: "x" },
      })
    ).toThrow("No pending credential capture");
  });

  it("binds completion to the authenticated owner and replaces claimed correlation fields", async () => {
    const { eventService, emit } = makeEventService();
    const bridge = createCredentialCaptureBridge({ eventService });
    const result = bridge.captureSessionCredential("alice", { userId: "bob", captureId: "forged" });
    const payload = (emit.mock.calls[0] as unknown[])[2] as { userId: string; captureId: string };
    expect(payload.userId).toBe("alice");
    expect(payload.captureId).not.toBe("forged");
    expect(() =>
      bridge.completeCapture("bob", payload.captureId, {
        kind: "success",
        value: { token: "stolen" },
      })
    ).toThrow("No pending credential capture");
    bridge.completeCapture("alice", payload.captureId, {
      kind: "success",
      value: { token: "owned" },
    });
    await expect(result).resolves.toEqual({ token: "owned" });
  });
});
