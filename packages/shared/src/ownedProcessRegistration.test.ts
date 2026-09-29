import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { OwnedProcessIdentity } from "./ownedProcessIdentity.mjs";
import {
  registerOwnedProcessGroup,
  type OwnedProcessRegistrationTarget,
} from "./ownedProcessRegistration.mjs";

const identity: OwnedProcessIdentity = {
  version: 1,
  platform: "linux",
  pid: 42,
  processGroupId: 42,
  startCoordinate: "birth",
};

function target(): EventEmitter &
  OwnedProcessRegistrationTarget & { send: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as EventEmitter &
    OwnedProcessRegistrationTarget & {
      send: ReturnType<typeof vi.fn>;
    };
  emitter.send = vi.fn();
  return emitter;
}

describe("native process-group registration", () => {
  it("settles only the matching accepted registration and removes lifecycle listeners", async () => {
    const ipc = target();
    const registration = registerOwnedProcessGroup(identity, ipc);
    const request = ipc.send.mock.calls[0]?.[0] as { registrationId: string };
    ipc.emit("message", {
      type: "vibestudio:owned-process-group-accepted",
      registrationId: "other",
    });
    expect(ipc.listenerCount("message")).toBe(1);
    ipc.emit("message", {
      type: "vibestudio:owned-process-group-accepted",
      registrationId: request.registrationId,
    });
    await expect(registration).resolves.toBeUndefined();
    expect(ipc.listenerCount("message")).toBe(0);
    expect(ipc.listenerCount("disconnect")).toBe(0);
  });

  it("rejects explicit refusal and IPC disconnect without leaving listeners", async () => {
    const rejected = target();
    const rejectedRegistration = registerOwnedProcessGroup(identity, rejected);
    const request = rejected.send.mock.calls[0]?.[0] as { registrationId: string };
    rejected.emit("message", {
      type: "vibestudio:owned-process-group-rejected",
      registrationId: request.registrationId,
    });
    await expect(rejectedRegistration).rejects.toThrow("rejected process-group ownership");
    expect(rejected.listenerCount("disconnect")).toBe(0);

    const disconnected = target();
    const disconnectedRegistration = registerOwnedProcessGroup(identity, disconnected);
    disconnected.emit("disconnect");
    await expect(disconnectedRegistration).rejects.toThrow("disconnected before accepting");
    expect(disconnected.listenerCount("message")).toBe(0);
  });
});
