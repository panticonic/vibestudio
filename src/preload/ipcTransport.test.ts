import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
const emitter = new EventEmitter();
vi.mock("electron", () => ({
  ipcRenderer: {
    on: (...args: Parameters<EventEmitter["on"]>) => emitter.on(...args),
    off: (...args: Parameters<EventEmitter["off"]>) => emitter.off(...args),
    send: vi.fn(),
  },
}));
it("delivers workspace-scoped recovery through the shared IPC bridge and releases listeners", async () => {
  const { createIpcTransport } = await import("./ipcTransport");
  const bridge = createIpcTransport();
  const recovered = vi.fn();
  const stop = bridge.onRecovery("cold-recover", recovered);
  emitter.emit("vibestudio:rpc:recovery", {}, "resubscribe", "project");
  expect(recovered).not.toHaveBeenCalled();
  emitter.emit("vibestudio:rpc:recovery", {}, "cold-recover", "project");
  expect(recovered).toHaveBeenCalledWith("project");
  stop();
  emitter.emit("vibestudio:rpc:recovery", {}, "cold-recover", "project");
  expect(recovered).toHaveBeenCalledTimes(1);
  emitter.removeAllListeners();
});
