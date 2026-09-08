import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { OwnedProcessIdentity } from "../dev/ownedProcessIdentity.js";
import {
  registerOwnedHubWithDevRunner,
  type DevRunnerIpcTarget,
} from "./devRunnerHubRegistration.js";

const identity: OwnedProcessIdentity = {
  version: 1,
  platform: "linux",
  pid: 42,
  processGroupId: 42,
  startCoordinate: "birth",
};

function target(): EventEmitter & DevRunnerIpcTarget & { send: ReturnType<typeof vi.fn> } {
  const emitter = new EventEmitter() as EventEmitter &
    DevRunnerIpcTarget & {
      send: ReturnType<typeof vi.fn>;
    };
  emitter.env = { VIBESTUDIO_DEV_RUNNER_IPC: "1" };
  emitter.send = vi.fn();
  return emitter;
}

describe("development runner hub registration", () => {
  it("settles only the matching accepted registration and removes lifecycle listeners", async () => {
    const ipc = target();
    const registration = registerOwnedHubWithDevRunner(identity, ipc);
    const request = ipc.send.mock.calls[0]?.[0] as { registrationId: string };
    ipc.emit("message", { type: "vibestudio:dev-owned-hub-accepted", registrationId: "other" });
    expect(ipc.listenerCount("message")).toBe(1);
    ipc.emit("message", {
      type: "vibestudio:dev-owned-hub-accepted",
      registrationId: request.registrationId,
    });
    await expect(registration).resolves.toBeUndefined();
    expect(ipc.listenerCount("message")).toBe(0);
    expect(ipc.listenerCount("disconnect")).toBe(0);
  });

  it("rejects explicit refusal and IPC disconnect without leaving listeners", async () => {
    const rejected = target();
    const rejectedRegistration = registerOwnedHubWithDevRunner(identity, rejected);
    const request = rejected.send.mock.calls[0]?.[0] as { registrationId: string };
    rejected.emit("message", {
      type: "vibestudio:dev-owned-hub-rejected",
      registrationId: request.registrationId,
    });
    await expect(rejectedRegistration).rejects.toThrow("rejected detached hub ownership");
    expect(rejected.listenerCount("disconnect")).toBe(0);

    const disconnected = target();
    const disconnectedRegistration = registerOwnedHubWithDevRunner(identity, disconnected);
    disconnected.emit("disconnect");
    await expect(disconnectedRegistration).rejects.toThrow("disconnected before accepting");
    expect(disconnected.listenerCount("message")).toBe(0);
  });
});
