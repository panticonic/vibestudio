import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { createMessagePortPair } from "../connection/controlChannel.js";
import { launchConnectionProcess } from "./connectionProcess.js";

function launch() {
  const child = Object.assign(new EventEmitter(), {
    postMessage: () => undefined,
    kill: () => true,
  });
  const handle = launchConnectionProcess({
    fork: () => child as never,
    createPorts: createMessagePortPair,
  });
  return { child, handle };
}

describe("connection process launch", () => {
  it("fails pending requests with the exit code when the process ends", async () => {
    const { child, handle } = launch();
    const pending = handle.channel.request("connection.close", {});
    child.emit("exit", 139);
    await expect(pending).rejects.toThrow("exited unexpectedly (code 139)");
    await expect(handle.exited).resolves.toMatchObject({ code: 139, requested: false });
    await expect(handle.channel.request("connection.close", {})).rejects.toThrow("code 139");
  });

  it("does not end the channel on a port close alone: only the exit knows why", async () => {
    const { child, handle } = launch();
    expect(handle.channel.isClosed).toBe(false);
    child.emit("exit", 1);
    expect(handle.channel.isClosed).toBe(true);
  });

  it("reports a requested stop as one, and waits for the exit", async () => {
    const { child, handle } = launch();
    child.kill = () => {
      queueMicrotask(() => child.emit("exit", 0));
      return true;
    };
    await expect(handle.dispose()).resolves.toMatchObject({ code: 0, requested: true });
  });
});
